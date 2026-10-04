package dev.agentcraft.client.agents;

import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.foreman.Protocol.AgentState;
import dev.agentcraft.layout.Anchor;
import dev.agentcraft.layout.AnchorNames;
import dev.agentcraft.layout.Anchors;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Keeps one {@link ClientAgentEntity} per Foreman agent in the client level, in sync with the
 * state model and the anchor layout (client thread, every client tick):
 * <ul>
 *   <li>new agent: spawned standing at its target anchor (no walk-in from nowhere);</li>
 *   <li>station/active change: walks there along a {@link GridPathfinder} route (teleports if
 *       there is no route, e.g. the HQ was rebuilt around it);</li>
 *   <li>agent gone after a snapshot: removed;</li>
 *   <li>Foreman link down: agents stay where they are with a dimmed "Foreman offline" plate;</li>
 *   <li>layout republished ({@code /agentcraft hq}): everyone is placed at their new anchors.</li>
 * </ul>
 * Without a layout, agents stand in a row near the world spawn so they are still visible.
 *
 * <p>Phase 3: a station anchor with a seat block ({@link Seats}) is walked to via a free cell next
 * to the seat, then the agent steps in and sits; leaving a seat starts with standing up. An agent
 * that is {@code waiting_user} walks to the user spot by the podium, or, when you are inside the
 * HQ, gathers around the shared podium anchor and waits facing it, so every client sees the same
 * target positions. The derived "waiting on you" status ({@link AgentView#awaitingUser}) comes from
 * the open decisions.
 */
public final class AgentManager {
	private static final AgentManager INSTANCE = new AgentManager();
	/** Teleport instead of walking when the route is longer than this (blocks). */
	private static final double MAX_WALK = 96;
	/** Ticks it takes to get up from a seat before walking off. */
	private static final int STAND_UP_TICKS = 8;
	/** Radius around the shared podium anchor used by agents waiting for input (blocks). */
	static final double USER_DISTANCE = 3.2;

	private final Map<String, ClientAgentEntity> entities = new LinkedHashMap<>();
	private final Map<Integer, ClientAgentEntity> byEntityId = new HashMap<>();
	private final StationAssigner assigner = new StationAssigner();
	private final Seats seats = new Seats();
	private final Map<String, String> awaiting = new HashMap<>();
	private final Map<String, Integer> awaitingCounts = new HashMap<>();
	private long awaitingRevision = -1;
	private @Nullable ClientLevel level;
	private long layoutRevision = -1;
	private int nextEntityId = -10_000;
	private int pathFailures;
	private long ticks;

	private AgentManager() {
	}

	public static AgentManager get() {
		return INSTANCE;
	}

	/** Live agent entities by agent id (client thread). */
	public Map<String, ClientAgentEntity> entities() {
		return Collections.unmodifiableMap(entities);
	}

	public @Nullable ClientAgentEntity entity(String agentId) {
		return entities.get(agentId);
	}

	public @Nullable ClientAgentEntity byEntityId(int id) {
		return byEntityId.get(id);
	}

	public int pathFailures() {
		return pathFailures;
	}

	/**
	 * A snapshot rebuilds the view: forget sticky slots so the assignment depends only on the state
	 * (Foreman order), not on the history of this session. Agents that change slot walk there.
	 */
	void onSnapshot() {
		assigner.clear();
		awaitingRevision = -1;
	}

	public int movingCount() {
		int n = 0;
		for (ClientAgentEntity e : entities.values()) {
			if (e.motion().walking()) {
				n++;
			}
		}
		return n;
	}

	void tick(Minecraft mc) {
		ClientLevel lvl = mc.level;
		if (lvl != level) {
			entities.clear(); // the old level and its entities are gone
			byEntityId.clear();
			assigner.clear();
			seats.clear();
			level = lvl;
			layoutRevision = -1;
		}
		if (lvl == null) {
			return;
		}
		ticks++;
		ForemanState st = Foreman.state();
		if (st == null || !st.hasData()) {
			removeAll();
			return;
		}
		Anchors.Layout layout = Anchors.current();
		boolean relayout = layout.revision() != layoutRevision;
		layoutRevision = layout.revision();
		if (relayout) {
			seats.clear();
		}
		List<Agent> agents = new ArrayList<>(st.agents().values());
		Map<String, Anchor> targets = layout.isEmpty() ? fallbackTargets(agents, lvl) : assigner.assign(agents, layout);
		boolean stale = st.isStale();
		updateAwaiting(st);
		GridPathfinder pf = layout.isEmpty() ? null : new GridPathfinder(lvl, layout.bounds());
		Anchor waitingCenter = layout.get(AnchorNames.USER);
		if (waitingCenter == null) {
			waitingCenter = layout.get(AnchorNames.DECISION_PODIUM);
		}
		int waitingIndex = 0;
		int waitingCount = 0;
		if (waitingCenter != null && pf != null) {
			for (Agent a : agents) {
				if (followsPlayer(a)) {
					waitingCount++;
				}
			}
		}

		Set<String> keep = new HashSet<>();
		for (Agent a : agents) {
			Anchor target = targets.get(a.id());
			if (target == null) {
				continue;
			}
			keep.add(a.id());
			ClientAgentEntity e = entities.get(a.id());
			if (e == null || e.isRemoved() || e.level() != lvl) {
				e = spawn(lvl, a, target);
				entities.put(a.id(), e);
				byEntityId.put(e.getId(), e);
				showRecentSay(st, e);
			} else if (!e.getSkin().equals(AgentSkins.get(a.id(), a.skin()))) {
				e.setSkin(AgentSkins.get(a.id(), a.skin()));
			}
			AgentView v = e.view();
			v.update(a, stale, awaiting.get(a.id()), awaitingCounts.getOrDefault(a.id(), 0));
			v.station = StationAssigner.stationKey(a);
			if (waitingCenter != null && pf != null && !stale && followsPlayer(a)) {
				Anchor near = waitingSpot(waitingCenter, waitingIndex++, waitingCount, pf);
				if (near != null) {
					target = near;
				}
			}
			v.anchor = target.name();
			Seats.Seat seat = pf == null ? null : seats.at(lvl, target, ticks, pf);
			Anchor effective = seat != null ? seat.target() : target;
			if (relayout) {
				e.life().setSeat(seat);
				place(e, effective);
			} else if (!stale) {
				retarget(lvl, layout, e, effective, seat);
			}
		}
		for (var it = entities.entrySet().iterator(); it.hasNext();) {
			var en = it.next();
			if (!keep.contains(en.getKey())) {
				remove(lvl, en.getValue());
				byEntityId.remove(en.getValue().getId());
				it.remove();
			}
		}
	}

	private static boolean followsPlayer(Agent a) {
		return a.state() == AgentState.WAITING_USER && a.isActive() && !a.isPaused();
	}

	/**
	 * agentId -> the first open decision that agent <b>owns</b>. Every open decision has exactly one
	 * owner, so the HQ shows one "!" per decision waiting on the user:
	 * <ul>
	 *   <li>a merge belongs to the worker whose task it merges (the lead files it, but it is the
	 *       worker's finished work that waits; "t4 awaiting your merge"), or to the agent that filed
	 *       it when the task has no known assignee;</li>
	 *   <li>a question or permission prompt belongs to the agent that asked, whatever task it is
	 *       about (a question about Juniper's task is Marlow's question, not Juniper's).</li>
	 * </ul>
	 * An agent's own questions/permissions come before the merges it owns.
	 */
	private void updateAwaiting(ForemanState st) {
		if (st.revision() == awaitingRevision) {
			return;
		}
		awaitingRevision = st.revision();
		awaiting.clear();
		awaitingCounts.clear();
		List<Protocol.Decision> open = st.openDecisions();
		for (int pass = 0; pass < 2; pass++) {
			for (Protocol.Decision d : open) {
				boolean merge = d.kind() == Protocol.DecisionKind.MERGE;
				if (merge != (pass == 1)) {
					continue;
				}
				String owner = owner(st, d);
				awaiting.putIfAbsent(owner, d.id());
				awaitingCounts.merge(owner, 1, Integer::sum);
			}
		}
	}

	/** The agent an open decision belongs to (see {@link #updateAwaiting}). */
	public static String owner(ForemanState st, Protocol.Decision d) {
		if (d.kind() == Protocol.DecisionKind.MERGE && d.taskId() != null) {
			Protocol.Task t = st.task(d.taskId());
			if (t != null && t.assignee() != null && st.agent(t.assignee()) != null) {
				return t.assignee();
			}
		}
		return d.agentId();
	}

	/** Deterministic shared fan around the same podium anchor on every client. */
	private static @Nullable Anchor waitingSpot(Anchor center, int index, int count, GridPathfinder pf) {
		double base = Math.toRadians(center.yaw() + 90.0);
		double fan = count <= 1 ? 0 : (index - (count - 1) / 2.0) * Math.toRadians(34);
		double[] radii = {USER_DISTANCE, USER_DISTANCE + 0.5, USER_DISTANCE - 0.6};
		double[] offsets = {0, 0.25, -0.25, 0.55, -0.55, 0.9, -0.9, Math.PI};
		for (double radius : radii) {
			for (double offset : offsets) {
				double angle = base + fan + offset;
				double x = center.x() + Math.cos(angle) * radius;
				double z = center.z() + Math.sin(angle) * radius;
				int bx = (int) Math.floor(x);
				int bz = (int) Math.floor(z);
				int by = (int) Math.floor(center.y() + 0.01);
				for (int dy : new int[] {0, 1, -1}) {
					double floor = pf.floor(bx, by + dy, bz);
					if (Double.isNaN(floor)) {
						continue;
					}
					Vec3 spot = new Vec3(x, floor, z);
					if (!pf.clear(spot, spot)) {
						continue;
					}
					float yaw = (float) Math.toDegrees(Math.atan2(-(center.x() - x), center.z() - z));
					return new Anchor(AnchorNames.USER + "@shared-" + index, x, floor, z, yaw, 0);
				}
			}
		}
		return null;
	}

	/** A fresh agent shows what it said in the last few seconds (e.g. after a reconnect). */
	private static void showRecentSay(ForemanState st, ClientAgentEntity e) {
		Protocol.AgentSay say = st.lastSay(e.agentId());
		if (say == null) {
			return;
		}
		long ago = System.currentTimeMillis() - say.ts();
		if (ago >= 0 && ago < 8000) {
			e.life().bubble.showLate(say, e.life().age(), (int) (ago / 50));
		}
	}

	private ClientAgentEntity spawn(ClientLevel lvl, Agent a, Anchor target) {
		ClientAgentEntity e = new ClientAgentEntity(lvl, a.id(), AgentSkins.get(a.id(), a.skin()));
		// Negative ids never collide with server-assigned entity ids.
		e.setId(nextEntityId--);
		Seats.Seat seat = seats.at(lvl, target, ticks, new GridPathfinder(lvl, Anchors.current().bounds()));
		e.life().setSeat(seat);
		place(e, seat != null ? seat.target() : target);
		lvl.addEntity(e);
		AgentCraft.LOGGER.info("Agent {} appeared at {}", a.id(), target.name());
		return e;
	}

	private static void place(ClientAgentEntity e, Anchor target) {
		Vec3 p = e.motion().placeAt(target);
		e.snapTo(p, target.yaw());
	}

	private void retarget(ClientLevel lvl, Anchors.Layout layout, ClientAgentEntity e, Anchor target, Seats.@Nullable Seat seat) {
		Anchor current = e.motion().target();
		if (current != null && current.name().equals(target.name()) && current.pos().distanceToSqr(target.pos()) < 1e-4) {
			return;
		}
		GridPathfinder pf = new GridPathfinder(lvl, layout.bounds());
		AgentLife life = e.life();
		List<Vec3> route = new ArrayList<>();
		Vec3 start = e.position();
		int delay = 0;
		Seats.Seat from = life.seat();
		if (from != null && life.sitAmount() > 0f && !e.motion().walking()) {
			// get up first, then step out of the seat to its free side
			delay = STAND_UP_TICKS;
			if (from.approach() != null) {
				route.add(start);
				start = from.approach();
			}
		}
		Vec3 dest = seat != null && seat.approach() != null ? seat.approach() : target.pos();
		List<Vec3> path = start.distanceToSqr(dest) < 1e-6 ? List.of(start, dest) : pf.find(start, dest);
		if (path == null || length(path) > MAX_WALK) {
			pathFailures++;
			AgentCraft.LOGGER.info("Agent {}: no walkable route to {} ({}), teleporting", e.agentId(), target.name(),
				path == null ? "no path" : "too far");
			life.setSeat(seat);
			place(e, target);
			return;
		}
		route.addAll(path);
		if (seat != null && seat.approach() != null) {
			route.add(target.pos()); // the last step: onto the seat
		}
		life.setSeat(seat);
		e.motion().walkTo(target, route, delay);
	}

	private static double length(List<Vec3> route) {
		double d = 0;
		for (int i = 1; i < route.size(); i++) {
			d += route.get(i).distanceTo(route.get(i - 1));
		}
		return d;
	}

	/** Snap every agent to its target now (QA: no one mid-walk in a screenshot). */
	public int settle() {
		int n = 0;
		for (ClientAgentEntity e : entities.values()) {
			Anchor t = e.motion().target();
			if (t != null && e.motion().walking()) {
				place(e, t);
				n++;
			}
		}
		return n;
	}

	private void removeAll() {
		if (level != null) {
			for (ClientAgentEntity e : entities.values()) {
				remove(level, e);
			}
		}
		entities.clear();
		byEntityId.clear();
	}

	private static void remove(ClientLevel lvl, ClientAgentEntity e) {
		lvl.removeEntity(e.getId(), Entity.RemovalReason.DISCARDED);
	}

	/** No layout yet: a row in front of the world spawn, facing it. */
	private static Map<String, Anchor> fallbackTargets(List<Agent> agents, ClientLevel lvl) {
		Map<String, Anchor> out = new LinkedHashMap<>();
		BlockPos spawn = lvl.getRespawnData().pos();
		int n = agents.size();
		for (int i = 0; i < n; i++) {
			double x = spawn.getX() + 0.5 + (i - (n - 1) / 2.0) * 1.4;
			out.put(agents.get(i).id(), new Anchor(AnchorNames.LOUNGE + "@spawn" + i, x, spawn.getY(), spawn.getZ() + 4.5, 180, 0));
		}
		return out;
	}
}

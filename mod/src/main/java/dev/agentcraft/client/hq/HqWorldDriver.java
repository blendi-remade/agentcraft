package dev.agentcraft.client.hq;

import dev.agentcraft.block.DecisionPodiumBlock;
import dev.agentcraft.block.LampStatus;
import dev.agentcraft.block.MergeStationBlock;
import dev.agentcraft.block.MonitorBlock;
import dev.agentcraft.block.StatusLampBlock;
import dev.agentcraft.block.entity.DecisionPodiumBlockEntity;
import dev.agentcraft.block.entity.MergeStationBlockEntity;
import dev.agentcraft.block.entity.MonitorBlockEntity;
import dev.agentcraft.block.entity.StatusLampBlockEntity;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.foreman.Protocol.DecisionKind;
import dev.agentcraft.client.foreman.Protocol.Goal;
import dev.agentcraft.client.foreman.Protocol.Repo;
import dev.agentcraft.layout.Anchor;
import dev.agentcraft.layout.AnchorNames;
import dev.agentcraft.layout.Anchors;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.CopperBulbBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * Drives the HQ's world blocks from the Foreman state on the authoritative server thread:
 * <ul>
 *   <li>status lamps by binding: {@code agent:<id>} (the agent's status family, the same one its
 *       nameplate shows: an idle/done agent with a decision waiting on you is {@code waiting}; off
 *       when the agent is off shift or gone), {@code ci:<repoId>} or {@code ci:#<n>} (the n-th repo
 *       in Foreman order), {@code goal} / {@code goal:atrium} (the current goal), {@code decisions}
 *       (waiting while any decision is open), {@code merge} (waiting while a merge decision is open);</li>
 *   <li>the decision podium {@code open} while any decision is open;</li>
 *   <li>merge stations {@code active} while a merge decision is open;</li>
 *   <li>monitors {@code lit} while their agent is on shift;</li>
 *   <li>signal bulbs (copper bulbs within 3 blocks of the {@code decision_podium} anchor or of a
 *       {@code mergestation} slot) lit while that station needs you.</li>
 * </ul>
 * Only blocks whose state differs are written. The set of wanted states is recomputed on every
 * Foreman change and re-applied every 2 s (so rebuilt or newly placed blocks pick it up). While the
 * Foreman link is down the blocks keep their last state (the view is stale, not wrong).
 */
public final class HqWorldDriver {
	private static final int RESYNC_TICKS = 40;
	/** Blocks around the layout bounds that still belong to the HQ (lamps set into the walls). */
	private static final int MARGIN = 3;
	/** Reach of a station's signal bulbs around its anchor (blocks). */
	private static final int SIGNAL_REACH = 3;

	/** What the world should show, by binding. Immutable once built. */
	record Wanted(Map<String, LampStatus> lamps, boolean podiumOpen, boolean mergeActive, Map<String, Boolean> monitorLit) {
	}

	private static volatile @Nullable Wanted last;
	private static long lastRevision = -1;
	private static long lastLayout = -1;
	private static int ticks;
	private static volatile int lastChanged;

	private HqWorldDriver() {
	}

	/** Install the authoritative block driver on the server tick. */
	public static void init() {
		ServerTickEvents.END_SERVER_TICK.register(server -> tick(server.overworld(), dev.agentcraft.server.ServerForemanRelay.state()));
	}

	/** Blocks changed by the last apply (QA / debugging). */
	public static int lastChanged() {
		return lastChanged;
	}

	public static @Nullable Wanted wanted() {
		return last;
	}

	private static void tick(ServerLevel level, ForemanState st) {
		Anchors.Layout layout = Anchors.current();
		if (st == null || !st.hasData() || st.isStale() || layout.isEmpty() || layout.bounds() == null) {
			return;
		}
		ticks++;
		boolean changed = st.revision() != lastRevision || layout.revision() != lastLayout;
		if (!changed && ticks % RESYNC_TICKS != 0) {
			return;
		}
		Wanted w = changed || last == null ? compute(st) : last;
		lastRevision = st.revision();
		lastLayout = layout.revision();
		boolean differs = !Objects.equals(w, last);
		last = w;
		if (differs || ticks % RESYNC_TICKS == 0) {
			Anchors.Bounds b = layout.bounds();
			List<BlockPos> podiumSignals = signalCenters(layout, AnchorNames.DECISION_PODIUM);
			List<BlockPos> mergeSignals = signalCenters(layout, AnchorNames.MERGESTATION);
			lastChanged = apply(level, w, b, podiumSignals, mergeSignals);
		}
	}

	/** Block positions of the anchors of a station (all its slots). */
	private static List<BlockPos> signalCenters(Anchors.Layout layout, String station) {
		List<BlockPos> out = new ArrayList<>();
		for (Anchor a : layout.anchors().values()) {
			String n = a.name();
			if (n.equals(station) || n.startsWith(station + "_") && n.substring(station.length() + 1).chars().allMatch(Character::isDigit)) {
				out.add(BlockPos.containing(a.x(), a.y(), a.z()));
			}
		}
		return out;
	}

	/**
	 * Agent id -> an open decision waiting on the user for that agent: its own question / permission
	 * prompt first, then merges it asked for, then decisions about its task (the same rule as the
	 * agents' nameplates, so a lamp and its agent's status dot always agree).
	 */
	static Map<String, String> awaiting(ForemanState st) {
		Map<String, String> out = new HashMap<>();
		List<Protocol.Decision> open = st.openDecisions();
		for (Protocol.Decision d : open) {
			if (d.kind() != DecisionKind.MERGE) {
				out.putIfAbsent(d.agentId(), d.id());
			}
		}
		for (Protocol.Decision d : open) {
			out.putIfAbsent(d.agentId(), d.id());
		}
		for (Protocol.Decision d : open) {
			if (d.taskId() != null) {
				Protocol.Task t = st.task(d.taskId());
				if (t != null && t.assignee() != null) {
					out.putIfAbsent(t.assignee(), d.id());
				}
			}
		}
		return out;
	}

	/** The lamp an agent shows: its state family, or waiting when it idles on a decision of yours. */
	static LampStatus agentLamp(Agent a, boolean awaitingUser) {
		if (!a.isActive()) {
			return LampStatus.OFF;
		}
		String fam = a.state().family();
		if (awaitingUser && (fam.equals("idle") || fam.equals("done"))) {
			return LampStatus.WAITING;
		}
		return LampStatus.forAgentState(a.state().wire());
	}

	static Wanted compute(ForemanState st) {
		Map<String, LampStatus> lamps = new HashMap<>();
		Map<String, Boolean> lit = new HashMap<>();
		Map<String, String> waitingOn = awaiting(st);
		for (Agent a : st.agents().values()) {
			lamps.put("agent:" + a.id(), agentLamp(a, waitingOn.containsKey(a.id())));
			lit.put(a.id(), a.isActive());
		}
		int n = 0;
		for (Repo r : st.repos().values()) {
			LampStatus ci = LampStatus.forCi(r.ci().wire());
			lamps.put("ci:" + r.id(), ci);
			lamps.put("ci:#" + (++n), ci);
		}
		LampStatus goal = goalLamp(st.goal());
		lamps.put("goal", goal);
		lamps.put("goal:atrium", goal);
		boolean open = !st.openDecisions().isEmpty();
		lamps.put("decisions", open ? LampStatus.WAITING : LampStatus.OFF);
		boolean merge = st.oldestOpen(DecisionKind.MERGE) != null;
		lamps.put("merge", merge ? LampStatus.WAITING : LampStatus.OFF);
		lamps.put(BEACON_BINDING, beaconLamp(st, open, goal));
		return new Wanted(Map.copyOf(lamps), open, merge, Map.copyOf(lit));
	}

	/** The cupola beacon's binding (the whole studio at a glance, seen from outside). */
	public static final String BEACON_BINDING = "beacon";

	/**
	 * The studio's aggregate state for the cupola beacon, most urgent first: anything waiting on you
	 * (clay), an agent in error/blocked (red), work going on (teal) or thinking (brass), the goal done
	 * (sage), else idle.
	 */
	static LampStatus beaconLamp(ForemanState st, boolean decisionOpen, LampStatus goal) {
		if (decisionOpen) {
			return LampStatus.WAITING;
		}
		boolean error = false;
		boolean working = false;
		boolean thinking = false;
		boolean waiting = false;
		for (Agent a : st.agents().values()) {
			if (!a.isActive()) {
				continue;
			}
			switch (a.state().family()) {
				case "waiting" -> waiting = true;
				case "error" -> error = true;
				case "working" -> working = true;
				case "thinking" -> thinking = true;
				default -> {
				}
			}
		}
		if (waiting) {
			return LampStatus.WAITING;
		}
		if (error) {
			return LampStatus.ERROR;
		}
		if (working) {
			return LampStatus.WORKING;
		}
		if (thinking) {
			return LampStatus.THINKING;
		}
		return goal == LampStatus.DONE ? LampStatus.DONE : LampStatus.IDLE;
	}

	static LampStatus goalLamp(@Nullable Goal g) {
		if (g == null) {
			return LampStatus.IDLE;
		}
		return switch (g.status()) {
			case PLANNING -> LampStatus.THINKING;
			case ACTIVE -> LampStatus.WORKING;
			case DONE -> LampStatus.DONE;
			case FAILED -> LampStatus.ERROR;
			default -> LampStatus.IDLE;
		};
	}

	/** Server thread: set every bound station block in the HQ region to its wanted state. */
	static int apply(ServerLevel level, Wanted w, Anchors.Bounds b, List<BlockPos> podiumSignals, List<BlockPos> mergeSignals) {
		List<BlockPos> pos = new ArrayList<>();
		List<BlockState> to = new ArrayList<>();
		int x0 = (b.minX() - MARGIN) >> 4;
		int x1 = (b.maxX() + MARGIN) >> 4;
		int z0 = (b.minZ() - MARGIN) >> 4;
		int z1 = (b.maxZ() + MARGIN) >> 4;
		for (int cx = x0; cx <= x1; cx++) {
			for (int cz = z0; cz <= z1; cz++) {
				LevelChunk chunk = level.getChunkSource().getChunkNow(cx, cz);
				if (chunk == null) {
					continue;
				}
				for (BlockEntity be : chunk.getBlockEntities().values()) {
					BlockPos p = be.getBlockPos();
					if (p.getX() < b.minX() - MARGIN || p.getX() > b.maxX() + MARGIN || p.getZ() < b.minZ() - MARGIN || p.getZ() > b.maxZ() + MARGIN) {
						continue;
					}
					BlockState s = be.getBlockState();
					BlockState want = wantedState(be, s, w);
					if (want != null && want != s) {
						pos.add(p);
						to.add(want);
					}
				}
			}
		}
		signals(level, podiumSignals, w.podiumOpen(), pos, to);
		signals(level, mergeSignals, w.mergeActive(), pos, to);
		for (int i = 0; i < pos.size(); i++) {
			level.setBlock(pos.get(i), to.get(i), Block.UPDATE_CLIENTS);
		}
		return pos.size();
	}

	/** Copper bulbs around the given station anchors follow {@code on} (no redstone involved). */
	private static void signals(ServerLevel level, List<BlockPos> centers, boolean on, List<BlockPos> pos, List<BlockState> to) {
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (BlockPos c : centers) {
			for (int dx = -SIGNAL_REACH; dx <= SIGNAL_REACH; dx++) {
				for (int dz = -SIGNAL_REACH; dz <= SIGNAL_REACH; dz++) {
					for (int dy = -1; dy <= 6; dy++) {
						m.set(c.getX() + dx, c.getY() + dy, c.getZ() + dz);
						if (!level.isLoaded(m)) {
							continue;
						}
						BlockState s = level.getBlockState(m);
						if (s.getBlock() instanceof CopperBulbBlock && s.getValue(CopperBulbBlock.LIT) != on) {
							BlockPos p = m.immutable();
							if (!pos.contains(p)) {
								pos.add(p);
								to.add(s.setValue(CopperBulbBlock.LIT, on));
							}
						}
					}
				}
			}
		}
	}

	private static @Nullable BlockState wantedState(BlockEntity be, BlockState s, Wanted w) {
		if (be instanceof StatusLampBlockEntity lamp && s.getBlock() instanceof StatusLampBlock) {
			LampStatus want = w.lamps().get(lamp.binding());
			if (want == null) {
				// bound to something the Foreman does not have: an agent that left goes dark, an unused CI
				// slot (no second repo yet) shows idle grey rather than a dead lamp
				want = lamp.binding().startsWith("ci:") ? LampStatus.IDLE : lamp.binding().startsWith("agent:") ? LampStatus.OFF : null;
			}
			return want == null ? null : s.setValue(StatusLampBlock.STATUS, want);
		}
		if (be instanceof DecisionPodiumBlockEntity && s.getBlock() instanceof DecisionPodiumBlock) {
			return s.setValue(DecisionPodiumBlock.OPEN, w.podiumOpen());
		}
		if (be instanceof MergeStationBlockEntity && s.getBlock() instanceof MergeStationBlock) {
			return s.setValue(MergeStationBlock.ACTIVE, w.mergeActive());
		}
		if (be instanceof MonitorBlockEntity mon && s.getBlock() instanceof MonitorBlock && !mon.binding().isEmpty()) {
			Boolean lit = w.monitorLit().get(mon.binding());
			return s.setValue(MonitorBlock.LIT, lit != null && lit);
		}
		return null;
	}
}

package dev.agentcraft.client.foreman;

import com.google.gson.JsonObject;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.foreman.Protocol.AgentLog;
import dev.agentcraft.client.foreman.Protocol.AgentLogs;
import dev.agentcraft.client.foreman.Protocol.AgentSay;
import dev.agentcraft.client.foreman.Protocol.AgentUpsert;
import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.foreman.Protocol.DecisionKind;
import dev.agentcraft.client.foreman.Protocol.DecisionUpsert;
import dev.agentcraft.client.foreman.Protocol.FeedAdd;
import dev.agentcraft.client.foreman.Protocol.FeedItem;
import dev.agentcraft.client.foreman.Protocol.ForemanStatus;
import dev.agentcraft.client.foreman.Protocol.ForemanStatusMsg;
import dev.agentcraft.client.foreman.Protocol.Goal;
import dev.agentcraft.client.foreman.Protocol.GoalUpsert;
import dev.agentcraft.client.foreman.Protocol.LogEntry;
import dev.agentcraft.client.foreman.Protocol.MemoryEntry;
import dev.agentcraft.client.foreman.Protocol.MemoryUpsert;
import dev.agentcraft.client.foreman.Protocol.Notify;
import dev.agentcraft.client.foreman.Protocol.Repo;
import dev.agentcraft.client.foreman.Protocol.RepoUpsert;
import dev.agentcraft.client.foreman.Protocol.Snapshot;
import dev.agentcraft.client.foreman.Protocol.Task;
import dev.agentcraft.client.foreman.Protocol.TaskStatus;
import dev.agentcraft.client.foreman.Protocol.TaskUpsert;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.SequencedCollection;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import org.jspecify.annotations.Nullable;

/**
 * The client-side model of the Foreman's state: agents, tasks, decisions, repos, memory, goals,
 * feed, per-agent log tails, the latest speech per agent, recent notifications, the Foreman status
 * and the link state.
 *
 * <p><b>Threading:</b> each instance is mutated on exactly one owner thread: the Minecraft server
 * thread for the authoritative relay model, or the client render thread for the local view. The
 * network link hands parsed frames to that owner thread. Read the client instance from renderers,
 * screens, HUD, and client tick handlers. From other threads use
 * {@code DevBridge.onClient(...)}. The getters return unmodifiable live views; copy if you keep
 * them. Maps iterate in Foreman order (snapshot order, new entries appended).
 *
 * <p>While the link is down the last known state is kept ({@link #isStale()} true) so the world
 * does not go empty; the next snapshot replaces everything.
 */
public final class ForemanState {
	public static final int LOG_TAIL = 200;
	public static final int FEED_TAIL = 200;
	public static final int NOTIFY_TAIL = 20;

	private final Map<String, Agent> agents = new LinkedHashMap<>();
	private final Map<String, Task> tasks = new LinkedHashMap<>();
	private final Map<String, Decision> decisions = new LinkedHashMap<>();
	private final Map<String, Repo> repos = new LinkedHashMap<>();
	private final Map<String, MemoryEntry> memory = new LinkedHashMap<>();
	private final Map<String, Goal> goals = new LinkedHashMap<>();
	private final Map<String, Deque<LogEntry>> logs = new HashMap<>();
	private final Map<String, AgentSay> lastSay = new HashMap<>();
	private final Deque<FeedItem> feed = new ArrayDeque<>();
	private final Deque<Notify> notifications = new ArrayDeque<>();
	private @Nullable Goal goal;
	private @Nullable ForemanStatus status;
	private LinkStatus link;
	private long revision;
	private long snapshotAt;
	private long lastMessageAt;
	private int snapshots;

	private final List<ForemanListener> listeners = new CopyOnWriteArrayList<>();

	public ForemanState(LinkStatus initial) {
		this.link = initial;
	}

	// ------------------------------------------------------------------ read API

	public Map<String, Agent> agents() {
		return Collections.unmodifiableMap(agents);
	}

	public @Nullable Agent agent(String id) {
		return agents.get(id);
	}

	public Map<String, Task> tasks() {
		return Collections.unmodifiableMap(tasks);
	}

	public @Nullable Task task(String id) {
		return tasks.get(id);
	}

	/** Tasks with this status, highest priority first, then oldest first. */
	public List<Task> tasksWithStatus(TaskStatus s) {
		List<Task> out = new ArrayList<>();
		for (Task t : tasks.values()) {
			if (t.status() == s) {
				out.add(t);
			}
		}
		out.sort(Comparator.comparingInt(Task::priority).reversed().thenComparingLong(Task::createdAt));
		return out;
	}

	public Map<String, Decision> decisions() {
		return Collections.unmodifiableMap(decisions);
	}

	public @Nullable Decision decision(String id) {
		return decisions.get(id);
	}

	/** Open decisions, oldest first. */
	public List<Decision> openDecisions() {
		List<Decision> out = new ArrayList<>();
		for (Decision d : decisions.values()) {
			if (d.isOpen()) {
				out.add(d);
			}
		}
		out.sort(Comparator.comparingLong(Decision::createdAt));
		return out;
	}

	/** Oldest open decision of this kind, or null. */
	public @Nullable Decision oldestOpen(DecisionKind kind) {
		for (Decision d : openDecisions()) {
			if (d.kind() == kind) {
				return d;
			}
		}
		return null;
	}

	public Map<String, Repo> repos() {
		return Collections.unmodifiableMap(repos);
	}

	public @Nullable Repo repo(String id) {
		return repos.get(id);
	}

	public Map<String, MemoryEntry> memory() {
		return Collections.unmodifiableMap(memory);
	}

	/** The current (latest) goal, or null. */
	public @Nullable Goal goal() {
		return goal;
	}

	/** All goals, oldest first. */
	public Map<String, Goal> goals() {
		return Collections.unmodifiableMap(goals);
	}

	/** Most recent feed items, oldest first (bounded to {@value #FEED_TAIL}); a read-only live view. */
	public SequencedCollection<FeedItem> feed() {
		return Collections.unmodifiableSequencedCollection(feed);
	}

	/** Log tail of one agent, oldest first (bounded to {@value #LOG_TAIL}); empty if none. */
	public List<LogEntry> logs(String agentId) {
		Deque<LogEntry> d = logs.get(agentId);
		return d == null ? List.of() : Collections.unmodifiableList(new ArrayList<>(d));
	}

	/** Number of log entries kept for an agent (cheap; no copy). */
	public int logCount(String agentId) {
		Deque<LogEntry> d = logs.get(agentId);
		return d == null ? 0 : d.size();
	}

	/** The last thing this agent said (speech bubble source), or null. */
	public @Nullable AgentSay lastSay(String agentId) {
		return lastSay.get(agentId);
	}

	/** Recent notify messages, oldest first; a read-only live view. */
	public SequencedCollection<Notify> notifications() {
		return Collections.unmodifiableSequencedCollection(notifications);
	}

	/** Backend/auth status of the Foreman, or null before the first snapshot. */
	public @Nullable ForemanStatus status() {
		return status;
	}

	public LinkStatus link() {
		return link;
	}

	/** True when the model holds data but the link is not live (show it as "last known"). */
	public boolean isStale() {
		return !link.synced();
	}

	/** True once any snapshot was received (the model has real data). */
	public boolean hasData() {
		return snapshots > 0;
	}

	/** Increments on every change (snapshot, upsert, append, link change). Use it to cache derived data. */
	public long revision() {
		return revision;
	}

	public long snapshotAt() {
		return snapshotAt;
	}

	public long lastMessageAt() {
		return lastMessageAt;
	}

	public int snapshotCount() {
		return snapshots;
	}

	// ------------------------------------------------------------------ listeners

	public void addListener(ForemanListener l) {
		listeners.add(l);
	}

	public void removeListener(ForemanListener l) {
		listeners.remove(l);
	}

	private void fire(Consumer<ForemanListener> call) {
		revision++;
		for (ForemanListener l : listeners) {
			try {
				call.accept(l);
				l.onChange(revision);
			} catch (Throwable t) {
				AgentCraft.LOGGER.warn("Foreman listener {} failed", l.getClass().getName(), t);
			}
		}
	}

	// ------------------------------------------------------------------ mutation (client thread, from ForemanLink)

	public void setLink(LinkStatus status) {
		this.link = status;
		fire(l -> l.onConnection(status));
	}

	// ------------------------------------------------------------------ hold queue + injection (video choreography)

	/** Upper bound of the hold queue (oldest messages are dropped beyond it; the release reconnects anyway). */
	public static final int HOLD_MAX = 20_000;
	private boolean hold;
	private final Deque<Object[]> held = new ArrayDeque<>();
	private int heldDropped;

	/**
	 * A message from the live link. While {@link #setHold held}, it is queued instead of applied, so
	 * a choreographed shot sees only what it injects; otherwise it is applied at once.
	 */
	public void receive(String type, JsonObject json) {
		if (hold) {
			held.addLast(new Object[] {type, json});
			while (held.size() > HOLD_MAX) {
				held.removeFirst();
				heldDropped++;
			}
			return;
		}
		apply(type, json);
	}

	/** True while live Foreman messages are being held back. */
	public boolean isHeld() {
		return hold;
	}

	/** Number of live messages waiting in the hold queue. */
	public int heldCount() {
		return held.size();
	}

	/** Hold live messages (queue them) instead of applying them. Client thread. */
	public void setHold(boolean on) {
		if (on && !hold) {
			held.clear();
			heldDropped = 0;
		}
		hold = on;
	}

	/**
	 * End the hold. {@code replay}: apply the queued messages in order; otherwise drop them (the
	 * caller then reconnects for a fresh snapshot). Returns how many were queued.
	 */
	public int releaseHold(boolean replay) {
		hold = false;
		int n = held.size();
		if (replay) {
			while (!held.isEmpty()) {
				Object[] m = held.removeFirst();
				try {
					apply((String) m[0], (JsonObject) m[1]);
				} catch (Exception e) {
					AgentCraft.LOGGER.warn("Replaying held Foreman message '{}' failed", m[0], e);
				}
			}
		} else {
			held.clear();
		}
		return n;
	}

	public int heldDropped() {
		return heldDropped;
	}

	/**
	 * Apply a Foreman message as if the Foreman had sent it (dev.foreman.inject, dev.record
	 * timelines). Bypasses the hold queue. Client thread. Returns false for types the model does not keep.
	 */
	public boolean inject(String type, JsonObject json) {
		return apply(type, json);
	}

	/**
	 * Build an {@code agent.upsert} / {@code task.upsert} from the current agent or task with a few
	 * fields replaced (wire names, e.g. {@code {"station":"desk","state":"editing"}}) and apply it.
	 * Returns the message that was applied. Client thread.
	 */
	public JsonObject patch(String kind, String id, JsonObject set) {
		Object current = switch (kind) {
			case "agent" -> agents.get(id);
			case "task" -> tasks.get(id);
			default -> throw new IllegalArgumentException("patch kind must be agent or task");
		};
		if (current == null) {
			throw new IllegalArgumentException("no " + kind + " '" + id + "' in the Foreman state (known: "
				+ String.join(", ", kind.equals("agent") ? agents.keySet() : tasks.keySet()) + ")");
		}
		JsonObject obj = ForemanJson.GSON.toJsonTree(current).getAsJsonObject();
		for (var e : set.entrySet()) {
			obj.add(e.getKey(), e.getValue().deepCopy());
		}
		if (kind.equals("task") && !set.has("updatedAt")) {
			obj.addProperty("updatedAt", System.currentTimeMillis());
		}
		JsonObject msg = new JsonObject();
		msg.addProperty("v", Protocol.VERSION);
		msg.addProperty("type", kind + ".upsert");
		msg.add(kind, obj);
		apply(kind + ".upsert", msg);
		return msg;
	}

	/** Apply one parsed Foreman message. Returns false for types the model does not keep (ack, diff, error...). */
	boolean apply(String type, JsonObject json) {
		lastMessageAt = System.currentTimeMillis();
		switch (type) {
			case "snapshot" -> applySnapshot(ForemanJson.read(json, Snapshot.class));
			case "agent.upsert" -> {
				Agent a = ForemanJson.read(json, AgentUpsert.class).agent();
				if (a != null && a.id() != null) {
					Agent prev = agents.put(a.id(), a);
					fire(l -> l.onAgent(prev, a));
				}
			}
			case "agent.log" -> {
				AgentLog m = ForemanJson.read(json, AgentLog.class);
				if (m.agentId() != null && !m.entries().isEmpty()) {
					appendLogs(m.agentId(), m.entries());
					fire(l -> l.onLog(m.agentId(), m.entries()));
				}
			}
			case "agent.say" -> {
				AgentSay s = ForemanJson.read(json, AgentSay.class);
				if (s.agentId() != null) {
					lastSay.put(s.agentId(), s);
					fire(l -> l.onSay(s));
				}
			}
			case "task.upsert" -> {
				Task t = ForemanJson.read(json, TaskUpsert.class).task();
				if (t != null && t.id() != null) {
					Task prev = tasks.put(t.id(), t);
					fire(l -> l.onTask(prev, t));
				}
			}
			case "decision.upsert" -> {
				Decision d = ForemanJson.read(json, DecisionUpsert.class).decision();
				if (d != null && d.id() != null) {
					Decision prev = decisions.put(d.id(), d);
					fire(l -> l.onDecision(prev, d));
				}
			}
			case "repo.upsert" -> {
				Repo r = ForemanJson.read(json, RepoUpsert.class).repo();
				if (r != null && r.id() != null) {
					Repo prev = repos.put(r.id(), r);
					fire(l -> l.onRepo(prev, r));
				}
			}
			case "memory.upsert" -> {
				MemoryEntry e = ForemanJson.read(json, MemoryUpsert.class).entry();
				if (e != null && e.id() != null) {
					MemoryEntry prev = memory.put(e.id(), e);
					fire(l -> l.onMemory(prev, e));
				}
			}
			case "goal.upsert" -> {
				Goal g = ForemanJson.read(json, GoalUpsert.class).goal();
				if (g != null && g.id() != null) {
					Goal prev = goals.put(g.id(), g);
					// "latest goal is current": the newest by creation time
					if (goal == null || goal.id().equals(g.id()) || g.createdAt() >= goal.createdAt()) {
						goal = g;
					}
					fire(l -> l.onGoal(prev, g));
				}
			}
			case "feed.add" -> {
				FeedItem item = ForemanJson.read(json, FeedAdd.class).item();
				if (item != null) {
					bounded(feed, item, FEED_TAIL);
					fire(l -> l.onFeed(item));
				}
			}
			case "notify" -> {
				Notify n = ForemanJson.read(json, Notify.class);
				bounded(notifications, n, NOTIFY_TAIL);
				fire(l -> l.onNotify(n));
			}
			case "foreman.status" -> {
				ForemanStatus s = ForemanJson.read(json, ForemanStatusMsg.class).status();
				if (s != null) {
					status = s;
					fire(l -> l.onStatus(s));
				}
			}
			default -> {
				return false;
			}
		}
		return true;
	}

	private void applySnapshot(Snapshot s) {
		agents.clear();
		tasks.clear();
		decisions.clear();
		repos.clear();
		memory.clear();
		goals.clear();
		logs.clear();
		feed.clear();
		for (Agent a : s.agents()) {
			if (a != null && a.id() != null) {
				agents.put(a.id(), a);
			}
		}
		for (Task t : s.tasks()) {
			if (t != null && t.id() != null) {
				tasks.put(t.id(), t);
			}
		}
		for (Decision d : s.decisions()) {
			if (d != null && d.id() != null) {
				decisions.put(d.id(), d);
			}
		}
		for (Repo r : s.repos()) {
			if (r != null && r.id() != null) {
				repos.put(r.id(), r);
			}
		}
		for (MemoryEntry e : s.memory()) {
			if (e != null && e.id() != null) {
				memory.put(e.id(), e);
			}
		}
		for (Goal g : s.goals()) {
			if (g != null && g.id() != null) {
				goals.put(g.id(), g);
			}
		}
		goal = s.goal();
		if (goal != null && goal.id() != null) {
			goals.putIfAbsent(goal.id(), goal);
		}
		for (FeedItem f : s.feed()) {
			if (f != null) {
				bounded(feed, f, FEED_TAIL);
			}
		}
		for (AgentLogs l : s.logs()) {
			if (l != null && l.agentId() != null) {
				appendLogs(l.agentId(), l.entries());
			}
		}
		// speech bubbles are transient: drop the ones of agents that no longer exist
		lastSay.keySet().retainAll(agents.keySet());
		status = s.foreman();
		snapshots++;
		snapshotAt = System.currentTimeMillis();
		fire(l -> l.onSnapshot(this));
	}

	private void appendLogs(String agentId, List<LogEntry> entries) {
		Deque<LogEntry> d = logs.computeIfAbsent(agentId, k -> new ArrayDeque<>());
		for (LogEntry e : entries) {
			if (e != null) {
				bounded(d, e, LOG_TAIL);
			}
		}
	}

	private static <T> void bounded(Deque<T> d, T item, int max) {
		d.addLast(item);
		while (d.size() > max) {
			d.removeFirst();
		}
	}
}

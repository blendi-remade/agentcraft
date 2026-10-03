package dev.agentcraft.client.foreman;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Locale;
import org.jspecify.annotations.Nullable;

/**
 * Java mirror of the Foreman protocol v1 (docs/protocol.md, generated from foreman/src/protocol.ts).
 * Field names are exact. Optional fields are nullable (boxed when numeric/boolean); required lists
 * are never null (normalised to empty). Unknown JSON fields are ignored and unknown enum values map
 * to {@code UNKNOWN}, so a newer Foreman never breaks the mod.
 */
public final class Protocol {
	public static final int VERSION = 1;

	private Protocol() {
	}

	/** Marker for protocol enums: wire value = lower-case constant name; unknown values map to UNKNOWN. */
	public interface Wire {
		default String wire() {
			return ((Enum<?>) this).name().toLowerCase(Locale.ROOT);
		}
	}

	// ------------------------------------------------------------------ enums

	public enum AgentState implements Wire {
		IDLE, THINKING, READING, EDITING, RUNNING, TESTING, WAITING_USER, BLOCKED, DONE, ERROR, UNKNOWN;

		/** Status-dot / lamp family: idle, thinking, working, waiting, error, done. */
		public String family() {
			return switch (this) {
				case THINKING -> "thinking";
				case READING, EDITING, RUNNING, TESTING -> "working";
				case WAITING_USER -> "waiting";
				case BLOCKED, ERROR -> "error";
				case DONE -> "done";
				default -> "idle";
			};
		}
	}

	public enum Station implements Wire {
		DESK, LIBRARY, TERMINAL, TESTBENCH, MERGESTATION, MEETING, LOUNGE, USER, UNKNOWN
	}

	public enum AgentRole implements Wire {
		LEAD, WORKER, UNKNOWN
	}

	public enum TaskStatus implements Wire {
		TODO, DOING, REVIEW, DONE, BLOCKED, CANCELLED, UNKNOWN
	}

	public enum CiStatus implements Wire {
		UNKNOWN, RUNNING, PASS, FAIL
	}

	public enum LogKind implements Wire {
		TEXT, TOOL, RESULT, ERROR, DIFF, UNKNOWN
	}

	public enum DecisionKind implements Wire {
		QUESTION, PERMISSION, MERGE, UNKNOWN
	}

	public enum DecisionStatus implements Wire {
		OPEN, ANSWERED, CANCELLED, UNKNOWN
	}

	public enum GoalStatus implements Wire {
		PLANNING, ACTIVE, DONE, FAILED, CANCELLED, UNKNOWN
	}

	public enum FeedKind implements Wire {
		GOAL, PLAN, TASK, MESSAGE, DECISION, MERGE, CI, MEMORY, SYSTEM, ERROR, USER, UNKNOWN
	}

	public enum NotifyLevel implements Wire {
		INFO, WARN, NEED_USER, UNKNOWN
	}

	public enum WorktreeStatus implements Wire {
		ACTIVE, MERGED, ABANDONED, UNKNOWN
	}

	public enum BackendName implements Wire {
		SIM, CLAUDE, CODEX, UNKNOWN
	}

	public enum AuthStatus implements Wire {
		OK, FAILED, UNKNOWN, CHECKING
	}

	public enum DiffFileStatus implements Wire {
		ADDED, MODIFIED, DELETED, RENAMED, UNKNOWN
	}

	public enum DiffLineKind implements Wire {
		ADD, DEL, CTX, UNKNOWN
	}

	/** Exact option labels (protocol.md). */
	public static final String MERGE = "Merge";
	public static final String REQUEST_CHANGES = "Request changes";
	public static final String REJECT = "Reject";
	public static final String ALLOW_ONCE = "Allow once";
	public static final String ALWAYS_ALLOW = "Always allow for this agent";
	public static final String DENY = "Deny";

	// ------------------------------------------------------------------ entities

	public record Agent(String id, String name, AgentRole role, @Nullable String title, String color, @Nullable String accent, String skin,
		AgentState state, String activity, Station station, @Nullable String taskId, @Nullable String repoId, @Nullable String worktree,
		@Nullable Boolean paused, @Nullable Boolean active) {
		public Agent {
			name = name == null ? id : name;
			role = role == null ? AgentRole.UNKNOWN : role;
			color = color == null ? "#9C9488" : color;
			skin = skin == null ? id : skin;
			state = state == null ? AgentState.UNKNOWN : state;
			activity = activity == null ? "" : activity;
			station = station == null ? Station.UNKNOWN : station;
		}

		/** false = off shift (render idle in the lounge). Missing = true. */
		public boolean isActive() {
			return active == null || active;
		}

		public boolean isPaused() {
			return paused != null && paused;
		}
	}

	public record LogEntry(long ts, LogKind kind, String text) {
		public LogEntry {
			kind = kind == null ? LogKind.UNKNOWN : kind;
			text = text == null ? "" : text;
		}
	}

	public record Task(String id, String title, @Nullable String description, TaskStatus status, @Nullable String assignee, List<String> deps,
		@Nullable String repoId, @Nullable String goalId, int priority, @Nullable String branch, @Nullable String worktree, CiStatus ci,
		@Nullable String blockedReason, @Nullable String summary, @Nullable String createdBy, long createdAt, long updatedAt) {
		public Task {
			title = title == null ? id : title;
			status = status == null ? TaskStatus.UNKNOWN : status;
			deps = deps == null ? List.of() : List.copyOf(deps);
			ci = ci == null ? CiStatus.UNKNOWN : ci;
		}
	}

	public record DecisionAnswer(@Nullable String option, @Nullable String text, long ts) {
	}

	public record Decision(String id, String agentId, DecisionKind kind, String question, List<String> options, @Nullable String context,
		DecisionStatus status, @Nullable DecisionAnswer answer, @Nullable String taskId, @Nullable String repoId, @Nullable String worktree,
		@Nullable String tool, long createdAt) {
		public Decision {
			kind = kind == null ? DecisionKind.UNKNOWN : kind;
			question = question == null ? "" : question;
			options = options == null ? List.of() : List.copyOf(options);
			status = status == null ? DecisionStatus.UNKNOWN : status;
		}

		public boolean isOpen() {
			return status == DecisionStatus.OPEN;
		}
	}

	public record Worktree(String id, String agentId, @Nullable String taskId, String branch, String base, String path, WorktreeStatus status,
		int ahead, int files, int additions, int deletions) {
		public Worktree {
			status = status == null ? WorktreeStatus.UNKNOWN : status;
		}
	}

	public record Repo(String id, String name, String path, String branch, @Nullable String head, boolean dirty, List<Worktree> worktrees,
		CiStatus ci) {
		public Repo {
			name = name == null ? id : name;
			worktrees = worktrees == null ? List.of() : List.copyOf(worktrees);
			ci = ci == null ? CiStatus.UNKNOWN : ci;
		}
	}

	public record MemoryEntry(String id, String scope, String title, String body, long updated, @Nullable String author) {
		public MemoryEntry {
			scope = scope == null ? "shared" : scope;
			title = title == null ? id : title;
			body = body == null ? "" : body;
		}
	}

	public record Goal(String id, String text, double progress, GoalStatus status, @Nullable String repoId, long createdAt, long updatedAt) {
		public Goal {
			text = text == null ? "" : text;
			status = status == null ? GoalStatus.UNKNOWN : status;
		}
	}

	public record FeedItem(long ts, FeedKind kind, String text, @Nullable String agentId, @Nullable String to) {
		public FeedItem {
			kind = kind == null ? FeedKind.UNKNOWN : kind;
			text = text == null ? "" : text;
		}
	}

	public record ForemanStatus(String version, BackendName backend, AuthStatus auth, @Nullable String message, @Nullable String account,
		@Nullable Double speed, @Nullable Boolean showcase, @Nullable Double costUsd, @Nullable String userName) {
		public ForemanStatus {
			version = version == null ? "?" : version;
			backend = backend == null ? BackendName.UNKNOWN : backend;
			auth = auth == null ? AuthStatus.UNKNOWN : auth;
		}
	}

	public record AgentLogs(String agentId, List<LogEntry> entries) {
		public AgentLogs {
			entries = entries == null ? List.of() : List.copyOf(entries);
		}
	}

	public record DiffLine(DiffLineKind kind, String text, @Nullable Integer oldNo, @Nullable Integer newNo) {
		public DiffLine {
			kind = kind == null ? DiffLineKind.UNKNOWN : kind;
			text = text == null ? "" : text;
		}
	}

	public record DiffHunk(String header, int oldStart, int oldLines, int newStart, int newLines, List<DiffLine> lines) {
		public DiffHunk {
			header = header == null ? "" : header;
			lines = lines == null ? List.of() : List.copyOf(lines);
		}
	}

	public record DiffFile(String path, @Nullable String oldPath, DiffFileStatus status, boolean binary, int additions, int deletions,
		List<DiffHunk> hunks) {
		public DiffFile {
			status = status == null ? DiffFileStatus.UNKNOWN : status;
			hunks = hunks == null ? List.of() : List.copyOf(hunks);
		}
	}

	public record DiffStats(int files, int additions, int deletions) {
	}

	// ------------------------------------------------------------------ Foreman -> mod messages

	public record Snapshot(ForemanStatus foreman, List<Agent> agents, List<Task> tasks, List<Decision> decisions, List<Repo> repos,
		List<MemoryEntry> memory, @Nullable Goal goal, List<Goal> goals, List<FeedItem> feed, List<AgentLogs> logs) {
		public Snapshot {
			agents = agents == null ? List.of() : List.copyOf(agents);
			tasks = tasks == null ? List.of() : List.copyOf(tasks);
			decisions = decisions == null ? List.of() : List.copyOf(decisions);
			repos = repos == null ? List.of() : List.copyOf(repos);
			memory = memory == null ? List.of() : List.copyOf(memory);
			goals = goals == null ? List.of() : List.copyOf(goals);
			feed = feed == null ? List.of() : List.copyOf(feed);
			logs = logs == null ? List.of() : List.copyOf(logs);
		}
	}

	public record AgentUpsert(Agent agent) {
	}

	public record AgentLog(String agentId, List<LogEntry> entries) {
		public AgentLog {
			entries = entries == null ? List.of() : List.copyOf(entries);
		}
	}

	public record AgentSay(String agentId, String text, @Nullable String to, long ts) {
		public AgentSay {
			text = text == null ? "" : text;
		}
	}

	public record TaskUpsert(Task task) {
	}

	public record DecisionUpsert(Decision decision) {
	}

	public record RepoUpsert(Repo repo) {
	}

	public record MemoryUpsert(MemoryEntry entry) {
	}

	public record GoalUpsert(Goal goal) {
	}

	public record FeedAdd(FeedItem item) {
	}

	public record Diff(String requestId, String repoId, String worktree, @Nullable String base, @Nullable String branch, List<DiffFile> files,
		DiffStats stats, boolean truncated, @Nullable String error) {
		public Diff {
			files = files == null ? List.of() : List.copyOf(files);
			stats = stats == null ? new DiffStats(0, 0, 0) : stats;
		}
	}

	public record Notify(NotifyLevel level, String text, @Nullable String decisionId, long ts) {
		public Notify {
			level = level == null ? NotifyLevel.UNKNOWN : level;
			text = text == null ? "" : text;
		}
	}

	public record ForemanStatusMsg(ForemanStatus status) {
	}

	/** Reply to a client message with an id. {@code result} e.g. {goalId} for goal.submit. */
	public record Ack(String re, boolean ok, @Nullable String error, @Nullable JsonObject result) {
	}

	public record ErrorMsg(String message, @Nullable String re) {
	}
}

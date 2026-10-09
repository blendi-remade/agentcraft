package dev.agentcraft.client.console;

import dev.agentcraft.client.decisions.DecisionQueue;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.foreman.Protocol.DecisionKind;
import dev.agentcraft.client.foreman.Protocol.Repo;
import dev.agentcraft.client.foreman.Protocol.Task;
import dev.agentcraft.client.foreman.Protocol.TaskStatus;
import dev.agentcraft.client.foreman.Protocol.Worktree;
import dev.agentcraft.client.foreman.Protocol.WorktreeStatus;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * Console input -> intent, and completions. Pure logic over the Foreman state model (client
 * thread), no Minecraft types, so every rule here can be exercised with {@code dev.console.parse}.
 *
 * <pre>
 * plain text                       goal.submit (asks which repo when there are several)
 * @name text  /  @all text         user.message
 * /answer [dN] &lt;n|label&gt; [text]    decision.answer (n is 1-based, as on the decision buttons)
 * /repo add &lt;path&gt;   /repos         repo.add / list repos
 * /pause|/resume|/stop @x [@y|all] agent.action
 * /spawn @x [taskId]               agent.action spawn
 * /task &lt;id&gt; cancel|retry|prioritize [n]|reassign @x
 * /diff [worktree|@agent]          diff review screen (or a summary)
 * /status /help /decide /clear /sound on|off
 * </pre>
 */
public final class ConsoleCommands {
	private ConsoleCommands() {
	}

	// ------------------------------------------------------------------ intents

	public sealed interface Intent permits Goal, Message, Answer, RepoAdd, Repos, AgentAction, TaskAction, ShowDiff, Status, Help, Decide, Clear,
		Sound, Invalid, Empty {
	}

	/** {@code repoId} null = the Foreman's default; {@code choices} non-empty = ask which repo first. */
	public record Goal(String text, @Nullable String repoId, List<Repo> choices) implements Intent {
	}

	/** {@code to} = agent id or "all". */
	public record Message(String to, String text) implements Intent {
	}

	public record Answer(Decision decision, @Nullable String option, @Nullable String text) implements Intent {
	}

	public record RepoAdd(String path) implements Intent {
	}

	public record Repos() implements Intent {
	}

	public record AgentAction(List<String> agentIds, String action, @Nullable String arg) implements Intent {
	}

	public record TaskAction(String taskId, String action, @Nullable String arg) implements Intent {
	}

	public record ShowDiff(String repoId, String worktree, @Nullable Decision decision) implements Intent {
	}

	public record Status() implements Intent {
	}

	public record Help(@Nullable String topic) implements Intent {
	}

	public record Decide(@Nullable String decisionId) implements Intent {
	}

	public record Clear() implements Intent {
	}

	public record Sound(@Nullable Boolean on) implements Intent {
	}

	public record Invalid(String error) implements Intent {
	}

	public record Empty() implements Intent {
	}

	/** One command for /help and completion. */
	public record Command(String name, String usage, String help) {
	}

	public static final List<Command> COMMANDS = List.of(
		new Command("answer", "/answer [d4] <n|option> [text]", "answer an open decision (n = button number)"),
		new Command("decide", "/decide", "open the decision queue (J)"),
		new Command("diff", "/diff [worktree|@agent]", "review a worktree's diff"),
		new Command("pause", "/pause @agent", "pause an agent (keeps its task)"),
		new Command("resume", "/resume @agent", "resume a paused or stopped agent"),
		new Command("stop", "/stop @agent", "take an agent off shift"),
		new Command("spawn", "/spawn @agent [task]", "bring an agent on shift"),
		new Command("task", "/task <id> cancel|retry|prioritize|reassign", "steer a task"),
		new Command("repo", "/repo add <path>", "register a local git repo"),
		new Command("repos", "/repos", "list repos"),
		new Command("status", "/status", "goal, agents, tasks and decisions"),
		new Command("sound", "/sound on|off", "decision bell and done chime"),
		new Command("clear", "/clear", "clear the console's own lines"),
		new Command("help", "/help", "this list"));

	private static final List<String> AGENT_ACTIONS = List.of("pause", "resume", "stop", "spawn");
	private static final List<String> TASK_ACTIONS = List.of("cancel", "retry", "prioritize", "reassign");

	// ------------------------------------------------------------------ parse

	public static Intent parse(String raw, ForemanState s) {
		String input = raw == null ? "" : raw.replace("\r", "");
		String trimmed = input.strip();
		if (trimmed.isEmpty()) {
			return new Empty();
		}
		if (trimmed.startsWith("@")) {
			return parseMessage(trimmed, s);
		}
		if (trimmed.startsWith("/")) {
			return parseCommand(trimmed, s);
		}
		return goal(trimmed, s);
	}

	private static Intent goal(String text, ForemanState s) {
		List<Repo> repos = new ArrayList<>(s.repos().values());
		if (repos.size() <= 1) {
			return new Goal(text, repos.isEmpty() ? null : repos.get(0).id(), List.of());
		}
		return new Goal(text, defaultRepo(s), repos);
	}

	/** The repo a new goal goes to by default: the current goal's repo, else the most recently added. */
	public static @Nullable String defaultRepo(ForemanState s) {
		if (s.goal() != null && s.goal().repoId() != null && s.repo(s.goal().repoId()) != null) {
			return s.goal().repoId();
		}
		String last = null;
		for (String id : s.repos().keySet()) {
			last = id;
		}
		return last;
	}

	private static Intent parseMessage(String trimmed, ForemanState s) {
		int sp = indexOfSpace(trimmed);
		String who = sp < 0 ? trimmed.substring(1) : trimmed.substring(1, sp);
		String text = sp < 0 ? "" : trimmed.substring(sp + 1).strip();
		if (who.isEmpty()) {
			return new Invalid("type an agent name after @ (Tab completes)");
		}
		String id = resolveAgent(who, s, true);
		if (id == null) {
			return new Invalid("no agent named @" + who + agentListSuffix(s));
		}
		if (text.isEmpty()) {
			return new Invalid("type a message for @" + displayName(id, s));
		}
		return new Message(id, text);
	}

	private static Intent parseCommand(String trimmed, ForemanState s) {
		// the command word ends at the first whitespace (a newline also ends it)
		int sp = indexOfSpace(trimmed);
		String cmd = (sp < 0 ? trimmed.substring(1) : trimmed.substring(1, sp)).toLowerCase(Locale.ROOT);
		String rest = sp < 0 ? "" : trimmed.substring(sp + 1).strip();
		List<String> args = splitArgs(rest);
		return switch (cmd) {
			case "answer", "a" -> parseAnswer(rest, s);
			case "repo" -> parseRepo(rest, args);
			case "repos" -> new Repos();
			case "pause", "resume", "stop", "spawn" -> parseAgentAction(cmd, args, s);
			case "task", "t" -> parseTask(args, s);
			case "diff" -> parseDiff(args, s);
			case "status", "st" -> new Status();
			case "help", "h", "?" -> new Help(args.isEmpty() ? null : args.get(0).replace("/", ""));
			case "decide", "decisions", "d" -> new Decide(args.isEmpty() ? null : args.get(0));
			case "clear", "cls" -> new Clear();
			case "sound", "sounds", "mute" -> parseSound(cmd, args);
			case "goal" -> rest.isEmpty() ? new Invalid("type the goal after /goal") : goal(rest, s);
			default -> new Invalid("unknown command /" + cmd + " (/help lists them)");
		};
	}

	private static Intent parseSound(String cmd, List<String> args) {
		if (cmd.equals("mute")) {
			return new Sound(false);
		}
		if (args.isEmpty()) {
			return new Sound(null);
		}
		return switch (args.get(0).toLowerCase(Locale.ROOT)) {
			case "on", "1", "yes" -> new Sound(true);
			case "off", "0", "no" -> new Sound(false);
			default -> new Invalid("/sound on or /sound off");
		};
	}

	private static Intent parseRepo(String rest, List<String> args) {
		if (args.isEmpty()) {
			return new Repos();
		}
		String sub = args.get(0).toLowerCase(Locale.ROOT);
		if (sub.equals("list") || sub.equals("ls")) {
			return new Repos();
		}
		if (!sub.equals("add")) {
			return new Invalid("usage: /repo add <path to a local git repo>");
		}
		String path = rest.strip().substring(3).strip();
		if (path.length() >= 2 && (path.startsWith("\"") && path.endsWith("\"") || path.startsWith("'") && path.endsWith("'"))) {
			path = path.substring(1, path.length() - 1).strip();
		}
		if (path.isEmpty()) {
			return new Invalid("usage: /repo add <path to a local git repo>");
		}
		return new RepoAdd(path);
	}

	private static Intent parseAgentAction(String action, List<String> args, ForemanState s) {
		if (args.isEmpty()) {
			return new Invalid("usage: /" + action + " @agent" + (action.equals("spawn") ? " [task]" : ""));
		}
		List<String> ids = new ArrayList<>();
		String arg = null;
		for (int i = 0; i < args.size(); i++) {
			String a = args.get(i);
			if (action.equals("spawn") && i > 0) {
				// spawn @kit t5: the task id
				String tid = a.startsWith("#") ? a.substring(1) : a;
				if (s.task(tid) == null) {
					return new Invalid("no task " + tid + taskListSuffix(s));
				}
				arg = tid;
				break;
			}
			String bare = a.startsWith("@") ? a.substring(1) : a;
			if (bare.equalsIgnoreCase("all") || bare.equalsIgnoreCase("everyone")) {
				if (action.equals("spawn")) {
					return new Invalid("spawn one agent at a time: /spawn @agent [task]");
				}
				for (Agent ag : s.agents().values()) {
					boolean wanted = switch (action) {
						case "pause" -> ag.isActive() && !ag.isPaused();
						case "resume" -> ag.isPaused() || !ag.isActive();
						default -> ag.isActive();
					};
					if (wanted && !ids.contains(ag.id())) {
						ids.add(ag.id());
					}
				}
				if (ids.isEmpty()) {
					return new Invalid("nobody to " + action);
				}
				continue;
			}
			String id = resolveAgent(bare, s, false);
			if (id == null) {
				return new Invalid("no agent named @" + bare + agentListSuffix(s));
			}
			if (!ids.contains(id)) {
				ids.add(id);
			}
		}
		return new AgentAction(List.copyOf(ids), action, arg);
	}

	private static Intent parseTask(List<String> args, ForemanState s) {
		if (args.isEmpty()) {
			return new Invalid("usage: /task <id> cancel|retry|prioritize [n]|reassign @agent");
		}
		String tid = args.get(0).startsWith("#") ? args.get(0).substring(1) : args.get(0);
		if (s.task(tid) == null) {
			return new Invalid("no task " + tid + taskListSuffix(s));
		}
		if (args.size() < 2) {
			return new Invalid("what should happen to " + tid + "? cancel, retry, prioritize [n] or reassign @agent");
		}
		String action = args.get(1).toLowerCase(Locale.ROOT);
		if (action.equals("prio") || action.equals("priority")) {
			action = "prioritize";
		}
		if (!TASK_ACTIONS.contains(action)) {
			return new Invalid("unknown task action '" + action + "': cancel, retry, prioritize [n] or reassign @agent");
		}
		String arg = null;
		if (action.equals("reassign")) {
			if (args.size() < 3) {
				return new Invalid("reassign " + tid + " to whom? /task " + tid + " reassign @agent");
			}
			String bare = args.get(2).startsWith("@") ? args.get(2).substring(1) : args.get(2);
			arg = resolveAgent(bare, s, false);
			if (arg == null) {
				return new Invalid("no agent named @" + bare + agentListSuffix(s));
			}
		} else if (action.equals("prioritize") && args.size() >= 3) {
			try {
				arg = Integer.toString(Integer.parseInt(args.get(2)));
			} catch (NumberFormatException e) {
				return new Invalid("priority must be a whole number");
			}
		}
		return new TaskAction(tid, action, arg);
	}

	private static Intent parseDiff(List<String> args, ForemanState s) {
		if (args.isEmpty()) {
			Decision m = DecisionQueue.firstOfKind(DecisionKind.MERGE);
			if (m != null && m.repoId() != null && m.worktree() != null) {
				return new ShowDiff(m.repoId(), m.worktree(), m);
			}
			return new Invalid("usage: /diff <worktree> or /diff @agent" + worktreeListSuffix(s));
		}
		String target = args.get(0);
		if (target.startsWith("@")) {
			String id = resolveAgent(target.substring(1), s, false);
			if (id == null) {
				return new Invalid("no agent named " + target + agentListSuffix(s));
			}
			Agent a = s.agent(id);
			if (a == null || a.worktree() == null || a.repoId() == null) {
				// fall back to that agent's most recent active worktree
				for (Repo r : s.repos().values()) {
					for (Worktree w : r.worktrees()) {
						if (id.equals(w.agentId()) && w.status() == WorktreeStatus.ACTIVE) {
							return new ShowDiff(r.id(), w.id(), mergeFor(s, r.id(), w.id()));
						}
					}
				}
				return new Invalid(displayName(id, s) + " has no worktree right now");
			}
			return new ShowDiff(a.repoId(), a.worktree(), mergeFor(s, a.repoId(), a.worktree()));
		}
		for (Repo r : s.repos().values()) {
			for (Worktree w : r.worktrees()) {
				if (w.id().equalsIgnoreCase(target)) {
					return new ShowDiff(r.id(), w.id(), mergeFor(s, r.id(), w.id()));
				}
			}
		}
		// a task id: its worktree
		Task t = s.task(target);
		if (t != null && t.worktree() != null && t.repoId() != null) {
			return new ShowDiff(t.repoId(), t.worktree(), mergeFor(s, t.repoId(), t.worktree()));
		}
		return new Invalid("no worktree '" + target + "'" + worktreeListSuffix(s));
	}

	private static @Nullable Decision mergeFor(ForemanState s, String repoId, String worktree) {
		for (Decision d : DecisionQueue.open()) {
			if (d.kind() == DecisionKind.MERGE && repoId.equals(d.repoId()) && worktree.equals(d.worktree())) {
				return d;
			}
		}
		return null;
	}

	private static Intent parseAnswer(String rest, ForemanState s) {
		List<Decision> open = DecisionQueue.open();
		if (open.isEmpty()) {
			return new Invalid("no decision is waiting");
		}
		String r = rest.strip();
		Decision d = null;
		int sp = indexOfSpace(r);
		String first = sp < 0 ? r : r.substring(0, sp);
		Decision byId = first.isEmpty() ? null : s.decision(first.startsWith("#") ? first.substring(1) : first);
		if (byId != null) {
			if (!byId.isOpen()) {
				return new Invalid(byId.id() + " is already " + byId.status().wire());
			}
			d = byId;
			r = sp < 0 ? "" : r.substring(sp + 1).strip();
		} else if (first.matches("(?i)d\\d+")) {
			return new Invalid("no decision " + first + " (open: " + ids(open) + ")");
		} else if (open.size() == 1) {
			d = open.get(0);
		} else {
			return new Invalid(open.size() + " decisions are open (" + ids(open) + "): /answer " + open.get(0).id() + " <n|option>");
		}
		if (r.isEmpty()) {
			return new Invalid(optionsHint(d));
		}
		// option by number or label; the remainder is the text
		int sp2 = indexOfSpace(r);
		String tok = sp2 < 0 ? r : r.substring(0, sp2);
		String after = sp2 < 0 ? "" : r.substring(sp2 + 1).strip();
		String option = resolveOption(d, tok, r);
		if (option != null) {
			// a multi-word label typed in full ("request changes ...") consumes those words
			String text = after;
			String lower = r.toLowerCase(Locale.ROOT);
			if (lower.startsWith(option.toLowerCase(Locale.ROOT)) && option.indexOf(' ') > 0) {
				text = r.substring(option.length()).strip();
			}
			if (option.equals(Protocol.REQUEST_CHANGES) && text.isEmpty()) {
				return new Invalid("say what should change: /answer " + d.id() + " " + (d.options().indexOf(option) + 1) + " <feedback>");
			}
			return new Answer(d, option, text.isEmpty() ? null : text);
		}
		if (tok.matches("\\d+")) {
			return new Invalid("option " + tok + " does not exist. " + optionsHint(d));
		}
		if (d.kind() == DecisionKind.QUESTION) {
			// free-text answer
			return new Answer(d, null, r);
		}
		return new Invalid("'" + tok + "' is not an option. " + optionsHint(d));
	}

	/** Option label for a token: 1-based number, exact label, a unique prefix or a known alias. */
	public static @Nullable String resolveOption(Decision d, String tok, String whole) {
		List<String> opts = d.options();
		if (tok.matches("\\d+")) {
			int n = Integer.parseInt(tok);
			return n >= 1 && n <= opts.size() ? opts.get(n - 1) : null;
		}
		String w = whole.toLowerCase(Locale.ROOT);
		// longest full label first ("Always allow for this team", "Request changes")
		String best = null;
		for (String o : opts) {
			String ol = o.toLowerCase(Locale.ROOT);
			if ((w.equals(ol) || w.startsWith(ol + " ")) && (best == null || o.length() > best.length())) {
				best = o;
			}
		}
		if (best != null) {
			return best;
		}
		String t = tok.toLowerCase(Locale.ROOT);
		String alias = switch (t) {
			case "always", "allow-always" -> Protocol.ALWAYS_ALLOW;
			case "allow", "once", "yes", "ok" -> d.kind() == DecisionKind.PERMISSION ? Protocol.ALLOW_ONCE : null;
			case "no" -> d.kind() == DecisionKind.PERMISSION ? Protocol.DENY : null;
			case "changes", "request", "rc" -> Protocol.REQUEST_CHANGES;
			default -> null;
		};
		if (alias != null && opts.contains(alias)) {
			return alias;
		}
		String found = null;
		for (String o : opts) {
			if (o.toLowerCase(Locale.ROOT).startsWith(t)) {
				if (found != null) {
					return null; // ambiguous
				}
				found = o;
			}
		}
		return found;
	}

	private static String optionsHint(Decision d) {
		if (d.options().isEmpty()) {
			return "type your answer: /answer " + d.id() + " <text>";
		}
		StringBuilder b = new StringBuilder("options for " + d.id() + ": ");
		for (int i = 0; i < d.options().size(); i++) {
			if (i > 0) {
				b.append(", ");
			}
			b.append(i + 1).append(' ').append(d.options().get(i));
		}
		return b.toString();
	}

	// ------------------------------------------------------------------ describe (live intent preview)

	/** One short line for the right side of the input: what Enter will do. Null = nothing to say. */
	public static @Nullable String describe(Intent in, ForemanState s) {
		return switch (in) {
			case Goal g -> g.repoId() == null ? "new goal" : "new goal → " + repoName(g.repoId(), s);
			case Message m -> m.to().equals("all") ? "message everyone" : "message " + displayName(m.to(), s);
			case Answer a -> "answer " + a.decision().id() + (a.option() != null ? ": " + a.option() : ": free text");
			case RepoAdd r -> "add repo";
			case Repos r -> "list repos";
			case AgentAction a -> a.action() + " " + (a.agentIds().size() == 1 ? displayName(a.agentIds().get(0), s) : a.agentIds().size() + " agents");
			case TaskAction t -> t.action() + " " + t.taskId();
			case ShowDiff d -> "diff " + d.worktree();
			case Status st -> "show status";
			case Help h -> "show help";
			case Decide d -> "open decisions";
			case Clear c -> "clear console";
			case Sound so -> so.on() == null ? "sound status" : so.on() ? "sound on" : "sound off";
			case Invalid i -> null;
			case Empty e -> null;
		};
	}

	// ------------------------------------------------------------------ completion

	/**
	 * A completion: replace {@code [start, end)} of the input with {@code replacement}.
	 * {@code agentId} (portrait), {@code dot} (status family) and {@code detail} are for the popup.
	 */
	public record Completion(int start, int end, String replacement, String label, @Nullable String detail, @Nullable String agentId,
		@Nullable String dot) {
	}

	/** Completions for the token under the caret (only when the caret is at the end of a token). */
	public static List<Completion> complete(String input, int cursor, ForemanState s) {
		List<Completion> out = new ArrayList<>();
		if (cursor < 0 || cursor > input.length()) {
			return out;
		}
		// the caret must be at the end of a token
		if (cursor < input.length() && !Character.isWhitespace(input.charAt(cursor))) {
			return out;
		}
		String head = input.substring(0, cursor);
		if (head.indexOf('\n') >= 0) {
			return out;
		}
		int ts = head.length();
		while (ts > 0 && !Character.isWhitespace(head.charAt(ts - 1))) {
			ts--;
		}
		String token = head.substring(ts);
		List<String> before = splitArgs(head.substring(0, ts));
		String lower = token.toLowerCase(Locale.ROOT);

		if (before.isEmpty()) {
			if (token.startsWith("@")) {
				agentCompletions(out, ts, cursor, lower.substring(1), s, true, " ");
			} else if (token.startsWith("/")) {
				String p = lower.substring(1);
				for (Command c : COMMANDS) {
					if (c.name().startsWith(p) && !(c.name().equals(p) && cursor < input.length())) {
						out.add(new Completion(ts, cursor, "/" + c.name() + " ", "/" + c.name(), c.help(), null, null));
					}
				}
			}
			return out;
		}
		String cmd = before.get(0).toLowerCase(Locale.ROOT);
		int argIndex = before.size(); // 1 = first argument
		switch (cmd) {
			case "/pause", "/resume", "/stop" -> agentCompletions(out, ts, cursor, lower.startsWith("@") ? lower.substring(1) : lower, s, true, " ");
			case "/spawn" -> {
				if (argIndex == 1) {
					agentCompletions(out, ts, cursor, lower.startsWith("@") ? lower.substring(1) : lower, s, false, " ");
				} else if (argIndex == 2) {
					taskCompletions(out, ts, cursor, lower, s, true);
				}
			}
			case "/answer", "/a" -> {
				if (argIndex == 1) {
					for (Decision d : DecisionQueue.open()) {
						if (d.id().toLowerCase(Locale.ROOT).startsWith(lower)) {
							out.add(new Completion(ts, cursor, d.id() + " ", d.id(), oneLine(d.question(), 48), d.agentId(), "waiting"));
						}
					}
				} else if (argIndex == 2) {
					Decision d = s.decision(before.get(1));
					if (d != null) {
						for (int i = 0; i < d.options().size(); i++) {
							String o = d.options().get(i);
							if (Integer.toString(i + 1).startsWith(lower) || o.toLowerCase(Locale.ROOT).startsWith(lower)) {
								out.add(new Completion(ts, cursor, (i + 1) + " ", (i + 1) + "  " + o, null, null, null));
							}
						}
					}
				}
			}
			case "/diff" -> {
				if (argIndex == 1) {
					if (token.startsWith("@")) {
						agentCompletions(out, ts, cursor, lower.substring(1), s, true, " ");
					} else {
						for (Repo r : s.repos().values()) {
							for (Worktree w : r.worktrees()) {
								if (w.status() == WorktreeStatus.ACTIVE && w.id().toLowerCase(Locale.ROOT).startsWith(lower)) {
									out.add(new Completion(ts, cursor, w.id(), w.id(), w.files() + " files, +" + w.additions() + " -" + w.deletions(), w.agentId(),
										null));
								}
							}
						}
					}
				}
			}
			case "/task", "/t" -> {
				if (argIndex == 1) {
					taskCompletions(out, ts, cursor, lower, s, false);
				} else if (argIndex == 2) {
					for (String a : TASK_ACTIONS) {
						if (a.startsWith(lower)) {
							out.add(new Completion(ts, cursor, a + " ", a, null, null, null));
						}
					}
				} else if (argIndex == 3 && before.get(2).equalsIgnoreCase("reassign")) {
					agentCompletions(out, ts, cursor, lower.startsWith("@") ? lower.substring(1) : lower, s, false, "");
				}
			}
			case "/repo" -> {
				if (argIndex == 1 && "add".startsWith(lower)) {
					out.add(new Completion(ts, cursor, "add ", "add", "register a local git repo", null, null));
				}
			}
			case "/sound" -> {
				if (argIndex == 1) {
					for (String o : List.of("on", "off")) {
						if (o.startsWith(lower)) {
							out.add(new Completion(ts, cursor, o, o, null, null, null));
						}
					}
				}
			}
			default -> {
			}
		}
		return out;
	}

	private static void agentCompletions(List<Completion> out, int start, int end, String prefix, ForemanState s, boolean withAll, String suffix) {
		for (Agent a : s.agents().values()) {
			if (a.id().startsWith(prefix) || a.name().toLowerCase(Locale.ROOT).startsWith(prefix)) {
				String detail = a.isActive() ? (a.isPaused() ? "paused" : a.activity()) : "off shift";
				out.add(new Completion(start, end, "@" + a.name().toLowerCase(Locale.ROOT) + suffix, a.name(), detail, a.id(), a.isPaused() ? "idle"
					: a.state().family()));
			}
		}
		if (withAll && "all".startsWith(prefix) && !prefix.isEmpty()) {
			out.add(new Completion(start, end, "@all" + suffix, "all", "everyone on shift", null, null));
		}
	}

	private static void taskCompletions(List<Completion> out, int start, int end, String prefix, ForemanState s, boolean onlyOpen) {
		for (Task t : s.tasks().values()) {
			if (t.status() == TaskStatus.CANCELLED || onlyOpen && (t.status() == TaskStatus.DONE || t.status() == TaskStatus.REVIEW)) {
				continue;
			}
			if (t.id().toLowerCase(Locale.ROOT).startsWith(prefix)) {
				out.add(new Completion(start, end, t.id() + " ", t.id(), oneLine(t.title(), 40), t.assignee(), null));
			}
		}
	}

	// ------------------------------------------------------------------ helpers

	/** Agent id for "kit", "Kit", "ju" (unique prefix of id or name); "all" when {@code allowAll}. */
	public static @Nullable String resolveAgent(String token, ForemanState s, boolean allowAll) {
		String t = token.toLowerCase(Locale.ROOT).replaceAll("[,:;.!?]+$", "");
		if (t.isEmpty()) {
			return null;
		}
		if (allowAll && (t.equals("all") || t.equals("everyone") || t.equals("team"))) {
			return "all";
		}
		for (Agent a : s.agents().values()) {
			if (a.id().equals(t) || a.name().toLowerCase(Locale.ROOT).equals(t)) {
				return a.id();
			}
		}
		String found = null;
		for (Agent a : s.agents().values()) {
			if (a.id().startsWith(t) || a.name().toLowerCase(Locale.ROOT).startsWith(t)) {
				if (found != null && !found.equals(a.id())) {
					return null;
				}
				found = a.id();
			}
		}
		return found;
	}

	public static String displayName(String agentId, ForemanState s) {
		if (agentId.equals("all")) {
			return "everyone";
		}
		Agent a = s.agent(agentId);
		return a != null ? a.name() : agentId;
	}

	public static String repoName(@Nullable String repoId, ForemanState s) {
		if (repoId == null) {
			return "";
		}
		Repo r = s.repo(repoId);
		return r != null ? r.name() : repoId;
	}

	private static String agentListSuffix(ForemanState s) {
		if (s.agents().isEmpty()) {
			return " (no agents yet)";
		}
		StringBuilder b = new StringBuilder(" (");
		int i = 0;
		for (Agent a : s.agents().values()) {
			if (i++ > 0) {
				b.append(", ");
			}
			b.append(a.name().toLowerCase(Locale.ROOT));
		}
		return b.append(')').toString();
	}

	private static String taskListSuffix(ForemanState s) {
		List<String> ids = new ArrayList<>();
		for (Task t : s.tasks().values()) {
			if (t.status() != TaskStatus.CANCELLED) {
				ids.add(t.id());
			}
		}
		return ids.isEmpty() ? "" : " (" + String.join(", ", ids.subList(0, Math.min(12, ids.size()))) + ")";
	}

	private static String worktreeListSuffix(ForemanState s) {
		List<String> ids = new ArrayList<>();
		for (Repo r : s.repos().values()) {
			for (Worktree w : r.worktrees()) {
				if (w.status() == WorktreeStatus.ACTIVE) {
					ids.add(w.id());
				}
			}
		}
		return ids.isEmpty() ? "" : " (" + String.join(", ", ids) + ")";
	}

	private static String ids(List<Decision> ds) {
		List<String> out = new ArrayList<>();
		for (Decision d : ds) {
			out.add(d.id());
		}
		return String.join(", ", out);
	}

	static String oneLine(String s, int max) {
		String o = s.replace('\n', ' ').strip();
		return o.length() <= max ? o : o.substring(0, max - 1).stripTrailing() + "…";
	}

	private static int indexOfSpace(String s) {
		for (int i = 0; i < s.length(); i++) {
			if (Character.isWhitespace(s.charAt(i))) {
				return i;
			}
		}
		return -1;
	}

	/** Whitespace-separated words (newlines count as whitespace). */
	static List<String> splitArgs(String s) {
		List<String> out = new ArrayList<>();
		for (String p : s.strip().split("\\s+")) {
			if (!p.isEmpty()) {
				out.add(p);
			}
		}
		return out;
	}

	/** For dev.console.parse: the intent as plain data. */
	public static Map<String, Object> toMap(Intent in) {
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("intent", in.getClass().getSimpleName().toLowerCase(Locale.ROOT));
		switch (in) {
			case Goal g -> {
				m.put("text", g.text());
				m.put("repoId", g.repoId());
				m.put("askRepo", !g.choices().isEmpty());
			}
			case Message msg -> {
				m.put("to", msg.to());
				m.put("text", msg.text());
			}
			case Answer a -> {
				m.put("decisionId", a.decision().id());
				m.put("option", a.option());
				m.put("text", a.text());
			}
			case RepoAdd r -> m.put("path", r.path());
			case AgentAction a -> {
				m.put("agents", a.agentIds());
				m.put("action", a.action());
				m.put("arg", a.arg());
			}
			case TaskAction t -> {
				m.put("taskId", t.taskId());
				m.put("action", t.action());
				m.put("arg", t.arg());
			}
			case ShowDiff d -> {
				m.put("repoId", d.repoId());
				m.put("worktree", d.worktree());
			}
			case Help h -> m.put("topic", h.topic());
			case Decide d -> m.put("decisionId", d.decisionId());
			case Sound so -> m.put("on", so.on());
			case Invalid i -> m.put("error", i.error());
			default -> {
			}
		}
		return m;
	}

	static boolean isAgentAction(String cmd) {
		return AGENT_ACTIONS.contains(cmd);
	}
}

package dev.agentcraft.client.permissions;

import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.Decision;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * A permission decision taken apart for display: which tool, the exact command or path, why the
 * Foreman asks (risk reason), the working directory, and what "Always allow for this team"
 * would cover. Reads both context formats in use:
 * <pre>
 * claude backend: "&lt;reason&gt;\ncwd: &lt;dir&gt;\n\"Always allow for this team\" covers: &lt;scope&gt;[\n&lt;title&gt;]"
 * sim backend:    "Bash: npm install chalk@5\ncwd: &lt;dir&gt;\nreason: &lt;reason&gt;"
 * </pre>
 * with the question "Kit wants to run Bash: npm test" / "Wren wants to run `npm install chalk@5` (...)".
 */
public record PermissionInfo(String tool, String command, @Nullable String reason, @Nullable String cwd, @Nullable String covers, Risk risk,
	List<String> extra) {

	/** Risk level, colour-coded with the status palette (low brass, medium clay, high red). */
	public enum Risk {
		LOW("thinking", "Low risk"), MEDIUM("waiting", "Medium risk"), HIGH("error", "High risk");

		public final String family;
		public final String label;

		Risk(String family, String label) {
			this.family = family;
			this.label = label;
		}
	}

	private static final Pattern BACKTICK = Pattern.compile("`([^`]+)`");
	private static final Pattern WANTS = Pattern.compile("wants to (?:run|use)\\s+(.*)$", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
	private static final Pattern TOOL_LINE = Pattern.compile("^([A-Z][A-Za-z]+):\\s+(.+)$");

	public static PermissionInfo of(Decision d) {
		String tool = d.tool() != null && !d.tool().isBlank() ? d.tool() : null;
		String command = null;
		String reason = null;
		String cwd = null;
		String covers = null;
		List<String> extra = new ArrayList<>();
		String coversPrefix = "\"" + Protocol.ALWAYS_ALLOW + "\" covers:";
		String ctx = d.context() == null ? "" : d.context();
		boolean first = true;
		for (String raw : ctx.split("\n")) {
			String line = raw.strip();
			if (line.isEmpty()) {
				continue;
			}
			String lower = line.toLowerCase(Locale.ROOT);
			if (lower.startsWith("cwd:")) {
				cwd = line.substring(4).strip();
			} else if (lower.startsWith("reason:")) {
				reason = line.substring(7).strip();
			} else if (line.startsWith(coversPrefix)) {
				covers = line.substring(coversPrefix.length()).strip();
			} else if (lower.contains("covers:") && lower.startsWith("\"always")) {
				covers = line.substring(line.indexOf(':', lower.indexOf("covers")) + 1).strip();
			} else {
				Matcher tm = TOOL_LINE.matcher(line);
				if (command == null && tm.matches() && (tool == null || tm.group(1).equalsIgnoreCase(tool))) {
					tool = tool == null ? tm.group(1) : tool;
					command = tm.group(2).strip();
				} else if (first && reason == null) {
					reason = line;
				} else {
					extra.add(line);
				}
			}
			first = false;
		}
		// the command from the question when the context has none
		String q = d.question();
		if (command == null) {
			Matcher bt = BACKTICK.matcher(q);
			if (bt.find()) {
				command = bt.group(1);
			} else {
				Matcher w = WANTS.matcher(q);
				if (w.find()) {
					command = w.group(1).strip();
				}
			}
			if (command != null) {
				Matcher tm = TOOL_LINE.matcher(command);
				if (tm.matches()) {
					tool = tool == null ? tm.group(1) : tool;
					command = tm.group(2).strip();
				}
			}
		}
		if (command == null) {
			command = q;
		}
		if (reason == null) {
			// "(network access, adds a dependency)" at the end of the question
			int p = q.lastIndexOf('(');
			if (p > 0 && q.endsWith(").")) {
				reason = q.substring(p + 1, q.length() - 2);
			} else if (p > 0 && q.endsWith(")")) {
				reason = q.substring(p + 1, q.length() - 1);
			}
		}
		if (tool == null) {
			tool = "Tool";
		}
		return new PermissionInfo(tool, command, reason, cwd, covers, classify(tool, command, reason), List.copyOf(extra));
	}

	/** Keyword risk classification over the tool, command and the Foreman's reason. */
	public static Risk classify(String tool, String command, @Nullable String reason) {
		String t = (tool + " " + command + " " + (reason == null ? "" : reason)).toLowerCase(Locale.ROOT);
		// destructive, irreversible or leaving the sandbox with writes
		String[] high = {"rm -rf", "rm -r ", "recursive delete", "delete", "removes", "remove-item", "discards work", "rewrites", "reset --hard",
			"git push", "publish", "--force", "credential", "secret", "password", "api key", ".git internals", "git internals", "sudo", "chmod",
			"runs a script outside", "repository outside", "writing files in", "changing everything under", "writes outside", "write outside",
			"a path outside the worktree", "drop table"};
		// network, new code from the internet, shared repo state
		String[] medium = {"network", "install", "download", "dependenc", "package.json", "curl", "wget", "http", "npx", "registry", "creates a branch",
			"creates a tag", "creates a repository", "shell script", "server", "port", "switches the worktree", "git checkout", "git switch"};
		String[] low = {"reads a path outside", "lists a path outside", "reading files in", "reading everything under", "changes directory"};
		boolean readOnly = false;
		for (String k : low) {
			readOnly |= t.contains(k);
		}
		for (String k : high) {
			if (t.contains(k) && !(readOnly && k.contains("outside"))) {
				return Risk.HIGH;
			}
		}
		if (readOnly) {
			return Risk.LOW;
		}
		for (String k : medium) {
			if (t.contains(k)) {
				return Risk.MEDIUM;
			}
		}
		// reading outside, changing directory, edits inside the worktree
		return Risk.LOW;
	}

	/** Kit icon for a tool name. */
	public static String iconFor(String tool) {
		String t = tool.toLowerCase(Locale.ROOT);
		if (t.contains("bash") || t.contains("shell") || t.contains("powershell")) {
			return "bash";
		}
		if (t.contains("edit") || t.contains("write") || t.contains("notebook")) {
			return "edit";
		}
		if (t.contains("read") || t.contains("grep") || t.contains("glob") || t.equals("ls")) {
			return "read";
		}
		if (t.contains("git")) {
			return "git";
		}
		if (t.contains("web") || t.contains("fetch")) {
			return "message";
		}
		return "bash";
	}
}

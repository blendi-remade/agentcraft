package dev.agentcraft.client.monitor;

import dev.agentcraft.client.foreman.Protocol.LogEntry;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.Tr;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import net.minecraft.client.gui.Font;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.resources.Identifier;
import net.minecraft.util.FormattedCharSequence;
import org.jspecify.annotations.Nullable;

/**
 * Turns {@code agent.log} entries into screen rows (assets-src/ui-style.md "Monitor text"): prose
 * wraps, tool lines get a kit icon + tool name + argument and never wrap, results/errors show their
 * first lines, diffs show the path and tinted +/- rows. Pure layout: no drawing, built on the client
 * thread and cached per screen until the log or the screen size changes.
 */
public final class LogRows {
	public static final int LINE = 10;
	public static final int TOOL_LINE = 13;
	public static final int ICON = 12;
	private static final int MAX_TEXT_LINES = 4;
	private static final int MAX_RESULT_LINES = 3;
	private static final int MAX_DIFF_LINES = 6;
	private static final Pattern TEST_CMD = Pattern.compile("\\b(npm|pnpm|yarn|bun)( run)? test\\b|\\bvitest\\b|\\bjest\\b|\\bpytest\\b|\\bcargo test\\b"
		+ "|\\bgo test\\b|\\bgradlew\\S* (test|check)\\b|\\bnode --test\\b");

	/**
	 * One screen row. {@code text} is drawn at {@code textX} with the row's base colour (style colours
	 * inside the sequence win; the alpha comes from the draw). {@code tint} != 0 fills the row
	 * background (diff rows). {@code icon} (12x12 kit sprite) is drawn at x 0.
	 */
	public record Row(int height, FormattedCharSequence text, int color, float textX, @Nullable Identifier icon, int tint) {
	}

	private LogRows() {
	}

	/** Rows for one entry, top to bottom. */
	public static List<Row> of(Font font, LogEntry e, int width, ScreenStyle st) {
		List<Row> out = new ArrayList<>(4);
		String text = e.text().replace("\r", "").replace("\t", "  ");
		switch (e.kind()) {
			case TOOL -> out.add(tool(font, text, width, st));
			case RESULT -> lines(font, out, text, width, st.result(), st, MAX_RESULT_LINES);
			case ERROR -> lines(font, out, text, width, st.error(), st, MAX_RESULT_LINES);
			case DIFF -> diff(font, out, text, width, st);
			default -> prose(font, out, plainProse(text), width, st.text());
		}
		return out;
	}

	private static void prose(Font font, List<Row> out, String text, int width, int color) {
		List<String> lines = TextUtil.wrapPlain(font, text.strip(), width);
		int n = Math.min(lines.size(), MAX_TEXT_LINES);
		for (int i = 0; i < n; i++) {
			String l = lines.get(i);
			if (i == n - 1 && lines.size() > n) {
				l = TextUtil.ellipsize(font, l + " " + TextUtil.ELLIPSIS, width);
			}
			out.add(plain(l, color));
		}
	}

	/** Result / error: the first lines as they are (lists, paths), a long single line wraps once. */
	private static void lines(Font font, List<Row> out, String text, int width, int color, ScreenStyle st, int max) {
		String[] ls = text.strip().split("\n");
		if (ls.length == 1) {
			List<String> w = TextUtil.wrapPlain(font, ls[0], width);
			for (int i = 0; i < Math.min(2, w.size()); i++) {
				String l = w.get(i);
				out.add(plain(i == 1 && w.size() > 2 ? TextUtil.ellipsize(font, l + " " + TextUtil.ELLIPSIS, width) : l, color));
			}
			return;
		}
		int shown = ls.length > max ? max - 1 : ls.length;
		for (int i = 0; i < shown; i++) {
			out.add(plain(TextUtil.ellipsize(font, ls[i], width), color));
		}
		if (ls.length > shown) {
			out.add(plain("+" + (ls.length - shown) + Tr.t(" more"), st.muted()));
		}
	}

	private static void diff(Font font, List<Row> out, String text, int width, ScreenStyle st) {
		String[] ls = text.split("\n");
		int i = 0;
		if (ls.length > 0 && !ls[0].startsWith("+") && !ls[0].startsWith("-") && !ls[0].startsWith("@@")) {
			out.add(plain(TextUtil.ellipsize(font, ls[0].strip(), width), st.path()));
			i = 1;
		}
		// strip the indentation the diff body shares (after the +/- sigil), so code fits narrow screens
		int indent = Integer.MAX_VALUE;
		for (int k = i; k < ls.length; k++) {
			String b = body(ls[k]);
			if (!b.isBlank() && !ls[k].startsWith("@@")) {
				indent = Math.min(indent, b.length() - b.stripLeading().length());
			}
		}
		if (indent == Integer.MAX_VALUE) {
			indent = 0;
		}
		// whitespace-only lines (an added blank line) say nothing in a small screen's tail: leave them out
		List<String> lines = new ArrayList<>(ls.length - i);
		for (; i < ls.length; i++) {
			if (ls[i].startsWith("@@") || !body(ls[i]).isBlank()) {
				lines.add(ls[i]);
			}
		}
		int rows = 0;
		int total = lines.size();
		for (String raw : lines) {
			if (rows == MAX_DIFF_LINES - 1 && total > MAX_DIFF_LINES) {
				out.add(plain("+" + (total - rows) + Tr.t(" more lines"), st.muted()));
				return;
			}
			String l = dedent(raw, indent);
			if (l.startsWith("@@")) {
				out.add(plain(TextUtil.ellipsize(font, l, width), st.hunk()));
			} else if (l.startsWith("+")) {
				out.add(new Row(LINE, seq(TextUtil.ellipsize(font, l, width - 2)), st.add(), 1, null, st.addBg()));
			} else if (l.startsWith("-")) {
				out.add(new Row(LINE, seq(TextUtil.ellipsize(font, l, width - 2)), st.del(), 1, null, st.delBg()));
			} else {
				out.add(plain(TextUtil.ellipsize(font, l, width), st.ctx()));
			}
			rows++;
		}
	}

	/** A diff line without its sigil column ("+ ", "- ", "  "). */
	private static String body(String l) {
		if (l.startsWith("+ ") || l.startsWith("- ") || l.startsWith("  ")) {
			return l.substring(2);
		}
		return l.length() > 0 && (l.charAt(0) == '+' || l.charAt(0) == '-' || l.charAt(0) == ' ') ? l.substring(1) : l;
	}

	private static String dedent(String l, int indent) {
		if (indent <= 0 || l.startsWith("@@")) {
			return l;
		}
		String sig = l.startsWith("+") ? "+ " : l.startsWith("-") ? "- " : "  ";
		String b = body(l);
		int cut = Math.min(indent, b.length() - b.stripLeading().length());
		return sig + b.substring(cut);
	}

	private static Row tool(Font font, String label, int width, ScreenStyle st) {
		String l = TextUtil.firstLine(label);
		String name;
		String arg;
		Identifier icon;
		if (l.startsWith("$")) {
			name = "$";
			arg = l.substring(1).strip();
			String cmd = arg.toLowerCase(Locale.ROOT);
			icon = TEST_CMD.matcher(cmd).find() ? Kit.icon("test") : cmd.startsWith("git ") ? Kit.icon("git") : Kit.icon("bash");
		} else {
			int sp = indexOfAny(l, ' ', ':');
			name = sp < 0 ? l : l.substring(0, sp);
			arg = sp < 0 ? "" : l.substring(sp + 1).strip();
			icon = Kit.icon(iconFor(name));
		}
		int avail = width - ICON - 3;
		// MCP tool names are long (request_merge, create_task): shorten the name before it eats the argument
		String shown = name.contains("_") && !arg.isEmpty() && font.width(name) > avail / 2 ? shortName(name) : name;
		if (font.width(shown) > avail) {
			shown = TextUtil.ellipsize(font, shown, avail);
		}
		MutableComponent c = Component.literal(shown).withColor(st.tool() & 0xFFFFFF);
		int nw = font.width(shown);
		if (!arg.isEmpty() && avail - nw > 12) {
			String a = TextUtil.ellipsize(font, arg, avail - nw - font.width(" "));
			c.append(Component.literal(" " + a).withColor(st.toolArg() & 0xFFFFFF));
		}
		return new Row(TOOL_LINE, c.getVisualOrderText(), st.tool(), ICON + 3, icon, 0);
	}

	/**
	 * A short label for a long snake_case tool name, used on narrow screens where the full name
	 * would leave no room for the argument (the icon already says what kind of tool it is):
	 * request_merge -> merge, create_task -> new task, write_memory -> write, ...
	 */
	static String shortName(String tool) {
		return switch (tool) {
			case "request_merge" -> "merge";
			case "create_task" -> "new task";
			case "update_task" -> "task";
			case "send_message" -> "message";
			case "read_memory" -> "read";
			case "write_memory" -> "write";
			case "report_status" -> "status";
			case "ask_user" -> "ask";
			default -> tool.replace('_', ' ');
		};
	}

	/** Prose as an agent writes it, without markdown markup the screen cannot show (`code`, **bold**, # headings). */
	static String plainProse(String s) {
		String t = s.replace("`", "").replace("**", "").replace("__", "");
		StringBuilder out = new StringBuilder(t.length());
		for (String line : t.split("\n", -1)) {
			String l = line;
			int h = 0;
			while (h < l.length() && l.charAt(h) == '#') {
				h++;
			}
			if (h > 0 && h < l.length() && l.charAt(h) == ' ') {
				l = l.substring(h + 1);
			}
			if (out.length() > 0) {
				out.append('\n');
			}
			out.append(l);
		}
		return out.toString();
	}

	/** Kit icon name for a tool (bash decision edit git memory merge message read test). */
	public static String iconFor(String tool) {
		return switch (tool) {
			case "Read", "NotebookRead", "Grep", "Glob", "LS", "WebFetch", "WebSearch" -> "read";
			case "Edit", "MultiEdit", "Write", "NotebookEdit" -> "edit";
			case "read_memory", "write_memory", "create_task", "update_task", "TodoWrite", "report_status" -> "memory";
			case "send_message" -> "message";
			case "ask_user" -> "decision";
			case "request_merge", "diff", "merge" -> "merge";
			case "git" -> "git";
			default -> "bash";
		};
	}

	private static int indexOfAny(String s, char a, char b) {
		for (int i = 0; i < s.length(); i++) {
			char ch = s.charAt(i);
			if (ch == a || ch == b) {
				return i;
			}
		}
		return -1;
	}

	static Row plain(String s, int color) {
		return new Row(LINE, seq(s), color, 0, null, 0);
	}

	static FormattedCharSequence seq(String s) {
		return Component.literal(s).getVisualOrderText();
	}
}

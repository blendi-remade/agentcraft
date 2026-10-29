package dev.agentcraft.client.diff;

import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.DiffFile;
import dev.agentcraft.client.foreman.Protocol.DiffHunk;
import dev.agentcraft.client.foreman.Protocol.DiffLine;
import dev.agentcraft.client.foreman.Protocol.DiffLineKind;
import dev.agentcraft.client.ui.Tr;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.minecraft.client.gui.Font;

/**
 * Layout of a structured diff as a column of rows (file headers, hunk headers, code lines, notes),
 * built for one text width and wrap mode and cached by the screen. Row y positions are in GUI
 * pixels from the top of the document. Long lines either wrap (hanging indent, breaking after
 * spaces/punctuation when possible) or stay on one row for horizontal scrolling.
 */
final class DiffDoc {
	static final int LINE_H = 10;
	static final int HUNK_H = 13;
	static final int FILE_H = 19;
	static final int GAP_H = 7;
	static final int NOTE_H = 16;
	static final int TOP_PAD = 3;
	static final int BOTTOM_PAD = 8;
	/** A pathological single line (minified file) is cut after this many wrapped rows. */
	static final int MAX_WRAP_ROWS = 40;

	enum Kind {
		FILE, HUNK, LINE, NOTE, GAP
	}

	static final class FileInfo {
		final int index;
		final DiffFile file;
		final String dir;
		final String base;
		final SyntaxTint.Lang lang;
		int headerRow;
		int top;
		int bottom;
		final List<Integer> hunkRows = new ArrayList<>();

		FileInfo(int index, DiffFile file) {
			this.index = index;
			this.file = file;
			String p = file.path() == null ? "" : file.path();
			int slash = p.lastIndexOf('/');
			this.dir = slash < 0 ? "" : p.substring(0, slash + 1);
			this.base = slash < 0 ? p : p.substring(slash + 1);
			this.lang = SyntaxTint.forPath(p);
		}

		String letter() {
			return switch (file.status()) {
				case ADDED -> "A";
				case DELETED -> "D";
				case RENAMED -> "R";
				default -> "M";
			};
		}
	}

	/** One source line: display text (tabs expanded) + its syntax spans. Shared by its wrapped rows. */
	static final class LineInfo {
		final DiffLine line;
		final String text;
		final int[] spans;

		LineInfo(DiffLine line, String text, int[] spans) {
			this.line = line;
			this.text = text;
			this.spans = spans;
		}
	}

	static final class Row {
		Kind kind;
		int file;
		LineInfo line;
		int start;
		int end;
		/** Wrapped continuation of the previous row's line (no line numbers). */
		boolean cont;
		/** Hanging indent of a continuation row in px. */
		int indent;
		/** HUNK: "@@ -a,b +c,d @@"; NOTE: the message. */
		String text = "";
		/** HUNK: the function context after the range. */
		String context = "";
		/** HUNK: unchanged base lines skipped before this hunk. */
		int hidden;
		int y;
		int h;
		/** Last row of its file card (draw the card's bottom edge). */
		boolean last;
	}

	private static final Pattern HUNK = Pattern.compile("^(@@ -\\d+(?:,\\d+)? \\+\\d+(?:,\\d+)? @@)(.*)$");

	final Protocol.Diff diff;
	final List<FileInfo> files = new ArrayList<>();
	final List<Row> rows = new ArrayList<>();
	int height;
	/** Widest line in px (no-wrap horizontal scroll range). */
	int maxTextWidth;
	/** Digits of the widest line number (gutter width). */
	int digits = 2;
	final int textWidth;
	final boolean wrap;
	private final List<LineInfo> lineCache = new ArrayList<>();

	private DiffDoc(Protocol.Diff diff, int textWidth, boolean wrap) {
		this.diff = diff;
		this.textWidth = textWidth;
		this.wrap = wrap;
	}

	/** Display form of a code line: tabs to 4 spaces, control characters dropped. */
	static String display(String s) {
		if (s == null || s.isEmpty()) {
			return "";
		}
		StringBuilder b = null;
		int col = 0;
		for (int i = 0; i < s.length(); i++) {
			char ch = s.charAt(i);
			if (ch == '\t' || ch < 0x20 || ch == 0x7F) {
				if (b == null) {
					b = new StringBuilder(s.length() + 8);
					b.append(s, 0, i);
				}
				if (ch == '\t') {
					int n = 4 - (col % 4);
					for (int k = 0; k < n; k++) {
						b.append(' ');
					}
					col += n;
				}
				continue;
			}
			if (b != null) {
				b.append(ch);
			}
			col++;
		}
		return b == null ? s : b.toString();
	}

	static DiffDoc build(Protocol.Diff diff, Font font, int textWidth, boolean wrap) {
		DiffDoc d = new DiffDoc(diff, Math.max(40, textWidth), wrap);
		d.layout(font);
		return d;
	}

	private void layout(Font font) {
		int y = TOP_PAD;
		int maxNo = 0;
		List<DiffFile> fs = diff.files();
		for (int i = 0; i < fs.size(); i++) {
			DiffFile f = fs.get(i);
			FileInfo fi = new FileInfo(i, f);
			files.add(fi);
			if (i > 0) {
				y = add(Kind.GAP, i, y, GAP_H);
			}
			fi.top = y;
			fi.headerRow = rows.size();
			y = add(Kind.FILE, i, y, FILE_H);
			if (f.binary()) {
				y = note(i, y, Tr.t("Binary file, not shown"));
			} else if (f.hunks().isEmpty()) {
				y = note(i, y, f.status() == Protocol.DiffFileStatus.RENAMED && f.oldPath() != null ? Tr.t("Renamed from ") + f.oldPath() + Tr.t(", no content changes")
					: Tr.t("No content changes"));
			}
			int prevEnd = 1;
			for (DiffHunk h : f.hunks()) {
				fi.hunkRows.add(rows.size());
				Row hr = row(Kind.HUNK, i, y, HUNK_H);
				// unchanged lines of the base between the previous hunk and this one (not in the diff)
				hr.hidden = f.status() == Protocol.DiffFileStatus.ADDED ? 0 : Math.max(0, h.oldStart() - prevEnd);
				prevEnd = h.oldStart() + h.oldLines();
				Matcher m = HUNK.matcher(h.header() == null ? "" : h.header());
				if (m.matches()) {
					hr.text = m.group(1);
					hr.context = m.group(2).trim();
				} else {
					hr.text = h.header();
				}
				y += HUNK_H;
				for (DiffLine l : h.lines()) {
					if (l.oldNo() != null) {
						maxNo = Math.max(maxNo, l.oldNo());
					}
					if (l.newNo() != null) {
						maxNo = Math.max(maxNo, l.newNo());
					}
					String text = display(l.text());
					LineInfo li = new LineInfo(l, text, SyntaxTint.spans(fi.lang, text));
					lineCache.add(li);
					y = addLine(font, i, li, y);
				}
			}
			if (!rows.isEmpty()) {
				rows.get(rows.size() - 1).last = true;
			}
			fi.bottom = y;
		}
		if (diff.truncated()) {
			y = add(Kind.GAP, -1, y, GAP_H);
			Row r = row(Kind.NOTE, -1, y, NOTE_H);
			r.text = Tr.t("The Foreman shortened this diff (very large files). Open the worktree for the rest.");
			y += NOTE_H;
		}
		height = y + BOTTOM_PAD;
		digits = Math.max(2, String.valueOf(maxNo).length());
	}

	private int add(Kind kind, int file, int y, int h) {
		row(kind, file, y, h);
		return y + h;
	}

	private int note(int file, int y, String text) {
		Row r = row(Kind.NOTE, file, y, NOTE_H);
		r.text = text;
		return y + NOTE_H;
	}

	private Row row(Kind kind, int file, int y, int h) {
		Row r = new Row();
		r.kind = kind;
		r.file = file;
		r.y = y;
		r.h = h;
		rows.add(r);
		return r;
	}

	private int addLine(Font font, int file, LineInfo li, int y) {
		String s = li.text;
		int full = font.width(s);
		maxTextWidth = Math.max(maxTextWidth, full);
		if (!wrap || full <= textWidth) {
			Row r = row(Kind.LINE, file, y, LINE_H);
			r.line = li;
			r.start = 0;
			r.end = s.length();
			return y + LINE_H;
		}
		int indentChars = 0;
		while (indentChars < s.length() && s.charAt(indentChars) == ' ') {
			indentChars++;
		}
		int indent = Math.min(font.width(s.substring(0, indentChars)) + 8, textWidth / 2);
		int pos = 0;
		int n = 0;
		boolean first = true;
		while (pos < s.length() && n < MAX_WRAP_ROWS) {
			int avail = first ? textWidth : textWidth - indent;
			String rest = s.substring(pos);
			int end;
			if (font.width(rest) <= avail) {
				end = s.length();
			} else {
				int fit = Math.max(1, font.plainSubstrByWidth(rest, avail).length());
				end = pos + fit;
				// prefer a break after a space or punctuation in the last 45 % of the row
				int min = pos + Math.max(1, (int) (fit * 0.55));
				for (int b = end; b > min; b--) {
					char ch = s.charAt(b - 1);
					if (ch == ' ' || ch == ',' || ch == ';' || ch == '(' || ch == '{' || ch == '[' || ch == '.' || ch == '&' || ch == '|') {
						end = b;
						break;
					}
				}
			}
			Row r = row(Kind.LINE, file, y, LINE_H);
			r.line = li;
			r.start = pos;
			r.end = end;
			r.cont = !first;
			r.indent = first ? 0 : indent;
			if (!first) {
				// continuation rows skip the spaces the break left at their start
				while (r.start < r.end && s.charAt(r.start) == ' ') {
					r.start++;
				}
			}
			y += LINE_H;
			pos = end;
			first = false;
			n++;
		}
		return y;
	}

	/** Index of the first row whose bottom is below {@code y}. */
	int rowAt(int y) {
		int lo = 0;
		int hi = rows.size() - 1;
		while (lo < hi) {
			int mid = (lo + hi) >>> 1;
			Row r = rows.get(mid);
			if (r.y + r.h <= y) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return Math.max(0, lo);
	}

	/** File whose card contains document y (the nearest earlier one in gaps), or -1. */
	int fileAt(int y) {
		int best = files.isEmpty() ? -1 : 0;
		for (FileInfo f : files) {
			if (f.top <= y) {
				best = f.index;
			}
		}
		return best;
	}

	static boolean isAdd(Row r) {
		return r.line != null && r.line.line.kind() == DiffLineKind.ADD;
	}

	static boolean isDel(Row r) {
		return r.line != null && r.line.line.kind() == DiffLineKind.DEL;
	}
}

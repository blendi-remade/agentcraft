package dev.agentcraft.client.taskwall;

import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.foreman.Protocol.CiStatus;
import dev.agentcraft.client.foreman.Protocol.Task;
import dev.agentcraft.client.foreman.Protocol.TaskStatus;
import dev.agentcraft.client.monitor.DisplayDraw;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.StatusMap;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import dev.agentcraft.client.ui.Tr;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.util.FormattedCharSequence;
import org.jspecify.annotations.Nullable;

/**
 * The kanban model of one Task Wall panel: four columns (Todo, Doing, Review, Done), blocked tasks
 * shown as red cards at the top of the column where they stalled (Doing when they have a worktree,
 * else Todo), cancelled tasks hidden. Laid out in board pixels and cached until the tasks or the
 * panel size change (agent changes only refresh the card contents); cards and columns then glide
 * to their new places ({@link #step}). One instance per panel origin, client thread only.
 *
 * <p>Layout, in order of what matters on a small wall seen from across a room:
 * <ul>
 *   <li><b>Column widths follow the content.</b> An empty column shrinks to a slim lane with its
 *       header; the rest share the width, and a column that overflows borrows width from one with
 *       slack (a small hill-climb over a card-score, see {@link #allocate}).</li>
 *   <li><b>Cards are sized to their title</b> (1 to 3 lines). When a column runs out of height the
 *       titles are capped at 2 lines, then the oldest/least urgent cards become one-line compact
 *       cards, and only then does the tail go behind "+N more". Wide columns put 2 cards per row
 *       when that shows more.</li>
 *   <li>A card keeps drawing its previous content while its size animates, until the new content
 *       fits (so a shrinking card never shows an empty body and a growing one never overflows).</li>
 * </ul>
 */
final class TaskBoard {
	static final int TRIM = 2; // texels of brass trim on the outer edges
	static final int PAD = 4;
	static final int GAP = 4;
	static final int HEADER_H = 13;
	static final int LINE = 10;
	static final int MAX_LINES = 3;
	/** Brief card: up to 2 title lines, no footer (the step between full and compact). */
	static final int BRIEF_H = 28;
	/** One-line card (title only) used when a column holds more cards than fit otherwise. */
	static final int COMPACT_H = 20;
	static final int CARD_MIN_W = 76;
	static final int CHIP_H = 11;
	/** Room kept free on a card's first title line for the status dot. */
	static final int DOT_ROOM = 9;
	/** Room for the assignee face on a compact card. */
	static final int FACE_ROOM = 11;
	/** Column width (px) under which the board switches to one list (small boards). */
	static final int LIST_BELOW = 72;
	/** Glide time constant (s): ~95 % of the way after 3 tau. */
	static final float TAU = 0.085f;

	/** Full card height for a title of {@code lines} lines: padding 5, the lines, 4, footer 9, padding 5. */
	static int fullH(int lines) {
		return 23 + lines * LINE;
	}

	/** Bottom padding under a full card's footer line (the footer sits {@code h - FOOT} from the top). */
	static final int FOOT = 14;

	/** How much of a card shows: everything, the title only (2 lines), or one line. */
	enum Size {
		FULL, BRIEF, COMPACT
	}

	enum Col {
		TODO(Tr.t("Todo"), "todo"), DOING(Tr.t("Doing"), "doing"), REVIEW(Tr.t("Review"), "review"), DONE(Tr.t("Done"), "done");

		final String label;
		final String card;

		Col(String label, String card) {
			this.label = label;
			this.card = card;
		}
	}

	/** One column: header, lane rectangle (target and animated), overflow chip. */
	static final class Column {
		final Col col;
		float x, w;   // target
		float ax, aw; // drawn (glides to the target)
		boolean placed;
		int count;
		int blocked;
		/** Open cards in this column that wait on the user (pulsing clay). */
		int needYou;
		FormattedCharSequence blockedSeq = FormattedCharSequence.EMPTY;
		float blockedW;
		int perRow = 1;
		FormattedCharSequence label = FormattedCharSequence.EMPTY;
		FormattedCharSequence countSeq = FormattedCharSequence.EMPTY;
		float countW;
		String family = "idle";
		@Nullable FormattedCharSequence chip;
		float chipY, chipW;
		final List<String> hidden = new ArrayList<>();

		Column(Col col) {
			this.col = col;
		}

		float countX() {
			return ax + aw - 4 - countW;
		}

		float chipX() {
			return ax + (aw - chipW) / 2f;
		}
	}

	/** What a card shows, laid out for one size. */
	static final class Content {
		float w, h;
		Size size = Size.FULL;
		final List<FormattedCharSequence> lines = new ArrayList<>(MAX_LINES);
		int titleColor;
		@Nullable Identifier face;
		@Nullable FormattedCharSequence name;
		int nameColor;
		@Nullable FormattedCharSequence hint;
		float hintW;
		int hintColor;
		/** A long hint (blocked reason) on a card without assignee reads from the left, like the title. */
		boolean hintLeft;
		@Nullable String dot;
		/** Blocked reason wrapped under the title (when it does not fit the footer), error colour. */
		final List<FormattedCharSequence> reason = new ArrayList<>(2);
		/** The card waits on the user: a pulsing clay ring around it. */
		boolean needsYou;

		boolean fits(float cw, float ch) {
			return w <= cw + 0.75f && h <= ch + 0.75f;
		}
	}

	/** A card: its slot (target), its animated rectangle and the content it draws. */
	static final class Card {
		final String id;
		Task task;
		Col col;
		Identifier sprite = Kit.card("todo");
		/** Drawn content; {@link #next} replaces it as soon as it fits the animated size. */
		@Nullable Content cur;
		@Nullable Content next;
		// slot (target) + how it was planned
		float tx, ty, tw, th;
		Size size = Size.FULL;
		int maxLines = 2;
		boolean visible;
		// animated
		float x, y, w, h;
		float scale = 1f;
		boolean placed;
		boolean removing;
		/** Set when the card changed column: it flies (lifted) to its slot, then glows there. */
		@Nullable Col arrivedFrom;
		long arrivedAt;
		boolean flying;
		final DisplayDraw.Rects glow = new DisplayDraw.Rects();
		final DisplayDraw.Rects shadow = new DisplayDraw.Rects();

		Card(String id, Task task) {
			this.id = id;
			this.task = task;
			this.col = colOf(task);
		}

		/**
		 * What to draw this frame: the new content as soon as it is no wider than the card, else the
		 * previous one (the renderer drops lines that do not fit the current height), so text never
		 * runs past the card's edge while its size animates.
		 */
		@Nullable Content drawable() {
			if (next != null && (cur == null || next.w <= w + 0.75f)) {
				return next;
			}
			return cur;
		}
	}

	/** Word widths of a title, for fast line counting while planning (no allocation per try). */
	static final class Title {
		final String text;
		final String[] words;
		final int[] ww;
		final int space;
		final int width;

		Title(Font font, String text) {
			this.text = text;
			this.words = text.isEmpty() ? new String[0] : text.split(" +");
			this.ww = new int[words.length];
			for (int i = 0; i < words.length; i++) {
				ww[i] = font.width(words[i]);
			}
			this.space = font.width(" ");
			this.width = font.width(text);
		}

		/** Lines this title needs (first line {@code w1} px, the others {@code w}), counted up to {@code max + 1}. */
		int lines(int w1, int w, int max) {
			if (words.length == 0) {
				return 1;
			}
			int lines = 1;
			int lineW = w1;
			int used = 0;
			for (int i = 0; i < words.length; i++) {
				int need = used == 0 ? ww[i] : used + space + ww[i];
				if (need <= lineW) {
					used = need;
					continue;
				}
				if (used == 0) {
					// a word longer than the line: it breaks by characters
					int rest = ww[i] - lineW;
					while (rest > 0) {
						lines++;
						if (lines > max) {
							return lines;
						}
						rest -= w;
					}
					used = rest + w;
					lineW = w;
					continue;
				}
				lines++;
				if (lines > max) {
					return lines;
				}
				lineW = w;
				used = 0;
				i--; // place the word on the new line
			}
			return lines;
		}

		/** The title wrapped like {@link #lines}, at most {@code max} lines, the last one ellipsized when text remains. */
		List<String> wrap(Font font, int w1, int w, int max) {
			List<String> out = new ArrayList<>(max);
			String[] ws = words.clone();
			StringBuilder line = new StringBuilder();
			int lineW = w1;
			int i = 0;
			while (i < ws.length && out.size() < max) {
				String cand = line.isEmpty() ? ws[i] : line + " " + ws[i];
				if (font.width(cand) <= lineW) {
					line.setLength(0);
					line.append(cand);
					i++;
				} else if (line.isEmpty()) {
					// a word longer than the line breaks by characters
					String part = font.plainSubstrByWidth(ws[i], lineW);
					if (part.isEmpty()) {
						part = ws[i].substring(0, 1);
					}
					out.add(part);
					ws[i] = ws[i].substring(part.length());
					if (ws[i].isEmpty()) {
						i++;
					}
					lineW = w;
				} else {
					out.add(line.toString());
					line.setLength(0);
					lineW = w;
				}
			}
			if (out.size() < max && !line.isEmpty()) {
				out.add(line.toString());
				line.setLength(0);
			}
			if ((i < ws.length || !line.isEmpty()) && !out.isEmpty()) {
				// text remains: the last line takes it, ellipsized
				StringBuilder rest = new StringBuilder(out.get(out.size() - 1));
				if (!line.isEmpty()) {
					rest.append(' ').append(line);
				}
				for (int k = i; k < ws.length; k++) {
					rest.append(' ').append(ws[k]);
				}
				out.set(out.size() - 1, TextUtil.ellipsize(font, rest.toString(), out.size() == 1 ? w1 : w));
			}
			if (out.isEmpty()) {
				out.add("");
			}
			return out;
		}
	}

	/**
	 * A column plan: cards per row, the first {@code fullRows} rows full (titles up to
	 * {@code maxLines}), the next {@code briefRows} brief, the rest compact; rows from
	 * {@code shownRows} on hide behind "+N more".
	 */
	private record Plan(int perRow, float cardW, int maxLines, int fullRows, int briefRows, int rows, int shownRows, float score) {
		Size size(int row) {
			return row < fullRows ? Size.FULL : row < fullRows + briefRows ? Size.BRIEF : Size.COMPACT;
		}
	}

	final BlockPos origin;
	long lastUsedNanos;
	int ppb;
	int panelW;
	int panelH;
	long taskSeq = Long.MIN_VALUE;
	long agentSeq = Long.MIN_VALUE;
	float pw, ph;             // panel px
	float ix0, iy0, ix1, iy1; // inside the trim
	float cardsTop;
	boolean listMode;         // one list instead of four columns (small boards)
	private final Column[] four = {new Column(Col.TODO), new Column(Col.DOING), new Column(Col.REVIEW), new Column(Col.DONE)};
	private final Column list = new Column(Col.TODO);
	final List<Column> columns = new ArrayList<>(4);
	final Map<String, Card> cards = new LinkedHashMap<>();
	private final Map<String, Title> titles = new HashMap<>();
	boolean everLaidOut;
	final DisplayDraw.Rects lanes = new DisplayDraw.Rects();
	final DisplayDraw.Rects shadows = new DisplayDraw.Rects();
	final DisplayDraw.Rects veil = new DisplayDraw.Rects();
	final DisplayDraw.Rects badge = new DisplayDraw.Rects();
	long lastStep;
	int total;
	/** Planner cost of the last full layout (dev stats). */
	long layoutNanos;

	TaskBoard(BlockPos origin) {
		this.origin = origin;
	}

	/**
	 * Pixel density: 64 px/block up to 3 blocks high (192 px of board), 72 on a 4-high wall (288 px:
	 * ~19 characters per title line, 5 cards per column), then about 320 px of height (64 on 5, 53
	 * on 6...), so the text grows with the wall. Chosen by a side-by-side test on a 7x4 wall from the
	 * HQ's camera distance (64 fills the board but drops names, 80 leaves too much empty walnut).
	 */
	static int density(int w, int h) {
		if (densityOverride > 0) {
			return densityOverride;
		}
		// 62 on the HQ's 7x4 wall: the columns fill the board with larger cards (72 left the bottom
		// half of every column empty; 54 squeezed Todo into one-line cards)
		return h <= 3 ? 64 : h == 4 ? 62 : Math.max(40, Math.round(320f / h));
	}

	/** Dev A/B: force a pixel density on every board (0 = the rule above); {@code dev.taskwall {ppb}}. */
	static int densityOverride;

	static Col colOf(Task t) {
		return switch (t.status()) {
			case DOING -> Col.DOING;
			case REVIEW -> Col.REVIEW;
			case DONE -> Col.DONE;
			case BLOCKED -> t.worktree() != null || t.branch() != null ? Col.DOING : Col.TODO;
			default -> Col.TODO;
		};
	}

	static boolean shown(Task t) {
		return t.status() != TaskStatus.CANCELLED && t.status() != TaskStatus.UNKNOWN;
	}

	/** Title text as shown on the wall (markdown backticks dropped). */
	static String titleText(Task t) {
		return t.title().replace("`", "").replace("**", "").strip();
	}

	/**
	 * Re-lay out when the tasks or the size changed, refresh card contents when only agents changed.
	 * Returns true when anything was rebuilt.
	 */
	boolean sync(@Nullable ForemanState s, int panelW, int panelH, long taskSeq, long agentSeq, long now) {
		int ppb = density(panelW, panelH);
		boolean resized = ppb != this.ppb || panelW != this.panelW || panelH != this.panelH;
		if (!resized && taskSeq == this.taskSeq && agentSeq == this.agentSeq && everLaidOut) {
			return false;
		}
		boolean tasksChanged = taskSeq != this.taskSeq;
		this.taskSeq = taskSeq;
		this.agentSeq = agentSeq;
		this.ppb = ppb;
		this.panelW = panelW;
		this.panelH = panelH;
		if (resized || tasksChanged || !everLaidOut) {
			long t0 = System.nanoTime();
			layout(s, resized || !everLaidOut);
			layoutNanos = System.nanoTime() - t0;
		} else {
			Font font = Minecraft.getInstance().font;
			for (Card c : cards.values()) {
				if (!c.removing && c.visible) {
					c.next = content(font, s, c);
				}
			}
		}
		everLaidOut = true;
		return true;
	}

	private void layout(@Nullable ForemanState s, boolean snap) {
		Font font = Minecraft.getInstance().font;
		pw = panelW * ppb;
		ph = panelH * ppb;
		float trim = ppb * TRIM / 16f;
		ix0 = trim + PAD;
		iy0 = trim + PAD - 1;
		ix1 = pw - trim - PAD;
		iy1 = ph - trim - PAD + 1;
		float equal = (ix1 - ix0 - GAP * 3) / 4f;
		boolean wasList = listMode;
		// too narrow for four readable columns (small boards): one list, most urgent first
		listMode = equal < LIST_BELOW;
		if (wasList != listMode) {
			snap = true;
		}
		cardsTop = iy0 + HEADER_H + 3;
		float avail = iy1 - cardsTop;

		// --- bucket the tasks
		Map<Col, List<Task>> by = new LinkedHashMap<>();
		for (Col c : Col.values()) {
			by.put(c, new ArrayList<>());
		}
		int total = 0;
		Set<String> titleIds = new HashSet<>();
		if (s != null) {
			for (Task t : s.tasks().values()) {
				if (shown(t)) {
					by.get(colOf(t)).add(t);
					total++;
					titleIds.add(t.id());
					String text = titleText(t);
					Title ti = titles.get(t.id());
					if (ti == null || !ti.text.equals(text)) {
						titles.put(t.id(), new Title(font, text));
					}
				}
			}
		}
		titles.keySet().retainAll(titleIds);
		Comparator<Task> blockedFirst = Comparator.comparing((Task t) -> t.status() != TaskStatus.BLOCKED);
		Comparator<Task> prio = Comparator.comparingInt(Task::priority).reversed().thenComparingLong(Task::createdAt);
		by.get(Col.TODO).sort(blockedFirst.thenComparing(prio));
		by.get(Col.DOING).sort(blockedFirst.thenComparing(prio));
		by.get(Col.REVIEW).sort(Comparator.comparingLong(Task::updatedAt));
		by.get(Col.DONE).sort(Comparator.comparingLong(Task::updatedAt).reversed());

		// --- lanes and their widths
		columns.clear();
		List<List<Task>> laneTasks = new ArrayList<>(4);
		if (listMode) {
			List<Task> ts = new ArrayList<>();
			for (Col k : List.of(Col.DOING, Col.REVIEW, Col.TODO, Col.DONE)) {
				ts.addAll(by.get(k));
			}
			ts.sort(Comparator.comparing((Task t) -> t.status() != TaskStatus.BLOCKED));
			columns.add(list);
			laneTasks.add(ts);
		} else {
			for (Column c : four) {
				columns.add(c);
				laneTasks.add(by.get(c.col));
			}
		}
		float[] widths = listMode ? new float[] {ix1 - ix0} : allocate(font, laneTasks, avail);

		// --- columns + slots
		Set<String> present = new HashSet<>();
		float x = ix0;
		for (int li = 0; li < columns.size(); li++) {
			Column col = columns.get(li);
			List<Task> ts = laneTasks.get(li);
			col.x = x;
			col.w = widths[li];
			x += widths[li] + GAP;
			if (snap || !col.placed) {
				col.ax = col.x;
				col.aw = col.w;
				col.placed = true;
			}
			col.count = ts.size();
			col.blocked = 0;
			col.needYou = 0;
			col.hidden.clear();
			col.chip = null;
			for (Task t : ts) {
				if (t.status() == TaskStatus.BLOCKED) {
					col.blocked++;
				}
				if (StatusMap.needsYou(s, t)) {
					col.needYou++;
				}
			}
			col.family = listMode ? "working" : switch (col.col) {
				case TODO -> "idle";
				case DOING -> "working";
				case REVIEW -> col.needYou > 0 ? "waiting" : "thinking";
				case DONE -> "done";
			};
			String label = listMode ? "TASKS" : col.col.label.toUpperCase(Locale.ROOT);
			String cs = Integer.toString(col.count);
			// an explicit "1 blocked" chip (not a red dot next to the count, which read as "4 blocked")
			String bl = col.blocked > 0 ? col.blocked + Tr.t(" blocked") : "";
			if (!bl.isEmpty() && font.width(label) + font.width(cs) + font.width(bl) + 24 > col.w) {
				bl = col.blocked + "!";
			}
			if (font.width(label) + font.width(cs) + (bl.isEmpty() ? 0 : font.width(bl) + 12) + 12 > col.w) {
				// tiny board: the count says it all
				label = cs + (listMode ? Tr.t(" tasks") : "");
				cs = "";
			}
			col.blockedSeq = seq(bl);
			col.blockedW = font.width(bl);
			col.label = seq(label);
			col.countSeq = seq(cs);
			col.countW = font.width(cs);

			Plan plan = best(ts, col.col, col.w, avail);
			col.perRow = plan.perRow();
			float[] rowY = new float[plan.shownRows() + 1];
			float[] rowH = new float[Math.max(1, plan.rows())];
			for (int r = 0; r < plan.rows(); r++) {
				rowH[r] = switch (plan.size(r)) {
					case FULL -> rowHeight(ts, r, plan.perRow(), plan.cardW(), plan.maxLines());
					case BRIEF -> BRIEF_H;
					case COMPACT -> COMPACT_H;
				};
			}
			rowY[0] = cardsTop;
			for (int r = 0; r < plan.shownRows(); r++) {
				rowY[r + 1] = rowY[r] + rowH[r] + GAP;
			}
			int show = Math.min(ts.size(), plan.shownRows() * plan.perRow());
			for (int i = 0; i < ts.size(); i++) {
				Task t = ts.get(i);
				present.add(t.id());
				Card card = cards.get(t.id());
				boolean isNew = card == null;
				if (isNew) {
					card = new Card(t.id(), t);
					cards.put(t.id(), card);
				}
				Col before = card.col;
				card.task = t;
				card.col = listMode ? colOf(t) : col.col;
				card.removing = false;
				card.sprite = Kit.card(t.status() == TaskStatus.BLOCKED ? "blocked" : card.col.card);
				int row = i / plan.perRow();
				card.size = plan.size(row);
				card.maxLines = plan.maxLines();
				card.tw = plan.cardW();
				card.th = row < plan.rows() ? rowH[row] : COMPACT_H;
				if (i < show) {
					int k = i % plan.perRow();
					card.tx = col.x + k * (plan.cardW() + GAP);
					card.ty = rowY[row];
					card.visible = true;
				} else {
					// hidden behind the "+N more" chip: park it there (it glides out of the chip when it gets a slot)
					card.tx = col.x;
					card.ty = rowY[plan.shownRows()];
					card.visible = false;
					col.hidden.add(t.id());
				}
				card.next = content(font, s, card);
				if (isNew || snap || !card.placed) {
					card.x = card.tx;
					card.y = card.ty;
					card.w = card.tw;
					card.h = card.th;
					card.placed = true;
					card.scale = isNew && !snap ? 0.6f : 1f;
					card.cur = card.next;
					card.next = null;
					card.arrivedFrom = null;
					card.arrivedAt = 0;
				} else if (before != card.col) {
					card.arrivedFrom = before;
					card.arrivedAt = 0;
				}
			}
			if (!col.hidden.isEmpty()) {
				String more = "+" + col.hidden.size() + Tr.t(" more");
				col.chip = seq(more);
				col.chipW = font.width(more) + 10;
				col.chipY = rowY[plan.shownRows()] - 1;
			}
		}
		for (Iterator<Card> it = cards.values().iterator(); it.hasNext(); ) {
			Card c = it.next();
			if (!present.contains(c.id)) {
				if (snap) {
					it.remove();
				} else {
					c.removing = true;
					c.flying = false;
				}
			}
		}
		this.total = total;
	}

	// ------------------------------------------------------------------ planning

	/** Width of a slim empty lane: the widest header label with a "0" count. */
	private static float emptyWidth(Font font) {
		int w = 0;
		for (Col c : Col.values()) {
			w = Math.max(w, font.width(c.label.toUpperCase(Locale.ROOT)));
		}
		return Math.max(48, w + font.width("0") + 14);
	}

	/**
	 * Column widths: empty columns get a slim lane, the others share the rest equally; then width
	 * moves from one column to another (4 to 32 px at a time, so a move that only pays off after a
	 * few px, like a title fitting on one line less, is still found) while that improves the board's
	 * card score ({@link #best}). Equal widths win every tie, so the columns stay put unless a move
	 * really shows more.
	 */
	private float[] allocate(Font font, List<List<Task>> lanes, float avail) {
		int n = lanes.size();
		float total = ix1 - ix0 - GAP * (n - 1);
		float[] w = new float[n];
		float emptyW = Math.min(emptyWidth(font), total / n);
		int filled = 0;
		for (List<Task> l : lanes) {
			if (!l.isEmpty()) {
				filled++;
			}
		}
		if (filled == 0) {
			java.util.Arrays.fill(w, total / n);
			return w;
		}
		float share = (total - emptyW * (n - filled)) / filled;
		for (int i = 0; i < n; i++) {
			w[i] = lanes.get(i).isEmpty() ? emptyW : share;
		}
		if (share < CARD_MIN_W) {
			return w;
		}
		Map<Long, Float> memo = new HashMap<>();
		final float[] steps = {4, 8, 12, 16, 24, 32};
		for (int iter = 0; iter < 24; iter++) {
			float bestGain = 0.12f; // about 8 px more title on five one-line cards
			int from = -1;
			int to = -1;
			float move = 0;
			for (int a = 0; a < n; a++) {
				if (lanes.get(a).isEmpty()) {
					continue;
				}
				for (float step : steps) {
					if (w[a] - step < CARD_MIN_W) {
						break;
					}
					float lose = score(memo, lanes, a, w[a], avail) - score(memo, lanes, a, w[a] - step, avail);
					for (int b = 0; b < n; b++) {
						if (b == a || lanes.get(b).isEmpty()) {
							continue;
						}
						// a hair of cost per px moved: of two equal gains, the smaller move wins
						float gain = score(memo, lanes, b, w[b] + step, avail) - score(memo, lanes, b, w[b], avail) - lose - step * 0.002f;
						if (gain > bestGain) {
							bestGain = gain;
							from = a;
							to = b;
							move = step;
						}
					}
				}
			}
			if (from < 0) {
				break;
			}
			w[from] -= move;
			w[to] += move;
		}
		return w;
	}

	private float score(Map<Long, Float> memo, List<List<Task>> lanes, int lane, float width, float avail) {
		long key = lane * 1_000_000L + Math.round(width * 10);
		Float v = memo.get(key);
		if (v == null) {
			v = best(lanes.get(lane), columns.get(lane).col, width, avail).score();
			memo.put(key, v);
		}
		return v;
	}

	/** The best plan for a column of {@code ts} at width {@code colW}: tries 1, 2, ... cards per row. */
	private Plan best(List<Task> ts, Col col, float colW, float avail) {
		Plan best = null;
		for (int p = 1; p <= 4; p++) {
			float cardW = (colW - GAP * (p - 1)) / p;
			if (p > 1 && (cardW < CARD_MIN_W || ts.size() <= p - 1)) {
				break;
			}
			Plan plan = plan(ts, col, cardW, p, avail);
			if (best == null || plan.score() > best.score() + 0.01f) {
				best = plan;
			}
		}
		return best;
	}

	/**
	 * The best mix for one card width: tries every split of the rows into full (titles up to 3, then
	 * 2 lines), brief and compact rows that fits the height, top rows getting the most room (they are
	 * the most urgent / newest); when even all-compact overflows, the tail hides behind "+N more".
	 * Score per card by how much of its title shows ({@link #shown}): full 3 x (0.6 + 0.4 shown),
	 * brief 2 x (0.6 + 0.4 shown), compact 1.2 x (0.3 + 0.7 shown), hidden -2; so a few px more on a
	 * column of one-liners counts, and the width allocator can find it.
	 */
	private Plan plan(List<Task> ts, Col col, float cardW, int perRow, float avail) {
		int n = ts.size();
		int rows = (n + perRow - 1) / perRow;
		// Done matters least: it gives way first when the board is full
		float weight = !listMode && col == Col.DONE ? 0.6f : 1f;
		if (n == 0) {
			return new Plan(perRow, cardW, 2, 0, 0, 0, 0, 0);
		}
		int[] w = titleWidths(cardW);
		float[] sBrief = new float[n + 1];
		float[] sCompact = new float[n + 1];
		for (int i = 0; i < n; i++) {
			Task t = ts.get(i);
			Title ti = titles.get(t.id());
			boolean face = compactFace(t, col);
			int bw1 = w[1] - (face ? FACE_ROOM : 0);
			sBrief[i + 1] = sBrief[i] + 2f * (0.6f + 0.4f * shown(ti, bw1, w[1], 2));
			sCompact[i + 1] = sCompact[i] + 1.2f * (0.3f + 0.7f * shown(ti, bw1, w[1], 1));
		}
		Plan best = null;
		for (int maxL = MAX_LINES; maxL >= 2; maxL--) {
			float[] hFull = new float[rows + 1];
			float[] sFull = new float[n + 1];
			for (int r = 0; r < rows; r++) {
				hFull[r + 1] = hFull[r] + rowHeight(ts, r, perRow, cardW, maxL);
			}
			for (int i = 0; i < n; i++) {
				Task t = ts.get(i);
				Title ti = titles.get(t.id());
				sFull[i + 1] = sFull[i] + 3f * (0.6f + 0.4f * shown(ti, t.assignee() != null ? w[0] : w[1], w[1], maxL));
			}
			for (int fr = rows; fr >= 0; fr--) {
				for (int br = rows - fr; br >= 0; br--) {
					int cr = rows - fr - br;
					float h = hFull[fr] + br * BRIEF_H + cr * COMPACT_H + GAP * (rows - 1);
					if (h > avail) {
						continue;
					}
					int nf = Math.min(n, fr * perRow);
					int nb = Math.min(n, (fr + br) * perRow);
					float sc = sFull[nf] + (sBrief[nb] - sBrief[nf]) + (sCompact[n] - sCompact[nb]);
					if (best == null || sc * weight > best.score() + 0.01f) {
						best = new Plan(perRow, cardW, maxL, fr, br, rows, rows, sc * weight);
					}
					break; // more brief rows score higher than more compact ones: the first fit is the best for this fr
				}
			}
			if (best != null && best.fullRows() == rows) {
				return best; // everything full at this many lines
			}
		}
		if (best != null) {
			return best;
		}
		// all compact; the tail goes behind "+N more"
		int shownRows = Math.max(0, (int) ((avail - CHIP_H) / (COMPACT_H + GAP)));
		int shown = Math.min(n, shownRows * perRow);
		float sc = sCompact[shown] - 2f * (n - shown);
		return new Plan(perRow, cardW, 2, 0, 0, rows, shownRows, weight * sc);
	}

	/** About how much of a title shows in {@code max} lines ({@code w1} px, then {@code w}): 1 when it all fits. */
	private static float shown(@Nullable Title ti, int w1, int w, int max) {
		if (ti == null || ti.width == 0 || ti.lines(w1, w, max) <= max) {
			return 1f;
		}
		// word wrap leaves ~10 % of each line empty
		return Math.min(1f, (w1 + w * (max - 1)) * 0.9f / ti.width);
	}

	private float rowHeight(List<Task> ts, int row, int perRow, float cardW, int maxL) {
		int lines = 1;
		int[] w = titleWidths(cardW);
		for (int i = row * perRow; i < Math.min(ts.size(), (row + 1) * perRow); i++) {
			Task t = ts.get(i);
			Title ti = titles.get(t.id());
			int l = ti == null ? 1 : ti.lines(t.assignee() != null ? w[0] : w[1], w[1], maxL);
			lines = Math.max(lines, Math.min(maxL, l) + reasonLines(t, w[1]).size());
		}
		return fullH(lines);
	}

	/**
	 * A blocked card's reason when it is too long for the footer: wrapped to at most 2 lines under
	 * the title (the footer then shows who and the id), so "needs the user's npm token" is never cut.
	 */
	static List<String> reasonLines(Task t, int inner) {
		if (t.status() != TaskStatus.BLOCKED || t.blockedReason() == null) {
			return List.of();
		}
		String reason = t.blockedReason().replace("`", "").strip();
		Font font = Minecraft.getInstance().font;
		int foot = inner - (t.assignee() != null ? 10 + font.width(t.assignee()) + 4 : 0);
		if (reason.isEmpty() || font.width(reason) <= foot) {
			return List.of();
		}
		List<String> out = TextUtil.wrapPlain(font, reason, inner);
		if (out.size() > 2) {
			out = List.of(out.get(0), TextUtil.ellipsize(font, out.get(1) + " " + String.join(" ", out.subList(2, out.size())), inner));
		}
		return out;
	}

	/** Title line widths for a card: {first line (status dot room), other lines}. */
	private static int[] titleWidths(float cardW) {
		Kit.Padding p = Kit.padding("card_todo");
		int inner = (int) (cardW - p.left() - p.right());
		return new int[] {inner - DOT_ROOM, inner};
	}

	/** Compact cards keep the face only where who is on it matters (in progress, in review, blocked). */
	private static boolean compactFace(Task t, Col col) {
		return t.assignee() != null && !t.assignee().isBlank()
			&& (col == Col.DOING || col == Col.REVIEW || t.status() == TaskStatus.BLOCKED);
	}

	// ------------------------------------------------------------------ content

	/** Card text + badges from the task and its assignee, for the card's planned slot. */
	private Content content(Font font, @Nullable ForemanState s, Card c) {
		Task t = c.task;
		Content o = new Content();
		o.w = c.tw;
		o.h = c.th;
		o.size = c.size;
		boolean blocked = t.status() == TaskStatus.BLOCKED;
		boolean done = t.status() == TaskStatus.DONE;
		int ink = UiStyle.color("paper.text", 0xFF1F1E1D);
		int muted = UiStyle.color("paper.muted", 0xFF655E55);
		int error = UiStyle.color("paper.del_fg", 0xFF873C2A);
		o.titleColor = done ? muted : ink;
		Kit.Padding p = Kit.padding("card_todo");
		int inner = (int) (c.tw - p.left() - p.right());
		Title ti = titles.get(t.id());
		if (ti == null) {
			ti = new Title(font, titleText(t));
		}
		String assignee = t.assignee() == null || t.assignee().isBlank() ? null : t.assignee();
		Agent a = s == null || assignee == null ? null : s.agent(assignee);
		if (c.size != Size.FULL) {
			// brief (2 lines) or compact (1 line): the title, and the face where who matters
			boolean face = compactFace(t, c.col);
			int w1 = inner - (face ? FACE_ROOM : 0);
			String text = ti.text.isEmpty() ? t.id() : ti.text;
			if (c.size == Size.COMPACT) {
				o.lines.add(seq(TextUtil.ellipsize(font, text, w1)));
			} else {
				for (String l : ti.text.isEmpty() ? List.of(t.id()) : ti.wrap(font, w1, inner, 2)) {
					o.lines.add(seq(l));
				}
			}
			o.face = face ? portrait(assignee) : null;
			return o;
		}
		List<String> reason = reasonLines(t, inner);
		int lines = Math.max(1, Math.min(c.maxLines, Math.round((c.th - fullH(0)) / (float) LINE) - reason.size()));
		int w1 = assignee != null ? inner - DOT_ROOM : inner;
		for (String l : ti.text.isEmpty() ? List.of(t.id()) : ti.wrap(font, w1, inner, lines)) {
			o.lines.add(seq(l));
		}
		for (String l : reason) {
			o.reason.add(seq(l));
		}
		o.needsYou = StatusMap.needsYou(s, t);
		// assignee: face + name, and their live state dot top-right while they work on this very card
		float footerLeft = 0;
		String nameText = null;
		if (assignee != null) {
			nameText = a != null ? a.name() : assignee;
			o.face = portrait(assignee);
			o.nameColor = UiStyle.agentOnLight(assignee);
			if (!done && a != null && a.isActive() && t.id().equals(a.taskId())) {
				o.dot = a.state().family();
			}
		}
		if (o.needsYou) {
			o.dot = "waiting"; // one mapping everywhere (StatusMap): waits on you = clay, pulsing
		} else if (t.status() == TaskStatus.REVIEW) {
			o.dot = StatusMap.task(s, t);
		}
		// footer hint (right): the most useful single fact
		String hint;
		int hintColor = muted;
		List<String> pending = new ArrayList<>();
		if (s != null) {
			for (String d : t.deps()) {
				Task dt = s.task(d);
				if (dt == null || dt.status() != TaskStatus.DONE) {
					pending.add(d);
				}
			}
		}
		String yours = StatusMap.needsYouLabel(s, t);
		if (blocked && !reason.isEmpty()) {
			hint = t.id(); // the reason has its own lines above the footer
		} else if (blocked) {
			String why = t.blockedReason() == null ? "" : t.blockedReason().replace("`", "").strip();
			hint = why.isEmpty() ? "blocked" : why;
			hintColor = error;
		} else if (yours != null) {
			hint = yours;
			hintColor = UiStyle.CLAY_DARK;
		} else if (t.ci() == CiStatus.FAIL && !done) {
			hint = Tr.t("CI failing");
			hintColor = error;
		} else if (!pending.isEmpty() && !done) {
			hint = Tr.t("after ") + String.join(", ", pending);
		} else if (t.ci() == CiStatus.RUNNING) {
			hint = Tr.t("CI running");
		} else if (t.priority() > 0 && c.col == Col.TODO) {
			hint = "P" + t.priority() + "  " + t.id();
		} else {
			hint = t.id();
		}
		// the hint beats the name (the face already says who): name + hint, else face + hint, else a shorter hint
		int faceW = assignee != null ? 10 : 0;
		if (nameText != null && font.width(nameText) + 4 + font.width(hint) + faceW <= inner) {
			o.name = seq(nameText);
			footerLeft = faceW + font.width(nameText) + 4;
		} else {
			footerLeft = faceW;
			if (nameText != null && font.width(hint) + faceW > inner && !blocked && hintColor != error) {
				// a long neutral hint (deps list): keep the name, shorten the hint
				o.name = seq(TextUtil.ellipsize(font, nameText, inner - faceW));
				footerLeft = faceW + font.width(nameText) + 4;
			}
		}
		int room = (int) (inner - footerLeft);
		if (font.width(hint) > room) {
			hint = blocked || hintColor == error || hint.startsWith("after") ? TextUtil.ellipsize(font, hint, room)
				: font.width(t.id()) <= room ? t.id() : "";
		}
		o.hint = hint.isEmpty() ? null : seq(hint);
		o.hintW = font.width(hint);
		o.hintColor = hintColor;
		o.hintLeft = assignee == null && hintColor == error;
		return o;
	}

	private static Identifier portrait(@Nullable String agentId) {
		return AgentCraft.id("textures/gui/portrait/" + agentId + ".png");
	}

	// ------------------------------------------------------------------ animation

	/** Advance the glide/pop animations (call once per frame). */
	void step(long now) {
		float dt = lastStep == 0 ? 0 : Math.min(0.1f, (now - lastStep) / 1e9f);
		lastStep = now;
		float k = dt <= 0 ? 0 : (float) (1 - Math.exp(-dt / TAU));
		for (Column col : columns) {
			col.ax = approach(col.ax, col.x, k);
			col.aw = approach(col.aw, col.w, k);
		}
		for (Iterator<Card> it = cards.values().iterator(); it.hasNext(); ) {
			Card c = it.next();
			if (c.removing) {
				c.scale -= dt * 5f;
				if (c.scale <= 0.05f) {
					it.remove();
				}
				continue;
			}
			c.w = approach(c.w, c.tw, k);
			c.h = approach(c.h, c.th, k);
			float dx = c.tx - c.x;
			float dy = c.ty - c.y;
			if (Math.abs(dx) < 0.3f && Math.abs(dy) < 0.3f) {
				c.x = c.tx;
				c.y = c.ty;
				if (c.arrivedFrom != null && c.arrivedAt == 0) {
					c.arrivedAt = now; // landed: the arrival glow starts
				}
				c.flying = false;
			} else {
				c.x += dx * k;
				c.y += dy * k;
				// only a status change flies (lifted, with a shadow); a reflow just glides
				boolean far = Math.abs(dx) > 2 || Math.abs(dy) > 2;
				c.flying = c.arrivedFrom != null && c.arrivedAt == 0 && far;
				if (!far && c.arrivedFrom != null && c.arrivedAt == 0) {
					c.arrivedAt = now; // as good as landed: the glow starts with the last couple of px
				}
			}
			if (c.next != null && (c.cur == null || c.next.fits(c.w, c.h) || (c.w == c.tw && c.h == c.th))) {
				c.cur = c.next;
				c.next = null;
			}
			if (c.scale < 1f) {
				c.scale = Math.min(1f, c.scale + dt * 3.5f);
			}
		}
	}

	private static float approach(float v, float target, float k) {
		float d = target - v;
		return Math.abs(d) < 0.3f ? target : v + d * k;
	}

	/** The card under board pixel (px, py), topmost first; or null. */
	@Nullable Card cardAt(float px, float py) {
		Card best = null;
		for (Card c : cards.values()) {
			if (!c.visible || c.removing) {
				continue;
			}
			if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) {
				if (best == null || c.flying) {
					best = c;
				}
			}
		}
		return best;
	}

	/** The column under board pixel x, or null. */
	@Nullable Column columnAt(float px) {
		for (Column c : columns) {
			if (px >= c.ax - GAP / 2f && px <= c.ax + c.aw + GAP / 2f) {
				return c;
			}
		}
		return null;
	}

	static FormattedCharSequence seq(String s) {
		return Component.literal(s).getVisualOrderText();
	}
}

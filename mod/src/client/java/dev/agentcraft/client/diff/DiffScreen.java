package dev.agentcraft.client.diff;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.agentcraft.client.diff.DiffDoc.FileInfo;
import dev.agentcraft.client.diff.DiffDoc.Row;
import dev.agentcraft.client.diff.ReviewKit.ButtonKind;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.foreman.Protocol.DiffLineKind;
import dev.agentcraft.client.foreman.Protocol.Repo;
import dev.agentcraft.client.foreman.Protocol.Task;
import dev.agentcraft.client.foreman.Protocol.Worktree;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

/**
 * Diff / merge review. Shows the structured diff of a worktree (from {@code diff.request}) as file
 * cards on paper: a file list with A/M/D badges and +/- counts, a unified diff with both line
 * numbers, hunk headers (with the unchanged lines they skip), tinted add/del rows, a syntax-ish
 * tint, smooth scrolling and keyboard navigation. Opened from a merge decision it answers it:
 * {@code Merge} (click, then "Confirm merge"; Ctrl+Enter merges at once), {@code Request changes}
 * (with feedback text), {@code Reject} (after a confirm). "Copy path" puts the selected file's
 * absolute path in the worktree on the clipboard (open it in your editor; Shift+c: the worktree).
 * Text is ink with a syntax tint on the add/del row tints (more readable than coloured text; the
 * ui-style colour-text variant is still one key away: t).
 *
 * <pre>
 * keys: j k / arrows scroll · space PgDn PgUp · g G Home End · n p Tab file · ] [ hunk · w wrap
 *       h l / Shift+wheel side-scroll (no wrap) · c copy path · r request changes · x reject
 *       Ctrl+Enter merge · F5 / u refresh · t text colours · Esc close
 * </pre>
 */
public final class DiffScreen extends Screen {
	/** What to review: a merge decision (preferred) or a bare repo + worktree. */
	public record Target(@Nullable String decisionId, @Nullable String repoId, @Nullable String worktree) {
		public boolean isEmpty() {
			return repoId == null || worktree == null;
		}
	}

	private enum Load {
		NONE, LOADING, READY, ERROR
	}

	private enum Mode {
		BROWSE, FEEDBACK, CONFIRM_MERGE, CONFIRM_REJECT, SENDING, DONE
	}

	private record Btn(String id, int x, int y, int w, int h, boolean enabled, String tip) {
		boolean hit(double mx, double my) {
			return mx >= x && mx < x + w && my >= y && my < y + h;
		}
	}

	private static final int SIDE_ROW_H = 22;
	/** Gutter edge to code text: status bar, sigil, a space. */
	private static final int TEXT_PAD = 15;
	private static final long DONE_CLOSE_MS = 1400;

	private final Target target;
	private Load load = Load.NONE;
	private Protocol.@Nullable Diff diff;
	private @Nullable String error;
	private long requestedAt;
	private int requestSerial;
	private boolean retryOnLink;
	private @Nullable DiffDoc doc;

	// view
	private boolean wrap = true;
	private boolean syntax = true;
	private float scroll;
	private float scrollTarget;
	private float hscroll;
	private float hscrollTarget;
	private int focusFile;
	private boolean spy = true;
	private float sideScroll;
	private long lastNanos;
	private boolean dragThumb;
	private double dragOffset;

	// actions
	private Mode mode = Mode.BROWSE;
	private @Nullable String sentOption;
	private long doneAt;
	private @Nullable String flash;
	private long flashUntil;
	private boolean flashError;
	private long rejectArmedAt;
	private @Nullable EditBox feedback;
	private boolean swallowChar;
	private final List<Btn> buttons = new ArrayList<>();
	private @Nullable String pressed;

	// layout (GUI px)
	private int px;
	private int py;
	private int pw;
	private int ph;
	private int ix;
	private int iy;
	private int iw;
	private int ih;
	private int bodyY;
	private int bodyH;
	private int sideX;
	private int sideW;
	private int codeX;
	private int codeW;
	private int viewX;
	private int viewY;
	private int viewW;
	private int viewH;
	private int barY;

	public DiffScreen(Target target) {
		super(Component.literal("Diff review"));
		this.target = target;
	}

	/** QA only: show a ready-made diff (no Foreman request). */
	static DiffScreen preview(Protocol.Diff diff) {
		DiffScreen s = new DiffScreen(new Target(null, diff.repoId(), diff.worktree()));
		s.diff = diff;
		s.load = Load.READY;
		s.requestSerial = -1;
		return s;
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	// ------------------------------------------------------------------ model

	public Target target() {
		return target;
	}

	private ForemanState st() {
		return Foreman.state();
	}

	private @Nullable Decision decision() {
		return target.decisionId() == null || st() == null ? null : st().decision(target.decisionId());
	}

	private boolean decisionOpen() {
		Decision d = decision();
		return d != null && d.isOpen() && d.kind() == Protocol.DecisionKind.MERGE;
	}

	private @Nullable Repo repo() {
		return target.repoId() == null || st() == null ? null : st().repo(target.repoId());
	}

	private @Nullable Worktree worktreeInfo() {
		Repo r = repo();
		if (r == null || target.worktree() == null) {
			return null;
		}
		for (Worktree w : r.worktrees()) {
			if (target.worktree().equals(w.id())) {
				return w;
			}
		}
		for (Worktree w : r.worktrees()) {
			if (target.worktree().equals(w.agentId()) && w.status() == Protocol.WorktreeStatus.ACTIVE) {
				return w;
			}
		}
		return null;
	}

	private @Nullable Task task() {
		Decision d = decision();
		String id = d != null && d.taskId() != null ? d.taskId() : null;
		if (id == null) {
			Worktree w = worktreeInfo();
			id = w == null ? null : w.taskId();
		}
		return id == null || st() == null ? null : st().task(id);
	}

	/** The agent whose work this is (worktree owner / task assignee), not the lead who asks. */
	private @Nullable String worker() {
		Worktree w = worktreeInfo();
		if (w != null) {
			return w.agentId();
		}
		Task t = task();
		if (t != null && t.assignee() != null) {
			return t.assignee();
		}
		Decision d = decision();
		return d == null ? null : d.agentId();
	}

	private boolean offline() {
		return st() == null || st().isStale();
	}

	private void request() {
		if (target.isEmpty()) {
			load = Load.NONE;
			return;
		}
		if (!Foreman.connected()) {
			load = Load.ERROR;
			error = "The Foreman is not connected (retrying when it is back).";
			retryOnLink = true;
			return;
		}
		retryOnLink = false;
		load = Load.LOADING;
		requestedAt = System.currentTimeMillis();
		int serial = ++requestSerial;
		Foreman.requestDiff(target.repoId(), target.worktree()).whenComplete((d, e) -> {
			if (serial != requestSerial) {
				return;
			}
			if (e != null) {
				load = Load.ERROR;
				error = e.getMessage() == null ? e.toString() : e.getMessage();
				// the link dropped while waiting: fetch again once it is back
				retryOnLink = !Foreman.connected();
			} else if (d.error() != null && d.files().isEmpty()) {
				load = Load.ERROR;
				error = d.error();
			} else {
				boolean first = diff == null;
				diff = d;
				doc = null;
				load = Load.READY;
				if (first) {
					scroll = scrollTarget = 0;
					focusFile = 0;
				}
			}
		});
	}

	/** The Foreman's worktree stats differ from the loaded diff: the agent changed something since. */
	private boolean outdated() {
		Worktree w = worktreeInfo();
		if (w == null || diff == null || load != Load.READY) {
			return false;
		}
		Protocol.DiffStats s = diff.stats();
		return w.status() == Protocol.WorktreeStatus.ACTIVE && (w.files() != s.files() || w.additions() != s.additions() || w.deletions() != s
			.deletions());
	}

	private void ensureDoc() {
		if (diff == null) {
			return;
		}
		int tw = textWidthFor();
		if (doc == null || doc.textWidth != tw || doc.wrap != wrap) {
			int keepFile = focusFile;
			boolean rebuilt = doc != null;
			doc = DiffDoc.build(diff, font, tw, wrap);
			if (rebuilt && keepFile < doc.files.size()) {
				// keep the reader on the same file across a re-wrap
				scroll = scrollTarget = Math.min(maxScroll(), doc.files.get(keepFile).top);
			}
			focusFile = Math.min(focusFile, Math.max(0, doc.files.size() - 1));
		}
	}

	private int gutterW() {
		int digits = doc == null ? 3 : doc.digits;
		return 2 * (digits * 6 + 5);
	}

	private int textX0() {
		return viewX + 2 + 1 + gutterW() + TEXT_PAD;
	}

	private int textWidthFor() {
		int digits = diff == null ? 3 : estimateDigits();
		int gw = 2 * (digits * 6 + 5);
		return viewW - 4 - 2 - gw - TEXT_PAD - 4;
	}

	private int estimateDigits() {
		int max = 0;
		for (Protocol.DiffFile f : diff.files()) {
			for (Protocol.DiffHunk h : f.hunks()) {
				max = Math.max(max, Math.max(h.oldStart() + h.oldLines(), h.newStart() + h.newLines()));
			}
		}
		return Math.max(2, String.valueOf(max).length());
	}

	private int maxScroll() {
		return doc == null ? 0 : Math.max(0, doc.height - viewH);
	}

	private int maxHScroll() {
		return doc == null || wrap ? 0 : Math.max(0, doc.maxTextWidth - (viewX + viewW - 6 - textX0()));
	}

	// ------------------------------------------------------------------ layout

	@Override
	protected void init() {
		int margin = width >= 900 ? 16 : width >= 560 ? 10 : 6;
		pw = Math.min(width - 2 * margin, 1100);
		ph = Math.min(height - 2 * Math.max(6, margin - 2), 640);
		px = (width - pw) / 2;
		py = (height - ph) / 2;
		ix = px + 8;
		iy = py + 8;
		iw = pw - 16;
		ih = ph - 17;
		barY = iy + ih - 20;
		sideW = Math.max(104, Math.min(210, Math.round(iw * 0.24f)));
		sideX = ix;
		codeX = sideX + sideW + 6;
		codeW = ix + iw - codeX;
		relayoutBody();
		if (requestSerial == 0) {
			request();
		}
		if (mode == Mode.FEEDBACK) {
			openFeedback(feedback == null ? "" : feedback.getValue(), false);
		}
	}

	private void relayoutBody() {
		bodyY = iy + 44 + (refusedReason() != null ? 13 : 0);
		bodyH = barY - 6 - bodyY;
		viewX = codeX + 2;
		viewY = bodyY + 2;
		viewW = codeW - 4 - 8;
		viewH = bodyH - 4;
	}

	private @Nullable String refusedReason() {
		Decision d = decision();
		if (d == null || d.context() == null) {
			return null;
		}
		int i = d.context().lastIndexOf("Merge refused:");
		return i < 0 ? null : TextUtil.firstLine(d.context().substring(i));
	}

	// ------------------------------------------------------------------ frame

	private void animate() {
		long now = System.nanoTime();
		float dt = lastNanos == 0 ? 0.016f : Math.min(0.1f, (now - lastNanos) / 1e9f);
		lastNanos = now;
		float k = 1 - (float) Math.exp(-dt * 16);
		scrollTarget = Math.max(0, Math.min(scrollTarget, maxScroll()));
		hscrollTarget = Math.max(0, Math.min(hscrollTarget, maxHScroll()));
		scroll += (scrollTarget - scroll) * k;
		if (Math.abs(scrollTarget - scroll) < 0.25f) {
			scroll = scrollTarget;
		}
		hscroll += (hscrollTarget - hscroll) * k;
		if (Math.abs(hscrollTarget - hscroll) < 0.25f) {
			hscroll = hscrollTarget;
		}
		if (doc != null && spy) {
			int f = Math.max(0, doc.fileAt(Math.round(scroll) + 2));
			if (f != focusFile) {
				focusFile = f;
				ensureSideVisible(f);
			}
		}
		if (mode == Mode.DONE && System.currentTimeMillis() - doneAt > DONE_CLOSE_MS) {
			onClose();
		}
		if ((mode == Mode.CONFIRM_REJECT || mode == Mode.CONFIRM_MERGE) && System.currentTimeMillis() - rejectArmedAt > 6000) {
			mode = Mode.BROWSE;
		}
	}

	/** Snap a scroll offset to whole physical pixels so text stays crisp while it glides. */
	private float snap(float v) {
		int s = Math.max(1, minecraft.getWindow().getGuiScale());
		return Math.round(v * s) / (float) s;
	}

	@Override
	public void extractBackground(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		if (ReviewKit.blurBehind) {
			extractBlurredBackground(g);
		}
		g.fill(0, 0, width, height, UiStyle.withAlpha(UiStyle.WALNUT, 0x7A));
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float a) {
		if (bodyY != iy + 44 + (refusedReason() != null ? 13 : 0)) {
			relayoutBody();
		}
		if (retryOnLink && Foreman.connected()) {
			request();
		}
		ensureDoc();
		animate();
		buttons.clear();
		if (decisionOpen()) {
			Panels.framed(g, px, py, pw, ph);
		} else {
			Panels.panel(g, px, py, pw, ph);
		}
		drawHeader(g, mx, my);
		drawSidebar(g, mx, my);
		drawCode(g, mx, my);
		drawActionBar(g, mx, my);
		super.extractRenderState(g, mx, my, a);
		for (Btn b : buttons) {
			if (b.hit(mx, my) && !b.tip().isEmpty()) {
				tooltip(g, b.tip(), mx, my);
			}
		}
	}

	private void tooltip(GuiGraphicsExtractor g, String text, int mx, int my) {
		int w = font.width(text) + 10;
		int x = Math.min(width - w - 2, mx + 6);
		int y = Math.max(2, my - 20);
		Panels.sprite(g, Kit.TOOLTIP, x, y, w, 16);
		g.text(font, text, x + 5, y + 5, UiStyle.color("palette.ui.panel"), false);
	}

	// ------------------------------------------------------------------ header

	private void drawHeader(GuiGraphicsExtractor g, int mx, int my) {
		Decision d = decision();
		Task t = task();
		Worktree w = worktreeInfo();
		int ink = ReviewKit.ink();
		int muted = ReviewKit.muted();
		// title strip
		Panels.sprite(g, Kit.HEADER, ix, iy, iw, 14);
		Panels.sprite(g, Kit.icon(d != null ? "merge" : "git"), ix + 4, iy + 1, 12, 12);
		String kind = d != null ? "Merge review" : "Worktree diff";
		int tx = ix + 20;
		ReviewKit.bold(g, font, kind, tx, iy + 3, ink);
		tx += ReviewKit.boldWidth(font, kind) + 6;
		// right side: decision state
		int rx = ix + iw - 5;
		String stateText;
		String fam;
		if (d == null) {
			stateText = target.worktree() == null ? "" : target.worktree();
			fam = null;
		} else if (d.isOpen()) {
			stateText = "Waiting for you";
			fam = "waiting";
		} else if (d.status() == Protocol.DecisionStatus.CANCELLED) {
			stateText = "Cancelled";
			fam = "idle";
		} else {
			String opt = d.answer() != null && d.answer().option() != null ? d.answer().option() : "Answered";
			stateText = opt + (d.answer() != null ? " · " + ReviewKit.ago(d.answer().ts()) : "");
			fam = answerFamily(opt);
		}
		// "1 of 2" when more decisions wait (the raw id "d3" meant nothing to a reader)
		String idText = "";
		ForemanState fsIdx = Foreman.state();
		if (d != null && d.isOpen() && fsIdx != null) {
			List<Protocol.Decision> open = fsIdx.openDecisions();
			int at = open.indexOf(d);
			if (open.size() > 1 && at >= 0) {
				idText = (at + 1) + " of " + open.size();
			}
		}
		if (!idText.isEmpty()) {
			rx -= font.width(idText);
			g.text(font, idText, rx, iy + 3, muted, false);
			rx -= 8;
		}
		if (!stateText.isEmpty()) {
			rx -= font.width(stateText);
			g.text(font, stateText, rx, iy + 3, fam != null && fam.equals("waiting") ? UiStyle.color("paper.link") : muted, false);
			if (fam != null) {
				rx -= 10;
				boolean pulse = "waiting".equals(fam);
				if (pulse) {
					float ph = (float) ((System.currentTimeMillis() % 1200) / 1200.0 * Math.PI * 2);
					int alpha = (int) (55 + 55 * Math.sin(ph));
					Panels.sprite(g, Kit.dot(fam, true), rx - 2, iy + 1, 11, 11, UiStyle.withAlpha(0xFFFFFFFF, alpha + 60));
				}
				Panels.dot(g, fam, rx, iy + 3, false);
			}
			rx -= 6;
		}
		String title = t != null ? t.id() + "  " + ReviewKit.plain(t.title()) : w != null ? w.branch() : target.worktree() == null ? "" : target.worktree();
		g.text(font, TextUtil.ellipsize(font, title, rx - tx - 4), tx, iy + 3, ink, false);

		// meta row: who, branch -> base, asked by, CI, stats
		int my0 = iy + 18;
		String who = worker();
		if (d != null && d.isOpen()) {
			// the asking agent waits on you: a breathing clay ring around its portrait
			int clay = UiStyle.withAlpha(UiStyle.CLAY, (int) (90 + 165 * dev.agentcraft.client.ui.StatusMap.pulse(System.nanoTime())));
			g.fill(ix - 2, my0 - 2, ix + 22, my0 + 22, clay);
		}
		ReviewKit.framedFace(g, font, who, ix, my0);
		int x = ix + 25;
		// right block
		Protocol.CiStatus ci = t != null ? t.ci() : repo() != null ? repo().ci() : Protocol.CiStatus.UNKNOWN;
		String ciText = ReviewKit.ciLabel(ci);
		int ciW = 10 + font.width(ciText);
		int right = ix + iw - 2;
		Panels.dot(g, ReviewKit.ciFamily(ci), right - ciW, my0 + 1, false);
		g.text(font, ciText, right - ciW + 10, my0 + 1, ReviewKit.ciInk(ci), false);
		String stat = statText();
		int statW = statWidth(stat);
		drawStat(g, right - statW, my0 + 11);
		int rightMin = right - Math.max(ciW, statW) - 10;
		// line 1
		String name = who == null ? "Unknown" : ReviewKit.agentName(who);
		ReviewKit.bold(g, font, name, x, my0 + 1, ReviewKit.agentInk(who));
		x += ReviewKit.boldWidth(font, name) + 4;
		String branch = w != null ? w.branch() : diff != null && diff.branch() != null ? diff.branch() : null;
		String base = w != null ? w.base() : diff != null && diff.base() != null ? diff.base() : repo() != null ? repo().branch() : null;
		if (branch != null) {
			String verb = d == null ? "" : d.isOpen() ? "wants to merge" : "asked to merge";
			String into = d == null ? "→" : "into";
			boolean verbFits = !verb.isEmpty() && x + font.width(verb) + 60 < rightMin;
			if (verbFits) {
				g.text(font, verb, x, my0 + 1, muted, false);
				x += font.width(verb) + 4;
			}
			int baseW = base == null ? 0 : ReviewKit.pillWidth(font, base) + font.width(into) + 8;
			int avail = rightMin - x - baseW - 4;
			String b = ReviewKit.ellipsizeLeft(font, branch, Math.max(30, avail - 8));
			x += ReviewKit.pill(g, font, b, x, my0, UiStyle.color("paper.path")) + 4;
			if (base != null && x + baseW <= rightMin + 4) {
				g.text(font, into, x, my0 + 1, muted, false);
				x += font.width(into) + 4;
				ReviewKit.pill(g, font, base, x, my0, UiStyle.color("paper.path"));
			}
		}
		// line 2
		StringBuilder sub = new StringBuilder();
		if (d != null) {
			sub.append("asked by ").append(ReviewKit.agentName(d.agentId())).append(" · ").append(ReviewKit.ago(d.createdAt()));
		} else if (w != null) {
			sub.append(w.ahead()).append(w.ahead() == 1 ? " commit" : " commits").append(" ahead · ").append(w.status().wire());
		}
		if (target.worktree() != null && d == null) {
			sub.append(sub.isEmpty() ? "" : " · ").append(target.worktree());
		}
		g.text(font, TextUtil.ellipsize(font, sub.toString(), rightMin - (ix + 25)), ix + 25, my0 + 12, muted, false);
		if (outdated()) {
			String u = "Updated  F5";
			int uw = ReviewKit.pillWidth(font, u);
			int ux = rightMin - uw - 2;
			if (ux > ix + 25 + font.width(sub.toString()) + 6) {
				ReviewKit.pill(g, font, u, ux, my0 + 10, UiStyle.color("paper.link"));
				buttons.add(new Btn("refresh", ux, my0 + 10, uw, 11, true, "The agent changed the worktree: reload the diff"));
			}
		}
		String refused = refusedReason();
		if (refused != null) {
			int ry = iy + 42;
			g.fill(ix, ry, ix + iw, ry + 11, UiStyle.color("paper.del_bg"));
			g.text(font, TextUtil.ellipsize(font, refused, iw - 8), ix + 4, ry + 2, UiStyle.color("paper.del_fg"), false);
		}
	}

	private String statText() {
		if (diff != null) {
			Protocol.DiffStats s = diff.stats();
			return s.files() + (s.files() == 1 ? " file" : " files");
		}
		Worktree w = worktreeInfo();
		return w == null ? "" : w.files() + (w.files() == 1 ? " file" : " files");
	}

	private int[] statNumbers() {
		if (diff != null) {
			return new int[] {diff.stats().additions(), diff.stats().deletions()};
		}
		Worktree w = worktreeInfo();
		return w == null ? null : new int[] {w.additions(), w.deletions()};
	}

	private int statWidth(String files) {
		int[] n = statNumbers();
		if (n == null) {
			return font.width(files);
		}
		return font.width("+" + n[0]) + 4 + font.width("-" + n[1]) + 6 + font.width(files);
	}

	private void drawStat(GuiGraphicsExtractor g, int x, int y) {
		int[] n = statNumbers();
		String files = statText();
		if (n != null) {
			String a = "+" + n[0];
			String r = "-" + n[1];
			g.text(font, a, x, y, UiStyle.color("paper.add_fg"), false);
			x += font.width(a) + 4;
			g.text(font, r, x, y, UiStyle.color("paper.del_fg"), false);
			x += font.width(r) + 6;
		}
		g.text(font, files, x, y, ReviewKit.muted(), false);
	}

	// ------------------------------------------------------------------ sidebar

	private int sideListY() {
		return bodyY + 13;
	}

	private int sideListH() {
		int n = doc == null ? 0 : doc.files.size();
		int full = n * SIDE_ROW_H;
		int max = bodyY + bodyH - sideListY();
		List<Note> notes = notes();
		if (!notes.isEmpty()) {
			max -= Math.min(90, 16 + notes.size() * 36);
		}
		return Math.max(SIDE_ROW_H * Math.min(n, 2), Math.min(full, max));
	}

	private void drawSidebar(GuiGraphicsExtractor g, int mx, int my) {
		int muted = ReviewKit.muted();
		int n = doc == null ? 0 : doc.files.size();
		g.text(font, "FILES", sideX + 2, bodyY + 2, muted, false);
		if (n > 0) {
			g.text(font, String.valueOf(n), sideX + 4 + font.width("FILES") + 4, bodyY + 2, ReviewKit.ink(), false);
		}
		int ly = sideListY();
		int lh = sideListH();
		int content = n * SIDE_ROW_H;
		sideScroll = Math.max(0, Math.min(sideScroll, Math.max(0, content - lh)));
		if (doc != null) {
			g.enableScissor(sideX, ly, sideX + sideW, ly + lh);
			for (FileInfo f : doc.files) {
				int y = ly + f.index * SIDE_ROW_H - Math.round(sideScroll);
				if (y + SIDE_ROW_H < ly || y > ly + lh) {
					continue;
				}
				boolean sel = f.index == focusFile;
				boolean hov = mx >= sideX && mx < sideX + sideW && my >= y && my < y + SIDE_ROW_H && my >= ly && my < ly + lh;
				if (sel) {
					g.fill(sideX, y, sideX + sideW, y + SIDE_ROW_H - 1, UiStyle.color("palette.ui.panel_hi"));
					g.fill(sideX, y, sideX + 2, y + SIDE_ROW_H - 1, UiStyle.CLAY);
				} else if (hov) {
					g.fill(sideX, y, sideX + sideW, y + SIDE_ROW_H - 1, UiStyle.color("palette.ui.panel_shade"));
				}
				int bx = sideX + 5;
				int bw = badge(g, f, bx, y + 2);
				int nameX = bx + bw + 4;
				int cx;
				if (f.file.binary() || f.file.additions() + f.file.deletions() == 0) {
					String tag = f.file.binary() ? "binary" : f.file.status() == Protocol.DiffFileStatus.RENAMED ? "moved" : "";
					cx = sideX + sideW - 4 - font.width(tag);
					g.text(font, tag, cx, y + 3, muted, false);
				} else {
					String a = "+" + f.file.additions();
					String r = "-" + f.file.deletions();
					int cw = font.width(a) + 3 + font.width(r);
					cx = sideX + sideW - 4 - cw;
					g.text(font, a, cx, y + 3, UiStyle.color("paper.add_fg"), false);
					g.text(font, r, cx + font.width(a) + 3, y + 3, UiStyle.color("paper.del_fg"), false);
				}
				g.text(font, TextUtil.ellipsize(font, f.base, cx - nameX - 3), nameX, y + 3, ReviewKit.ink(), false);
				int dx = nameX;
				String dir = f.dir.isEmpty() ? "(repo root)" : f.dir;
				if (f.file.status() == Protocol.DiffFileStatus.RENAMED && f.file.oldPath() != null) {
					// "was <old path>" (the old path ellipsized from the left, the label kept)
					g.text(font, "was", dx, y + 12, UiStyle.color("paper.hunk"), false);
					dx += font.width("was") + 4;
					dir = f.file.oldPath();
				}
				g.text(font, ReviewKit.ellipsizeLeft(font, dir, sideX + sideW - 4 - dx), dx, y + 12, muted, false);
				g.fill(sideX + 4, y + SIDE_ROW_H - 1, sideX + sideW - 4, y + SIDE_ROW_H, UiStyle.color("palette.ui.panel_shade"));
			}
			g.disableScissor();
			if (content > lh) {
				scrollbar(g, sideX + sideW - 4, ly, lh, content, lh, sideScroll, false, 4);
			}
		} else if (load == Load.LOADING) {
			g.text(font, "loading" + TextUtil.ELLIPSIS, sideX + 4, ly + 4, muted, false);
		}
		// review notes: the decision context (worker summary, reviewer notes) as little note cards
		List<Note> notes = notes();
		if (!notes.isEmpty()) {
			int ny = ly + lh + 8;
			int bottom = bodyY + bodyH;
			if (ny + 26 < bottom) {
				Panels.divider(g, sideX, ny - 5, sideW);
				g.text(font, "NOTES", sideX + 2, ny, muted, false);
				ny += 12;
				for (Note note : notes) {
					List<String> lines = TextUtil.wrapPlain(font, ReviewKit.plain(note.text()), sideW - 11);
					int room = (bottom - ny - 18) / 10;
					if (room < 1) {
						break;
					}
					boolean cut = lines.size() > room;
					if (cut) {
						lines = new ArrayList<>(lines.subList(0, room));
						lines.set(room - 1, TextUtil.ellipsize(font, lines.get(room - 1) + TextUtil.ELLIPSIS, sideW - 11));
					}
					int ch = 16 + lines.size() * 10 + 2;
					g.fill(sideX, ny, sideX + sideW, ny + ch, UiStyle.color("palette.ui.panel_hi"));
					ReviewKit.outline(g, sideX, ny, sideW, ch, UiStyle.color("palette.ui.panel_edge"));
					int hx = sideX + 5;
					if (note.author() != null) {
						ReviewKit.face(g, font, note.author(), hx, ny + 4, 8);
						hx += 11;
						String name = ReviewKit.agentName(note.author());
						g.text(font, name, hx, ny + 5, ReviewKit.agentInk(note.author()), false);
						hx += font.width(name) + 4;
					}
					g.text(font, TextUtil.ellipsize(font, note.label(), sideX + sideW - 4 - hx), hx, ny + 5, muted, false);
					int ty = ny + 16;
					for (String line : lines) {
						g.text(font, line, sideX + 5, ty, note.dim() ? muted : ReviewKit.ink(), false);
						ty += 10;
					}
					ny += ch + 4;
					if (cut) {
						break;
					}
				}
			}
		}
	}

	private record Note(@Nullable String author, String label, String text, boolean dim) {
	}

	/** The decision context minus the stats line (shown in the header) and the refusal (banner). */
	private List<Note> notes() {
		List<Note> out = new ArrayList<>();
		Decision d = decision();
		String ctx = d != null ? d.context() : null;
		String worker = worker();
		if (ctx == null || ctx.isBlank()) {
			Task t = task();
			if (t != null && t.summary() != null && !t.summary().isBlank()) {
				out.add(new Note(worker, "summary", t.summary().trim(), false));
			}
			return out;
		}
		for (String line : ctx.split("\n")) {
			String l = line.trim();
			if (l.isEmpty() || l.startsWith("Merge refused:") || l.matches("^\\d+ files?, \\+\\d+ -\\d+.*")) {
				continue;
			}
			java.util.regex.Matcher m = REVIEWED.matcher(l);
			if (m.matches()) {
				out.add(new Note(agentByName(m.group(1)), "reviewed", m.group(2).trim(), false));
			} else if (l.startsWith("(cancelled")) {
				out.add(new Note(null, "cancelled", l, true));
			} else {
				out.add(new Note(worker, out.isEmpty() ? "summary" : "note", l, false));
			}
		}
		return out;
	}

	private static final java.util.regex.Pattern REVIEWED = java.util.regex.Pattern.compile("^Reviewed by ([A-Za-z0-9_-]+):\\s*(.*)$");

	private static @Nullable String agentByName(String name) {
		ForemanState s = Foreman.state();
		if (s != null) {
			for (Protocol.Agent a : s.agents().values()) {
				if (a.name().equalsIgnoreCase(name) || a.id().equalsIgnoreCase(name)) {
					return a.id();
				}
			}
		}
		return name.toLowerCase(Locale.ROOT);
	}

	/** File status badge (A M D R); returns its width. */
	private int badge(GuiGraphicsExtractor g, FileInfo f, int x, int y) {
		int bg;
		int fg;
		switch (f.file.status()) {
			case ADDED -> {
				bg = UiStyle.color("paper.add_bg");
				fg = UiStyle.color("paper.add_fg");
			}
			case DELETED -> {
				bg = UiStyle.color("paper.del_bg");
				fg = UiStyle.color("paper.del_fg");
			}
			case RENAMED -> {
				bg = ReviewKit.mix(UiStyle.color("palette.ui.panel"), UiStyle.color("paper.hunk"), 0.16f);
				fg = UiStyle.color("paper.hunk");
			}
			default -> {
				bg = ReviewKit.mix(UiStyle.color("palette.ui.panel"), UiStyle.BRASS, 0.28f);
				fg = UiStyle.color("paper.path");
			}
		}
		String l = f.letter();
		g.fill(x, y, x + 9, y + 11, bg);
		g.text(font, l, x + (10 - font.width(l)) / 2, y + 2, fg, false);
		return 9;
	}

	// ------------------------------------------------------------------ code pane

	private void drawCode(GuiGraphicsExtractor g, int mx, int my) {
		Panels.inset(g, codeX, bodyY, codeW, bodyH);
		int muted = ReviewKit.muted();
		if (load != Load.READY || doc == null) {
			int cy = bodyY + bodyH / 2 - 10;
			int ccx = codeX + codeW / 2;
			String msg;
			String sub = null;
			int color = muted;
			if (load == Load.LOADING) {
				double p = ((System.currentTimeMillis() - requestedAt) % 1400) / 1400.0;
				Panels.sprite(g, Kit.progressRing(p), ccx - 16, cy - 30, 32, 32);
				msg = "Fetching the diff of " + target.worktree() + TextUtil.ELLIPSIS;
			} else if (load == Load.ERROR) {
				msg = "Could not load the diff";
				sub = (error == null ? "" : error) + "   F5 retry";
				color = UiStyle.color("paper.del_fg");
			} else {
				msg = "Nothing to review";
				sub = "No open merge decisions and no active worktrees.";
			}
			g.text(font, msg, ccx - font.width(msg) / 2, cy, color, false);
			if (sub != null) {
				String s = TextUtil.ellipsize(font, sub, codeW - 16);
				g.text(font, s, ccx - font.width(s) / 2, cy + 12, muted, false);
			}
			return;
		}
		if (doc.files.isEmpty()) {
			String msg = "No changes in this worktree yet";
			g.text(font, msg, codeX + (codeW - font.width(msg)) / 2, bodyY + bodyH / 2 - 4, muted, false);
			return;
		}
		float sy = snap(scroll);
		int base = (int) Math.floor(sy);
		float frac = sy - base;
		float sx = snap(hscroll);
		g.enableScissor(viewX, viewY, viewX + viewW, viewY + viewH);
		g.pose().pushMatrix();
		g.pose().translate(0, -frac);
		int first = doc.rowAt(base);
		for (int i = first; i < doc.rows.size(); i++) {
			Row r = doc.rows.get(i);
			int y = viewY + r.y - base;
			if (y > viewY + viewH + 1) {
				break;
			}
			drawRow(g, r, y, sx);
		}
		g.pose().popMatrix();
		// sticky file header
		int fi = doc.fileAt(base + 1);
		if (fi >= 0) {
			FileInfo f = doc.files.get(fi);
			if (f.top < sy && f.bottom > sy + DiffDoc.FILE_H / 2f) {
				float stickY = 0;
				if (fi + 1 < doc.files.size()) {
					float next = doc.files.get(fi + 1).top - DiffDoc.GAP_H - sy;
					stickY = Math.min(0, next - DiffDoc.FILE_H);
				}
				stickY = Math.min(stickY, f.bottom - sy - DiffDoc.FILE_H);
				g.pose().pushMatrix();
				g.pose().translate(0, snap(stickY) - (float) Math.floor(snap(stickY)));
				int yy = viewY + (int) Math.floor(snap(stickY));
				drawFileHeader(g, f, yy, true);
				g.pose().popMatrix();
			}
		}
		g.disableScissor();
		boolean hov = mx >= codeX + codeW - 9 && mx < codeX + codeW && my >= viewY && my < viewY + viewH;
		scrollbar(g, codeX + codeW - 8, viewY, viewH, doc.height, viewH, scroll, hov || dragThumb, 6);
		if (!wrap && maxHScroll() > 0) {
			// thin horizontal position bar under the text column
			int tx = textX0();
			int tw = viewX + viewW - tx - 2;
			int total = doc.maxTextWidth;
			int bw = Math.max(16, tw * tw / Math.max(1, total));
			int bx = tx + Math.round((tw - bw) * (hscroll / Math.max(1, maxHScroll())));
			g.fill(tx, viewY + viewH - 2, tx + tw, viewY + viewH, UiStyle.color("palette.ui.panel_shade"));
			g.fill(bx, viewY + viewH - 2, bx + bw, viewY + viewH, UiStyle.color("palette.ui.thumb"));
		}
	}

	private int cardX0() {
		return viewX + 2;
	}

	private int cardX1() {
		return viewX + viewW - 2;
	}

	private void drawRow(GuiGraphicsExtractor g, Row r, int y, float sx) {
		int x0 = cardX0();
		int x1 = cardX1();
		int edge = UiStyle.color("palette.ui.panel_edge");
		int cream = UiStyle.color("palette.ui.panel");
		switch (r.kind) {
			case GAP -> {
				return;
			}
			case FILE -> {
				drawFileHeader(g, doc.files.get(r.file), y, false);
				return;
			}
			case HUNK -> {
				g.fill(x0 + 1, y, x1 - 1, y + r.h, UiStyle.color("palette.ui.inset"));
				g.fill(x0 + 1, y, x1 - 1, y + 1, ReviewKit.mix(UiStyle.color("palette.ui.inset"), edge, 0.6f));
				int tx = x0 + 6;
				g.text(font, r.text, tx, y + 3, UiStyle.color("paper.hunk"), false);
				int right = x1 - 6;
				if (r.hidden > 0) {
					String skip = r.hidden + (r.hidden == 1 ? " unchanged line" : " unchanged lines");
					int sw = font.width(skip);
					if (right - sw > tx + font.width(r.text) + 40) {
						g.text(font, skip, right - sw, y + 3, ReviewKit.mix(ReviewKit.muted(), UiStyle.color("palette.ui.inset"), 0.25f), false);
						right -= sw + 8;
					}
				}
				if (!r.context.isEmpty()) {
					int cx = tx + font.width(r.text) + 6;
					g.text(font, TextUtil.ellipsize(font, r.context, right - cx), cx, y + 3, ReviewKit.muted(), false);
				}
			}
			case NOTE -> {
				if (r.file >= 0) {
					g.fill(x0 + 1, y, x1 - 1, y + r.h, cream);
				}
				String s = TextUtil.ellipsize(font, r.text, x1 - x0 - 12);
				g.text(font, s, x0 + (x1 - x0 - font.width(s)) / 2, y + 4, ReviewKit.muted(), false);
				if (r.file < 0) {
					return;
				}
			}
			case LINE -> drawLine(g, r, y, sx);
			default -> {
			}
		}
		// card side borders (and bottom edge on the file's last row)
		g.fill(x0, y, x0 + 1, y + r.h, edge);
		g.fill(x1 - 1, y, x1, y + r.h, edge);
		if (r.last) {
			g.fill(x0, y + r.h - 1, x1, y + r.h, edge);
		}
	}

	private void drawFileHeader(GuiGraphicsExtractor g, FileInfo f, int y, boolean sticky) {
		int x0 = cardX0();
		int x1 = cardX1();
		int edge = UiStyle.color("palette.ui.panel_edge");
		int h = DiffDoc.FILE_H;
		g.fill(x0, y, x1, y + h, UiStyle.color("palette.ui.panel_shade"));
		g.fill(x0, y, x1, y + 1, edge);
		g.fill(x0, y + h - 1, x1, y + h, edge);
		g.fill(x0, y, x0 + 1, y + h, edge);
		g.fill(x1 - 1, y, x1, y + h, edge);
		if (sticky) {
			g.fill(x0, y + h, x1, y + h + 1, UiStyle.withAlpha(UiStyle.color("palette.ui.paper_deep"), 0x90));
		}
		int bx = x0 + 5;
		int bw = badge(g, f, bx, y + 4);
		int tx = bx + bw + 6;
		// right: counts + 5-square stat bar (or what kind of change it is when there are no lines)
		int total = f.file.additions() + f.file.deletions();
		int cx;
		if (f.file.binary() || total == 0) {
			String tag = f.file.binary() ? "binary" : f.file.status() == Protocol.DiffFileStatus.RENAMED ? "moved" : "no changes";
			cx = x1 - 6 - font.width(tag);
			g.text(font, tag, cx, y + 6, ReviewKit.muted(), false);
		} else {
			String a = "+" + f.file.additions();
			String r = "-" + f.file.deletions();
			int barW = 5 * 6;
			int cw = font.width(a) + 4 + font.width(r) + 6 + barW;
			cx = x1 - 6 - cw;
			g.text(font, a, cx, y + 6, UiStyle.color("paper.add_fg"), false);
			g.text(font, r, cx + font.width(a) + 4, y + 6, UiStyle.color("paper.del_fg"), false);
			int sq = cx + font.width(a) + 4 + font.width(r) + 6;
			int adds = Math.round(5f * f.file.additions() / total);
			if (adds == 0 && f.file.additions() > 0) {
				adds = 1;
			}
			int dels = Math.min(5 - adds, Math.max(f.file.deletions() > 0 ? 1 : 0, Math.round(5f * f.file.deletions() / total)));
			for (int i = 0; i < 5; i++) {
				int col = i < adds ? UiStyle.color("paper.add_fg") : i < adds + dels ? UiStyle.color("paper.del_fg") : UiStyle.color("palette.ui.edge");
				g.fill(sq + i * 6, y + 7, sq + i * 6 + 5, y + 12, col);
			}
		}
		// path: muted directory + bold file name
		int avail = cx - 8 - tx;
		int nameW = ReviewKit.boldWidth(font, f.base);
		String dir = f.dir;
		if (f.file.status() == Protocol.DiffFileStatus.RENAMED && f.file.oldPath() != null) {
			dir = f.file.oldPath() + "  →  " + f.dir;
		}
		if (nameW >= avail) {
			ReviewKit.bold(g, font, TextUtil.ellipsize(font, f.base, avail - 6), tx, y + 6, ReviewKit.ink());
		} else {
			String d = ReviewKit.ellipsizeLeft(font, dir, avail - nameW);
			g.text(font, d, tx, y + 6, ReviewKit.muted(), false);
			ReviewKit.bold(g, font, f.base, tx + font.width(d), y + 6, ReviewKit.ink());
		}
	}

	private void drawLine(GuiGraphicsExtractor g, Row r, int y, float sx) {
		int x0 = cardX0();
		int x1 = cardX1();
		DiffLineKind kind = r.line.line.kind();
		boolean add = kind == DiffLineKind.ADD;
		boolean del = kind == DiffLineKind.DEL;
		int cream = UiStyle.color("palette.ui.panel");
		int addBg = UiStyle.color("paper.add_bg");
		int delBg = UiStyle.color("paper.del_bg");
		int addFg = UiStyle.color("paper.add_fg");
		int delFg = UiStyle.color("paper.del_fg");
		int bg = add ? addBg : del ? delBg : cream;
		int gutterBg = add ? ReviewKit.mix(addBg, addFg, 0.10f) : del ? ReviewKit.mix(delBg, delFg, 0.09f)
			: ReviewKit.mix(cream, UiStyle.color("palette.ui.inset"), 0.7f);
		int gx = x0 + 1;
		int digits = doc.digits;
		int colW = digits * 6 + 5;
		int gw = 2 * colW;
		g.fill(gx, y, x1 - 1, y + r.h, bg);
		g.fill(gx, y, gx + gw, y + r.h, gutterBg);
		int numColor = add ? ReviewKit.mix(addFg, addBg, 0.25f) : del ? ReviewKit.mix(delFg, delBg, 0.25f) : ReviewKit.muted();
		if (!r.cont) {
			Integer o = r.line.line.oldNo();
			Integer n = r.line.line.newNo();
			if (o != null) {
				String s = String.valueOf(o);
				g.text(font, s, gx + colW - 3 - font.width(s), y + 1, numColor, false);
			}
			if (n != null) {
				String s = String.valueOf(n);
				g.text(font, s, gx + gw - 3 - font.width(s), y + 1, numColor, false);
			}
		}
		if (add || del) {
			g.fill(gx + gw, y, gx + gw + 2, y + r.h, add ? addFg : delFg);
		}
		int sigX = gx + gw + 5;
		if (!r.cont) {
			if (add) {
				g.text(font, "+", sigX, y + 1, addFg, false);
			} else if (del) {
				g.text(font, "-", sigX, y + 1, delFg, false);
			}
		} else {
			g.text(font, "»", sigX, y + 1, ReviewKit.mix(ReviewKit.muted(), bg, 0.35f), false);
		}
		int tx = gx + gw + TEXT_PAD + r.indent;
		boolean clip = !wrap;
		if (clip) {
			g.enableScissor(gx + gw + TEXT_PAD - 1, viewY, x1 - 2, viewY + viewH);
			g.pose().pushMatrix();
			g.pose().translate(-sx, 0);
		}
		drawCodeText(g, r, tx, y + 1, add, del);
		if (clip) {
			g.pose().popMatrix();
			g.disableScissor();
		}
	}

	private void drawCodeText(GuiGraphicsExtractor g, Row r, int x, int y, boolean add, boolean del) {
		String s = r.line.text;
		int start = r.start;
		int end = r.end;
		if (start >= end) {
			return;
		}
		if (!syntax) {
			int c = add ? UiStyle.color("paper.add_fg") : del ? UiStyle.color("paper.del_fg") : ReviewKit.ink();
			g.text(font, s.substring(start, end), x, y, c, false);
			return;
		}
		int[] sp = r.line.spans;
		int ink = ReviewKit.ink();
		int pos = start;
		int cx = x;
		for (int i = 0; i + 2 < sp.length && pos < end; i += 3) {
			int a = sp[i];
			int b = sp[i + 1];
			if (b <= pos) {
				continue;
			}
			if (a >= end) {
				break;
			}
			if (a > pos) {
				String plain = s.substring(pos, a);
				g.text(font, plain, cx, y, ink, false);
				cx += font.width(plain);
				pos = a;
			}
			int e = Math.min(b, end);
			String tok = s.substring(pos, e);
			g.text(font, tok, cx, y, SyntaxTint.color(sp[i + 2]), false);
			cx += font.width(tok);
			pos = e;
		}
		if (pos < end) {
			g.text(font, s.substring(pos, end), cx, y, ink, false);
		}
	}

	/** Kit scrollbar for pixel content ({@code w} 6 = full kit track, 4 = slim list bar). */
	private void scrollbar(GuiGraphicsExtractor g, int x, int y, int h, int content, int view, float offset, boolean hovered, int w) {
		if (content <= view) {
			return;
		}
		if (w >= 6) {
			Panels.sprite(g, Kit.SCROLL_TRACK, x, y, 6, h);
		}
		int thumbH = Math.max(10, (int) Math.round((double) h * view / content));
		int travel = h - thumbH;
		float max = content - view;
		int ty = y + Math.round(travel * Math.max(0, Math.min(1, offset / max)));
		if (w >= 6) {
			Panels.sprite(g, hovered ? Kit.SCROLL_THUMB_HOVER : Kit.SCROLL_THUMB, x, ty, 6, thumbH);
			if (thumbH >= 10) {
				Panels.sprite(g, Kit.SCROLL_GRIP, x + 2, ty + thumbH / 2 - 1, 2, 3);
			}
		} else {
			g.fill(x, ty, x + 2, ty + thumbH, UiStyle.color("palette.ui.thumb"));
		}
	}

	// ------------------------------------------------------------------ action bar

	private void drawActionBar(GuiGraphicsExtractor g, int mx, int my) {
		int y = barY;
		int x = ix;
		int right = ix + iw;
		boolean open = decisionOpen();
		boolean offline = offline();
		// right: copy path
		String path = selectedPath();
		String copy = "Copy path";
		int cw = ReviewKit.buttonWidth(font, copy);
		int cx = right - cw;
		if (path != null) {
			button(g, "copy", copy, cx, y, cw, ButtonKind.NORMAL, true, mx, my, "c  ·  " + path);
		} else {
			cx = right;
		}
		int leftEnd = x;
		switch (mode) {
			case FEEDBACK -> {
				String send = "Send";
				String cancel = "Cancel";
				int sw = ReviewKit.buttonWidth(font, send);
				int kw = ReviewKit.buttonWidth(font, cancel);
				int fw = Math.max(80, cx - 8 - sw - 4 - kw - 4 - x);
				Panels.sprite(g, Kit.TEXT_FIELD_FOCUSED, x, y, fw, 20);
				if (feedback != null) {
					feedback.setX(x + 6);
					feedback.setY(y + 6);
					feedback.setWidth(fw - 12);
					if (feedback.getValue().isEmpty()) {
						g.text(font, TextUtil.ellipsize(font, "What should " + ReviewKit.agentName(worker()) + " change?  Enter sends, Esc cancels", fw - 16),
							x + 7, y + 6, UiStyle.color("ink_ui.ghost_on_paper"), false);
					}
				}
				int bx = x + fw + 4;
				button(g, "send", send, bx, y, sw, ButtonKind.PRIMARY, feedback != null && !feedback.getValue().isBlank() && !offline, mx, my, "Enter");
				button(g, "cancel", cancel, bx + sw + 4, y, kw, ButtonKind.NORMAL, true, mx, my, "Esc");
				leftEnd = cx;
			}
			case CONFIRM_MERGE -> {
				Worktree w = worktreeInfo();
				String base = w != null ? w.base() : diff != null && diff.base() != null ? diff.base() : "the base branch";
				String q = "Merge " + (target.worktree() == null ? "this branch" : target.worktree()) + " into " + base + "?";
				String yes = "Confirm merge";
				String no = "Cancel";
				int yw = ReviewKit.buttonWidth(font, yes);
				int nw = ReviewKit.buttonWidth(font, no);
				button(g, "merge_confirm", yes, x, y, yw, ButtonKind.PRIMARY, load == Load.READY && !offline, mx, my, "Enter");
				button(g, "cancel", no, x + yw + 4, y, nw, ButtonKind.NORMAL, true, mx, my, "Esc");
				int qx = x + yw + nw + 12;
				g.text(font, TextUtil.ellipsize(font, q, cx - 8 - qx), qx, y + 6, ReviewKit.ink(), false);
				leftEnd = cx;
			}
			case CONFIRM_REJECT -> {
				String q = "Reject abandons " + (target.worktree() == null ? "the branch" : target.worktree()) + ".";
				String yes = "Reject branch";
				String no = "Keep it";
				int yw = ReviewKit.buttonWidth(font, yes);
				int nw = ReviewKit.buttonWidth(font, no);
				button(g, "reject_confirm", yes, x, y, yw, ButtonKind.DANGER, !offline, mx, my, "x / Enter");
				button(g, "cancel", no, x + yw + 4, y, nw, ButtonKind.NORMAL, true, mx, my, "Esc");
				int qx = x + yw + nw + 12;
				g.text(font, TextUtil.ellipsize(font, q, cx - 8 - qx), qx, y + 6, UiStyle.color("paper.del_fg"), false);
				leftEnd = cx;
			}
			case SENDING, DONE -> {
				String msg = mode == Mode.SENDING ? "Sending \"" + sentOption + "\" to the Foreman" + TextUtil.ELLIPSIS
					: doneText();
				int c = mode == Mode.DONE && Protocol.MERGE.equals(sentOption) ? UiStyle.color("paper.add_fg") : ReviewKit.muted();
				if (mode == Mode.DONE) {
					Panels.dot(g, answerFamily(sentOption), x, y + 6, false);
					x += 11;
				}
				g.text(font, TextUtil.ellipsize(font, msg, cx - 8 - x), x, y + 6, c, false);
				leftEnd = cx;
			}
			default -> {
				if (open) {
					String merge = "Merge";
					String req = "Request changes";
					String rej = "Reject";
					int w1 = Math.max(64, ReviewKit.buttonWidth(font, merge));
					int w2 = ReviewKit.buttonWidth(font, req);
					int w3 = ReviewKit.buttonWidth(font, rej);
					boolean ready = load == Load.READY && !offline;
					button(g, "merge", merge, x, y, w1, ButtonKind.PRIMARY, ready, mx, my, ready ? "Ctrl+Enter  ·  merge into "
						+ (worktreeInfo() != null ? worktreeInfo().base() : "the base branch") : offline ? "Foreman offline" : "Waiting for the diff");
					button(g, "request", req, x + w1 + 4, y, w2, ButtonKind.NORMAL, !offline, mx, my, "r  ·  send feedback to "
						+ ReviewKit.agentName(worker()));
					button(g, "reject", rej, x + w1 + w2 + 8, y, w3, ButtonKind.DANGER, !offline, mx, my, "x  ·  abandon the branch");
					leftEnd = x + w1 + w2 + w3 + 8 + 10;
					if (offline) {
						String o = "Foreman offline: read only";
						g.text(font, o, leftEnd, y + 6, UiStyle.color("paper.del_fg"), false);
						leftEnd += font.width(o) + 10;
					}
				} else {
					Decision d = decision();
					String s;
					if (d == null) {
						s = target.isEmpty() ? "" : "Read only: no merge decision for this worktree";
					} else if (d.status() == Protocol.DecisionStatus.CANCELLED) {
						s = "This merge decision was cancelled";
					} else {
						String opt = d.answer() != null && d.answer().option() != null ? d.answer().option() : "answered";
						s = "Answered: " + opt + (d.answer() != null && d.answer().text() != null ? " \"" + d.answer().text() + "\"" : "");
					}
					if (!s.isEmpty()) {
						s = TextUtil.ellipsize(font, s, Math.max(40, (cx - x) / 2));
						g.text(font, s, x, y + 6, ReviewKit.muted(), false);
						leftEnd = x + font.width(s) + 12;
					}
				}
			}
		}
		// flash message (copied / error) or key hints between the actions and the copy button
		long now = System.currentTimeMillis();
		int hx = cx - 8;
		if (flash != null && now < flashUntil) {
			String f = TextUtil.ellipsize(font, flash, hx - leftEnd);
			g.text(font, f, hx - font.width(f), y + 6, flashError ? UiStyle.color("paper.del_fg") : UiStyle.color("paper.add_fg"), false);
			return;
		}
		if (mode != Mode.BROWSE) {
			return;
		}
		String[][] hints = {{"Esc", "close"}, {"w", wrap ? "no wrap" : "wrap"}, {"n p", "file"}, {"j k", "scroll"}};
		for (String[] h : hints) {
			int w = ReviewKit.hintWidth(font, h[0], h[1]);
			if (hx - w < leftEnd) {
				break;
			}
			hx -= w;
			ReviewKit.hint(g, font, h[0], h[1], hx, y + 4);
			hx -= 10;
		}
	}

	/** Dot family of an answer: merged = done, changes requested = thinking (work goes on), rejected = idle. */
	private static String answerFamily(@Nullable String option) {
		if (Protocol.MERGE.equals(option)) {
			return "done";
		}
		return Protocol.REQUEST_CHANGES.equals(option) ? "thinking" : "idle";
	}

	private String doneText() {
		String who = ReviewKit.agentName(worker());
		if (Protocol.MERGE.equals(sentOption)) {
			return "Merge approved. The Foreman is merging " + (target.worktree() == null ? "" : target.worktree()) + ".";
		}
		if (Protocol.REQUEST_CHANGES.equals(sentOption)) {
			return "Feedback sent to " + who + ".";
		}
		return "Rejected. The branch was abandoned.";
	}

	private void button(GuiGraphicsExtractor g, String id, String label, int x, int y, int w, ButtonKind kind, boolean enabled, int mx, int my,
		String tip) {
		boolean hov = enabled && mx >= x && mx < x + w && my >= y && my < y + 20;
		ReviewKit.button(g, font, label, x, y, w, kind, hov, hov && id.equals(pressed), !enabled);
		buttons.add(new Btn(id, x, y, w, 20, enabled, tip));
	}

	private @Nullable String selectedPath() {
		Worktree w = worktreeInfo();
		if (w == null || w.path() == null || w.path().isEmpty()) {
			return null;
		}
		if (doc == null || doc.files.isEmpty()) {
			return w.path();
		}
		String rel = doc.files.get(Math.min(focusFile, doc.files.size() - 1)).file.path();
		return joinPath(w.path(), rel);
	}

	static String joinPath(String root, String rel) {
		boolean win = root.indexOf('\\') >= 0;
		String r = win ? rel.replace('/', '\\') : rel;
		String sep = win ? "\\" : "/";
		return root.endsWith(sep) ? root + r : root + sep + r;
	}

	// ------------------------------------------------------------------ actions

	private void act(String id) {
		switch (id) {
			case "merge" -> {
				// two steps like a merge button on a code host: a stray click never merges
				mode = Mode.CONFIRM_MERGE;
				rejectArmedAt = System.currentTimeMillis();
			}
			case "merge_confirm" -> send(Protocol.MERGE, null);
			case "request" -> openFeedback("", true);
			case "reject" -> {
				mode = Mode.CONFIRM_REJECT;
				rejectArmedAt = System.currentTimeMillis();
			}
			case "reject_confirm" -> send(Protocol.REJECT, null);
			case "send" -> {
				if (feedback != null && !feedback.getValue().isBlank()) {
					send(Protocol.REQUEST_CHANGES, feedback.getValue().trim());
				}
			}
			case "cancel" -> cancelMode();
			case "copy" -> copyPath(false);
			case "refresh" -> request();
			default -> {
			}
		}
	}

	private void cancelMode() {
		if (feedback != null) {
			removeWidget(feedback);
		}
		mode = Mode.BROWSE;
		setFocused(null);
	}

	private void openFeedback(String text, boolean fresh) {
		if (feedback != null) {
			removeWidget(feedback);
		}
		feedback = new EditBox(font, ix + 6, barY + 6, 200, 10, Component.literal("Feedback"));
		feedback.setBordered(false);
		feedback.setTextShadow(false);
		feedback.setTextColor(ReviewKit.ink());
		feedback.setMaxLength(4000);
		feedback.setValue(text);
		addRenderableWidget(feedback);
		setFocused(feedback);
		feedback.setFocused(true);
		mode = Mode.FEEDBACK;
		if (fresh) {
			swallowChar = false;
		}
	}

	private void send(String option, @Nullable String text) {
		Decision d = decision();
		if (d == null || !d.isOpen() || offline()) {
			flash("This decision is no longer open", true);
			return;
		}
		Mode before = mode == Mode.FEEDBACK ? Mode.FEEDBACK : Mode.BROWSE;
		if (feedback != null && mode == Mode.FEEDBACK) {
			feedback.setEditable(false);
		}
		mode = Mode.SENDING;
		sentOption = option;
		Foreman.answer(d.id(), option, text).whenComplete((ack, err) -> {
			String problem = err != null ? (err.getMessage() == null ? err.toString() : err.getMessage()) : ack.ok() ? null : ack.error();
			if (problem != null) {
				mode = before;
				if (feedback != null) {
					feedback.setEditable(true);
				}
				flash("Not sent: " + problem, true);
			} else {
				mode = Mode.DONE;
				doneAt = System.currentTimeMillis();
				if (feedback != null) {
					removeWidget(feedback);
				}
			}
		});
	}

	private void copyPath(boolean root) {
		Worktree w = worktreeInfo();
		String p = root && w != null ? w.path() : selectedPath();
		if (p == null) {
			flash("No worktree path known", true);
			return;
		}
		minecraft.keyboardHandler.setClipboard(p);
		flash("Copied " + p, false);
	}

	private void flash(String msg, boolean isError) {
		flash = msg;
		flashError = isError;
		flashUntil = System.currentTimeMillis() + (isError ? 6000 : 2500);
	}

	// ------------------------------------------------------------------ navigation

	private void scrollBy(float px) {
		spy = true;
		scrollTarget = Math.max(0, Math.min(maxScroll(), scrollTarget + px));
	}

	private void scrollTo(float y) {
		scrollTarget = Math.max(0, Math.min(maxScroll(), y));
	}

	private void goFile(int index) {
		if (doc == null || doc.files.isEmpty()) {
			return;
		}
		int i = Math.max(0, Math.min(doc.files.size() - 1, index));
		focusFile = i;
		spy = false;
		scrollTo(doc.files.get(i).top);
		ensureSideVisible(i);
	}

	private void ensureSideVisible(int i) {
		int lh = sideListH();
		int y = i * SIDE_ROW_H;
		if (y < sideScroll) {
			sideScroll = y;
		} else if (y + SIDE_ROW_H > sideScroll + lh) {
			sideScroll = y + SIDE_ROW_H - lh;
		}
	}

	private void goHunk(int dir) {
		if (doc == null) {
			return;
		}
		int cur = Math.round(scrollTarget) + DiffDoc.FILE_H + 2;
		int best = -1;
		for (FileInfo f : doc.files) {
			for (int hr : f.hunkRows) {
				int y = doc.rows.get(hr).y - DiffDoc.FILE_H;
				if (dir > 0 ? y > Math.round(scrollTarget) + 1 : y < Math.round(scrollTarget) - 1) {
					if (best < 0 || (dir > 0 ? y < best : y > best)) {
						best = y;
					}
				}
			}
		}
		if (best >= 0) {
			spy = true;
			scrollTo(best);
		} else if (dir > 0 && cur >= 0) {
			scrollTo(maxScroll());
		}
	}

	private int page() {
		return Math.max(DiffDoc.LINE_H, viewH - 3 * DiffDoc.LINE_H);
	}

	@Override
	public boolean keyPressed(KeyEvent e) {
		int k = e.input();
		if (mode == Mode.FEEDBACK) {
			if (e.isEscape()) {
				cancelMode();
				return true;
			}
			if (k == InputConstants.KEY_RETURN || k == InputConstants.KEY_NUMPADENTER) {
				act("send");
				return true;
			}
			return super.keyPressed(e);
		}
		if (mode == Mode.SENDING || mode == Mode.DONE) {
			if (e.isEscape()) {
				onClose();
			}
			return true;
		}
		if (e.isEscape()) {
			if (mode == Mode.CONFIRM_REJECT || mode == Mode.CONFIRM_MERGE) {
				mode = Mode.BROWSE;
			} else {
				onClose();
			}
			return true;
		}
		boolean shift = e.hasShiftDown();
		boolean ctrl = e.hasControlDown();
		if (mode == Mode.CONFIRM_MERGE && (k == InputConstants.KEY_RETURN || k == InputConstants.KEY_NUMPADENTER)) {
			act("merge_confirm");
			return true;
		}
		if (mode == Mode.CONFIRM_REJECT && (k == InputConstants.KEY_X || k == InputConstants.KEY_RETURN)) {
			act("reject_confirm");
			return true;
		}
		switch (k) {
			case InputConstants.KEY_J, InputConstants.KEY_DOWN -> scrollBy(DiffDoc.LINE_H * (shift ? 5 : 1));
			case InputConstants.KEY_K, InputConstants.KEY_UP -> scrollBy(-DiffDoc.LINE_H * (shift ? 5 : 1));
			case InputConstants.KEY_PAGEDOWN -> scrollBy(page());
			case InputConstants.KEY_PAGEUP -> scrollBy(-page());
			case InputConstants.KEY_SPACE -> scrollBy(shift ? -page() : page());
			case InputConstants.KEY_HOME -> {
				spy = true;
				scrollTo(0);
			}
			case InputConstants.KEY_END -> {
				spy = true;
				scrollTo(maxScroll());
			}
			case InputConstants.KEY_G -> {
				spy = true;
				scrollTo(shift ? maxScroll() : 0);
			}
			case InputConstants.KEY_N -> goFile(focusFile + 1);
			case InputConstants.KEY_P -> goFile(focusFile - 1);
			case InputConstants.KEY_TAB -> goFile(focusFile + (shift ? -1 : 1));
			case InputConstants.KEY_RBRACKET -> goHunk(1);
			case InputConstants.KEY_LBRACKET -> goHunk(-1);
			case InputConstants.KEY_W -> {
				wrap = !wrap;
				hscroll = hscrollTarget = 0;
			}
			case InputConstants.KEY_T -> syntax = !syntax;
			case InputConstants.KEY_H, InputConstants.KEY_LEFT -> hscrollTarget -= 48;
			case InputConstants.KEY_L, InputConstants.KEY_RIGHT -> hscrollTarget += 48;
			case InputConstants.KEY_C -> copyPath(shift);
			case InputConstants.KEY_F5, InputConstants.KEY_U -> request();
			case InputConstants.KEY_R -> {
				if (decisionOpen() && !offline()) {
					openFeedback("", true);
					swallowChar = true;
				}
			}
			case InputConstants.KEY_X -> {
				if (decisionOpen() && !offline()) {
					act("reject");
				}
			}
			case InputConstants.KEY_RETURN, InputConstants.KEY_NUMPADENTER -> {
				if (ctrl && decisionOpen() && load == Load.READY && !offline()) {
					send(Protocol.MERGE, null);
				}
			}
			default -> {
				return super.keyPressed(e);
			}
		}
		return true;
	}

	@Override
	public boolean charTyped(CharacterEvent e) {
		if (swallowChar) {
			swallowChar = false;
			if (e.codepoint() == 'r' || e.codepoint() == 'R') {
				return true;
			}
		}
		return super.charTyped(e);
	}

	@Override
	public boolean mouseClicked(MouseButtonEvent e, boolean doubleClick) {
		double mx = e.x();
		double my = e.y();
		if (e.button() == InputConstants.MOUSE_BUTTON_LEFT) {
			for (Btn b : buttons) {
				if (b.enabled() && b.hit(mx, my)) {
					pressed = b.id();
					act(b.id());
					return true;
				}
			}
			// sidebar file rows
			int ly = sideListY();
			int lh = sideListH();
			if (doc != null && mx >= sideX && mx < sideX + sideW && my >= ly && my < ly + lh) {
				int i = (int) ((my - ly + sideScroll) / SIDE_ROW_H);
				if (i >= 0 && i < doc.files.size()) {
					goFile(i);
					return true;
				}
			}
			// scrollbar
			if (doc != null && mx >= codeX + codeW - 9 && mx < codeX + codeW && my >= viewY && my < viewY + viewH && doc.height > viewH) {
				int thumbH = Math.max(10, Math.round((float) viewH * viewH / doc.height));
				int travel = viewH - thumbH;
				float ty = viewY + travel * (scroll / Math.max(1, maxScroll()));
				if (my >= ty && my < ty + thumbH) {
					dragThumb = true;
					dragOffset = my - ty;
				} else {
					float f = (float) ((my - viewY - thumbH / 2.0) / Math.max(1, travel));
					spy = true;
					scrollTo(f * maxScroll());
				}
				return true;
			}
			// clicking a hunk/file header row in the code pane: focus that file
			if (doc != null && mx >= viewX && mx < viewX + viewW && my >= viewY && my < viewY + viewH) {
				int dy = (int) (my - viewY + scroll);
				int f = doc.fileAt(dy);
				if (f >= 0) {
					focusFile = f;
				}
			}
		}
		return super.mouseClicked(e, doubleClick);
	}

	@Override
	public boolean mouseReleased(MouseButtonEvent e) {
		pressed = null;
		dragThumb = false;
		return super.mouseReleased(e);
	}

	@Override
	public boolean mouseDragged(MouseButtonEvent e, double dx, double dy) {
		if (dragThumb && doc != null) {
			int thumbH = Math.max(10, Math.round((float) viewH * viewH / doc.height));
			int travel = Math.max(1, viewH - thumbH);
			float f = (float) ((e.y() - dragOffset - viewY) / travel);
			spy = true;
			scrollTarget = scroll = Math.max(0, Math.min(maxScroll(), f * maxScroll()));
			return true;
		}
		return super.mouseDragged(e, dx, dy);
	}

	@Override
	public boolean mouseScrolled(double mx, double my, double sx, double sy) {
		int ly = sideListY();
		if (doc != null && mx >= sideX && mx < sideX + sideW && my >= ly && my < ly + sideListH()) {
			sideScroll -= (float) (sy * SIDE_ROW_H);
			return true;
		}
		boolean horizontal = !wrap && (sx != 0 || minecraft.hasShiftDown());
		if (horizontal) {
			hscrollTarget -= (float) ((sx != 0 ? sx : sy) * 36);
		} else {
			scrollBy((float) (-sy * DiffDoc.LINE_H * 3));
		}
		return true;
	}

	// ------------------------------------------------------------------ dev / QA

	/** Snapshot of the screen for {@code dev.diff}. */
	JsonObject stateJson() {
		JsonObject o = new JsonObject();
		o.addProperty("decisionId", target.decisionId());
		o.addProperty("repoId", target.repoId());
		o.addProperty("worktree", target.worktree());
		o.addProperty("load", load.name().toLowerCase(Locale.ROOT));
		o.addProperty("error", error);
		o.addProperty("mode", mode.name().toLowerCase(Locale.ROOT));
		o.addProperty("decisionOpen", decisionOpen());
		o.addProperty("wrap", wrap);
		o.addProperty("syntax", syntax);
		o.addProperty("scroll", scroll);
		o.addProperty("maxScroll", maxScroll());
		o.addProperty("focusFile", focusFile);
		o.addProperty("outdated", outdated());
		o.addProperty("worker", worker());
		o.addProperty("copyPath", selectedPath());
		if (doc != null) {
			o.addProperty("rows", doc.rows.size());
			o.addProperty("height", doc.height);
			o.addProperty("textWidth", doc.textWidth);
			JsonArray fs = new JsonArray();
			for (FileInfo f : doc.files) {
				JsonObject j = new JsonObject();
				j.addProperty("path", f.file.path());
				j.addProperty("status", f.letter());
				j.addProperty("additions", f.file.additions());
				j.addProperty("deletions", f.file.deletions());
				j.addProperty("top", f.top);
				fs.add(j);
			}
			o.add("files", fs);
		}
		JsonObject layout = new JsonObject();
		layout.addProperty("width", width);
		layout.addProperty("height", height);
		layout.addProperty("sideW", sideW);
		layout.addProperty("viewW", viewW);
		layout.addProperty("viewH", viewH);
		o.add("layout", layout);
		return o;
	}

	/** Apply view options from {@code dev.diff} (scroll, file, wrap, syntax, mode). */
	void applyDev(@Nullable Integer file, @Nullable Float scrollPx, @Nullable Boolean wrapOpt, @Nullable Boolean syntaxOpt, @Nullable String modeOpt,
		@Nullable String feedbackText) {
		if (wrapOpt != null) {
			wrap = wrapOpt;
		}
		if (syntaxOpt != null) {
			syntax = syntaxOpt;
		}
		ensureDoc();
		if (file != null) {
			goFile(file);
			scroll = scrollTarget;
		}
		if (scrollPx != null) {
			spy = true;
			scrollTarget = scroll = Math.max(0, Math.min(maxScroll(), scrollPx));
		}
		if (modeOpt != null) {
			switch (modeOpt) {
				case "feedback" -> {
					openFeedback(feedbackText == null ? "" : feedbackText, true);
				}
				case "confirm_reject" -> {
					mode = Mode.CONFIRM_REJECT;
					rejectArmedAt = System.currentTimeMillis();
				}
				case "confirm_merge" -> {
					mode = Mode.CONFIRM_MERGE;
					rejectArmedAt = System.currentTimeMillis();
				}
				default -> cancelMode();
			}
		}
	}
}

package dev.agentcraft.client.console;

import com.mojang.blaze3d.platform.InputConstants;
import dev.agentcraft.client.console.ConsoleActions.After;
import dev.agentcraft.client.console.ConsoleActions.Feedback;
import dev.agentcraft.client.console.ConsoleCommands.Completion;
import dev.agentcraft.client.console.ConsoleCommands.Goal;
import dev.agentcraft.client.console.ConsoleCommands.Intent;
import dev.agentcraft.client.console.ConsoleCommands.Invalid;
import dev.agentcraft.client.console.ConsoleLog.Line;
import dev.agentcraft.client.console.ConsoleLog.Tone;
import dev.agentcraft.client.decisions.DecisionsFeature;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.foreman.Protocol.FeedKind;
import dev.agentcraft.client.foreman.Protocol.Repo;
import dev.agentcraft.client.hud.Keys;
import dev.agentcraft.client.hud.UiBits;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.util.Util;
import org.jspecify.annotations.Nullable;

/**
 * The command console: a paper command bar at the bottom (brass {@code >}, live "what Enter does"
 * hint, ghost completion, agent autocomplete with Tab) over a live feed panel (Foreman feed + the
 * console's own lines, each agent in its colour). Non-pausing, so the HQ keeps moving behind it.
 * See {@link ConsoleCommands} for the input language and {@link ConsoleActions} for what is sent.
 */
public class ConsoleScreen extends Screen {
	private static final int M = 8;
	private static final int ROW = 10;
	private static final int MAX_POPUP = 6;

	private final TextModel input = new TextModel(8000);
	private final TextFieldView field = new TextFieldView();
	private final TextUtil.Scroll scroll = new TextUtil.Scroll();
	private final long openedAt = Util.getMillis();
	private boolean openedByKey;
	/** Save what is typed as the draft when it closes (not for QA consoles). */
	private boolean keepDraft = true;
	private int historyIndex = -1;
	private String draft = "";
	private int compSel;
	private boolean popupHidden;
	private String lastValue = "";
	private @Nullable Goal pendingGoal;
	private int repoSel;
	private long errorShownAt;

	// derived per frame
	private List<Completion> completions = List.of();
	private @Nullable Intent intent;
	private String intentFor = "\u0000";
	private long intentRev = -1;
	private int intentCursor = -1;

	// layout (hit-testing)
	private int fieldX;
	private int fieldY;
	private int fieldW;
	private int fieldH;
	private int panelX;
	private int panelY;
	private int panelW;
	private int panelH;
	private int listX;
	private int listY;
	private int listW;
	private int listH;
	private final List<int[]> chipHits = new ArrayList<>(); // x, y, w, h, agent index
	private final List<String> chipAgents = new ArrayList<>();
	private int popupX;
	private int popupY;
	private int popupW;
	private int popupRowH;
	private int popupCount;
	private int popupStart;
	private int popupRowsY;

	// wrapped rows cache
	private long rowsRev = -1;
	private int rowsWidth = -1;
	private List<Row> rows = List.of();

	/** A text run; {@code col} > 0 starts it at that x (px from the row's text start) instead of after the previous run. */
	private record Run(String text, int color, int col) {
		Run(String text, int color) {
			this(text, color, 0);
		}
	}

	/** A feed row; {@code sep} rows are time separators ("23:55") between minutes. */
	private record Row(String time, @Nullable String faceAgent, int stripe, List<Run> runs, boolean header, boolean sep, boolean opensDecisions,
		boolean cont) {
		Row(String time, @Nullable String faceAgent, int stripe, List<Run> runs, boolean header, boolean sep) {
			this(time, faceAgent, stripe, runs, header, sep, false, false);
		}
	}

	public ConsoleScreen() {
		this(null);
	}

	public ConsoleScreen(@Nullable String prefill) {
		super(Component.literal("Console"));
		if (prefill != null) {
			input.set(prefill);
		} else if (!ConsoleLog.draft().isEmpty()) {
			// what you were typing when you closed it (Esc never throws a draft away)
			input.set(ConsoleLog.draft());
			input.moveTo(ConsoleLog.draftCursor(), false);
			lastValue = input.value();
			popupHidden = true;
		}
	}

	public ConsoleScreen openedByKey() {
		openedByKey = true;
		return this;
	}

	/**
	 * A console for QA / DevBridge shots: starts with exactly {@code prefill} (or empty), never shows
	 * nor keeps the player's draft, so scenes are repeatable ("@ju" typed twice never becomes "@ju@ju").
	 */
	public static ConsoleScreen forDev(@Nullable String prefill) {
		ConsoleScreen s = new ConsoleScreen(prefill == null ? "" : prefill);
		s.keepDraft = false;
		return s;
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	@Override
	public boolean isInputCaptured() {
		return true;
	}

	@Override
	protected void init() {
		minecraft.onTextInputFocusChange(this, true);
		input.touch();
	}

	@Override
	public void removed() {
		if (keepDraft) {
			ConsoleLog.keepDraft(input.value(), input.cursor());
		}
		minecraft.onTextInputFocusChange(this, false);
		super.removed();
	}

	// ------------------------------------------------------------------ public state (dev.console)

	public String value() {
		return input.value();
	}

	public void setValue(String v) {
		input.set(v);
		popupHidden = false;
		compSel = 0;
	}

	public List<Completion> completions() {
		return completions;
	}

	public @Nullable String ghost() {
		return ghostText();
	}

	public @Nullable Intent intent() {
		return intent;
	}

	public boolean repoChooserOpen() {
		return pendingGoal != null;
	}

	// ------------------------------------------------------------------ derived state

	private void refresh() {
		ForemanState s = Foreman.state();
		String v = input.value();
		if (!v.equals(lastValue)) {
			lastValue = v;
			compSel = 0;
			popupHidden = false;
			if (pendingGoal != null) {
				pendingGoal = null;
			}
			historyIndex = historyIndex >= 0 && !v.equals(historyAt(historyIndex)) ? -1 : historyIndex;
		}
		if (s == null) {
			completions = List.of();
			intent = null;
			return;
		}
		if (!v.equals(intentFor) || s.revision() != intentRev || input.cursor() != intentCursor) {
			intent = ConsoleCommands.parse(v, s);
			completions = ConsoleCommands.complete(v, input.cursor(), s);
			intentFor = v;
			intentRev = s.revision();
			intentCursor = input.cursor();
		}
		if (compSel >= completions.size()) {
			compSel = 0;
		}
	}

	private @Nullable String historyAt(int i) {
		List<String> h = ConsoleLog.history();
		return i >= 0 && i < h.size() ? h.get(i) : null;
	}

	private @Nullable String ghostText() {
		if (completions.isEmpty() || input.cursor() != input.length() || popupHidden) {
			return null;
		}
		Completion c = completions.get(compSel);
		String typed = input.value().substring(c.start(), c.end());
		String rep = c.replacement().stripTrailing();
		if (rep.length() > typed.length() && rep.toLowerCase(Locale.ROOT).startsWith(typed.toLowerCase(Locale.ROOT))) {
			return rep.substring(typed.length());
		}
		return null;
	}

	private boolean popupVisible() {
		if (popupHidden || completions.isEmpty()) {
			return false;
		}
		// a single exact match needs no popup once fully typed
		if (completions.size() == 1) {
			Completion c = completions.get(0);
			String typed = input.value().substring(c.start(), c.end());
			return !c.replacement().strip().equalsIgnoreCase(typed.strip());
		}
		return true;
	}

	// ------------------------------------------------------------------ actions

	private void applyCompletion() {
		if (completions.isEmpty()) {
			return;
		}
		Completion c = completions.get(compSel);
		String typed = input.value().substring(c.start(), c.end());
		boolean alreadyThis = c.replacement().strip().equalsIgnoreCase(typed.strip());
		if (alreadyThis && completions.size() > 1) {
			compSel = (compSel + 1) % completions.size();
			c = completions.get(compSel);
		}
		input.replace(c.start(), c.end(), c.replacement());
		lastValue = input.value();
		ForemanState s = Foreman.state();
		if (s != null) {
			intent = ConsoleCommands.parse(input.value(), s);
			// keep the cycle position when the same token prefix still matches
			List<Completion> next = ConsoleCommands.complete(input.value(), input.cursor(), s);
			completions = next;
			intentFor = input.value();
			intentRev = s.revision();
			intentCursor = input.cursor();
		}
		compSel = 0;
		popupHidden = true;
	}

	private void submit() {
		ForemanState s = Foreman.state();
		if (s == null) {
			return;
		}
		String raw = input.value();
		Intent in = ConsoleCommands.parse(raw, s);
		if (pendingGoal != null) {
			List<Repo> choices = pendingGoal.choices();
			Repo r = choices.get(Math.max(0, Math.min(repoSel, choices.size() - 1)));
			in = new Goal(pendingGoal.text(), r.id(), List.of());
			pendingGoal = null;
		} else if (in instanceof Goal g && !g.choices().isEmpty()) {
			pendingGoal = g;
			repoSel = 0;
			for (int i = 0; i < g.choices().size(); i++) {
				if (g.choices().get(i).id().equals(g.repoId())) {
					repoSel = i;
				}
			}
			return;
		}
		if (in instanceof Invalid) {
			errorShownAt = Util.getMillis();
		}
		After after = ConsoleActions.run(in, raw, restored -> {
			if (minecraft.gui.screen() == this && input.isEmpty()) {
				input.set(restored);
				lastValue = input.value();
				errorShownAt = Util.getMillis();
			} else if (keepDraft && minecraft.gui.screen() != this && ConsoleLog.draft().isEmpty()) {
				// closed meanwhile: the refused text waits in the next console
				ConsoleLog.keepDraft(restored, restored.length());
			}
		});
		switch (after) {
			case CLEAR -> {
				input.clear();
				lastValue = "";
				historyIndex = -1;
				draft = "";
				scroll.toBottom();
			}
			case CLOSE -> {
				// the action opened another screen (decisions, diff): the command is done, keep no draft
				input.clear();
				lastValue = "";
				historyIndex = -1;
				draft = "";
				if (keepDraft) {
					ConsoleLog.keepDraft("", 0);
				}
			}
			case KEEP -> {
				if (ConsoleActions.feedback() != null && ConsoleActions.feedback().tone() == Tone.ERROR) {
					errorShownAt = Util.getMillis();
				}
			}
		}
	}

	private void history(int dir) {
		List<String> h = ConsoleLog.history();
		if (h.isEmpty()) {
			return;
		}
		if (dir < 0) {
			if (historyIndex == -1) {
				draft = input.value();
				historyIndex = h.size() - 1;
			} else if (historyIndex > 0) {
				historyIndex--;
			}
		} else {
			if (historyIndex == -1) {
				return;
			}
			historyIndex++;
			if (historyIndex >= h.size()) {
				historyIndex = -1;
				input.set(draft);
				lastValue = input.value();
				popupHidden = true;
				return;
			}
		}
		input.set(h.get(historyIndex));
		lastValue = input.value();
		popupHidden = true;
	}

	// ------------------------------------------------------------------ input

	@Override
	public boolean keyPressed(KeyEvent e) {
		refresh();
		int k = e.key();
		if (e.isEscape()) {
			if (pendingGoal != null) {
				pendingGoal = null;
				return true;
			}
			if (popupVisible()) {
				popupHidden = true;
				return true;
			}
			onClose();
			return true;
		}
		if (Keys.matches(Keys.console, e) && input.isEmpty() && pendingGoal == null && Util.getMillis() - openedAt > 150) {
			onClose();
			return true;
		}
		if (pendingGoal != null) {
			List<Repo> choices = pendingGoal.choices();
			int digit = TextKeys.digit(e);
			if (digit > 0 && digit <= choices.size()) {
				repoSel = digit - 1;
				submit();
				return true;
			}
			if (k == InputConstants.KEY_LEFT || k == InputConstants.KEY_UP || k == InputConstants.KEY_TAB && e.hasShiftDown()) {
				repoSel = (repoSel - 1 + choices.size()) % choices.size();
				return true;
			}
			if (k == InputConstants.KEY_RIGHT || k == InputConstants.KEY_DOWN || k == InputConstants.KEY_TAB) {
				repoSel = (repoSel + 1) % choices.size();
				return true;
			}
			if (TextKeys.isEnter(e)) {
				submit();
				return true;
			}
		}
		if (TextKeys.isEnter(e)) {
			if (e.hasShiftDown()) {
				input.insert("\n");
			} else {
				submit();
			}
			return true;
		}
		if (k == InputConstants.KEY_TAB) {
			if (!completions.isEmpty()) {
				popupHidden = false;
				applyCompletion();
			}
			return true;
		}
		if (k == InputConstants.KEY_UP || k == InputConstants.KEY_DOWN) {
			int dir = k == InputConstants.KEY_UP ? -1 : 1;
			if (popupVisible() && completions.size() > 1) {
				compSel = (compSel + dir + completions.size()) % completions.size();
				return true;
			}
			if (input.value().indexOf('\n') >= 0 || input.layout(font, innerFieldW()).size() > 1) {
				if (input.vertical(font, innerFieldW(), dir, e.hasShiftDown())) {
					return true;
				}
			}
			history(dir);
			return true;
		}
		if (k == InputConstants.KEY_PAGEUP) {
			scroll.scrollBy(-Math.max(1, listH / ROW - 1));
			return true;
		}
		if (k == InputConstants.KEY_PAGEDOWN) {
			scroll.scrollBy(Math.max(1, listH / ROW - 1));
			return true;
		}
		if (k == InputConstants.KEY_END && e.hasControlDown() && input.isEmpty()) {
			scroll.toBottom();
			return true;
		}
		if (TextKeys.handle(e, input)) {
			return true;
		}
		return true;
	}

	private int innerFieldW() {
		return TextFieldView.wrapWidth(font, input, fieldW, fieldStyle());
	}

	@Override
	public boolean charTyped(CharacterEvent e) {
		int cp = e.codepoint();
		if (cp < 32) {
			return true;
		}
		// the key that opened the console must not type itself
		if (openedByKey && Util.getMillis() - openedAt < 150 && cp == '`') {
			return true;
		}
		input.insert(e.codepointAsString());
		return true;
	}

	@Override
	public boolean mouseClicked(MouseButtonEvent e, boolean doubleClick) {
		double mx = e.x();
		double my = e.y();
		// completion rows
		if (popupVisible() && mx >= popupX && mx < popupX + popupW && my >= popupRowsY && my < popupRowsY + popupCount * popupRowH) {
			int i = (int) ((my - popupRowsY) / popupRowH);
			if (i >= 0 && i < popupCount) {
				compSel = popupStart + i;
				applyCompletion();
				return true;
			}
		}
		// roster chips: start a message
		for (int[] hit : chipHits) {
			if (mx >= hit[0] && mx < hit[0] + hit[2] && my >= hit[1] && my < hit[1] + hit[3]) {
				String id = chipAgents.get(hit[4]);
				Agent a = Foreman.state() == null ? null : Foreman.state().agent(id);
				String tag = "@" + (a != null ? a.name() : id).toLowerCase(Locale.ROOT) + " ";
				if (input.isEmpty()) {
					input.set(tag);
				} else {
					input.insert(tag);
				}
				return true;
			}
		}
		// a "needs you" line in the feed opens the decision queue (Esc comes back here)
		if (!overlayOpen() && mx >= listX && mx < listX + listW - 10 && my >= listY + 4 && my < listY + listH - 2) {
			int i = scroll.offset() + (int) ((my - listY - 4) / ROW);
			if (i >= 0 && i < rows.size() && rows.get(i).opensDecisions() && DecisionsFeature.waitingCount() > 0) {
				DecisionsFeature.openQueue(null, this);
				return true;
			}
		}
		if (mx >= fieldX && mx < fieldX + fieldW && my >= fieldY && my < fieldY + fieldH) {
			int idx = field.hit(font, input, fieldX, fieldY, fieldW, fieldStyle(), mx, my);
			if (idx >= 0) {
				input.moveTo(idx, e.hasShiftDown());
			}
			return true;
		}
		return super.mouseClicked(e, doubleClick);
	}

	@Override
	public boolean mouseScrolled(double x, double y, double scrollX, double scrollY) {
		if (scrollY == 0) return true;
		if (popupVisible() && x >= popupX && x < popupX + popupW
				&& y >= popupY && y < popupRowsY + popupCount * popupRowH + 14) {
			compSel = Math.clamp(compSel + (scrollY > 0 ? -1 : 1), 0, completions.size() - 1);
			return true;
		}
		scroll.scrollBy(scrollY > 0 ? -3 : 3);
		return true;
	}

	// ------------------------------------------------------------------ drawing

	@Override
	public void extractBackground(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		// the world stays visible but steps back: a warm walnut dim over everything, deeper at the
		// bottom where the bar and the feed sit (like the modals' veil, lighter)
		g.fill(0, 0, width, height, UiStyle.withAlpha(UiStyle.WALNUT, 92));
		int h = height * 2 / 3;
		g.fillGradient(0, height - h, width, height, UiStyle.withAlpha(UiStyle.INK, 0), UiStyle.withAlpha(UiStyle.INK, 120));
	}

	private TextFieldView.Style fieldStyle() {
		String hint = null;
		int hintColor = UiBits.muted();
		Feedback fb = ConsoleActions.feedback();
		long now = System.currentTimeMillis();
		if (input.isEmpty()) {
			if (fb != null && (fb.pending() || fb.tone() == Tone.OK && now - fb.at() < 5000)) {
				hint = fb.text();
				hintColor = fb.tone() == Tone.OK ? UiBits.okText() : UiBits.muted();
			}
		} else if (pendingGoal != null) {
			Repo r = pendingGoal.choices().get(Math.max(0, Math.min(repoSel, pendingGoal.choices().size() - 1)));
			hint = "new goal \u2192 " + r.name();
		} else if (intent != null) {
			ForemanState s = Foreman.state();
			if (s != null && s.hasData() && s.isStale() && sendsToForeman(intent)) {
				// say it before Enter, not after
				hint = "Foreman offline: this can't be sent yet";
				hintColor = UiBits.errorText();
			} else if (intent instanceof Invalid inv) {
				hint = errorStripVisible() ? null : inv.error();
			} else if (s != null) {
				hint = ConsoleCommands.describe(intent, s);
			}
		}
		String placeholder = "Talk to Marlow, /goal to start work, or @agent to message";
		return new TextFieldView.Style(">", UiStyle.BRASS, placeholder, ghostText(), hint, hintColor, 6);
	}

	/** Intents that go to the Foreman (everything but the local commands). */
	private static boolean sendsToForeman(Intent in) {
		return in instanceof Goal || in instanceof ConsoleCommands.Message || in instanceof ConsoleCommands.Answer || in instanceof ConsoleCommands.RepoAdd
			|| in instanceof ConsoleCommands.AgentAction || in instanceof ConsoleCommands.TaskAction;
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		refresh();
		chipHits.clear();
		chipAgents.clear();
		ForemanState s = Foreman.state();

		// ---- command bar
		// the bar and the feed share one column (one aligned console, not a full-width bar under a panel)
		panelW = Math.min(420, Math.max(260, width * 62 / 100));
		fieldX = M;
		fieldW = panelW;
		TextFieldView.Style st = fieldStyle();
		fieldH = field.height(font, input, fieldW, st);
		fieldY = height - M - fieldH;

		// ---- feed panel
		panelX = M;
		int panelBottom = fieldY - 5;
		panelH = Math.min(panelBottom - 46, Math.max(120, (int) (height * 0.6)));
		panelY = panelBottom - panelH;
		drawPanel(g, s, mouseX, mouseY);

		// ---- error strip / repo chooser above the bar
		int above = fieldY - 4;
		if (pendingGoal != null) {
			above = drawRepoChooser(g, above);
		} else if (errorStripVisible()) {
			above = drawErrorStrip(g, ConsoleActions.feedback().text(), above);
		}

		field.draw(g, font, input, fieldX, fieldY, fieldW, true, st);

		if (popupVisible()) {
			drawPopup(g, above, mouseX, mouseY);
		} else {
			popupCount = 0;
		}
	}

	private void drawPanel(GuiGraphicsExtractor g, @Nullable ForemanState s, int mouseX, int mouseY) {
		Panels.panel(g, panelX, panelY, panelW, panelH);
		Kit.Padding p = Kit.padding("panel_paper");
		int x = panelX + p.left();
		int w = panelW - p.left() - p.right();
		int y = panelY + p.top();

		// header: title + link summary, roster on the right
		g.text(font, "Console", x, y + 5, UiBits.ink(), false);
		String sub = headerSub(s);
		int rosterW = rosterWidth(s);
		g.text(font, TextUtil.ellipsize(font, sub, w - font.width("Console") - 10 - rosterW), x + font.width("Console") + 6, y + 5, UiBits.muted(), false);
		drawRoster(g, s, x + w - rosterW + 2, y, mouseX, mouseY);
		y += 20;
		g.fill(x, y, x + w, y + 1, UiStyle.color("palette.ui.edge", 0xFFC9BBA3));
		y += 4;

		// feed list
		int footerH = 14;
		listX = x;
		listY = y;
		listW = w;
		listH = panelY + panelH - p.bottom() - footerH - 3 - y;
		Panels.inset(g, listX, listY, listW, listH);
		List<Row> rs = rows(listW - 14);
		int view = Math.max(1, (listH - 6) / ROW);
		scroll.update(rs.size(), view);
		int ly = listY + 4;
		g.enableScissor(listX + 2, listY + 2, listX + listW - 2, listY + listH - 2);
		if (rs.isEmpty()) {
			String msg = s == null || !s.hasData() ? "Waiting for the Foreman…" : "Talk to Marlow below, or use /goal to start work.";
			g.text(font, msg, listX + 8, ly + 2, UiBits.muted(), false);
		}
		int textX0 = listX + 6;
		for (int i = scroll.offset(); i < Math.min(rs.size(), scroll.offset() + view); i++) {
			Row r = rs.get(i);
			// (a view that starts on the tail of a wrapped line just shows that tail, under its
			// stripe, like any chat log: no blank first row)
			if (r.sep()) {
				int tw = font.width(r.time());
				int mid = listX + (listW - 8) / 2;
				int rule = UiStyle.color("palette.ui.edge", 0xFFC9BBA3);
				g.fill(textX0 + 2, ly + 4, mid - tw / 2 - 5, ly + 5, rule);
				g.fill(mid + tw / 2 + 5, ly + 4, listX + listW - 12, ly + 5, rule);
				g.text(font, r.time(), mid - tw / 2, ly, UiStyle.color("paper.disabled", 0xFFA39B8E), false);
				ly += ROW;
				continue;
			}
			if (r.stripe() != 0) {
				g.fill(listX + 3, ly - 1, listX + 5, ly + 9, r.stripe());
			}
			if (r.header()) {
				g.fill(textX0, ly + 9, listX + listW - 10, ly + 10, UiStyle.color("palette.ui.edge", 0xFFC9BBA3));
			}
			int tx = textX0 + 2;
			if (r.faceAgent() != null) {
				UiBits.face(g, r.faceAgent(), tx, ly, 1);
			}
			tx += 11;
			int tx0 = tx;
			for (Run run : r.runs()) {
				if (run.col() > 0) {
					tx = tx0 + run.col();
				}
				g.text(font, run.text(), tx, ly, run.color(), false);
				tx += font.width(run.text());
			}
			ly += ROW;
		}
		g.disableScissor();
		Panels.scrollbar(g, listX + listW - 8, listY + 2, listH - 4, scroll, false);
		if (!scroll.following() && scroll.scrollable()) {
			String more = "↓ newer below";
			int mw = font.width(more) + 10;
			Panels.sprite(g, Kit.PILL, listX + listW - 14 - mw, listY + listH - 15, mw, 11);
			g.text(font, more, listX + listW - 14 - mw + 5, listY + listH - 13, UiBits.muted(), false);
		}

		// footer: key hints (hidden while a popup sits over it)
		if (overlayOpen()) {
			return;
		}
		int fy = panelY + panelH - p.bottom() - footerH + 2;
		String dk = Keys.label(Keys.decisions);
		int waiting = DecisionsFeature.waitingCount();
		String[] hints = waiting > 0 ? new String[] {"Enter", "send", "Tab", "complete", "↑↓", "history", dk, waiting + " waiting", "Esc", "close"}
			: new String[] {"Enter", "send", "Tab", "complete", "↑↓", "history", "Shift+Enter", "new line", "Esc", "close"};
		if (UiBits.hintsWidth(font, hints) > w) {
			hints = new String[] {"Enter", "send", "Tab", "complete", "↑↓", "history", "Esc", "close"};
		}
		UiBits.hints(g, font, x, fy, false, hints);
	}

	private boolean overlayOpen() {
		return pendingGoal != null || popupVisible() || errorStripVisible();
	}

	private boolean errorStripVisible() {
		Feedback fb = ConsoleActions.feedback();
		return pendingGoal == null && fb != null && fb.tone() == Tone.ERROR && Util.getMillis() - errorShownAt < 9000 && fb.at() >= openedAt - 1;
	}

	private String headerSub(@Nullable ForemanState s) {
		if (s == null || !s.hasData()) {
			return "· connecting to the Foreman";
		}
		if (s.isStale()) {
			return "· Foreman offline (last known state)";
		}
		int active = 0;
		for (Agent a : s.agents().values()) {
			if (a.isActive()) {
				active++;
			}
		}
		String repo = s.repos().size() == 1 ? s.repos().values().iterator().next().name() : s.repos().size() + " repos";
		String spend = ConsoleActions.spendLabel(s);
		return "· " + active + " on shift · " + repo + (spend != null ? " · " + spend : "");
	}

	private int rosterWidth(@Nullable ForemanState s) {
		return s == null ? 0 : s.agents().size() * ROSTER_STEP;
	}

	/** Roster portraits: 16 px faces (2x), so who is on shift reads at a glance. */
	private static final int ROSTER_STEP = 21;

	private void drawRoster(GuiGraphicsExtractor g, @Nullable ForemanState s, int x, int y, int mouseX, int mouseY) {
		if (s == null) {
			return;
		}
		int i = 0;
		String hovered = null;
		boolean stale = s.isStale();
		for (Agent a : s.agents().values()) {
			int cx = x + i * ROSTER_STEP;
			boolean off = !a.isActive() || stale;
			// while the Foreman is offline nobody's state is known: no live colours
			String fam = stale || a.isPaused() ? "idle" : dev.agentcraft.client.ui.StatusMap.agent(s, a);
			// a thin ring in the state colour around the portrait (breathing clay while it waits on you)
			int ring = UiStyle.status(fam);
			if ("waiting".equals(fam)) {
				ring = UiStyle.withAlpha(ring, (int) (110 + 145 * dev.agentcraft.client.ui.StatusMap.pulse(System.nanoTime())));
			}
			g.fill(cx - 1, y - 1, cx + 17, y + 17, ring);
			UiBits.face(g, a.id(), cx, y, 2);
			if (off) {
				g.fill(cx, y, cx + 16, y + 16, UiStyle.withAlpha(UiStyle.CREAM, 150));
			}
			Panels.sprite(g, Kit.dot(fam, false), cx + 12, y + 11, 7, 7);
			chipAgents.add(a.id());
			chipHits.add(new int[] {cx - 1, y - 1, 19, 19, chipAgents.size() - 1});
			if (mouseX >= cx - 1 && mouseX < cx + 18 && mouseY >= y - 1 && mouseY < y + 18) {
				hovered = a.id();
			}
			i++;
		}
		if (hovered != null) {
			Agent a = s.agent(hovered);
			if (a != null) {
				String st = stale ? "last known: " + (a.isPaused() ? "paused" : a.activity()) : !a.isActive() ? "off shift" : a.isPaused() ? "paused"
					: a.activity();
				g.setTooltipForNextFrame(font, Component.literal(a.name() + " · " + st + "  (click to message)"), mouseX, mouseY);
			}
		}
	}

	private int drawErrorStrip(GuiGraphicsExtractor g, String text, int bottom) {
		Kit.Padding p = Kit.padding("panel_paper");
		int w = Math.min(fieldW, font.width(text) + p.left() + p.right() + 14);
		int h = 22;
		int y = bottom - h;
		Panels.panel(g, fieldX, y, w, h);
		Panels.dot(g, "error", fieldX + p.left(), y + 7, false);
		g.text(font, TextUtil.ellipsize(font, text, w - p.left() - p.right() - 12), fieldX + p.left() + 11, y + 7, UiBits.errorText(), false);
		return y - 2;
	}

	private int drawRepoChooser(GuiGraphicsExtractor g, int bottom) {
		Goal pg = pendingGoal;
		Kit.Padding p = Kit.padding("panel_paper");
		int h = p.top() + 12 + 16 + p.bottom() - 2;
		int y = bottom - h;
		int w = Math.max(panelW, Math.min(fieldW, 300));
		Panels.panel(g, fieldX, y, w, h);
		int x = fieldX + p.left();
		g.text(font, "Which repo is this goal for?", x, y + p.top(), UiBits.ink(), false);
		String hint = "Enter send · 1-" + pg.choices().size() + " pick · Esc back";
		g.text(font, hint, fieldX + w - p.right() - font.width(hint), y + p.top(), UiBits.muted(), false);
		int cx = x;
		int cy = y + p.top() + 13;
		for (int i = 0; i < pg.choices().size(); i++) {
			Repo r = pg.choices().get(i);
			String label = (i + 1) + "  " + r.name();
			int pw = font.width(label) + 12;
			if (cx + pw > fieldX + w - p.right()) {
				break;
			}
			boolean sel = i == repoSel;
			Panels.sprite(g, sel ? Kit.button(true, "normal") : Kit.PILL, cx, cy - 1, pw, sel ? 13 : 11);
			g.text(font, label, cx + 6, cy + 1, sel ? UiBits.panelHi() : UiBits.ink(), false);
			cx += pw + 4;
		}
		return y - 2;
	}

	private void drawPopup(GuiGraphicsExtractor g, int bottom, int mouseX, int mouseY) {
		int n = Math.min(MAX_POPUP, completions.size());
		popupCount = n;
		popupStart = CompletionViewport.start(popupStart, compSel, completions.size(), n);
		popupRowH = 11;
		Kit.Padding p = Kit.padding("tooltip");
		int maxLabel = 0;
		int maxDetail = 0;
		for (int i = 0; i < n; i++) {
			Completion c = completions.get(popupStart + i);
			maxLabel = Math.max(maxLabel, font.width(c.label()));
			if (c.detail() != null) {
				maxDetail = Math.max(maxDetail, Math.min(170, font.width(c.detail())));
			}
		}
		String tabHint = "complete";
		int footer = 14;
		int w = p.left() + 11 + 4 + maxLabel + (maxDetail > 0 ? 10 + maxDetail : 0) + p.right() + 6;
		w = Math.max(w, p.left() + UiBits.hintsWidth(font, "Tab", tabHint) + p.right() + 30);
		int h = p.top() + n * popupRowH + footer + p.bottom();
		Completion first = completions.get(0);
		Kit.Padding fp = Kit.padding("text_field");
		int caretX = fieldX + fp.left() + font.width(">") + 4 + font.width(input.value().substring(0, Math.min(first.start(), input.length())));
		int x = Math.max(M, Math.min(caretX - p.left() - 11 - 4, width - M - w));
		int y = bottom - h;
		popupX = x;
		popupY = y;
		popupW = w;
		// paper card with a brass frame (the kit's language, not a dark tooltip box)
		g.fill(x - 1, y - 1, x + w + 1, y + h + 1, UiStyle.BRASS);
		Panels.sprite(g, Kit.PANEL_PAPER, x, y, w, h);
		int ry = y + p.top();
		popupRowsY = ry;
		for (int i = 0; i < n; i++) {
			Completion c = completions.get(popupStart + i);
			boolean sel = popupStart + i == compSel;
			if (sel) {
				g.fill(x + 3, ry - 1, x + w - 3, ry + popupRowH - 1, UiStyle.withAlpha(UiStyle.CLAY, 46));
				g.fill(x + 3, ry - 1, x + 5, ry + popupRowH - 1, UiStyle.CLAY);
			}
			int cx = x + p.left();
			if (c.agentId() != null) {
				UiBits.face(g, c.agentId(), cx, ry, 1);
				if (c.dot() != null) {
					Panels.sprite(g, Kit.dot(c.dot(), false), cx + 5, ry + 4, 7, 7);
				}
			} else if (c.label().startsWith("/")) {
				g.text(font, "/", cx + 2, ry + 1, UiStyle.BRASS, false);
			}
			cx += 15;
			int nameColor = c.agentId() != null ? UiBits.nameOnLight(c.agentId()) : UiBits.ink();
			String label = c.label().startsWith("/") ? c.label().substring(1) : c.label();
			g.text(font, label, cx, ry + 1, nameColor, false);
			if (c.detail() != null) {
				String d = TextUtil.ellipsize(font, c.detail(), Math.max(20, w - (cx - x) - maxLabel - 10 - p.right()));
				g.text(font, d, cx + maxLabel + 10, ry + 1, UiBits.muted(), false);
			}
			ry += popupRowH;
		}
		UiBits.hints(g, font, x + p.left(), ry + 2, false, "Tab", tabHint);
		if (n > 1) {
			String nav = "↑↓";
			g.text(font, nav, x + w - p.right() - font.width(nav) - 2, ry + 4, UiBits.muted(), false);
		}
	}

	// ------------------------------------------------------------------ feed rows

	private List<Row> rows(int width) {
		long rev = ConsoleLog.revision();
		if (rev == rowsRev && width == rowsWidth) {
			return rows;
		}
		rowsRev = rev;
		rowsWidth = width;
		List<Row> out = new ArrayList<>();
		ForemanState s = Foreman.state();
		int textW = width - 15;
		String lastTime = "";
		for (Line l : ConsoleLog.lines()) {
			String time = UiBits.clock(l.ts());
			if (!time.equals(lastTime)) {
				out.add(new Row(time, null, 0, List.of(), false, true));
				lastTime = time;
			}
			buildRows(out, l, "", textW, s);
		}
		rows = List.copyOf(out);
		return rows;
	}

	private void buildRows(List<Row> out, Line l, String time, int textW, @Nullable ForemanState s) {
		int ink = UiBits.ink();
		int muted = UiBits.muted();
		String agent = l.agentId();
		int stripe = 0;
		List<Run> lead = new ArrayList<>();
		String body = l.text();
		int bodyColor = ink;
		boolean header = false;
		if (l.local()) {
			switch (l.tone()) {
				case HEADER -> header = true;
				case OK -> bodyColor = UiBits.okText();
				case ERROR -> bodyColor = UiBits.errorText();
				case ECHO -> bodyColor = muted;
				default -> {
				}
			}
			if (agent != null) {
				stripe = identity(agent, s);
				String name = UiBits.agentName(agent);
				if (body.startsWith(name)) {
					lead.add(new Run(name, UiBits.nameOnLight(agent)));
					body = body.substring(name.length());
				}
			}
			if (body.indexOf('\t') >= 0) {
				columns(out, l, body, stripe, agent, textW);
				return;
			}
		} else {
			FeedKind kind = l.kind() == null ? FeedKind.UNKNOWN : l.kind();
			String user = UiBits.userName();
			if (agent != null && UiBits.isUser(agent) && !body.startsWith(user)) {
				// the Foreman's echo of your own actions ("Kit: pause") reads as "You paused Kit"
				java.util.regex.Matcher am = AGENT_ACTION.matcher(body);
				if (am.matches()) {
					body = pastTense(am.group(2)) + " " + am.group(1) + am.group(3);
				}
				lead.add(new Run("You", UiStyle.CLAY_DARK));
				lead.add(new Run(" ", ink));
				agent = null;
				stripe = UiStyle.CLAY;
			}
			String name = agent != null ? (UiBits.isUser(agent) ? user : UiBits.agentName(agent)) : null;
			if (agent != null) {
				stripe = identity(agent, s);
			}
			if (!lead.isEmpty()) {
				bodyColor = ink;
			} else if (kind == FeedKind.MESSAGE && name != null) {
				lead.add(new Run(name, UiBits.nameOnLight(agent)));
				if (l.to() != null && !l.to().equals("all")) {
					lead.add(new Run(" → ", muted));
					lead.add(new Run(UiBits.isUser(l.to()) ? "you" : UiBits.agentName(l.to()), UiBits.nameOnLight(l.to())));
				}
				lead.add(new Run("  ", ink));
			} else if (name != null && body.startsWith(name)) {
				lead.add(new Run(name, UiBits.nameOnLight(agent)));
				body = body.substring(name.length());
				bodyColor = muted;
			} else if (name != null && body.startsWith(user)) {
				lead.add(new Run(user, UiStyle.CLAY_DARK));
				body = body.substring(user.length());
				bodyColor = muted;
			} else {
				bodyColor = muted;
			}
			switch (kind) {
				case ERROR -> bodyColor = UiBits.errorText();
				case DECISION -> {
					if (body.contains("needs you")) {
						bodyColor = UiStyle.CLAY_DARK;
					}
				}
				case CI -> {
					if (body.contains("tests pass") || body.contains(" fail 0")) {
						bodyColor = UiBits.okText();
					} else if (body.contains("fail")) {
						bodyColor = UiBits.errorText();
					}
				}
				case MERGE -> bodyColor = UiBits.okText();
				case GOAL, USER -> {
					// goal lines without an author are the Foreman's ("Goal complete: ...", "Goal
					// closed: ..."), not yours; only a goal you typed (agentId "user", handled above,
					// or an older Foreman's bare "New goal: ...") reads as "You"
					boolean yours = kind == FeedKind.USER || body.startsWith("New goal");
					if (lead.isEmpty() && !yours) {
						bodyColor = body.startsWith("Goal complete") ? UiBits.okText() : ink;
					} else if (lead.isEmpty()) {
						lead.add(new Run("You", UiStyle.CLAY_DARK));
						if (kind == FeedKind.USER && l.to() != null && !UiBits.isUser(l.to())) {
							lead.add(new Run(" \u2192 ", muted));
							lead.add(new Run(l.to().equals("all") ? "everyone" : UiBits.agentName(l.to()), UiBits.nameOnLight(l.to())));
						}
						lead.add(new Run("  ", ink));
						bodyColor = ink;
					}
					if (kind == FeedKind.USER && stripe == 0) {
						stripe = UiStyle.CLAY;
					}
				}
				default -> {
				}
			}
		}
		// wrap: the lead sits on the first line, continuation lines hang under the text
		int leadW = 0;
		for (Run r : lead) {
			leadW += font.width(r.text());
		}
		String text = body.replace('\n', ' ');
		List<String> first = TextUtil.wrapPlain(font, text, Math.max(40, textW - leadW));
		if (first.isEmpty()) {
			first = List.of("");
		}
		List<Run> r0 = new ArrayList<>(lead);
		r0.add(new Run(first.get(0), header ? ink : bodyColor));
		String faceAgent = agent != null && (UiBits.hasPortrait(agent)) ? agent : null;
		boolean opens = !l.local() && l.kind() == FeedKind.DECISION && l.text().contains("needs you");
		out.add(new Row(time, faceAgent, stripe, r0, header, false, opens, false));
		if (first.size() > 1) {
			String rest = text.substring(Math.min(text.length(), first.get(0).length())).stripLeading();
			List<String> more = TextUtil.wrapPlain(font, rest, textW);
			int max = l.local() ? 12 : 4;
			for (int i = 0; i < Math.min(max, more.size()); i++) {
				String seg = more.get(i);
				if (i == max - 1 && more.size() > max) {
					seg = TextUtil.ellipsize(font, seg + " …", textW);
				}
				out.add(new Row("", null, stripe, List.of(new Run(seg, bodyColor)), false, false, opens, true));
			}
		}
	}

	private static final java.util.regex.Pattern AGENT_ACTION = java.util.regex.Pattern.compile("^(\\w+): (pause|resume|stop|spawn)(.*)$");

	private static String pastTense(String verb) {
		return switch (verb) {
			case "pause" -> "paused";
			case "resume" -> "resumed";
			case "stop" -> "stopped";
			default -> "spawned";
		};
	}

	/**
	 * A local line with tab-separated columns: help (command | what it does) and diff files (path | +a
	 * | -d). Help descriptions wrap in their column (never clipped at narrow GUIs); a command too wide
	 * for the column gets its own row with the description under it.
	 */
	private void columns(List<Row> out, Line l, String body, int stripe, @Nullable String agent, int textW) {
		String[] c = body.split("\t");
		String face = agent != null && UiBits.hasPortrait(agent) ? agent : null;
		List<Run> runs = new ArrayList<>();
		if (l.tone() == Tone.FILE) {
			String path = TextUtil.ellipsize(font, c[0], Math.max(40, textW - 70));
			runs.add(new Run(path, UiBits.ink(), 0));
			int right = rowsWidth - 30;
			String add = c.length > 1 ? c[1] : "";
			String del = c.length > 2 ? " " + c[2] : "";
			int w = font.width(add + del);
			runs.add(new Run(add, UiStyle.color("paper.add_fg", 0xFF455746), Math.max(font.width(path) + 8, right - w)));
			runs.add(new Run(del, UiStyle.color("paper.del_fg", 0xFF873C2A), 0));
			out.add(new Row("", face, stripe, runs, false, false));
			return;
		}
		int col = helpColumn(textW);
		int pathColor = UiStyle.color("paper.path", 0xFF6C5415);
		String cmd = c[0];
		String desc = c.length > 1 ? c[1] : "";
		List<String> descLines = TextUtil.wrapPlain(font, desc, Math.max(40, textW - col));
		if (descLines.isEmpty()) {
			descLines = List.of("");
		}
		int start = 0;
		if (font.width(cmd) + 8 > col) {
			out.add(new Row("", face, stripe, List.of(new Run(TextUtil.ellipsize(font, cmd, textW), pathColor, 0)), false, false));
		} else {
			out.add(new Row("", face, stripe, List.of(new Run(cmd, pathColor, 0), new Run(descLines.get(0), UiBits.muted(), col)), false, false));
			start = 1;
		}
		for (int i = start; i < descLines.size(); i++) {
			out.add(new Row("", null, stripe, List.of(new Run(descLines.get(i), UiBits.muted(), col)), false, false, false, true));
		}
	}

	/** x (from the text start) of the help descriptions: past the usual command widths, at most 45 % of the row. */
	private int helpColumn(int textW) {
		int widest = font.width("@juniper text");
		for (ConsoleCommands.Command cmd : ConsoleCommands.COMMANDS) {
			int w = font.width(cmd.usage());
			// very long usages (/task <id> cancel|retry|...) wrap onto their own row instead of pushing the column
			if (w <= 150) {
				widest = Math.max(widest, w);
			}
		}
		return Math.max(70, Math.min(widest + 10, textW * 45 / 100));
	}

	private static int identity(String agentId, @Nullable ForemanState s) {
		if (UiBits.isUser(agentId)) {
			return UiStyle.CLAY;
		}
		Agent a = s == null ? null : s.agent(agentId);
		int c = dev.agentcraft.Cast.parseColor(a != null ? a.color() : null, -1);
		if (c == -1) {
			var m = dev.agentcraft.Cast.get(agentId);
			return m != null ? 0xFF000000 | m.color() : 0;
		}
		return 0xFF000000 | c;
	}
}

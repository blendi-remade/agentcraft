package dev.agentcraft.client.agents;

import com.mojang.blaze3d.platform.InputConstants;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.dev.DevBridge;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.foreman.Protocol.AgentState;
import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.foreman.Protocol.DecisionKind;
import dev.agentcraft.client.foreman.Protocol.LogEntry;
import dev.agentcraft.client.foreman.Protocol.Task;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import org.jspecify.annotations.Nullable;

/**
 * The agent card: right-click an agent to see who it is and what it is doing, and to steer it.
 * A compact paper card (brass frame while the agent needs you): portrait, name, title and role;
 * the state dot with a plain-words state and the activity; the current task (id, title, column,
 * branch); <b>the decision it waits on</b> with a way to act on it right there (the decision's
 * review screen when one is registered, otherwise its options as rows: press a row twice to
 * answer; "Request changes" asks for the feedback text); decisions it filed that wait on you
 * through another agent; the last log lines; and three actions: <b>Message</b> (opens the console
 * prefilled with {@code @id }, or a message line in the card), <b>Pause/Resume</b>, <b>Stop</b>
 * (off shift; <b>Spawn</b> brings an off-shift agent back).
 *
 * <p>Keys: M message, P pause/resume, 1-4 answer (twice), R review, Esc close. The message line is
 * a vanilla {@link EditBox} drawn in the kit style: it starts SDL text input when it gets focus
 * (real typing works; 26.x delivers typed characters only while text input is on), scrolls to the
 * caret, handles selection, clipboard and surrogate pairs.
 *
 * <p>Live: it follows the Foreman state while open, and the world keeps running behind it.
 * Shootable as {@code dev.screen {open:"agent"}} (last clicked agent, else whoever needs you first)
 * or {@code dev.agents.card {agent}}.
 */
public final class AgentCardScreen extends Screen {
	private static final int W = 252;
	private static final int ROW = 10;
	private static final int OPT_H = 15;
	private static final int MAX_OPTIONS = 4;
	/** Two presses within this time answer a decision row. */
	private static final long ARM_MS = 4000;
	private static @Nullable String lastAgent;
	private static final Map<String, Boolean> PORTRAITS = new HashMap<>();

	private enum Mode {
		NONE, MESSAGE, FEEDBACK
	}

	private final String agentId;
	private int x0;
	private int y0;
	private int h;
	private int logRows = 6;
	private final Btn[] buttons = {new Btn("message"), new Btn("pause"), new Btn("stop"), new Btn("model")};
	private final Btn review = new Btn("review");
	private final List<Btn> optionRows = new ArrayList<>();
	private final Btn[] optionPool = {new Btn("option"), new Btn("option"), new Btn("option"), new Btn("option")};
	private @Nullable String ownedId;
	private @Nullable String status;
	private boolean statusError;
	private long statusUntil;
	private Mode mode = Mode.NONE;
	private @Nullable EditBox field;
	private @Nullable String feedbackFor;
	/** The key that opened the message line, swallowed if SDL also delivers it as a character. */
	private int ignoreChar = -1;
	private long ignoreCharUntil;
	private int armed = -1;
	private @Nullable String armedDecision;
	private long armedUntil;
	private long revision = -1;
	private int logCount = -1;
	private final List<LogEntry> logs = new ArrayList<>();

	// content of this frame (rebuilt in refresh)
	private @Nullable Decision owned;
	private final List<String> decisionLines = new ArrayList<>();
	private @Nullable String decisionContext;
	private final List<Decision> filed = new ArrayList<>();

	private static final class Btn {
		final String id;
		String label = "";
		@Nullable String option;
		boolean primary;
		boolean disabled;
		int x, y, w, h = 20;

		Btn(String id) {
			this.id = id;
		}

		boolean hit(double mx, double my) {
			return !disabled && w > 0 && mx >= x && mx < x + w && my >= y && my < y + h;
		}
	}

	public AgentCardScreen(String agentId) {
		super(Component.literal("Agent"));
		this.agentId = agentId;
		lastAgent = agentId;
	}

	public String agentId() {
		return agentId;
	}

	/** The message line's text, or null when it is closed (QA). */
	public @Nullable String inputText() {
		return field == null ? null : field.getValue();
	}

	/** The agent the card opens for when QA asks without an id: last clicked, else whoever needs you, else the first. */
	public static @Nullable String defaultAgent() {
		ForemanState st = Foreman.state();
		if (lastAgent != null && st != null && st.agent(lastAgent) != null) {
			return lastAgent;
		}
		AgentManager m = AgentManager.get();
		for (ClientAgentEntity e : m.entities().values()) {
			if (e.view().needsYou()) {
				return e.agentId();
			}
		}
		if (st != null && !st.agents().isEmpty()) {
			return st.agents().keySet().iterator().next();
		}
		return null;
	}

	@Override
	protected void init() {
		layout();
	}

	@Override
	protected void repositionElements() {
		// window resize: keep the message line (and what was typed), just lay the card out again
		layout();
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	@Override
	public void extractBackground(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		// no dimming, no blur: the HQ stays alive behind the card
	}

	private @Nullable Agent agent() {
		ForemanState st = Foreman.state();
		return st == null ? null : st.agent(agentId);
	}

	private @Nullable AgentView view() {
		ClientAgentEntity e = AgentManager.get().entity(agentId);
		return e == null ? null : e.view();
	}

	private boolean live() {
		AgentView v = view();
		return Foreman.connected() && (v == null || !v.stale);
	}

	// ---------------------------------------------------------------- content + layout

	private void refresh(ForemanState st) {
		int n = st.logCount(agentId);
		AgentView v = view();
		String want = v != null ? v.awaitingDecision : null;
		boolean changed = st.revision() != revision || n != logCount || !java.util.Objects.equals(want, ownedId);
		if (changed) {
			revision = st.revision();
			logCount = n;
			ownedId = want;
			logs.clear();
			List<LogEntry> all = st.logs(agentId);
			logs.addAll(all.subList(Math.max(0, all.size() - 6), all.size()));
			owned = want != null ? st.decision(want) : null;
			if (owned != null && !owned.isOpen()) {
				owned = null;
			}
			filed.clear();
			for (Decision d : st.openDecisions()) {
				if (d.agentId().equals(agentId) && !AgentManager.owner(st, d).equals(agentId) && filed.size() < 2) {
					filed.add(d);
				}
			}
			decisionLines.clear();
			decisionContext = null;
			if (owned != null) {
				Font font = this.font;
				int avail = W - Kit.padding("panel_paper").left() - Kit.padding("panel_paper").right() - 12;
				List<String> lines = TextUtil.wrapPlain(font, owned.question(), avail);
				if (lines.size() > 2) {
					String rest = String.join(" ", lines.subList(1, lines.size()));
					lines = List.of(lines.get(0), TextUtil.ellipsize(font, rest, avail));
				}
				decisionLines.addAll(lines);
				decisionContext = contextLine(owned);
			}
		}
		if (feedbackFor != null && (owned == null || !owned.id().equals(feedbackFor))) {
			closeField(); // the decision was answered meanwhile
		}
		if (armedDecision != null && (owned == null || !owned.id().equals(armedDecision) || System.currentTimeMillis() > armedUntil)) {
			armed = -1;
			armedDecision = null;
		}
	}

	/** One line of context under a decision: the diff stats of a merge, the command of a permission prompt. */
	private static @Nullable String contextLine(Decision d) {
		String ctx = d.context();
		if (ctx == null || ctx.isBlank() || d.kind() == DecisionKind.QUESTION) {
			return null;
		}
		String first = null;
		for (String line : ctx.split("\n")) {
			String l = line.trim();
			if (l.isEmpty()) {
				continue;
			}
			if (first == null) {
				first = l;
			}
			if (d.kind() == DecisionKind.MERGE && l.contains(" | tests:")) {
				return l;
			}
		}
		return first;
	}

	private int decisionBlockHeight(boolean hasReview, int options) {
		if (owned == null) {
			return 0;
		}
		int inner = 4 + 10 + 2 + decisionLines.size() * ROW + (decisionContext != null ? ROW : 0) + 3;
		inner += hasReview ? 20 : options * (OPT_H + 1);
		return inner + 4 + 6;
	}

	private void layout() {
		Font font = this.font;
		ForemanState st = Foreman.state();
		if (st != null) {
			refresh(st);
		}
		int taskLines = taskLines(font).size();
		Kit.Padding pp = Kit.padding("panel_paper");
		boolean hasReview = owned != null && hasReviewScreen(owned);
		int options = owned == null || hasReview ? 0 : Math.min(MAX_OPTIONS, owned.options().size());
		int fixed = pp.top() + 32 + 16 + (taskLines > 0 ? taskLines * ROW + 12 : 12) + filed.size() * 11 + 4
			+ decisionBlockHeight(hasReview, options) + (field != null ? 24 : 0) + 26 + 10 + pp.bottom();
		logRows = owned != null ? 4 : 6;
		while (logRows > 2 && fixed + logRows * ROW + 8 + 6 > this.height - 8) {
			logRows--;
		}
		h = fixed + logRows * ROW + 8 + 6;
		x0 = (this.width - W) / 2;
		y0 = Math.max(4, (this.height - h) / 2);
	}

	// ---------------------------------------------------------------- drawing

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		Agent ag = agent();
		AgentView v = view();
		ForemanState st = Foreman.state();
		if (ag == null || st == null) {
			onClose();
			return;
		}
		layout();
		Font font = this.font;
		Kit.Padding pp = Kit.padding("panel_paper");
		boolean live = live();
		// the brass frame only while the agent really needs you (not while off shift or offline)
		boolean needsYou = live && v != null && v.needsYou();
		if (needsYou) {
			Panels.framed(g, x0, y0, W, h);
		} else {
			Panels.panel(g, x0, y0, W, h);
		}
		int ix = x0 + pp.left();
		int iw = W - pp.left() - pp.right();
		int y = y0 + pp.top();
		int ink = UiStyle.color("paper.text");
		int muted = UiStyle.color("paper.muted");

		// header: portrait, name, title + role, state on the right
		Identifier portrait = AgentCraft.id("textures/gui/portrait/" + agentId + "_framed.png");
		int textX = ix;
		if (hasPortrait(portrait)) {
			g.blit(RenderPipelines.GUI_TEXTURED, portrait, ix, y, 0, 0, 20, 20, 20, 20);
			textX = ix + 26;
		}
		Panels.text(g, font, ag.name(), textX, y + 1, UiStyle.agentOnLight(agentId));
		String role = ag.role() == Protocol.AgentRole.LEAD ? "lead" : "worker";
		String sub = (ag.title() != null ? ag.title() + " · " : "") + role;
		Panels.text(g, font, TextUtil.ellipsize(font, sub, iw - (textX - ix)), textX, y + 12, muted);
		String fam = v != null ? v.family : ag.state().family();
		String stateLabel = stateLabel(ag, v);
		int sw = font.width(stateLabel);
		int sx = ix + iw - sw;
		Panels.text(g, font, stateLabel, sx, y + 1, ink);
		if (v != null && v.showsPaused()) {
			int bar = UiStyle.color("status.idle", 0xFF9C9488);
			g.fill(sx - 10, y + 1, sx - 8, y + 8, bar);
			g.fill(sx - 6, y + 1, sx - 4, y + 8, bar);
		} else {
			if ("waiting".equals(fam) && live) {
				float pulse = 0.5f + 0.5f * (float) Math.sin(System.currentTimeMillis() / 1000.0 * Math.PI * 2 / 1.2);
				Panels.sprite(g, Kit.dot("waiting", true), sx - 13, y - 1, 11, 11, UiStyle.withAlpha(0xFFFFFFFF, (int) (60 + 150 * pulse)));
			}
			Panels.dot(g, fam, sx - 11, y + 1, false);
		}
		y += 22 + 4;
		Panels.divider(g, ix, y, iw);
		y += 6;

		// activity line
		String act = v != null ? v.activityLine() : ag.activity();
		Panels.text(g, font, TextUtil.ellipsize(font, act.isEmpty() ? "-" : act, iw), ix, y, ink);
		y += 12 + 4;

		// task
		List<String> tl = taskLines(font);
		Task task = ag.taskId() != null ? st.task(ag.taskId()) : null;
		if (task != null) {
			int pw = Panels.pill(g, font, task.id(), ix, y - 1, ink);
			for (int i = 0; i < tl.size(); i++) {
				Panels.text(g, font, tl.get(i), ix + pw + 5, y + i * ROW, ink);
			}
			y += Math.max(1, tl.size()) * ROW + 1;
			String meta = column(task) + (task.branch() != null ? "  " + task.branch() : "");
			Panels.text(g, font, TextUtil.ellipsize(font, meta, iw - pw - 5), ix + pw + 5, y, UiStyle.color("paper.path"));
			y += 11;
		} else {
			Panels.text(g, font, ag.isActive() ? "No task right now" : "Off shift", ix, y, muted);
			y += 12;
		}
		// decisions it filed that wait on you through another agent (the lead's merge requests)
		for (Decision d : filed) {
			Panels.text(g, font, TextUtil.ellipsize(font, filedLine(st, d), iw), ix, y, muted);
			y += 11;
		}
		y += 4;

		// the decision it waits on, with the way to act on it
		boolean hasReview = owned != null && hasReviewScreen(owned);
		optionRows.clear();
		review.w = 0;
		if (owned != null) {
			y = drawDecision(g, font, owned, v, ix, y, iw, hasReview, mouseX, mouseY, live);
		}

		// log tail
		int logH = logRows * ROW + 8;
		Panels.inset(g, ix, y, iw, logH);
		Kit.Padding ip = Kit.padding("panel_inset");
		int ly = y + ip.top();
		int start = Math.max(0, logs.size() - logRows);
		if (logs.isEmpty()) {
			Panels.text(g, font, "No log yet", ix + ip.left() + 1, ly, muted);
		}
		for (int i = start; i < logs.size(); i++) {
			LogEntry le = logs.get(i);
			int lx = ix + ip.left() + 1;
			int avail = iw - ip.left() - ip.right() - 2;
			String text = TextUtil.firstLine(le.text());
			if (le.kind() == Protocol.LogKind.TOOL) {
				Panels.sprite(g, Kit.icon(toolIcon(text)), lx, ly - 2, 12, 12);
				lx += 14;
				avail -= 14;
			}
			Panels.text(g, font, TextUtil.ellipsize(font, text, avail), lx, ly, logColor(le.kind()));
			ly += ROW;
		}
		y += logH + 6;

		// message / feedback line (a vanilla EditBox in the kit's text field)
		EditBox f = field;
		if (f != null) {
			Panels.sprite(g, Kit.TEXT_FIELD_FOCUSED, ix, y, iw, 18);
			String tag = mode == Mode.FEEDBACK ? "changes" : "@" + ag.name();
			int tagColor = mode == Mode.FEEDBACK ? UiStyle.color("paper.link") : UiStyle.agentOnLight(agentId);
			int pw = Panels.pill(g, font, tag, ix + 3, y + 3, tagColor);
			int fx = ix + 3 + pw + 4;
			f.setX(fx);
			f.setY(y + 5);
			f.setWidth(ix + iw - 5 - fx);
			f.extractRenderState(g, mouseX, mouseY, a);
			y += 24;
		}

		// actions
		layoutButtons(ag, ix, y, iw);
		for (Btn b : buttons) {
			drawButton(g, font, b, mouseX, mouseY);
		}
		y += 20 + 6;

		// hints or the last action's result
		if (status != null && System.currentTimeMillis() < statusUntil) {
			Panels.text(g, font, TextUtil.ellipsize(font, status, iw), ix, y, statusError ? UiStyle.color("paper.del_fg") : UiStyle.color("paper.add_fg"));
		} else if (!live) {
			int hx = hint(g, font, ix, y, ix + iw, "Esc", "close");
			Panels.text(g, font, TextUtil.ellipsize(font, "Foreman offline: read only", ix + iw - hx), hx, y, muted);
		} else if (field != null) {
			int hx = hint(g, font, ix, y, ix + iw, "Enter", "send");
			hint(g, font, hx, y, ix + iw, "Esc", "cancel");
		} else if (armed >= 0 && armed < optionRows.size()) {
			int hx = hint(g, font, ix, y, ix + iw, String.valueOf(armed + 1), "again to answer");
			hint(g, font, hx, y, ix + iw, "Esc", "close");
		} else {
			int right = ix + iw;
			int hx = hint(g, font, ix, y, right, "M", "msg");
			hx = hint(g, font, hx, y, right, "O", "model");
			if (ag.isActive()) {
				hx = hint(g, font, hx, y, right, "P", ag.isPaused() ? "resume" : "pause");
			}
			if (!optionRows.isEmpty()) {
				hx = hint(g, font, hx, y, right, optionRows.size() == 1 ? "1" : "1-" + optionRows.size(), "answer");
			} else if (review.w > 0) {
				hx = hint(g, font, hx, y, right, "R", "review");
			}
			hint(g, font, hx, y, right, "Esc", "close");
		}
	}

	/** The "waits on you" block: kind, ids, the question, one context line, then the review button or the option rows. */
	private int drawDecision(GuiGraphicsExtractor g, Font font, Decision d, @Nullable AgentView v, int ix, int y, int iw, boolean hasReview, int mx,
		int my, boolean live) {
		int options = hasReview ? 0 : Math.min(MAX_OPTIONS, d.options().size());
		int bh = decisionBlockHeight(hasReview, options) - 6;
		Panels.inset(g, ix, y, iw, bh);
		int bx = ix + 6;
		int bw = iw - 12;
		int by = y + 4;
		String kind = switch (d.kind()) {
			case MERGE -> "Merge review";
			case PERMISSION -> "Permission";
			default -> "Question";
		};
		String head = kind + " · " + d.id() + (d.taskId() != null ? " · " + d.taskId() : "");
		Panels.text(g, font, head, bx, by, live ? UiStyle.color("paper.link") : UiStyle.color("paper.muted"));
		if (v != null && v.awaitingCount > 1) {
			String more = "+" + (v.awaitingCount - 1) + " more";
			Panels.text(g, font, more, bx + bw - font.width(more), by, UiStyle.color("paper.muted"));
		}
		by += 10 + 2;
		for (String line : decisionLines) {
			Panels.text(g, font, line, bx, by, UiStyle.color("paper.text"));
			by += ROW;
		}
		if (decisionContext != null) {
			Panels.text(g, font, TextUtil.ellipsize(font, decisionContext, bw), bx, by, UiStyle.color("paper.muted"));
			by += ROW;
		}
		by += 3;
		if (hasReview) {
			review.label = switch (d.kind()) {
				case MERGE -> "Review the diff";
				case PERMISSION -> "Decide";
				default -> "Answer";
			};
			review.primary = true;
			review.disabled = !live;
			review.x = bx;
			review.y = by;
			review.w = bw;
			review.h = 20;
			drawButton(g, font, review, mx, my);
			by += 20;
		} else {
			for (int i = 0; i < options; i++) {
				String opt = d.options().get(i);
				Btn row = optionPool[i];
				row.option = opt;
				row.x = bx;
				row.y = by;
				row.w = bw;
				row.h = OPT_H;
				row.disabled = !live;
				optionRows.add(row);
				boolean isArmed = armed == i && d.id().equals(armedDecision);
				boolean hover = row.hit(mx, my);
				String state = row.disabled ? "disabled" : hover ? "hover" : "normal";
				Panels.sprite(g, Kit.button(isArmed, state), row.x, row.y, row.w, row.h);
				String key = String.valueOf(i + 1);
				int kw = font.width(key) + 8;
				Panels.sprite(g, Kit.KEYCAP, row.x + 3, row.y + 2, kw, 11);
				Panels.text(g, font, key, row.x + 7, row.y + 4, UiStyle.color("paper.text"));
				String label = optionLabel(d, opt);
				if (isArmed) {
					label = "Answer: " + label;
				}
				int labelColor = row.disabled ? UiStyle.color("paper.disabled")
					: isArmed ? UiStyle.color("palette.ui.panel_hi", UiStyle.CREAM) : UiStyle.color("paper.text");
				Panels.text(g, font, TextUtil.ellipsize(font, label, row.w - kw - 12), row.x + kw + 7, row.y + 4, labelColor);
				by += OPT_H + 1;
			}
		}
		return y + bh + 6;
	}

	private static String optionLabel(Decision d, String opt) {
		return Protocol.REQUEST_CHANGES.equals(opt) ? opt + "…" : opt;
	}

	private void drawButton(GuiGraphicsExtractor g, Font font, Btn b, int mouseX, int mouseY) {
		if (b.primary && !b.disabled) {
			// Panels.button tints primary labels with palette.ui.highlight, which is the clay of the button
			// itself; draw the label in the light panel colour instead
			Panels.button(g, font, "", b.x, b.y, b.w, true, b.hit(mouseX, mouseY), false);
			String l = TextUtil.ellipsize(font, b.label, b.w - 12);
			Panels.text(g, font, l, b.x + (b.w - font.width(l)) / 2, b.y + 6, UiStyle.color("palette.ui.panel_hi", UiStyle.CREAM));
		} else {
			Panels.button(g, font, b.label, b.x, b.y, b.w, b.primary, b.hit(mouseX, mouseY), b.disabled);
		}
	}

	private String filedLine(ForemanState st, Decision d) {
		String owner = AgentManager.owner(st, d);
		Agent o = st.agent(owner);
		String who = o != null ? o.name() : owner;
		String what = d.kind() == DecisionKind.MERGE ? "merge of " + (d.taskId() != null ? d.taskId() : d.worktree()) : d.kind().wire();
		return "Filed " + d.id() + " for you: " + what + " (" + who + "'s work)";
	}

	/** Draws a key hint; returns the x after it (stops drawing once it would pass {@code right}). */
	private int hint(GuiGraphicsExtractor g, Font font, int x, int y, int right, String key, String verb) {
		int kw = font.width(key) + 8;
		int end = x + kw + 3 + font.width(verb);
		if (end > right) {
			return right;
		}
		Panels.sprite(g, Kit.KEYCAP, x, y - 2, kw, 12);
		Panels.text(g, font, key, x + 4, y, UiStyle.color("paper.text"));
		Panels.text(g, font, verb, x + kw + 3, y, UiStyle.color("paper.muted"));
		return end + 10;
	}

	private void layoutButtons(Agent ag, int ix, int y, int iw) {
		Btn msg = buttons[0];
		Btn pause = buttons[1];
		Btn stop = buttons[2];
		boolean on = live();
		msg.label = field != null ? "Send" : "Message";
		// one call to action at a time: the decision block's when there is one
		msg.primary = field != null || owned == null;
		msg.disabled = !on;
		pause.label = ag.isPaused() ? "Resume" : "Pause";
		pause.primary = false;
		pause.disabled = !on || !ag.isActive();
		stop.label = ag.isActive() ? "Stop" : "Spawn";
		stop.primary = false;
		stop.disabled = !on;
		int gap = 6;
		int bw = (iw - (buttons.length - 1) * gap) / buttons.length;
		msg.x = ix;
		pause.x = ix + bw + gap;
		stop.x = ix + 2 * (bw + gap);
		buttons[3].label = "Model";
		buttons[3].disabled = !Foreman.connected();
		int column = 0;
		for (Btn b : buttons) {
			b.x = ix + column++ * (bw + gap);
			b.y = y;
			b.w = bw;
		}
		buttons[buttons.length - 1].w = iw - (buttons.length - 1) * (bw + gap);
	}

	private List<String> taskLines(Font font) {
		Agent ag = agent();
		ForemanState st = Foreman.state();
		if (ag == null || st == null || ag.taskId() == null) {
			return List.of();
		}
		Task t = st.task(ag.taskId());
		if (t == null) {
			return List.of();
		}
		int pw = font.width(t.id()) + Kit.padding("pill").left() + Kit.padding("pill").right();
		int avail = W - Kit.padding("panel_paper").left() - Kit.padding("panel_paper").right() - pw - 5;
		List<String> lines = TextUtil.wrapPlain(font, t.title(), avail);
		if (lines.size() > 2) {
			String rest = String.join(" ", lines.subList(1, lines.size()));
			lines = List.of(lines.get(0), TextUtil.ellipsize(font, rest, avail));
		}
		return lines;
	}

	private static String stateLabel(Agent a, @Nullable AgentView v) {
		if (v != null && v.stale) {
			return "Offline";
		}
		if (!a.isActive()) {
			return "Off shift";
		}
		if (a.isPaused()) {
			return "Paused";
		}
		if (a.state() == AgentState.WAITING_USER || v != null && "waiting".equals(v.family)) {
			return "Waiting for you";
		}
		return switch (a.state()) {
			case UNKNOWN -> "Idle";
			default -> {
				String s = a.state().wire();
				yield Character.toUpperCase(s.charAt(0)) + s.substring(1);
			}
		};
	}

	private static String column(Task t) {
		return switch (t.status()) {
			case TODO -> "To do";
			case DOING -> "Doing";
			case REVIEW -> "In review";
			case DONE -> "Done";
			case BLOCKED -> "Blocked";
			case CANCELLED -> "Cancelled";
			default -> "";
		};
	}

	private static int logColor(Protocol.LogKind k) {
		return switch (k) {
			case TOOL -> UiStyle.color("paper.path");
			case RESULT -> UiStyle.color("paper.add_fg");
			case ERROR -> UiStyle.color("paper.del_fg");
			case DIFF -> UiStyle.color("paper.hunk");
			default -> UiStyle.color("paper.text");
		};
	}

	/** Kit icon for a tool log line ("Read src/x.ts", "$ npm test", "write_memory ..."). */
	static String toolIcon(String text) {
		String t = text.toLowerCase(Locale.ROOT).trim();
		if (t.startsWith("read") || t.startsWith("grep") || t.startsWith("glob")) {
			return "read";
		}
		if (t.startsWith("edit") || t.startsWith("write ") || t.startsWith("multiedit") || t.startsWith("patch")) {
			return "edit";
		}
		if (t.contains("memory")) {
			return "memory";
		}
		if (t.startsWith("$ git") || t.startsWith("git") || t.startsWith("diff")) {
			return "git";
		}
		if (t.contains("test")) {
			return "test";
		}
		if (t.contains("merge")) {
			return "merge";
		}
		if (t.contains("send_message") || t.contains("ask_user")) {
			return "message";
		}
		if (t.contains("task")) {
			return "decision";
		}
		return "bash";
	}

	private boolean hasPortrait(Identifier id) {
		return PORTRAITS.computeIfAbsent(id.toString(), k -> Minecraft.getInstance().getResourceManager().getResource(id).isPresent());
	}

	// ---------------------------------------------------------------- review screens

	/** DevBridge screens that can show a decision of this kind (they take no arguments). */
	private static String[] screenNames(DecisionKind kind) {
		return switch (kind) {
			case MERGE -> new String[] {"diff", "decision"};
			case PERMISSION -> new String[] {"permission", "decision"};
			default -> new String[] {"decision"};
		};
	}

	private boolean hasReviewScreen(Decision d) {
		return AgentsFeature.decisionScreen(d.kind()) != null || genericScreen(d) != null;
	}

	/**
	 * A no-argument DevBridge screen that would show exactly this decision: a kind-specific one
	 * ("diff", "permission") when it is the oldest open decision of its kind, the generic "decision"
	 * screen when it is the oldest open decision of all (what such screens open by default).
	 */
	private static @Nullable Function<Minecraft, Screen> genericScreen(Decision d) {
		ForemanState st = Foreman.state();
		if (st == null) {
			return null;
		}
		Decision oldestOfKind = st.oldestOpen(d.kind());
		List<Decision> open = st.openDecisions();
		Decision oldest = open.isEmpty() ? null : open.get(0);
		for (String name : screenNames(d.kind())) {
			Function<Minecraft, Screen> f = DevBridge.screens().get(name);
			if (f == null) {
				continue;
			}
			Decision def = name.equals("decision") ? oldest : oldestOfKind;
			if (def != null && def.id().equals(d.id())) {
				return f;
			}
		}
		return null;
	}

	private void openReview(Decision d) {
		Screen s = null;
		try {
			AgentsFeature.DecisionScreenFactory f = AgentsFeature.decisionScreen(d.kind());
			if (f != null) {
				s = f.create(this.minecraft, d);
			}
			if (s == null) {
				Function<Minecraft, Screen> gf = genericScreen(d);
				if (gf != null) {
					s = gf.apply(this.minecraft);
				}
			}
		} catch (RuntimeException ex) {
			AgentCraft.LOGGER.warn("decision screen for {} failed to open", d.id(), ex);
		}
		if (s != null) {
			this.minecraft.gui.setScreen(s);
		} else {
			setStatus("No review screen for " + d.id(), true);
		}
	}

	// ---------------------------------------------------------------- input

	@Override
	public boolean mouseClicked(MouseButtonEvent event, boolean doubleClick) {
		if (event.button() == InputConstants.MOUSE_BUTTON_LEFT) {
			for (Btn b : buttons) {
				if (b.hit(event.x(), event.y())) {
					press(b.id);
					return true;
				}
			}
			if (review.hit(event.x(), event.y())) {
				press("review");
				return true;
			}
			for (int i = 0; i < optionRows.size(); i++) {
				if (optionRows.get(i).hit(event.x(), event.y())) {
					option(i);
					return true;
				}
			}
			if (event.x() < x0 || event.x() > x0 + W || event.y() < y0 || event.y() > y0 + h) {
				onClose();
				return true;
			}
		}
		return super.mouseClicked(event, doubleClick);
	}

	@Override
	public boolean keyPressed(KeyEvent event) {
		if (field != null) {
			if (event.isEscape()) {
				closeField();
				return true;
			}
			if (event.isConfirmation()) {
				press("message");
				return true;
			}
			// everything else edits the line (arrows, backspace, selection, clipboard ...)
			super.keyPressed(event);
			return true;
		}
		int key = event.key();
		if (key == InputConstants.KEY_O) {
			press("model");
			return true;
		}
		if (key == InputConstants.KEY_M) {
			press("message");
			if (field != null) {
				ignoreChar = 'm';
				ignoreCharUntil = System.currentTimeMillis() + 60;
			}
			return true;
		}
		if (key == InputConstants.KEY_P) {
			press("pause");
			return true;
		}
		if (key == InputConstants.KEY_R && review.w > 0) {
			press("review");
			return true;
		}
		if (key >= InputConstants.KEY_1 && key <= InputConstants.KEY_4) {
			int i = key - InputConstants.KEY_1;
			if (i < optionRows.size()) {
				option(i);
				return true;
			}
		}
		return super.keyPressed(event);
	}

	@Override
	public boolean charTyped(CharacterEvent event) {
		if (field == null) {
			return false;
		}
		int cp = event.codepoint();
		if (ignoreChar >= 0 && System.currentTimeMillis() < ignoreCharUntil && Character.toLowerCase(cp) == ignoreChar) {
			ignoreChar = -1;
			return true;
		}
		ignoreChar = -1;
		return super.charTyped(event);
	}

	private void openField(Mode m, @Nullable String decisionId) {
		if (field == null) {
			EditBox f = new EditBox(this.font, x0 + 60, y0, W - 80, 10, Component.literal(m == Mode.FEEDBACK ? "Requested changes" : "Message"));
			f.setBordered(false);
			f.setTextShadow(false);
			f.setTextColor(UiStyle.color("paper.text"));
			f.setTextColorUneditable(UiStyle.color("paper.disabled"));
			f.setMaxLength(2000);
			f.setCanLoseFocus(false);
			field = addRenderableWidget(f);
		}
		mode = m;
		feedbackFor = decisionId;
		// focusing the EditBox starts SDL text input, so real key presses arrive as characters
		setFocused(field);
		field.setFocused(true);
	}

	private void closeField() {
		EditBox f = field;
		if (f != null) {
			f.setCanLoseFocus(true);
			removeWidget(f); // clears the focus: SDL text input stops
			f.setFocused(false);
		}
		field = null;
		mode = Mode.NONE;
		feedbackFor = null;
	}

	/** Press a decision row: the first press arms it, the second answers (or asks for the change request text). */
	private void option(int i) {
		Decision d = owned;
		if (d == null || i >= optionRows.size() || !live()) {
			return;
		}
		String opt = optionRows.get(i).option;
		if (opt == null) {
			return;
		}
		if (Protocol.REQUEST_CHANGES.equals(opt)) {
			armed = -1;
			armedDecision = null;
			openField(Mode.FEEDBACK, d.id());
			return;
		}
		long now = System.currentTimeMillis();
		if (armed == i && d.id().equals(armedDecision) && now <= armedUntil) {
			armed = -1;
			armedDecision = null;
			send(Foreman.answer(d.id(), opt, null), "Answered " + d.id() + ": " + opt);
		} else {
			armed = i;
			armedDecision = d.id();
			armedUntil = now + ARM_MS;
		}
	}

	private void press(String id) {
		Agent ag = agent();
		if (ag == null) {
			return;
		}
		if (id.equals("model")) {
			if (Foreman.connected()) this.minecraft.gui.setScreen(new AgentModelScreen(this, agentId));
			else setStatus("The Foreman is offline", true);
			return;
		}
		if (!live()) {
			setStatus("The Foreman is offline", true);
			return;
		}
		switch (id) {
			case "message" -> {
				EditBox f = field;
				if (f != null) {
					String text = f.getValue().trim();
					if (text.isEmpty()) {
						return;
					}
					if (mode == Mode.FEEDBACK && feedbackFor != null) {
						String d = feedbackFor;
						closeField();
						send(Foreman.answer(d, Protocol.REQUEST_CHANGES, text), "Requested changes on " + d);
					} else {
						closeField();
						send(Foreman.message(agentId, text), "Sent to " + ag.name());
					}
				} else if (!openConsole(this.minecraft, "@" + agentId + " ")) {
					openField(Mode.MESSAGE, null);
				}
			}
			case "pause" -> {
				if (!ag.isActive()) {
					return;
				}
				boolean resume = ag.isPaused();
				send(Foreman.agentAction(agentId, resume ? "resume" : "pause", null), ag.name() + (resume ? " resumed" : " paused"));
			}
			case "stop" -> {
				boolean spawn = !ag.isActive();
				send(Foreman.agentAction(agentId, spawn ? "spawn" : "stop", null), ag.name() + (spawn ? " is back on shift" : " is off shift"));
			}
			case "review" -> {
				if (owned != null) {
					openReview(owned);
				}
			}
			default -> {
			}
		}
	}

	private void setStatus(String text, boolean error) {
		status = text;
		statusError = error;
		statusUntil = System.currentTimeMillis() + 4000;
	}

	private void send(CompletableFuture<Protocol.Ack> f, String ok) {
		status = "...";
		statusError = false;
		statusUntil = System.currentTimeMillis() + 20_000;
		f.whenComplete((ack, err) -> Minecraft.getInstance().execute(() -> {
			if (err != null || ack == null || !ack.ok()) {
				setStatus(err != null ? "Could not reach the Foreman" : ack == null ? "No answer" : "Foreman: " + (ack.error() != null ? ack.error() : "refused"),
					true);
			} else {
				setStatus(ok, false);
			}
		}));
	}

	/**
	 * Open the console screen (whatever the console feature registered as "console") with
	 * {@code prefill} typed into its input, exactly as a player would type it. False when there is no
	 * console screen.
	 */
	public static boolean openConsole(Minecraft mc, String prefill) {
		Function<Minecraft, Screen> f = DevBridge.screens().get("console");
		if (f == null) {
			return false;
		}
		Screen s;
		try {
			s = f.apply(mc);
		} catch (RuntimeException ex) {
			AgentCraft.LOGGER.warn("console screen failed to open", ex);
			return false;
		}
		if (s == null) {
			return false;
		}
		mc.gui.setScreen(s);
		for (int i = 0; i < prefill.length();) {
			int cp = prefill.codePointAt(i);
			i += Character.charCount(cp);
			s.charTyped(new CharacterEvent(cp));
		}
		return true;
	}
}

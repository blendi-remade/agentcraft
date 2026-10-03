package dev.agentcraft.client.hud;

import dev.agentcraft.client.decisions.DecisionScreen;
import dev.agentcraft.client.decisions.DecisionsFeature;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Goal;
import dev.agentcraft.client.foreman.Protocol.GoalStatus;
import dev.agentcraft.client.foreman.Protocol.Task;
import dev.agentcraft.client.foreman.Protocol.TaskStatus;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElement;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;

/**
 * Boss-bar style goal progress at the top centre: the goal text with its status dot and percentage,
 * a progress bar, and the task counts by column. Under it hangs the decisions badge
 * ("2 waiting · J", pulsing clay) whenever decisions are open. With no goal yet a small hint says how
 * to give one. Dimmed while the Foreman link is down (last known state).
 */
public final class GoalBar implements HudElement {
	public static final int TOP = 6;
	private static final int MAX_W = 300;
	/** Narrower than this and the bar moves below the connection pill instead of squeezing next to it. */
	private static final int MIN_W = 220;
	/** Free GUI px kept between the bar and the connection pill. */
	private static final int PILL_GAP = 6;
	private static final long DONE_FADE_MS = 60_000;

	private long cachedRevision = -1;
	private final int[] counts = new int[5]; // doing review todo blocked done
	private int totalTasks;

	/** Bottom edge of what this element drew last frame (toasts / other HUD stack below it). */
	public static int bottom = 0;
	/** Right edge of the widest thing it drew last frame (0 = nothing). */
	public static int right = 0;
	/** QA: something drawn last frame intersected the connection pill. */
	public static boolean pillClash;

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, DeltaTracker deltaTracker) {
		Minecraft mc = Minecraft.getInstance();
		ForemanState s = Foreman.state();
		bottom = 0;
		right = 0;
		pillClash = false;
		if (mc.player == null || s == null || !s.hasData()) {
			return;
		}
		Font font = mc.font;
		int y = TOP + authBannerOffset(s, font, g);
		boolean stale = s.isStale();
		// panels stay opaque (legible over any background); offline / long-done content is dimmed instead
		int alpha = stale ? 200 : 255;
		Goal goal = s.goal();
		boolean decisionScreen = mc.gui.screen() instanceof DecisionScreen;
		if (goal != null) {
			long age = System.currentTimeMillis() - goal.updatedAt();
			if (goal.status() == GoalStatus.DONE && age > DONE_FADE_MS) {
				alpha = Math.min(alpha, 190);
			}
			y = drawGoal(g, font, s, goal, y, alpha, stale);
		} else if (!stale) {
			y = drawNoGoal(g, font, y);
		}
		int waiting = DecisionsFeature.waitingCount();
		if (waiting > 0 && !decisionScreen) {
			y = drawBadge(g, font, waiting, y + 2, alpha);
		}
		bottom = y;
	}

	/** The connection feature draws a loud paper banner at the top centre when auth failed: stack below it. */
	private static int authBannerOffset(ForemanState s, Font font, GuiGraphicsExtractor g) {
		var fs = s.status();
		if (fs == null || fs.auth() != dev.agentcraft.client.foreman.Protocol.AuthStatus.FAILED || !s.link().synced()) {
			return 0;
		}
		String msg = ConnectionBanner.authMessage(fs);
		int maxW = Math.min(360, g.guiWidth() - 40);
		int lines = TextUtil.wrap(font, msg, maxW - 34).size();
		Kit.Padding p = Kit.padding("panel_paper");
		return p.top() + 10 + lines * 10 + p.bottom() + 4;
	}

	private void recount(ForemanState s, Goal goal) {
		if (s.revision() == cachedRevision) {
			return;
		}
		cachedRevision = s.revision();
		java.util.Arrays.fill(counts, 0);
		totalTasks = 0;
		for (Task t : s.tasks().values()) {
			if (goal.id() != null && t.goalId() != null && !t.goalId().equals(goal.id())) {
				continue;
			}
			int i = switch (t.status()) {
				case DOING -> 0;
				case REVIEW -> 1;
				case TODO -> 2;
				case BLOCKED -> 3;
				case DONE -> 4;
				default -> -1;
			};
			if (i >= 0) {
				counts[i]++;
				totalTasks++;
			}
		}
	}

	/**
	 * Where a centred element {@code wantW} wide (at most) goes at row {@code y}: beside the connection
	 * pill (top right) when it fits there at {@code minW} or more, else below the pill. The pill's real
	 * extent comes from this frame ({@link ConnectionBanner} draws first), so a long "Reconnecting to the
	 * Foreman (5) / showing last known state" pill never lands on the bar. Returns x, y, w.
	 */
	private static int[] place(GuiGraphicsExtractor g, int y, int h, int wantW, int minW) {
		int gw = g.guiWidth();
		int w = Math.min(wantW, gw - 24);
		int x = (gw - w) / 2;
		int pl = ConnectionBanner.pillLeft;
		int pb = ConnectionBanner.pillBottom;
		boolean rowsMeet = pb > 0 && y < pb + 3 && y + h > 0;
		if (rowsMeet && x + w > pl - PILL_GAP) {
			int fit = 2 * (pl - PILL_GAP - gw / 2);
			if (fit >= Math.min(minW, wantW)) {
				w = Math.min(w, fit);
				x = (gw - w) / 2;
			} else {
				y = pb + 4;
			}
		}
		if (pb > 0 && x + w > pl && y < pb) {
			pillClash = true;
		}
		return new int[] {x, y, w};
	}

	/** While planning: the lead is planning, unless it is waiting on your answer (a question before the plan). */
	static String planningLine(ForemanState s) {
		for (var a : s.agents().values()) {
			if (a.role() == dev.agentcraft.client.foreman.Protocol.AgentRole.LEAD) {
				return a.state() == dev.agentcraft.client.foreman.Protocol.AgentState.WAITING_USER
					? a.name() + " needs your answer before planning"
					: a.name() + " is planning the tasks…";
			}
		}
		return "Marlow is planning the tasks…";
	}

	private int drawGoal(GuiGraphicsExtractor g, Font font, ForemanState s, Goal goal, int y0, int alpha, boolean stale) {
		recount(s, goal);
		Kit.Padding p = Kit.padding("tooltip");
		int h = p.top() + 9 + 4 + 6 + 4 + 9 + p.bottom();
		int[] at = place(g, y0, h, MAX_W, MIN_W);
		int x = at[0];
		int y = at[1];
		int w = at[2];
		right = Math.max(right, x + w);
		int tint = (alpha << 24) | 0xFFFFFF;
		Panels.sprite(g, Kit.TOOLTIP, x, y, w, h);
		int ix = x + p.left() + 1;
		int iw = w - p.left() - p.right() - 2;
		int ty = y + p.top();

		String family;
		String fill;
		String prefix = "";
		switch (goal.status()) {
			case PLANNING -> {
				family = "thinking";
				fill = "brass";
				prefix = "Planning · ";
			}
			case DONE -> {
				family = "done";
				fill = "sage";
				prefix = "Done " + UiBits.CHECK + "  ";
			}
			case FAILED -> {
				family = "error";
				fill = "red";
				prefix = "Failed · ";
			}
			case CANCELLED -> {
				family = "idle";
				fill = "brass";
				prefix = "Cancelled · ";
			}
			default -> {
				family = "working";
				fill = "teal";
			}
		}
		if (stale) {
			// last known state: no live status colour (the pill says it is reconnecting)
			family = "idle";
		}
		Panels.sprite(g, Kit.dot(family, false), ix, ty + 1, 7, 7, tint);
		int pct = (int) Math.round(Math.max(0, Math.min(1, goal.progress())) * 100);
		String pctS = pct + "%";
		int pctW = font.width(pctS);
		String text = prefix + UiBits.oneLine(goal.text());
		int textColor = stale ? UiBits.activityOnInk() : UiBits.cream();
		g.text(font, TextUtil.ellipsize(font, text, iw - 11 - pctW - 8), ix + 11, ty, UiStyle.withAlpha(textColor, alpha), false);
		g.text(font, pctS, ix + iw - pctW, ty, UiStyle.withAlpha(stale ? UiBits.activityOnInk() : UiStyle.BRASS, alpha), false);

		int by = ty + 9 + 4;
		Panels.sprite(g, Kit.PROGRESS_TRACK, ix, by, iw, 6, tint);
		int fw = (int) Math.round(Math.max(0, Math.min(1, goal.progress())) * iw);
		if (fw >= 4) {
			Panels.sprite(g, Kit.progressFill(fill), ix, by, fw, 6, tint);
		}

		// task counts by column, each with its status dot
		int cy = by + 6 + 4;
		String[] labels = {"doing", "review", "todo", "blocked", "done"};
		String[] fams = {"working", "thinking", "idle", "error", "done"};
		int cx = ix;
		int act = UiStyle.withAlpha(UiBits.activityOnInk(), alpha);
		if (totalTasks == 0) {
			g.text(font, goal.status() == GoalStatus.PLANNING ? planningLine(s) : "no tasks yet", cx, cy, act, false);
		} else {
			// done count on the right ("2/9 done"), the open columns on the left with labels when they fit
			String done = counts[4] + "/" + totalTasks + " done";
			int doneW = font.width(done);
			Panels.sprite(g, Kit.dot("done", false), ix + iw - doneW - 9, cy + 1, 7, 7, tint);
			g.text(font, done, ix + iw - doneW, cy, act, false);
			int room = iw - doneW - 9 - 10;
			boolean withLabels = countsWidth(font, labels, true) <= room;
			int open = counts[0] + counts[1] + counts[2] + counts[3];
			if (open == 0) {
				String all = goal.status() == GoalStatus.DONE ? "finished " + UiBits.ago(goal.updatedAt()) : "nothing open right now";
				g.text(font, TextUtil.ellipsize(font, all, room), cx, cy, act, false);
			}
			for (int i = 0; i < 4; i++) {
				if (counts[i] == 0) {
					// empty columns say nothing ("0 doing" next to "7/7 done" reads like a problem)
					continue;
				}
				String c = counts[i] + (withLabels ? " " + labels[i] : "");
				if (cx + 9 + font.width(c) > ix + room) {
					break;
				}
				Panels.sprite(g, Kit.dot(fams[i], false), cx, cy + 1, 7, 7, tint);
				g.text(font, c, cx + 9, cy, act, false);
				cx += 9 + font.width(c) + 8;
			}
		}
		return y + h;
	}

	private int countsWidth(Font font, String[] labels, boolean withLabels) {
		int w = 0;
		for (int i = 0; i < 4; i++) {
			if (counts[i] == 0) {
				continue;
			}
			w += 9 + font.width(counts[i] + (withLabels ? " " + labels[i] : "")) + 8;
		}
		return Math.max(0, w - 8);
	}

	private int drawNoGoal(GuiGraphicsExtractor g, Font font, int y0) {
		String key = Keys.console == null ? "Backtick" : Keys.label(Keys.console);
		String a = "No goal yet · press";
		String b = "to give the team one";
		Kit.Padding p = Kit.padding("tooltip");
		int kw = UiBits.keycapWidth(font, key);
		int w = p.left() + 11 + font.width(a) + 4 + kw + 4 + font.width(b) + p.right() + 2;
		int h = p.top() + 10 + p.bottom() + 1;
		int[] at = place(g, y0, h, w, w);
		int x = at[0];
		int y = at[1];
		right = Math.max(right, x + w);
		Panels.sprite(g, Kit.TOOLTIP, x, y, w, h, 0xE6FFFFFF);
		int cx = x + p.left() + 1;
		int ty = y + p.top() + 1;
		Panels.dot(g, "idle", cx, ty, false);
		cx += 11;
		g.text(font, a, cx, ty, UiBits.activityOnInk(), false);
		cx += font.width(a) + 4;
		UiBits.keycap(g, font, key, cx, ty - 2);
		cx += kw + 4;
		g.text(font, b, cx, ty, UiBits.activityOnInk(), false);
		return y + h;
	}

	private int drawBadge(GuiGraphicsExtractor g, Font font, int waiting, int y0, int alpha) {
		String key = Keys.decisions == null ? "J" : Keys.label(Keys.decisions);
		String text = waiting + " waiting · press";
		Kit.Padding p = Kit.padding("tooltip");
		int kw = UiBits.keycapWidth(font, key);
		int w = p.left() + 13 + font.width(text) + 4 + kw + p.right() + 1;
		int h = p.top() + 10 + p.bottom() + 1;
		int[] at = place(g, y0, h, w, w);
		int x = at[0];
		int y = at[1];
		right = Math.max(right, x + w);
		Panels.sprite(g, Kit.TOOLTIP, x, y, w, h);
		int cx = x + p.left() + 2;
		int ty = y + p.top() + 1;
		boolean stale = Foreman.state() != null && Foreman.state().isStale();
		if (stale) {
			// can't be answered until the Foreman is back: no pulse, no clay
			Panels.sprite(g, Kit.dot("idle", false), cx, ty, 7, 7);
		} else {
			UiBits.pulsingDot(g, "waiting", cx, ty);
		}
		cx += 11;
		g.text(font, text, cx, ty, UiStyle.withAlpha(stale ? UiBits.activityOnInk() : UiStyle.CLAY, alpha), false);
		cx += font.width(text) + 4;
		UiBits.keycap(g, font, key, cx, ty - 2);
		return y + h;
	}
}

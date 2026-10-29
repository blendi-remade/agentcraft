package dev.agentcraft.client.hud;

import dev.agentcraft.client.decisions.DecisionScreen;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanListener;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.foreman.Protocol.Notify;
import dev.agentcraft.client.foreman.Protocol.NotifyLevel;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import dev.agentcraft.client.ui.Tr;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElement;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.util.FormattedCharSequence;
import net.minecraft.util.Util;
import org.jspecify.annotations.Nullable;

/**
 * In-game paper toasts for the Foreman's {@code notify}: the agent's framed portrait, who it is
 * about, two lines of text; "need you" toasts get a clay stripe and the decisions key hint. They slide
 * in at the top right under the connection pill, stack (newest on top, three at most), and leave
 * early once their decision is answered. Not shown while the decision screen is open.
 */
public final class Toasts implements HudElement {
	private static final int W = 196;
	private static final int MAX = 3;
	private static final int SLIDE_MS = 180;
	private static final int FADE_MS = 350;
	private static final List<Toast> ACTIVE = new ArrayList<>();
	private static int shown;

	private record Toast(Notify n, @Nullable String agentId, String title, String body, long start, long life, @Nullable String decisionId) {
	}

	public static void init() {
		Foreman.addListener(new ForemanListener() {
			@Override
			public void onNotify(Notify n) {
				push(n);
			}

			@Override
			public void onDecision(@Nullable Decision previous, Decision decision) {
				if (!decision.isOpen()) {
					expireFor(decision.id());
				}
			}
		});
	}

	public static int shown() {
		return shown;
	}

	public static int active() {
		return ACTIVE.size();
	}

	/** Add a toast for a notify (client thread). */
	public static void push(Notify n) {
		ForemanState s = Foreman.state();
		String agentId = null;
		String body = n.text();
		if (n.decisionId() != null && s != null && s.decision(n.decisionId()) != null) {
			agentId = s.decision(n.decisionId()).agentId();
		}
		// "Marlow: Merge t2 ..." -> agent Marlow, body after the colon
		int colon = body.indexOf(": ");
		if (colon > 0 && colon < 24 && s != null) {
			String who = body.substring(0, colon).strip().toLowerCase(Locale.ROOT);
			for (Agent a : s.agents().values()) {
				if (a.name().toLowerCase(Locale.ROOT).equals(who) || a.id().equals(who)) {
					agentId = agentId == null ? a.id() : agentId;
					body = body.substring(colon + 2);
					break;
				}
			}
		}
		String title = switch (n.level()) {
			case NEED_USER -> (agentId != null ? UiBits.agentName(agentId) : Tr.t("Your team")) + Tr.t(" needs you");
			case WARN -> agentId != null ? UiBits.agentName(agentId) : Tr.t("Heads up");
			default -> agentId != null ? UiBits.agentName(agentId) : Tr.t("Foreman");
		};
		long life = switch (n.level()) {
			case NEED_USER -> 9000;
			case WARN -> 8000;
			default -> 5500;
		};
		ACTIVE.add(0, new Toast(n, agentId, title, body, Util.getMillis(), life, n.decisionId()));
		while (ACTIVE.size() > MAX) {
			ACTIVE.remove(ACTIVE.size() - 1);
		}
		shown++;
	}

	private static void expireFor(String decisionId) {
		long now = Util.getMillis();
		for (int i = 0; i < ACTIVE.size(); i++) {
			Toast t = ACTIVE.get(i);
			if (decisionId.equals(t.decisionId())) {
				long end = Math.min(t.start() + t.life(), now + FADE_MS);
				ACTIVE.set(i, new Toast(t.n(), t.agentId(), t.title(), t.body(), t.start(), Math.max(0, end - t.start()), t.decisionId()));
			}
		}
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, DeltaTracker deltaTracker) {
		Minecraft mc = Minecraft.getInstance();
		long now = Util.getMillis();
		ACTIVE.removeIf(t -> now - t.start() > t.life());
		if (mc.player == null || ACTIVE.isEmpty() || mc.gui.screen() instanceof DecisionScreen) {
			return;
		}
		Font font = mc.font;
		// under the connection pill (one or two lines tall)
		int y = Math.max(40, ConnectionBanner.pillBottom + 6);
		// stay clear of the goal bar when the screen is narrow enough for them to meet
		if (GoalBar.right > g.guiWidth() - 6 - W - 4) {
			y = Math.max(y, GoalBar.bottom + 6);
		}
		for (Toast t : ACTIVE) {
			y += draw(g, font, t, now, y) + 4;
		}
	}

	private static int draw(GuiGraphicsExtractor g, Font font, Toast t, long now, int y) {
		Kit.Padding p = Kit.padding("panel_paper");
		boolean need = t.n().level() == NotifyLevel.NEED_USER;
		int textX = p.left() + 26;
		int textW = W - textX - p.right();
		List<FormattedCharSequence> lines = TextUtil.wrap(font, UiBits.oneLine(t.body()), textW);
		if (lines.size() > 2) {
			String second = TextUtil.wrapPlain(font, UiBits.oneLine(t.body()), textW).get(1);
			lines = List.of(lines.get(0), net.minecraft.network.chat.Component.literal(TextUtil.ellipsize(font, second + " …", textW))
				.getVisualOrderText());
		}
		int h = Math.max(p.top() + 20 + p.bottom() - 2, p.top() + 10 + lines.size() * 10 + (need ? 12 : 0) + p.bottom() - 2);
		long age = now - t.start();
		float slide = Math.min(1f, age / (float) SLIDE_MS);
		slide = 1f - (1f - slide) * (1f - slide);
		long left = t.life() - age;
		float fade = left < FADE_MS ? Math.max(0f, left / (float) FADE_MS) : 1f;
		int x = g.guiWidth() - 6 - W + (int) ((1f - slide) * (W + 10));
		int a = (int) (255 * fade);
		if (a < 8) {
			return h;
		}
		int tint = (a << 24) | 0xFFFFFF;
		Panels.sprite(g, Kit.PANEL_PAPER, x, y, W, h, tint);
		if (need) {
			g.fill(x + 3, y + 4, x + 5, y + h - 6, UiStyle.withAlpha(UiStyle.CLAY, a));
		}
		int px = x + p.left();
		int py = y + p.top() - 1;
		if (t.agentId() != null && UiBits.hasPortrait(t.agentId())) {
			UiBits.framedPortrait(g, t.agentId(), px, py, 1);
		} else {
			String icon = t.body().startsWith("Merged") ? "merge" : t.body().startsWith("Goal") ? "decision" : need ? "decision" : "message";
			Panels.sprite(g, Kit.icon(icon), px + 4, py + 4, 12, 12, tint);
		}
		int tx = x + textX;
		int nameColor = t.agentId() != null ? UiBits.nameOnLight(t.agentId()) : UiBits.ink();
		String title = TextUtil.ellipsize(font, t.title(), textW);
		if (t.agentId() != null && title.startsWith(UiBits.agentName(t.agentId()))) {
			String nm = UiBits.agentName(t.agentId());
			g.text(font, nm, tx, py + 1, UiStyle.withAlpha(nameColor, a), false);
			g.text(font, title.substring(nm.length()), tx + font.width(nm), py + 1, UiStyle.withAlpha(need ? UiStyle.CLAY_DARK : UiBits.muted(), a), false);
		} else {
			g.text(font, title, tx, py + 1, UiStyle.withAlpha(need ? UiStyle.CLAY_DARK : t.n().level() == NotifyLevel.WARN ? UiBits.errorText() : UiBits.ink(),
				a), false);
		}
		int ly = py + 12;
		for (FormattedCharSequence line : lines) {
			g.text(font, line, tx, ly, UiStyle.withAlpha(UiBits.ink(), a), false);
			ly += 10;
		}
		if (need && a > 200) {
			String key = Keys.decisions == null ? "J" : Keys.label(Keys.decisions);
			int hw = UiBits.hintsWidth(font, key, "answer");
			UiBits.hints(g, font, x + W - p.right() - hw, ly, false, key, "answer");
		}
		return h;
	}
}

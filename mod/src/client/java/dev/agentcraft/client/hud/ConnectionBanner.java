package dev.agentcraft.client.hud;

import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.LinkStatus;
import dev.agentcraft.client.foreman.LinkStatus.Phase;
import dev.agentcraft.client.foreman.Protocol.AuthStatus;
import dev.agentcraft.client.foreman.Protocol.BackendName;
import dev.agentcraft.client.foreman.Protocol.ForemanStatus;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElement;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.util.Util;

/**
 * Small Foreman status pill in the top-right corner, and a loud banner at the top centre when the
 * selected backend cannot authenticate.
 * <ul>
 *   <li>connected: quiet ink pill, teal dot, "Foreman · sim" (or the claude account); fades to a
 *       lower opacity after a few seconds;</li>
 *   <li>reconnecting (it was connected): clay pulsing dot, "Reconnecting to the Foreman", attempt
 *       count, and "showing last known state";</li>
 *   <li>never connected: grey dot, "Foreman not running" + how to start it;</li>
 *   <li>auth failed: paper banner with a red dot and the Foreman's message.</li>
 * </ul>
 */
public final class ConnectionBanner implements HudElement {
	private static final int MARGIN = 6;
	private static final long FADE_AFTER_MS = 6000;

	/**
	 * Left / bottom edge of the pill drawn this frame (GUI px; left = gui width and bottom = 0 when
	 * nothing was drawn). This element is registered before the goal bar and the toasts, so they read
	 * the current frame's values and keep clear of it.
	 */
	public static int pillLeft = Integer.MAX_VALUE;
	public static int pillBottom = 0;

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, DeltaTracker deltaTracker) {
		Minecraft mc = Minecraft.getInstance();
		pillLeft = g.guiWidth();
		pillBottom = 0;
		if (mc.player == null || Foreman.state() == null) {
			return;
		}
		ForemanState st = Foreman.state();
		LinkStatus link = st.link();
		ForemanStatus fs = st.status();
		Font font = mc.font;
		long now = System.currentTimeMillis();

		String dot;
		String title;
		String detail = null;
		int alpha = 255;
		boolean pulse = false;
		if (link.phase() == Phase.DISABLED) {
			dot = "idle";
			title = "Foreman link off";
			detail = "AGENTCRAFT_FOREMAN=0";
		} else if (link.synced()) {
			dot = fs != null && fs.auth() == AuthStatus.FAILED ? "error" : fs != null && fs.auth() == AuthStatus.CHECKING ? "thinking" : "working";
			title = "Foreman · " + backendLabel(fs);
			if (fs != null && fs.backend() != BackendName.SIM && fs.account() != null) {
				detail = fs.account();
			}
			if (now - link.sinceMs() > FADE_AFTER_MS) {
				alpha = 150;
			}
		} else if (link.everSynced()) {
			dot = "waiting";
			pulse = true;
			title = "Reconnecting to the Foreman" + (link.attempt() > 1 ? " (" + link.attempt() + ")" : "");
			detail = "showing last known state";
		} else {
			dot = "idle";
			title = "Foreman not running";
			detail = "start it: cd foreman; npm run start";
		}
		drawPill(g, font, dot, title, detail, alpha, pulse, now);

		if (link.synced() && fs != null && fs.auth() == AuthStatus.FAILED) {
			drawAuthBanner(g, font, fs);
		}
	}

	private static String backendLabel(ForemanStatus fs) {
		if (fs == null) {
			return "connected";
		}
		return switch (fs.backend()) {
			case SIM -> fs.speed() != null && fs.speed() != 1.0 ? "sim ×" + trim(fs.speed()) : "sim";
			case CLAUDE -> "claude";
			case CODEX -> "codex";
			default -> fs.backend().wire();
		};
	}

	private static String trim(double d) {
		return d == Math.rint(d) ? Long.toString((long) d) : Double.toString(d);
	}

	private static void drawPill(GuiGraphicsExtractor g, Font font, String dot, String title, String detail, int alpha, boolean pulse, long now) {
		Kit.Padding p = Kit.padding("tooltip");
		int textW = Math.max(font.width(title), detail == null ? 0 : font.width(detail));
		int w = p.left() + 11 + 4 + textW + p.right();
		int h = p.top() + 9 + (detail == null ? 0 : 10) + p.bottom();
		int x = g.guiWidth() - w - MARGIN;
		int y = MARGIN;
		pillLeft = x;
		pillBottom = y + h;
		int tint = (alpha << 24) | 0xFFFFFF;
		Panels.sprite(g, Kit.TOOLTIP, x, y, w, h, tint);
		int dx = x + p.left();
		int dy = y + p.top() - 1;
		if (pulse) {
			float t = (float) Math.sin((now % 1200) / 1200.0 * Math.PI * 2) * 0.5f + 0.5f;
			Panels.sprite(g, Kit.dot(dot, true), dx, dy, 11, 11, ((int) (alpha * (0.35f + 0.65f * t)) << 24) | 0xFFFFFF);
		}
		Panels.sprite(g, Kit.dot(dot, false), dx + 2, dy + 2, 7, 7, tint);
		int tx = dx + 11 + 4;
		g.text(font, title, tx, y + p.top(), UiStyle.withAlpha(UiStyle.CREAM, alpha), false);
		if (detail != null) {
			g.text(font, detail, tx, y + p.top() + 10, UiStyle.withAlpha(UiStyle.color("ink_ui.activity", 0xFFC4BDB2), alpha), false);
		}
	}

	private static void drawAuthBanner(GuiGraphicsExtractor g, Font font, ForemanStatus fs) {
		String head = switch (fs.backend()) {
			case CODEX -> "Codex backend can't authenticate";
			case CLAUDE -> "Claude backend can't authenticate";
			case OPENAI -> "OpenAI backend can't authenticate";
			default -> "Agent backend can't authenticate";
		};
		String msg = fs.message() != null ? fs.message() : "Check the selected provider's credentials, then restart the Foreman";
		int maxW = Math.min(360, g.guiWidth() - 40);
		var lines = TextUtil.wrap(font, msg, maxW - 34);
		Kit.Padding p = Kit.padding("panel_paper");
		int w = Math.min(maxW, Math.max(font.width(head), lines.stream().mapToInt(font::width).max().orElse(0)) + 34 + p.left() + p.right() - 16);
		int h = p.top() + 10 + lines.size() * 10 + p.bottom();
		int x = (g.guiWidth() - w) / 2;
		int y = MARGIN;
		Panels.panel(g, x, y, w, h);
		long now = Util.getMillis();
		float t = (float) Math.sin((now % 1200) / 1200.0 * Math.PI * 2) * 0.5f + 0.5f;
		Panels.sprite(g, Kit.dot("error", true), x + p.left(), y + p.top() - 1, 11, 11, ((int) (255 * (0.4f + 0.6f * t)) << 24) | 0xFFFFFF);
		Panels.dot(g, "error", x + p.left() + 2, y + p.top() + 1, false);
		int tx = x + p.left() + 16;
		g.text(font, head, tx, y + p.top(), UiStyle.status("error"), false);
		int ly = y + p.top() + 11;
		for (var line : lines) {
			g.text(font, line, tx, ly, UiStyle.color("paper.text"), false);
			ly += 10;
		}
	}
}

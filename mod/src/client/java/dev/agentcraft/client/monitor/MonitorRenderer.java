package dev.agentcraft.client.monitor;

import com.mojang.blaze3d.vertex.PoseStack;
import dev.agentcraft.block.MonitorBlock;
import dev.agentcraft.block.entity.MonitorBlockEntity;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.ui.UiStyle;
import dev.agentcraft.client.ui.WorldUi;
import dev.agentcraft.client.world.StationRenderState;
import dev.agentcraft.client.world.StationRenderer;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.state.level.CameraRenderState;
import net.minecraft.util.FormattedCharSequence;
import net.minecraft.util.LightCoordsUtil;
import org.jspecify.annotations.Nullable;

/**
 * Desk monitor BER: the bound agent's live log on the connected screen, drawn once from the
 * panel's origin block. Header (status dot, name, activity, task id), a tail of log rows that
 * slides up as entries arrive (newest at the bottom, the top row fading), a blinking cursor while
 * the agent works, "waiting for you" when it needs the user, and quiet states for off shift, an
 * unknown agent, no Foreman yet and a lost link (last known log, dimmed, with a badge).
 *
 * <p>Everything is full-bright (the screen glows), opaque geometry is drawn in the solid pass, and
 * the layout is cached in a {@link MonitorScreen} until the agent's log, the agent or the screen
 * changes, so a frame only submits a few text runs and two rectangle batches per monitor.
 */
public class MonitorRenderer extends StationRenderer<MonitorBlockEntity, MonitorRenderer.State> {
	/** Screen plane of the north-facing model (assets-src block contract), minus a hair to sit on top. */
	public static final float SCREEN_DEPTH = 12f / 16f - 0.002f;
	/** Default pixel density (ui-style metrics: desk monitors 96 px per block). */
	public static final float PX_PER_BLOCK = 96f;

	static final float Z_TINT = DisplayDraw.Z_STEP;
	static final float Z_TEXT = 2 * DisplayDraw.Z_STEP;
	static final float Z_HEADER_TEXT = 4 * DisplayDraw.Z_STEP;
	static final float Z_VEIL = 5 * DisplayDraw.Z_STEP;
	static final float Z_BADGE = 6 * DisplayDraw.Z_STEP;
	static final float Z_BADGE_TEXT = 7 * DisplayDraw.Z_STEP;

	public static class State extends StationRenderState {
		public boolean lit;
		@Nullable MonitorScreen screen;
		float shift;
		boolean stale;
		boolean caretOn;
		float pulse;
		int worldLight;
	}

	/** Pixel density for a panel: 1-block-high (or wide) screens get 128 px/block so a tail of 7 rows fits, bigger ones 96. */
	public static int density(int w, int h) {
		return Math.min(w, h) <= 1 ? 128 : (int) PX_PER_BLOCK;
	}

	@Override
	public State createRenderState() {
		return new State();
	}

	@Override
	public boolean shouldRenderOffScreen() {
		return true; // multi-block screens draw from the origin block only
	}

	@Override
	public int getViewDistance() {
		return 64;
	}

	@Override
	protected void extractStation(MonitorBlockEntity be, State s, float partialTicks) {
		s.lit = be.getBlockState().getValue(MonitorBlock.LIT);
		if (!s.panelOrigin) {
			return;
		}
		long now = System.nanoTime();
		ForemanState fs = Foreman.state();
		String agent = MonitorFeature.resolveAgent(be, s.binding, s.facing, s.panelWidth, s.panelHeight);
		ScreenStyle st = MonitorFeature.styleFor(be.getBlockPos());
		int ppb = density(s.panelWidth, s.panelHeight);
		MonitorScreen m = MonitorFeature.screen(be.getBlockPos());
		m.lastUsedNanos = now;
		if (m.sync(fs, agent, st, ppb, s.panelWidth, s.panelHeight, MonitorFeature.logSeq(agent), MonitorFeature.agentSeq(agent), now)) {
			DisplayStats.rebuilt(DisplayStats.Kind.MONITOR);
		}
		s.screen = m;
		s.shift = m.shift(now);
		s.stale = fs != null && fs.hasData() && fs.isStale();
		long ms = now / 1_000_000L;
		s.caretOn = (ms / UiStyle.metric("metrics.caret_blink_ms", 500)) % 2 == 0;
		int pulseMs = UiStyle.metric("metrics.pulse_ms", 1200);
		double ph = (ms % pulseMs) / (double) pulseMs;
		s.pulse = (float) (0.5 - 0.5 * Math.cos(ph * Math.PI * 2));
		s.worldLight = s.lightCoords;
		DisplayStats.add(DisplayStats.Kind.MONITOR, System.nanoTime() - now);
	}

	@Override
	public void submit(State s, PoseStack poseStack, SubmitNodeCollector collector, CameraRenderState camera) {
		MonitorScreen m = s.screen;
		if (!s.panelOrigin || m == null || m.style == null) {
			return;
		}
		long t0 = System.nanoTime();
		poseStack.pushPose();
		toFace(poseStack, s.facing, SCREEN_DEPTH, m.ppb);
		poseStack.translate(0, -(s.panelHeight - 1) * m.ppb, 0);
		if (s.lit) {
			drawLit(s, m, poseStack, collector);
		} else {
			drawOff(s, m, poseStack, collector);
		}
		poseStack.popPose();
		DisplayStats.add(DisplayStats.Kind.MONITOR, System.nanoTime() - t0);
	}

	private static void drawLit(State s, MonitorScreen m, PoseStack ps, SubmitNodeCollector c) {
		ScreenStyle st = m.style;
		Font font = Minecraft.getInstance().font;
		int light = WorldUi.uiLight();
		m.bg.submit(ps, c);
		m.dyn.clear();
		// ---- log rows, newest at the bottom
		float bottom = m.cy1 + s.shift;
		float limit = m.by1 + m.ppb * 2f / 16f - 1; // rows may hide under the bezel, never beyond it
		boolean overflow = false;
		float hsum = 0;
		for (LogRows.Row r : m.rows) {
			hsum += r.height();
		}
		overflow = hsum > m.cy1 - m.cy0;
		float y = bottom;
		ps.pushPose();
		ps.translate(0, 0, Z_TEXT);
		boolean sliding = s.shift > 0.01f;
		boolean feed = m.mode == MonitorScreen.Mode.FEED;
		List<LogRows.Row> rows = m.rows;
		for (int i = 0; i < rows.size(); i++) {
			LogRows.Row r = rows.get(i);
			float top = y - r.height();
			if (y <= m.cy0 - 1 || (!sliding && top < m.cy0 - 0.5f)) {
				break; // under the header band (rows only pass under it while sliding)
			}
			if (y > limit) {
				y = top;
				continue;
			}
			if (feed && !sliding && r.textX() > 0 && (i + 1 >= rows.size() || top - rows.get(i + 1).height() < m.cy0 - 0.5f)) {
				break; // a feed item's second line without its first: leave it out
			}
			int alpha = 255;
			if (overflow && top < m.cy0 + LogRows.LINE) {
				float t = Math.max(0f, Math.min(1f, (top - m.cy0) / LogRows.LINE));
				alpha = (int) (128 + 127 * t);
			}
			if (r.tint() != 0) {
				m.dyn.add(m.bx0 + 1, top, m.bx1 - 1, top + r.height(), Z_TINT - Z_TEXT, DisplayDraw.mulAlpha(r.tint(), 255), light);
			}
			float ty = top + (r.height() - 8) / 2f + 0.5f;
			if (r.icon() != null) {
				WorldUi.submitSprite(ps, c, WorldUi.Layer.SOLID, r.icon(), m.cx0, top + (r.height() - LogRows.ICON) / 2f, LogRows.ICON, LogRows.ICON, 0f,
					alpha >= 255 ? 0xFFFFFFFF : (alpha << 24) | 0xFFFFFF, light);
			}
			WorldUi.submitText(ps, c, r.text(), m.cx0 + r.textX(), ty, UiStyle.withAlpha(r.color(), alpha), light);
			y = top;
		}
		// ---- cursor / footer line
		float fy = m.by1 - MonitorScreen.PAD_BOTTOM - LogRows.LINE + 1;
		if (m.footer != null) {
			int a = 170 + (int) (85 * s.pulse);
			WorldUi.submitText(ps, c, m.footer, m.cx0, fy, UiStyle.withAlpha(m.footerColor, a), light);
		} else if (m.caret && s.caretOn) {
			m.dyn.add(m.cx0, fy - 0.5f, m.cx0 + 5, fy + 8, 0, st.caret(), light);
		}
		ps.popPose();
		if (m.dyn.size() > 0) {
			ps.pushPose();
			ps.translate(0, 0, Z_TEXT);
			m.dyn.submit(ps, c);
			ps.popPose();
		}
		// ---- header
		ps.pushPose();
		ps.translate(0, 0, Z_HEADER_TEXT);
		float hy = m.by0 + m.padTop;
		if (m.name != null) {
			boolean waiting = m.dotFamily.equals("waiting");
			if (waiting) {
				int a = (int) (40 + 150 * s.pulse);
				WorldUi.submitSprite(ps, c, WorldUi.Layer.OVERLAY, DisplayDraw.dot("waiting", true), m.cx0 - 2, hy - 1.5f, 11, 11, 0f, (a << 24) | 0xFFFFFF, light);
			}
			WorldUi.submitSprite(ps, c, WorldUi.Layer.SOLID, DisplayDraw.dot(m.dotFamily, false), m.cx0, hy + 0.5f, 7, 7, DisplayDraw.Z_STEP * 0.5f, 0xFFFFFFFF,
				light);
			WorldUi.submitText(ps, c, m.name, m.cx0 + 10, hy, m.nameColor, light);
		}
		if (m.activity != null) {
			WorldUi.submitText(ps, c, m.activity, m.activityX, m.activityY, st.muted(), light);
		}
		if (m.usage != null) {
			WorldUi.submitText(ps, c, m.usage, m.cx0, m.usageY, st.muted(), light);
		}
		if (m.pill != null) {
			WorldUi.submitText(ps, c, m.pill, m.pillX, hy, m.pillColor, light);
		}
		// ---- centred message (off shift, no agent, connecting)
		List<FormattedCharSequence> centre = m.centre;
		if (!centre.isEmpty()) {
			float total = centre.size() * LogRows.LINE + (centre.size() - 1) * 2;
			float cy = (m.cy0 + m.by1 - total) / 2f;
			for (int i = 0; i < centre.size(); i++) {
				WorldUi.submitText(ps, c, centre.get(i), m.centreX.get(i), cy + i * (LogRows.LINE + 2), m.centreColors.get(i), light);
			}
		}
		ps.popPose();
		// ---- link lost: dim everything, then a badge
		if (s.stale) {
			drawOfflineBadge(m, ps, c, font, light);
		}
	}

	private static void drawOfflineBadge(MonitorScreen m, PoseStack ps, SubmitNodeCollector c, Font font, int light) {
		ScreenStyle st = m.style;
		m.veil.clear();
		m.veil.add(m.bx0 - 0.5f, m.by0 - 0.5f, m.bx1 + 0.5f, m.by1 + 0.5f, Z_VEIL, DisplayDraw.mulAlpha(st.bgBottom(), 150), light);
		ps.pushPose();
		ps.translate(0, 0, 0);
		c.order(0).submitCustomGeometry(ps, DisplayDraw.fillTranslucent(), (pose, vc) -> m.veil.emit(pose, vc, 255, -1));
		// the badge keeps clear of the bezel lip: narrow screens say just "Offline" next to the red dot
		String label = font.width(DisplayText.OFFLINE) + 18 <= (m.cx1 - m.cx0) ? DisplayText.OFFLINE : "Offline";
		int tw = font.width(label);
		float w = tw + 18;
		float h = 14;
		float x = (m.bx0 + m.bx1 - w) / 2f;
		float y = (m.by0 + m.by1 - h) / 2f;
		DisplayDraw.Rects badge = m.badge.clear();
		badge.add(x, y, x + w, y + h, Z_BADGE, st.badgeBg(), light);
		badge.submit(ps, c);
		ps.translate(0, 0, Z_BADGE_TEXT);
		WorldUi.submitSprite(ps, c, WorldUi.Layer.SOLID, DisplayDraw.dot("error", false), x + 4, y + 3.5f, 7, 7, 0f, 0xFFFFFFFF, light);
		WorldUi.submitText(ps, c, label, x + 14, y + 3, st.badgeText(), light);
		ps.popPose();
	}

	/** Unlit screen (smoked glass from the block model): only a quiet label, lit by the room. */
	private static void drawOff(State s, MonitorScreen m, PoseStack ps, SubmitNodeCollector c) {
		if (m.name == null) {
			return;
		}
		int light = LightCoordsUtil.pack(Math.max(4, LightCoordsUtil.block(s.worldLight)), LightCoordsUtil.sky(s.worldLight));
		ps.pushPose();
		ps.translate(0, 0, Z_TEXT);
		int muted = UiStyle.color("status.idle", 0xFF9C9488);
		String label = m.mode == MonitorScreen.Mode.OFF_SHIFT ? "off shift" : "screen off";
		WorldUi.submitText(ps, c, label, m.cx0, m.by1 - MonitorScreen.PAD_BOTTOM - 9, muted, light);
		ps.popPose();
	}
}

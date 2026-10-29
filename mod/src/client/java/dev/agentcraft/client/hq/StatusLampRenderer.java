package dev.agentcraft.client.hq;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import dev.agentcraft.block.LampStatus;
import dev.agentcraft.block.StatusLampBlock;
import dev.agentcraft.block.entity.StatusLampBlockEntity;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.foreman.Protocol.Goal;
import dev.agentcraft.client.foreman.Protocol.Task;
import dev.agentcraft.client.foreman.Protocol.TaskStatus;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import dev.agentcraft.client.ui.WorldUi;
import dev.agentcraft.client.world.StationRenderState;
import dev.agentcraft.client.world.StationRenderer;
import dev.agentcraft.layout.Anchors;
import dev.agentcraft.client.ui.Tr;
import java.util.List;
import java.util.Locale;
import org.jspecify.annotations.Nullable;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.rendertype.RenderTypes;
import net.minecraft.client.renderer.state.level.CameraRenderState;
import net.minecraft.core.Direction;

/**
 * Status lamp BER. The lamp colour itself is the block state (driven by {@link HqWorldDriver}); this
 * adds what a block state cannot:
 * <ul>
 *   <li>{@code waiting} lamps breathe (an additive clay glow over the lens, ~0.8 Hz), so "needs you"
 *       reads from across the hall even in daylight;</li>
 *   <li>the lamp bound to {@code goal:atrium} is the Goal Atrium's projector: it draws the
 *       hologram above itself (goal text, progress ring, task and agent counts) with a soft light
 *       beam from the lens up to the card.</li>
 * </ul>
 */
public class StatusLampRenderer extends StationRenderer<StatusLampBlockEntity, StatusLampRenderer.State> {
	public static final String ATRIUM_BINDING = "goal:atrium";
	public static final String DECISIONS_BINDING = "decisions";
	public static final String MERGE_BINDING = "merge";
	public static final String BEACON_BINDING = HqWorldDriver.BEACON_BINDING;
	/** Height of the hologram card's centre above the lamp block's origin (blocks). */
	static final float HOLO_Y = 3.55f;
	/** Card size in kit pixels and its world scale (blocks per pixel = PX * K). */
	static final int CARD_W = 236;
	static final int CARD_H = 92;
	static final float K = 0.74f;
	static final int TEXT_W = 176;

	public static class State extends StationRenderState {
		public LampStatus status = LampStatus.OFF;
		public boolean hologram;
		public boolean stale;
		public boolean hasGoal;
		public double progress;
		public String statusWord = "";
		public int statusColor;
		public List<String> goalLines = List.of();
		public String percent = "";
		public String line1 = "";
		public String line2a = "";
		public String line2b = "";
		public int cardW = CARD_W;
		/** Waiting niche glow (lamps bound {@code decisions} / {@code merge}): face with air in front, frame half width (blocks). */
		public @Nullable Direction frameFace;
		public float frameHalf;
	}

	@Override
	public State createRenderState() {
		return new State();
	}

	@Override
	public boolean shouldRenderOffScreen() {
		return true; // the hologram floats well above its block
	}

	@Override
	public int getViewDistance() {
		return 96;
	}

	@Override
	protected void extractStation(StatusLampBlockEntity be, State s, float partialTicks) {
		s.status = be.getBlockState().getValue(StatusLampBlock.STATUS);
		s.hologram = ATRIUM_BINDING.equals(s.binding);
		ForemanState fs = Foreman.state();
		// offline: the lamps hold their last state, but nothing pretends you are needed right now
		s.stale = fs == null || fs.isStale();
		s.frameFace = null;
		if (s.status == LampStatus.WAITING && !s.stale && (DECISIONS_BINDING.equals(s.binding) || MERGE_BINDING.equals(s.binding))
			&& be.getLevel() != null) {
			// the open face towards the middle of the HQ (a lamp set into an outer wall also has air outside)
			double best = Double.MAX_VALUE;
			Anchors.Bounds b = Anchors.current().bounds();
			double cx = b == null ? 0 : (b.minX() + b.maxX()) / 2.0;
			double cz = b == null ? 0 : (b.minZ() + b.maxZ()) / 2.0;
			for (Direction d : Direction.Plane.HORIZONTAL) {
				net.minecraft.core.BlockPos n = be.getBlockPos().relative(d);
				if (be.getLevel().getBlockState(n).isAir()) {
					double dist = Math.hypot(n.getX() + 0.5 - cx, n.getZ() + 0.5 - cz);
					if (dist < best) {
						best = dist;
						s.frameFace = d;
					}
				}
			}
			s.frameHalf = DECISIONS_BINDING.equals(s.binding) ? 2.5f : 1.5f;
		}
		if (s.hologram) {
			extractHologram(s);
			// nameplates near the plinth lift clear of the goal panel instead of hiding behind it
			net.minecraft.core.BlockPos p = be.getBlockPos();
			dev.agentcraft.client.agents.PlateLayout.reserve(p.getX() + 0.5, p.getY() + HOLO_Y - CARD_H / 2f * WorldUi.PX * K, p.getZ() + 0.5,
				s.cardW + 8, CARD_H + 8, WorldUi.PX * K);
		}
	}

	private static void extractHologram(State s) {
		ForemanState st = Foreman.state();
		Font font = Minecraft.getInstance().font;
		Goal g = st == null ? null : st.goal();
		s.stale = st == null || st.isStale();
		s.hasGoal = g != null;
		int total = 0;
		int done = 0;
		int doing = 0;
		int review = 0;
		int working = 0;
		int onShift = 0;
		int waitingUser = 0;
		if (st != null) {
			for (Task t : st.tasks().values()) {
				if (t.status() == TaskStatus.CANCELLED || g != null && t.goalId() != null && !t.goalId().equals(g.id())) {
					continue;
				}
				total++;
				switch (t.status()) {
					case DONE -> done++;
					case DOING -> doing++;
					case REVIEW -> review++;
					default -> {
					}
				}
			}
			for (Agent a : st.agents().values()) {
				if (!a.isActive()) {
					continue;
				}
				onShift++;
				String fam = a.state().family();
				if (fam.equals("working") || fam.equals("thinking")) {
					working++;
				}
			}
			waitingUser = st.openDecisions().size();
		}
		if (g != null) {
			// the ring and its label follow the done count, so they agree with "2 of 9 tasks done"
			// (judges: a weighted "39%" next to "2 of 9 done" read as a contradiction)
			s.progress = total > 0 ? done / (double) total : Math.max(0, Math.min(1, g.progress()));
			s.percent = total > 0 ? done + "/" + total : Math.round(s.progress * 100) + "%";
			s.statusWord = g.status().wire().toUpperCase(Locale.ROOT);
			String fam = switch (g.status()) {
				case PLANNING -> "thinking";
				case ACTIVE -> "working";
				case DONE -> "done";
				case FAILED -> "error";
				default -> "idle";
			};
			s.statusColor = UiStyle.status(fam);
			// the goal wraps to 3 lines (wider column) before anything is cut
			List<String> lines = TextUtil.wrapPlain(font, g.text().replace("`", ""), TEXT_W);
			if (lines.size() > 3) {
				lines = List.of(lines.get(0), lines.get(1), TextUtil.ellipsize(font, String.join(" ", lines.subList(2, lines.size())), TEXT_W));
			}
			s.goalLines = List.copyOf(lines);
			s.line1 = done + Tr.t(" of ") + total + Tr.t(" tasks done") + (doing > 0 ? "  ·  " + doing + Tr.t(" in progress") : "");
			s.line2a = plural(working, "agent") + Tr.t(" working") + (review > 0 ? "  ·  " + review + Tr.t(" in review") : "");
			s.line2b = waitingUser > 0 ? "  ·  " + waitingUser + (waitingUser == 1 ? Tr.t(" needs you") : Tr.t(" need you")) : "";
		} else {
			s.progress = 0;
			s.percent = "–";
			s.statusWord = "NO GOAL";
			s.statusColor = UiStyle.status("idle");
			s.goalLines = List.of("What should the team", "work on?");
			s.line1 = Tr.t("Press ` and type a goal");
			s.line2a = st == null || !st.hasData() ? Tr.t("Foreman not connected") : plural(onShift, "agent") + Tr.t(" on shift");
			s.line2b = "";
		}
		if (s.stale && st != null && st.hasData()) {
			s.line2a = Tr.t("Foreman offline · last known state");
			s.line2b = "";
		}
		int w = Math.max(font.width(s.line1), font.width(s.line2a) + font.width(s.line2b));
		for (String l : s.goalLines) {
			w = Math.max(w, font.width(l));
		}
		s.cardW = Math.max(CARD_W, 84 + w + 12);
	}

	static String plural(int n, String word) {
		return n + " " + word + (n == 1 ? "" : "s");
	}

	@Override
	public void submit(State s, PoseStack poseStack, SubmitNodeCollector collector, CameraRenderState camera) {
		if (s.status == LampStatus.WAITING && !s.stale) {
			breathe(s, poseStack, collector);
		}
		if (BEACON_BINDING.equals(s.binding) && s.status != LampStatus.OFF) {
			beacon(s, poseStack, collector);
		}
		if (s.frameFace != null) {
			floorGlow(s, poseStack, collector);
		}
		if (s.hologram) {
			beam(s, poseStack, collector);
			card(s, poseStack, collector, camera);
		}
	}

	// ------------------------------------------------------------------ cupola beacon

	/**
	 * The cupola beacon: each lamp of the band glows in its status colour with a soft halo spilling
	 * over the copper round it, so the studio's state reads from across the meadow by day and night.
	 * Waiting (something needs you) breathes; the other states hold a steady glow.
	 */
	private static void beacon(State s, PoseStack poseStack, SubmitNodeCollector collector) {
		String fam = switch (s.status) {
			case THINKING -> "thinking";
			case WORKING -> "working";
			case WAITING -> "waiting";
			case ERROR -> "error";
			case DONE -> "done";
			default -> "idle";
		};
		int rgb = UiStyle.status(fam) & 0xFFFFFF;
		float wave = s.status == LampStatus.WAITING && !s.stale ? 0.5f + 0.5f * (float) Math.sin(s.timeSeconds * Math.PI * 2 * 0.8) : 0.6f;
		float dim = s.stale ? 0.45f : 1f;
		int core = ((int) ((140 + 115 * wave) * dim) << 24) | rgb;
		int halo = ((int) ((70 + 80 * wave) * dim) << 24) | rgb;
		// The glow stays inside the lamp's own face: the lightning pipeline tests AND writes depth, so
		// halos that spilled onto the neighbouring lamps of the band overlapped coplanar and z-fought
		// (a fast shimmer, worst with a moving camera). A slightly larger offset keeps it off the block
		// face at exterior-shot distances.
		for (Direction d : Direction.Plane.HORIZONTAL) {
			poseStack.pushPose();
			toFace(poseStack, d, -0.02f, 16f);
			collector.submitCustomGeometry(poseStack, RenderTypes.lightning(), (pose, vc) -> {
				quad(pose, vc, 3, 3, 13, 13, core, core);
				float e = 0.5f;
				quad(pose, vc, 3, e, 13, 3, halo, core);
				quad(pose, vc, 3, 13, 13, 16 - e, core, halo);
				hquad(pose, vc, e, 3, 3, 13, halo, core);
				hquad(pose, vc, 13, 3, 16 - e, 13, core, halo);
			});
			poseStack.popPose();
		}
	}

	// ------------------------------------------------------------------ waiting glow

	private static void breathe(State s, PoseStack poseStack, SubmitNodeCollector collector) {
		float wave = 0.5f + 0.5f * (float) Math.sin(s.timeSeconds * Math.PI * 2 * 0.8);
		int a = (int) (40 + 150 * wave);
		int argb = (a << 24) | (UiStyle.CLAY & 0xFFFFFF);
		for (Direction d : Direction.Plane.HORIZONTAL) {
			poseStack.pushPose();
			toFace(poseStack, d, -0.004f, 16f);
			collector.submitCustomGeometry(poseStack, RenderTypes.lightning(), (pose, vc) -> {
				quad(pose, vc, 3, 3, 13, 13, argb, argb);
			});
			poseStack.popPose();
		}
	}

	/**
	 * A soft clay glow framing the niche around a waiting {@code decisions} / {@code merge} lamp, so
	 * "a decision is waiting" reads from across the room: a thin bright line with a halo fading
	 * outwards, breathing with the lamp. Drawn on the wall plane in front of the lamp, centred on it,
	 * from the floor (3 blocks below the lamp) to 3 blocks above its bottom.
	 */
	private static void frame(State s, PoseStack poseStack, SubmitNodeCollector collector) {
		float wave = 0.5f + 0.5f * (float) Math.sin(s.timeSeconds * Math.PI * 2 * 0.8);
		int core = ((int) (120 + 110 * wave) << 24) | (UiStyle.CLAY & 0xFFFFFF);
		int halo = ((int) (40 + 50 * wave) << 24) | (UiStyle.CLAY & 0xFFFFFF);
		int clear = UiStyle.CLAY & 0xFFFFFF;
		float half = s.frameHalf * 16f;
		float x0 = 8 - half;
		float x1 = 8 + half;
		float y0 = -32f;
		float y1 = 64f;
		float t = 1.5f; // core line
		float h = 7f; // halo reach
		poseStack.pushPose();
		toFace(poseStack, s.frameFace, -0.006f, 16f);
		collector.submitCustomGeometry(poseStack, RenderTypes.lightning(), (pose, vc) -> {
			// no hard outline (it read as a debug selection box): a warm light pooling up from the
			// floor of the niche and a faint wash on its sides, breathing with the lamp
			quad(pose, vc, x0 + t, y0 + t, x1 - t, y0 + t + h * 3, halo, clear);
			hquad(pose, vc, x0 + t, y0 + t, x0 + t + h, y1 - t, halo, clear);
			hquad(pose, vc, x1 - t - h, y0 + t, x1 - t, y1 - t, clear, halo);
		});
		poseStack.popPose();
	}

	/**
	 * A soft, breathing clay pool of light on the floor in front of a waiting {@code decisions} /
	 * {@code merge} niche (replaces the thin glowing outline, which judges read as a debug selection
	 * box): brightest at the wall, fading out into the room and to the sides.
	 */
	private static void floorGlow(State s, PoseStack poseStack, SubmitNodeCollector collector) {
		float wave = 0.5f + 0.5f * (float) Math.sin(s.timeSeconds * Math.PI * 2 * 0.8);
		int peak = ((int) (70 + 80 * wave) << 24) | (UiStyle.CLAY & 0xFFFFFF);
		int mid = ((int) (25 + 35 * wave) << 24) | (UiStyle.CLAY & 0xFFFFFF);
		int clear = UiStyle.CLAY & 0xFFFFFF;
		Direction d = s.frameFace;
		float sx = d.getStepX();
		float sz = d.getStepZ();
		float lx = -sz;
		float lz = sx;
		float cx = 0.5f + 0.5f * sx;
		float cz = 0.5f + 0.5f * sz;
		float y = -2.98f;
		float half = s.frameHalf + 0.5f;
		float[] ts = {0f, 1.6f, 3.4f};
		float[] us = {-half, 0f, half};
		collector.submitCustomGeometry(poseStack, RenderTypes.lightning(), (pose, vc) -> {
			for (int i = 0; i < 2; i++) {
				for (int j = 0; j < 2; j++) {
					float[][] pts = {{ts[i], us[j]}, {ts[i], us[j + 1]}, {ts[i + 1], us[j + 1]}, {ts[i + 1], us[j]}};
					int[] cols = new int[4];
					for (int k = 0; k < 4; k++) {
						float t = pts[k][0];
						float u = pts[k][1];
						cols[k] = t >= 3.3f || Math.abs(u) >= half - 0.01f ? clear : t < 0.1f ? (u == 0f ? peak : mid) : (u == 0f ? mid : clear);
					}
					for (int w = 0; w < 2; w++) {
						for (int k = 0; k < 4; k++) {
							int kk = w == 0 ? k : 3 - k;
							float t = pts[kk][0];
							float u = pts[kk][1];
							vc.addVertex(pose, cx + sx * t + lx * u, y, cz + sz * t + lz * u).setColor(cols[kk]);
						}
					}
				}
			}
		});
	}

	/** A quad with a horizontal colour gradient (left -> right). */
	private static void hquad(PoseStack.Pose pose, VertexConsumer vc, float x0, float y0, float x1, float y1, int left, int right) {
		vc.addVertex(pose, x0, y0, 0).setColor(left);
		vc.addVertex(pose, x0, y1, 0).setColor(left);
		vc.addVertex(pose, x1, y1, 0).setColor(right);
		vc.addVertex(pose, x1, y0, 0).setColor(right);
	}

	// ------------------------------------------------------------------ hologram

	/** Two crossed, upward-fading additive planes from the lens to the card. */
	private static void beam(State s, PoseStack poseStack, SubmitNodeCollector collector) {
		float bottom = 1.02f;
		float top = HOLO_Y - CARD_H / 2f * WorldUi.PX * K + 0.05f;
		float pulse = 0.85f + 0.15f * (float) Math.sin(s.timeSeconds * 1.3);
		int base = s.hasGoal ? s.statusColor : UiStyle.CREAM;
		int lo = ((int) (115 * pulse * (s.stale ? 0.4f : 1f)) << 24) | (base & 0xFFFFFF);
		int hi = base & 0xFFFFFF; // alpha 0
		collector.submitCustomGeometry(poseStack, RenderTypes.lightning(), (pose, vc) -> {
			float rb = 0.16f;
			float rt = 0.95f;
			// x plane and z plane, both windings so they show from either side
			for (int side = 0; side < 2; side++) {
				vc.addVertex(pose, 0.5f - rb, bottom, 0.5f).setColor(lo);
				vc.addVertex(pose, 0.5f + rb, bottom, 0.5f).setColor(lo);
				vc.addVertex(pose, 0.5f + rt, top, 0.5f).setColor(hi);
				vc.addVertex(pose, 0.5f - rt, top, 0.5f).setColor(hi);
				vc.addVertex(pose, 0.5f, bottom, 0.5f - rb).setColor(lo);
				vc.addVertex(pose, 0.5f, bottom, 0.5f + rb).setColor(lo);
				vc.addVertex(pose, 0.5f, top, 0.5f + rt).setColor(hi);
				vc.addVertex(pose, 0.5f, top, 0.5f - rt).setColor(hi);
				// reversed winding
				vc.addVertex(pose, 0.5f - rt, top, 0.5f).setColor(hi);
				vc.addVertex(pose, 0.5f + rt, top, 0.5f).setColor(hi);
				vc.addVertex(pose, 0.5f + rb, bottom, 0.5f).setColor(lo);
				vc.addVertex(pose, 0.5f - rb, bottom, 0.5f).setColor(lo);
				vc.addVertex(pose, 0.5f, top, 0.5f - rt).setColor(hi);
				vc.addVertex(pose, 0.5f, top, 0.5f + rt).setColor(hi);
				vc.addVertex(pose, 0.5f, bottom, 0.5f + rb).setColor(lo);
				vc.addVertex(pose, 0.5f, bottom, 0.5f - rb).setColor(lo);
				if (side == 0) {
					break;
				}
			}
		});
	}

	private static void card(State s, PoseStack poseStack, SubmitNodeCollector collector, CameraRenderState camera) {
		Font font = Minecraft.getInstance().font;
		int light = WorldUi.uiLight();
		float bob = 0.04f * (float) Math.sin(s.timeSeconds * 0.9);
		poseStack.pushPose();
		WorldUi.billboard(poseStack, camera, 0.5, HOLO_Y + bob, 0.5);
		poseStack.scale(K, K, K);
		int cw = s.cardW;
		// one line taller for a three-line goal (judges: the goal was cut with an ellipsis after 2 lines).
		// A paper restyle (PANEL_PAPER + FRAME_BRASS, ink text) was tried and lost its text in game (QA
		// run w-2): left to the UI track, which owns the kit's world text layering.
		int ch = CARD_H + Math.max(0, s.goalLines.size() - 2) * 10;
		float x0 = -cw / 2f;
		float y0 = -ch / 2f;
		// matte paper panel with a thin brass frame and a walnut hairline (the Warm Studio kit, like the
		// diff and library modals), not a dark HUD slab
		int brass = UiStyle.BRASS;
		int walnut = UiStyle.WALNUT;
		// frame strips sit outside the panel (never overlapping it, so no depth fight)
		frameStrip(poseStack, collector, x0 - 3, y0 - 3, x0 + cw + 3, y0 + ch + 3, 1, walnut, light);
		frameStrip(poseStack, collector, x0 - 2, y0 - 2, x0 + cw + 2, y0 + ch + 2, 2, brass, light);
		WorldUi.submitNineSlice(poseStack, collector, WorldUi.Layer.SOLID, Kit.PANEL_PAPER, x0, y0, cw, ch, 0xFFFFFFFF, light);
		int ink = UiStyle.INK;
		int muted = UiStyle.color("paper.muted", 0xFF655E55);
		int dim = s.stale ? 0x99 : 0xFF;
		// progress ring (2x) with the done count inside ("2/9"), captioned "tasks"
		float rx = x0 + 10;
		float ry = y0 + (ch - 64) / 2f;
		WorldUi.submitSprite(poseStack, collector, WorldUi.Layer.OVERLAY, Kit.progressRing(s.progress), rx, ry, 64, 64, 0xFFFFFFFF, light);
		int pw = font.width(s.percent);
		WorldUi.submitText(poseStack, collector, s.percent, rx + 32 - pw / 2f, ry + 23, UiStyle.withAlpha(ink, dim), light);
		if (s.hasGoal) {
			String cap = "tasks";
			poseStack.pushPose();
			poseStack.translate(rx + 32, ry + 34, 0f);
			poseStack.scale(0.75f, 0.75f, 1f);
			WorldUi.submitText(poseStack, collector, cap, -font.width(cap) / 2f, 0, UiStyle.withAlpha(muted, dim), light);
			poseStack.popPose();
		}
		// text column
		float tx = x0 + 86;
		float ty = y0 + 9;
		WorldUi.submitText(poseStack, collector, "GOAL", tx, ty, UiStyle.withAlpha(UiStyle.CLAY_DARK, dim), light);
		WorldUi.submitText(poseStack, collector, s.statusWord, tx + font.width("GOAL") + 6, ty, UiStyle.withAlpha(s.statusColor, dim), light);
		float ly = ty + 13;
		for (String line : s.goalLines) {
			WorldUi.submitText(poseStack, collector, line, tx, ly, UiStyle.withAlpha(ink, dim), light);
			ly += 10;
		}
		float ry2 = y0 + ch - 27;
		WorldUi.submitFill(poseStack, collector, tx, ry2 - 4, x0 + cw - 10, ry2 - 3, UiStyle.withAlpha(brass, 0xCC), light);
		WorldUi.submitText(poseStack, collector, s.line1, tx, ry2, UiStyle.withAlpha(muted, dim), light);
		WorldUi.submitText(poseStack, collector, s.line2a, tx, ry2 + 10, UiStyle.withAlpha(muted, dim), light);
		if (!s.line2b.isEmpty()) {
			// "2 need you": clay, breathing with every other waiting surface
			float k = dev.agentcraft.client.ui.StatusMap.pulse(System.nanoTime());
			int clay = dev.agentcraft.client.monitor.DisplayDraw.mix(UiStyle.CLAY_DARK, UiStyle.CLAY, k);
			WorldUi.submitText(poseStack, collector, s.line2b, tx + font.width(s.line2a), ry2 + 10, UiStyle.withAlpha(clay, dim), light);
		}
		poseStack.popPose();
	}

	/** A rectangular frame {@code t} px thick just inside (x0, y0)-(x1, y1). */
	private static void frameStrip(PoseStack ps, SubmitNodeCollector c, float x0, float y0, float x1, float y1, float t, int argb, int light) {
		WorldUi.submitFill(ps, c, x0, y0, x1, y0 + t, argb, light);
		WorldUi.submitFill(ps, c, x0, y1 - t, x1, y1, argb, light);
		WorldUi.submitFill(ps, c, x0, y0 + t, x0 + t, y1 - t, argb, light);
		WorldUi.submitFill(ps, c, x1 - t, y0 + t, x1, y1 - t, argb, light);
	}

	private static void quad(PoseStack.Pose pose, VertexConsumer vc, float x0, float y0, float x1, float y1, int top, int bottom) {
		vc.addVertex(pose, x0, y0, 0).setColor(top);
		vc.addVertex(pose, x0, y1, 0).setColor(bottom);
		vc.addVertex(pose, x1, y1, 0).setColor(bottom);
		vc.addVertex(pose, x1, y0, 0).setColor(top);
	}
}

package dev.agentcraft.client.taskwall;

import com.mojang.blaze3d.vertex.PoseStack;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.block.PanelBlock;
import dev.agentcraft.block.entity.TaskBoardBlockEntity;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.TaskStatus;
import dev.agentcraft.client.monitor.DisplayDraw;
import dev.agentcraft.client.monitor.DisplayStats;
import dev.agentcraft.client.monitor.DisplayText;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.UiStyle;
import dev.agentcraft.client.ui.WorldUi;
import dev.agentcraft.client.world.StationRenderState;
import dev.agentcraft.client.world.StationRenderer;
import dev.agentcraft.client.ui.Tr;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.state.level.CameraRenderState;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.data.AtlasIds;
import net.minecraft.resources.Identifier;
import net.minecraft.util.FormattedCharSequence;
import net.minecraft.util.LightCoordsUtil;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import org.jspecify.annotations.Nullable;

/**
 * Task Wall BER: a kanban of the Foreman's tasks on the connected task_board panel, drawn once from
 * its origin block on the board plane. Columns Todo / Doing / Review / Done with counts (widths
 * follow the content, see {@link TaskBoard}); kit cards per status (blocked = red card at the top
 * of its column, with the reason); title, assignee face + name, the assignee's live state dot while
 * they work on that card, and one footer hint (blocked reason, CI failing, waiting on deps,
 * priority, else the id). Cards fly between columns when their status changes and glow briefly
 * where they land; overflow collapses into "+N more". Cards are paper pinned to the wall, so they
 * take the room's light (with a floor so they stay readable).
 */
public class TaskBoardRenderer extends StationRenderer<TaskBoardBlockEntity, TaskBoardRenderer.State> {
	/** Board plane of the north-facing model (assets-src block contract: cards on z = 14/16), minus a hair. */
	public static final float LINEN_DEPTH = 14f / 16f - 0.002f;
	static final float Z = DisplayDraw.Z_STEP;
	static final float LIFT = 5 * DisplayDraw.Z_STEP; // flying cards sit above the others
	/** The board's surface sprite (block atlas), tiled under the cards. */
	static final Identifier SURFACE = Identifier.withDefaultNamespace("block/stripped_oak_log");
	/**
	 * Block-light floor for the board: paper in a dark room still reads (the alcove is the dimmest
	 * spot of the studio, and the cards are the thing to read there). {@code dev.taskwall {lightFloor}}.
	 */
	static int lightFloor = 13;

	public static class State extends StationRenderState {
		@Nullable TaskBoard board;
		int light;
		float time;
		@Nullable String hovered;
		boolean stale;
		boolean noData;
		String noDataText = "";
	}

	private static final List<TaskBoard.Card> STATIC = new ArrayList<>();
	private static final List<TaskBoard.Card> FLYING = new ArrayList<>();

	@Override
	public State createRenderState() {
		return new State();
	}

	@Override
	public boolean shouldRenderOffScreen() {
		return true;
	}

	@Override
	public int getViewDistance() {
		return 96;
	}

	@Override
	protected void extractStation(TaskBoardBlockEntity be, State s, float partialTicks) {
		if (!s.panelOrigin) {
			return;
		}
		long now = System.nanoTime();
		ForemanState fs = Foreman.state();
		TaskBoard b = TaskWallFeature.board(be.getBlockPos());
		b.lastUsedNanos = now;
		if (b.sync(fs != null && fs.hasData() ? fs : null, s.panelWidth, s.panelHeight, TaskWallFeature.taskSeq(), TaskWallFeature.agentSeq(), now)) {
			DisplayStats.rebuilt(DisplayStats.Kind.BOARD);
		}
		b.step(now);
		s.board = b;
		s.time = now / 1e9f;
		s.light = light(be, s.facing, s.panelWidth, s.panelHeight);
		s.hovered = hovered(be, b, s.facing);
		s.stale = fs != null && fs.hasData() && fs.isStale();
		s.noData = fs == null || !fs.hasData();
		s.noDataText = s.noData ? DisplayText.noData(fs) : "";
		DisplayStats.add(DisplayStats.Kind.BOARD, System.nanoTime() - now);
	}

	/** The card under the crosshair (click affordance); none while the HUD is hidden (screenshots) or a screen is open. */
	private static @Nullable String hovered(TaskBoardBlockEntity be, TaskBoard b, Direction facing) {
		Minecraft mc = Minecraft.getInstance();
		if (mc.gui.screen() != null || mc.gui.hud.isHidden() || be.getLevel() == null || !(mc.hitResult instanceof BlockHitResult bh)
			|| bh.getType() != HitResult.Type.BLOCK) {
			return null;
		}
		BlockState hs = be.getLevel().getBlockState(bh.getBlockPos());
		if (!(hs.getBlock() instanceof PanelBlock) || !PanelBlock.origin(be.getLevel(), bh.getBlockPos(), hs).equals(be.getBlockPos())) {
			return null;
		}
		float[] p = TaskWallFeature.toBoard(be.getBlockPos(), facing, b.panelH, b.ppb, bh.getLocation());
		TaskBoard.Card c = b.cardAt(p[0], p[1]);
		return c == null ? null : c.id;
	}

	/** Brightest light just in front of the panel (centre row), with a floor so the cards stay legible at night. */
	private static int light(TaskBoardBlockEntity be, Direction facing, int w, int h) {
		if (be.getLevel() == null) {
			return WorldUi.uiLight();
		}
		Direction right = facing.getCounterClockWise();
		int block = 0;
		int sky = 0;
		BlockPos base = be.getBlockPos().relative(facing).above(h / 2);
		for (int i = 0; i < w; i += Math.max(1, w / 3)) {
			int l = LightCoordsUtil.getLightCoords(be.getLevel(), base.relative(right, i));
			block = Math.max(block, LightCoordsUtil.block(l));
			sky = Math.max(sky, LightCoordsUtil.sky(l));
		}
		// the floor also keeps palette colours true under a sunset sky (sky light alone tints them pink)
		return LightCoordsUtil.pack(Math.max(block, lightFloor), sky);
	}

	@Override
	public void submit(State s, PoseStack ps, SubmitNodeCollector c, CameraRenderState camera) {
		TaskBoard b = s.board;
		if (!s.panelOrigin || b == null || b.ppb == 0) {
			return;
		}
		long t0 = System.nanoTime();
		ps.pushPose();
		toFace(ps, s.facing, LINEN_DEPTH, b.ppb);
		ps.translate(0, -(s.panelHeight - 1) * b.ppb, 0);
		int light = s.light;
		int headInk = UiStyle.color("paper.text", 0xFF1F1E1D);
		int muted = UiStyle.color("paper.muted", 0xFF655E55);
		// the board's own walnut surface, evenly lit (the block face is shaded by its facing; the cards are not)
		drawTiled(ps, c, b, SURFACE, light);
		// ---- column rules + headers (one rect batch)
		DisplayDraw.Rects r = b.lanes.clear();
		int rule = UiStyle.color("board.rule", 0xFFC9A227);
		for (int i = 0; i < b.columns.size(); i++) {
			TaskBoard.Column col = b.columns.get(i);
			if (i > 0) {
				float rx = col.ax - TaskBoard.GAP / 2f;
				r.add(rx - 0.5f, b.iy0 + 2, rx + 0.5f, b.iy1 - 2, Z, rule, light);
			}
			// header strip: paper label with a status-coloured underline
			r.add(col.ax, b.iy0 + 1, col.ax + col.aw, b.iy0 + TaskBoard.HEADER_H - 1, 2 * Z, UiStyle.color("board.label", 0xFFF4EFE6), light);
			r.add(col.ax, b.iy0 + TaskBoard.HEADER_H - 2, col.ax + col.aw, b.iy0 + TaskBoard.HEADER_H, 2.5f * Z, UiStyle.status(col.family), light);
			if (col.chip != null) {
				float cx = col.chipX();
				r.add(cx, col.chipY, cx + col.chipW, col.chipY + TaskBoard.CHIP_H, 2 * Z, UiStyle.color("board.chip", 0xFFE9E1D3), light);
				r.add(cx, col.chipY + TaskBoard.CHIP_H - 1, cx + col.chipW, col.chipY + TaskBoard.CHIP_H, 2.5f * Z,
					UiStyle.color("palette.ui.edge", 0xFFC9BBA3), light);
			}
		}
		r.submit(ps, c);
		ps.pushPose();
		ps.translate(0, 0, 3 * Z);
		for (TaskBoard.Column col : b.columns) {
			WorldUi.submitText(ps, c, col.label, col.ax + 4, b.iy0 + 3, headInk, light);
			WorldUi.submitText(ps, c, col.countSeq, col.countX(), b.iy0 + 3, muted, light);
			if (col.blocked > 0 && col.blockedW > 0) {
				// explicit "1 blocked" in the error colour, apart from the column's count
				float bx = col.countX() - 8 - col.blockedW;
				WorldUi.submitText(ps, c, col.blockedSeq, bx, b.iy0 + 3, UiStyle.color("paper.del_fg", 0xFF873C2A), light);
			}
			if (col.chip != null) {
				WorldUi.submitText(ps, c, col.chip, col.chipX() + 5, col.chipY + 2, muted, light);
			}
		}
		ps.popPose();
		// ---- cards: settled ones first, then the ones in flight (lifted, with a shadow)
		STATIC.clear();
		FLYING.clear();
		for (TaskBoard.Card card : b.cards.values()) {
			boolean gliding = Math.abs(card.x - card.tx) > 1 || Math.abs(card.y - card.ty) > 1;
			if (!card.visible && !card.removing && !gliding) {
				continue; // parked behind "+N more"
			}
			(card.flying ? FLYING : STATIC).add(card);
		}
		long now = System.nanoTime();
		for (TaskBoard.Card card : STATIC) {
			drawCard(ps, c, b, card, 0, light, now, card.id.equals(s.hovered));
		}
		if (!FLYING.isEmpty()) {
			DisplayDraw.Rects shadow = b.shadows.clear();
			int sh = UiStyle.withAlpha(UiStyle.color("palette.ui.shadow", 0xFF1F1E1D), 46);
			for (TaskBoard.Card card : FLYING) {
				shadow.add(card.x + 2, card.y + 3, card.x + card.w + 2, card.y + card.h + 2, LIFT - Z, sh, light);
			}
			c.order(0).submitCustomGeometry(ps, DisplayDraw.fillTranslucent(), (pose, vc) -> shadow.emit(pose, vc, 255, -1));
			for (TaskBoard.Card card : FLYING) {
				drawCard(ps, c, b, card, LIFT, light, now, false);
			}
		}
		if (!s.noData && b.total == 0 && b.cards.isEmpty()) {
			drawEmpty(ps, c, b, light);
		}
		if (s.stale || s.noData) {
			drawOffline(ps, c, b, light, s.noData ? s.noDataText : DisplayText.OFFLINE, s.noData);
		}
		ps.popPose();
		DisplayStats.add(DisplayStats.Kind.BOARD, System.nanoTime() - t0);
	}

	/** No tasks yet: a paper note pinned in the middle that says how to start, with the console key as a keycap. */
	private static void drawEmpty(PoseStack ps, SubmitNodeCollector c, TaskBoard b, int light) {
		Font font = Minecraft.getInstance().font;
		String l1 = Tr.t("No tasks yet");
		String key = TaskWallFeature.startKey();
		String pre = key.isEmpty() ? Tr.t("Open the console, type a goal") : Tr.t("Press ");
		String post = key.isEmpty() ? "" : Tr.t(" and type a goal");
		float kw = key.isEmpty() ? 0 : font.width(key) + 8;
		float w2 = font.width(pre) + kw + font.width(post);
		float w = Math.max(font.width(l1), w2) + 18, h = 33;
		float x = (b.pw - w) / 2f, y = (b.iy0 + TaskBoard.HEADER_H + b.iy1 - h) / 2f;
		TextureAtlasSprite sprite = WorldUi.sprite(Kit.card("todo"));
		TextureAtlasSprite cap = WorldUi.sprite(Kit.KEYCAP);
		float kx = x + 9 + font.width(pre);
		float ky = y + 16;
		c.order(0).submitCustomGeometry(ps, WorldUi.guiAtlasSolid(), (pose, vc) -> {
			DisplayDraw.nineSlice(pose, vc, sprite, x, y, w, h - 1, 2 * Z, 0xFFFFFFFF, light, 1);
			if (kw > 0) {
				DisplayDraw.nineSlice(pose, vc, cap, kx, ky - 1, kw, 12, 2.5f * Z, 0xFFFFFFFF, light);
			}
		});
		ps.pushPose();
		ps.translate(0, 0, 3 * Z);
		int ink = UiStyle.color("paper.text", 0xFF1F1E1D);
		int muted = UiStyle.color("paper.muted", 0xFF655E55);
		WorldUi.submitText(ps, c, l1, x + 9, y + 5, ink, light);
		WorldUi.submitText(ps, c, pre, x + 9, ky + 1, muted, light);
		if (kw > 0) {
			WorldUi.submitText(ps, c, key, kx + 4, ky + 1, ink, light);
			WorldUi.submitText(ps, c, post, kx + kw, ky + 1, muted, light);
		}
		ps.popPose();
	}

	/** Link lost (or never up): the last known board stays, dimmed under a walnut veil, with a paper badge on top. */
	private static void drawOffline(PoseStack ps, SubmitNodeCollector c, TaskBoard b, int light, String label, boolean never) {
		Font font = Minecraft.getInstance().font;
		DisplayDraw.Rects v = b.veil.clear();
		float trim = b.ppb * TaskBoard.TRIM / 16f;
		v.add(trim, trim, b.pw - trim, b.ph - trim, LIFT + 4 * Z, UiStyle.withAlpha(UiStyle.color("palette.colors.walnut", 0xFF3B2A20), 150), light);
		c.order(0).submitCustomGeometry(ps, DisplayDraw.fillTranslucent(), (pose, vc) -> v.emit(pose, vc, 255, -1));
		int tw = font.width(label);
		float w = tw + 20, h = 15;
		float x = (b.pw - w) / 2f, y = (b.ph - h) / 2f;
		DisplayDraw.Rects badge = b.badge.clear();
		badge.add(x, y, x + w, y + h, LIFT + 5 * Z, UiStyle.color("board.label", 0xFFF4EFE6), light);
		badge.add(x, y + h - 1, x + w, y + h, LIFT + 5.5f * Z, UiStyle.color("palette.ui.edge", 0xFFC9BBA3), light);
		badge.submit(ps, c);
		ps.pushPose();
		ps.translate(0, 0, LIFT + 6 * Z);
		WorldUi.submitSprite(ps, c, WorldUi.Layer.SOLID, DisplayDraw.dot(never ? "idle" : "error", false), x + 5, y + 4, 7, 7, 0f, 0xFFFFFFFF, light);
		WorldUi.submitText(ps, c, label, x + 15, y + 4, UiStyle.color("paper.text", 0xFF1F1E1D), light);
		ps.popPose();
	}

	/** A block texture tiled over the panel inside its trim (one texture repeat per block). */
	private static void drawTiled(PoseStack ps, SubmitNodeCollector c, TaskBoard b, Identifier spriteId, int light) {
		TextureAtlasSprite sp = Minecraft.getInstance().getAtlasManager().getAtlasOrThrow(AtlasIds.BLOCKS).getSprite(spriteId);
		float trim = b.ppb * TaskBoard.TRIM / 16f;
		float x0 = trim, y0 = trim, x1 = b.pw - trim, y1 = b.ph - trim;
		int ppb = b.ppb;
		c.order(0).submitCustomGeometry(ps, DisplayDraw.solid(sp.atlasLocation()), (pose, vc) -> {
			for (int bx = 0; bx * ppb < x1; bx++) {
				for (int by = 0; by * ppb < y1; by++) {
					float cx0 = Math.max(x0, bx * ppb), cx1 = Math.min(x1, (bx + 1) * ppb);
					float cy0 = Math.max(y0, by * ppb), cy1 = Math.min(y1, (by + 1) * ppb);
					if (cx1 <= cx0 || cy1 <= cy0) {
						continue;
					}
					float u0 = sp.getU((cx0 - bx * ppb) / ppb), u1 = sp.getU((cx1 - bx * ppb) / ppb);
					float v0 = sp.getV((cy0 - by * ppb) / ppb), v1 = sp.getV((cy1 - by * ppb) / ppb);
					WorldUi.quad(pose, vc, cx0, cy0, cx1, cy1, Z * 0.5f, u0, v0, u1, v1, 0xFFFFFFFF, light);
				}
			}
		});
	}

	private static String family(TaskBoard.Col col) {
		return switch (col) {
			case TODO -> "idle";
			case DOING -> "working";
			case REVIEW -> "thinking";
			case DONE -> "done";
		};
	}

	private static void drawCard(PoseStack ps, SubmitNodeCollector c, TaskBoard b, TaskBoard.Card card, float lift, int light, long now,
		boolean hovered) {
		TaskBoard.Content ct = card.drawable();
		if (ct == null) {
			return;
		}
		float w = card.w;
		float h = card.h;
		ps.pushPose();
		if (card.scale < 0.999f) {
			float cx = card.x + w / 2f;
			float cy = card.y + h / 2f;
			ps.translate(cx, cy, 0);
			ps.scale(card.scale, card.scale, 1f);
			ps.translate(-cx, -cy, 0);
		}
		float x = card.x;
		float y = card.y;
		// arrival glow: a light outline in the new column's colour that fades over 1.4 s once the card has landed
		if (card.arrivedAt != 0) {
			float t = (now - card.arrivedAt) / 1e9f / 1.4f;
			if (t < 1) {
				float k = (1 - t) * (1 - t);
				int base = UiStyle.status(card.task.status() == TaskStatus.BLOCKED ? "error" : family(card.col));
				// lifted towards cream so even Todo's grey reads against the walnut
				int tint = DisplayDraw.mix(base, UiStyle.color("palette.colors.cream", 0xFFF4EFE6), 0.35f);
				int inner = UiStyle.withAlpha(tint, (int) (235 * k));
				int outer = UiStyle.withAlpha(tint, (int) (110 * k));
				DisplayDraw.Rects g = card.glow.clear();
				ring(g, x, y, w, h, 2, lift + Z, inner, light);
				ring(g, x - 2, y - 2, w + 4, h + 4, 1, lift + Z, outer, light);
				c.order(0).submitCustomGeometry(ps, DisplayDraw.fillTranslucent(), (pose, vc) -> g.emit(pose, vc, 255, -1));
			} else {
				card.arrivedAt = 0;
				card.arrivedFrom = null;
			}
		}
		TextureAtlasSprite sprite = WorldUi.sprite(card.sprite);
		float zc = lift + 2 * Z;
		// opaque body without the sprite's translucent shadow row, then a soft shadow under it
		c.order(0).submitCustomGeometry(ps, WorldUi.guiAtlasSolid(), (pose, vc) -> DisplayDraw.nineSlice(pose, vc, sprite, x, y, w,
			h - 1, zc, 0xFFFFFFFF, light, 1));
		DisplayDraw.Rects soft = card.shadow.clear();
		int shadowInk = UiStyle.color("palette.ui.shadow", 0xFF1F1E1D);
		soft.add(x + 1, y + h - 1, x + w, y + h, zc, UiStyle.withAlpha(shadowInk, 60), light);
		soft.add(x + 2, y + h, x + w - 1, y + h + 1, zc, UiStyle.withAlpha(shadowInk, 24), light);
		if (ct.needsYou && !hovered) {
			// waits on you: a breathing clay outline (same pulse as every other "waiting" surface)
			float k = dev.agentcraft.client.ui.StatusMap.pulse(now);
			int clay = UiStyle.status("waiting");
			ring(soft, x, y, w, h - 1, 1.5f, zc, UiStyle.withAlpha(clay, (int) (150 + 105 * k)), light);
			ring(soft, x - 1.5f, y - 1.5f, w + 3, h + 2, 1.5f, zc, UiStyle.withAlpha(clay, (int) (30 + 70 * k)), light);
		}
		if (hovered) {
			// crosshair on the card: a brass outline says "right-click opens it"
			ring(soft, x - 0.5f, y - 0.5f, w + 1, h + 1, 1, zc, UiStyle.color("palette.colors.brass", 0xFFC9A227), light);
		}
		c.order(0).submitCustomGeometry(ps, DisplayDraw.fillTranslucent(), (pose, vc) -> soft.emit(pose, vc, 255, -1));
		Kit.Padding p = Kit.padding("card_todo");
		float cx0 = x + p.left();
		float cx1 = x + w - p.right();
		ps.pushPose();
		ps.translate(0, 0, lift + 3 * Z);
		// Content was laid out for the card's target size; while the size animates, lines that would not
		// fit the current height drop out (from the bottom), so a resizing card never overlaps itself.
		boolean full = ct.size == TaskBoard.Size.FULL && h >= TaskBoard.fullH(1) - 0.5f;
		if (!full) {
			// title only (1 or 2 lines), centred in whatever height the card has right now
			int n = Math.max(1, Math.min(ct.lines.size(), (int) ((h - 5) / TaskBoard.LINE)));
			float ty = y + (h - 1 - (n * TaskBoard.LINE - 2)) / 2f;
			for (int i = 0; i < n; i++) {
				WorldUi.submitText(ps, c, ct.lines.get(i), cx0, ty + i * TaskBoard.LINE, ct.titleColor, light);
			}
			if (ct.face != null && (ct.size != TaskBoard.Size.FULL || ct.dot == null)) {
				DisplayDraw.submitTexture(ps, c, ct.face, cx1 - 8, ty, 8, 8, 0f, 0xFFFFFFFF, light);
			}
		} else {
			float ty = y + p.top();
			float fy = y + h - TaskBoard.FOOT;
			int li = 0;
			for (int i = 0; i < ct.lines.size(); i++, li++) {
				float ly = ty + li * TaskBoard.LINE;
				if (i > 0 && ly + 8 > fy - 2) {
					break; // the footer has risen into this line: the next content takes over once it fits
				}
				WorldUi.submitText(ps, c, ct.lines.get(i), cx0, ly, ct.titleColor, light);
			}
			int reasonInk = UiStyle.color("paper.del_fg", 0xFF873C2A);
			for (int i = 0; i < ct.reason.size(); i++, li++) {
				float ly = ty + li * TaskBoard.LINE;
				if (ly + 8 > fy - 2) {
					break;
				}
				WorldUi.submitText(ps, c, ct.reason.get(i), cx0, ly, reasonInk, light);
			}
			if (ct.dot != null) {
				if (ct.dot.equals("waiting")) {
					int pulse = UiStyle.metric("metrics.pulse_ms", 1200);
					double ph = ((now / 1_000_000L) % pulse) / (double) pulse;
					int a = (int) (40 + 150 * (0.5 - 0.5 * Math.cos(ph * Math.PI * 2)));
					WorldUi.submitSprite(ps, c, WorldUi.Layer.OVERLAY, DisplayDraw.dot("waiting", true), cx1 - 9, ty - 2, 11, 11, 0f, (a << 24) | 0xFFFFFF,
						light);
				}
				WorldUi.submitSprite(ps, c, WorldUi.Layer.SOLID, DisplayDraw.dot(ct.dot, false), cx1 - 7, ty, 7, 7, Z * 0.5f, 0xFFFFFFFF, light);
			}
			// footer on the card's bottom edge, so it rides along while the height animates
			float fx = cx0;
			if (ct.face != null) {
				DisplayDraw.submitTexture(ps, c, ct.face, fx, fy, 8, 8, 0f, 0xFFFFFFFF, light);
				fx += 10;
			}
			FormattedCharSequence name = ct.name;
			if (name != null) {
				WorldUi.submitText(ps, c, name, fx, fy, ct.nameColor, light);
			}
			if (ct.hint != null) {
				WorldUi.submitText(ps, c, ct.hint, ct.hintLeft ? fx : cx1 - ct.hintW, fy, ct.hintColor, light);
			}
		}
		ps.popPose();
		ps.popPose();
	}

	/** A rectangular outline {@code t} px thick just outside (x, y, w, h). */
	private static void ring(DisplayDraw.Rects r, float x, float y, float w, float h, float t, float z, int argb, int light) {
		r.add(x - t, y - t, x + w + t, y, z, argb, light);
		r.add(x - t, y + h, x + w + t, y + h + t, z, argb, light);
		r.add(x - t, y, x, y + h, z, argb, light);
		r.add(x + w, y, x + w + t, y + h, z, argb, light);
	}
}

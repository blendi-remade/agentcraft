package dev.agentcraft.client.diff;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.math.Axis;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.block.FacingEntityBlock;
import dev.agentcraft.block.ModBlocks;
import dev.agentcraft.block.entity.MergeStationBlockEntity;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.foreman.Protocol.Repo;
import dev.agentcraft.client.foreman.Protocol.Task;
import dev.agentcraft.client.foreman.Protocol.Worktree;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import dev.agentcraft.client.ui.WorldUi;
import dev.agentcraft.client.world.StationRenderState;
import dev.agentcraft.client.world.StationRenderer;
import dev.agentcraft.client.ui.Tr;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.rendertype.RenderType;
import net.minecraft.client.renderer.rendertype.RenderTypes;
import net.minecraft.client.renderer.state.level.CameraRenderState;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.resources.Identifier;
import net.minecraft.util.LightCoordsUtil;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * Merge Station BER: a paper review card propped on the worktop, facing the front. A row of merge
 * stations (same facing, side by side) is a review queue: the k-th station from the viewer's left
 * shows the k-th waiting merge decision (oldest first); the first one carries the count, or an
 * "all clear" card when nothing waits. Card: worker face + name + task, task title, +/- and file
 * count, CI dot; a pulsing clay dot while it waits for you.
 */
public class MergeStationRenderer extends StationRenderer<MergeStationBlockEntity, MergeStationRenderer.State> {
	static final float PX_PER_BLOCK = 96f;
	static final int CARD_W = 88;
	static final int CARD_H = 63;
	static final int EMPTY_H = 22;
	static final float TILT = 14f;
	/** Depth step (blocks) for opaque layers stacked on the card. */
	static final float LIFT = 0.0015f;

	public static class State extends StationRenderState {
		public boolean show;
		public boolean empty;
		public int index;
		public int count;
		public @Nullable String worker;
		public String name = "";
		public int nameColor;
		public String taskId = "";
		public String title = "";
		public String adds = "";
		public String dels = "";
		public String files = "";
		public String ciFamily = "idle";
		public String ciLabel = "";
		public int ciInk;
		public int light;
	}

	private static long queueRevision = -1;
	private static List<Decision> queue = List.of();
	private static final Map<String, RenderType> FACE_TYPES = new HashMap<>();

	@Override
	public State createRenderState() {
		return new State();
	}

	@Override
	public boolean shouldRenderOffScreen() {
		return false;
	}

	/** Waiting merge decisions, oldest first (cached by Foreman revision). Client thread. */
	public static List<Decision> queue() {
		ForemanState s = Foreman.state();
		if (s == null) {
			return List.of();
		}
		if (s.revision() != queueRevision) {
			List<Decision> q = new ArrayList<>();
			for (Decision d : s.openDecisions()) {
				if (d.kind() == Protocol.DecisionKind.MERGE) {
					q.add(d);
				}
			}
			queue = List.copyOf(q);
			queueRevision = s.revision();
		}
		return queue;
	}

	/** Position of this station in its row, counted from the viewer's left (0 = first). */
	public static int rowIndex(Level level, BlockPos pos, BlockState state) {
		if (!state.hasProperty(FacingEntityBlock.FACING)) {
			return 0;
		}
		Direction facing = state.getValue(FacingEntityBlock.FACING);
		Direction left = facing.getClockWise();
		int k = 0;
		BlockPos p = pos.relative(left);
		while (k < 16) {
			BlockState s = level.getBlockState(p);
			if (!s.is(ModBlocks.MERGE_STATION) || s.getValue(FacingEntityBlock.FACING) != facing) {
				break;
			}
			k++;
			p = p.relative(left);
		}
		return k;
	}

	@Override
	protected void extractStation(MergeStationBlockEntity be, State s, float partialTicks) {
		Level level = be.getLevel();
		s.show = false;
		if (level == null || Foreman.state() == null || !Foreman.state().hasData()) {
			return;
		}
		s.light = LightCoordsUtil.getLightCoords(level, be.getBlockPos().above());
		List<Decision> q = queue();
		int k = rowIndex(level, be.getBlockPos(), be.getBlockState());
		s.index = k;
		s.count = q.size();
		if (k >= q.size()) {
			s.show = k == 0;
			s.empty = true;
			return;
		}
		s.show = true;
		s.empty = false;
		Decision d = q.get(k);
		ForemanState st = Foreman.state();
		Task t = d.taskId() == null ? null : st.task(d.taskId());
		Worktree w = null;
		Repo r = d.repoId() == null ? null : st.repo(d.repoId());
		if (r != null && d.worktree() != null) {
			for (Worktree x : r.worktrees()) {
				if (d.worktree().equals(x.id())) {
					w = x;
				}
			}
		}
		s.worker = w != null ? w.agentId() : t != null && t.assignee() != null ? t.assignee() : d.agentId();
		s.name = ReviewKit.agentName(s.worker);
		s.nameColor = ReviewKit.agentInk(s.worker);
		s.taskId = t != null ? t.id() : d.worktree() == null ? "" : d.worktree();
		s.title = ReviewKit.plain(t != null ? t.title() : d.question());
		if (w != null) {
			s.adds = "+" + w.additions();
			s.dels = "-" + w.deletions();
			s.files = w.files() + (w.files() == 1 ? Tr.t(" file") : Tr.t(" files"));
		} else {
			s.adds = s.dels = "";
			s.files = "";
		}
		Protocol.CiStatus ci = t != null ? t.ci() : Protocol.CiStatus.UNKNOWN;
		s.ciFamily = ReviewKit.ciFamily(ci);
		s.ciInk = ReviewKit.ciInk(ci);
		s.ciLabel = switch (ci) {
			case PASS -> "pass";
			case FAIL -> "fail";
			case RUNNING -> "testing";
			default -> "";
		};
	}

	@Override
	public void submit(State s, PoseStack ps, SubmitNodeCollector collector, CameraRenderState camera) {
		if (!s.show) {
			return;
		}
		Font font = Minecraft.getInstance().font;
		int h = s.empty ? EMPTY_H : CARD_H;
		int w = s.empty ? Math.min(CARD_W, 17 + Math.max(font.width(Tr.t("All merged")), font.width(Tr.t("nothing waits"))) + 7) : CARD_W;
		int light = LightCoordsUtil.pack(Math.max(LightCoordsUtil.block(s.light), 11), LightCoordsUtil.sky(s.light));
		ps.pushPose();
		// north-facing model frame: the viewer stands at -Z; the card stands on the top face, leaning back
		ps.translate(0.5f, 0.5f, 0.5f);
		ps.rotateDegrees(Axis.YP, -modelRotation(s.facing));
		ps.translate(-0.5f, -0.5f, -0.5f);
		ps.translate(0.5f, 1.0f + 0.004f, 0.52f);
		ps.rotateDegrees(Axis.XP, TILT);
		float hb = h / PX_PER_BLOCK;
		float wb = w / PX_PER_BLOCK;
		ps.pushPose();
		ps.translate(wb / 2f, hb, 0);
		ps.scale(-1f / PX_PER_BLOCK, -1f / PX_PER_BLOCK, 1f);
		drawCard(s, ps, collector, font, w, h, light);
		ps.popPose();
		// back of the card (the front quads are culled from behind)
		ps.pushPose();
		ps.translate(-wb / 2f, hb, 0.001f);
		ps.rotateDegrees(Axis.YP, 180);
		ps.scale(-1f / PX_PER_BLOCK, -1f / PX_PER_BLOCK, 1f);
		WorldUi.submitFill(ps, collector, 0, 0, w, h + 1, UiStyle.color("palette.ui.panel_shade"), light);
		ps.popPose();
		ps.popPose();
	}

	private void drawCard(State s, PoseStack ps, SubmitNodeCollector c, Font font, int w, int h, int light) {
		int ink = UiStyle.color("paper.text");
		int muted = UiStyle.color("paper.muted");
		if (s.empty) {
			WorldUi.submitNineSlice(ps, c, WorldUi.Layer.SOLID, Kit.card("done"), 0, 0, w, h, 0xFFFFFFFF, light);
			WorldUi.submitSprite(ps, c, Kit.dot("done", false), 7, 7, 7, 7, 0xFFFFFFFF, light);
			WorldUi.submitText(ps, c, Tr.t("All merged"), 17, 4, ink, light);
			WorldUi.submitText(ps, c, Tr.t("nothing waits"), 17, 12, muted, light);
			// the brass foot
			WorldUi.submitFill(ps, c, 2, h - 1, w - 2, h + 1, UiStyle.color("palette.ui.border"), light);
			return;
		}
		WorldUi.submitNineSlice(ps, c, WorldUi.Layer.SOLID, Kit.card("review"), 0, 0, w, h, 0xFFFFFFFF, light);
		int x = 7;
		// header: merge icon + label, count chip (clay = waiting for you) with a pulsing halo
		WorldUi.submitSprite(ps, c, Kit.icon("merge"), x - 1, 3, 12, 12, 0xFFFFFFFF, light);
		String count = s.index == 0 ? String.valueOf(s.count) : (s.index + 1) + "/" + s.count;
		int cw = Math.max(10, font.width(count) + 5);
		int cx = w - 5 - cw;
		int labelMax = cx - (x + 13) - (s.index == 0 ? 13 : 3);
		String head = s.index == 0 ? (font.width(Tr.t("Merge review")) <= labelMax ? Tr.t("Merge review") : Tr.t("Review")) : Tr.t("Next");
		WorldUi.submitText(ps, c, head, x + 13, 5, ink, light);
		if (s.index == 0) {
			float phase = (float) ((System.currentTimeMillis() % 1200) / 1200.0 * Math.PI * 2);
			int alpha = (int) (70 + 70 * Math.sin(phase));
			WorldUi.submitSprite(ps, c, WorldUi.Layer.OVERLAY, Kit.dot("waiting", true), cx - 12, 3, 11, 11, 0.05f, UiStyle.withAlpha(0xFFFFFFFF,
				alpha + 30), light);
			WorldUi.submitSprite(ps, c, WorldUi.Layer.OVERLAY, Kit.dot("waiting", false), cx - 10, 5, 7, 7, 0.1f, 0xFFFFFFFF, light);
			// the chip sits a hair in front of the card (two opaque quads must not be coplanar), its text with it
			ps.pushPose();
			ps.translate(0, 0, -LIFT);
			WorldUi.submitNineSlice(ps, c, WorldUi.Layer.SOLID, Kit.progressFill("clay"), cx, 4, cw, 10, 0xFFFFFFFF, light);
			WorldUi.submitText(ps, c, count, cx + (cw - font.width(count) + 1) / 2, 5, UiStyle.color("palette.ui.panel_hi"), light);
			ps.popPose();
		} else {
			WorldUi.submitText(ps, c, count, w - 5 - font.width(count), 5, muted, light);
		}
		ps.pushPose();
		ps.translate(0, 0, -LIFT);
		WorldUi.submitNineSlice(ps, c, WorldUi.Layer.SOLID, Kit.DIVIDER, x, 15, w - 5 - x, 3, 0xFFFFFFFF, light);
		ps.popPose();
		// worker face + name + task id
		int ry = 20;
		submitFace(ps, c, s.worker, x, ry, light);
		WorldUi.submitText(ps, c, TextUtil.ellipsize(font, s.name, 40), x + 11, ry, s.nameColor, light);
		int idx = x + 11 + Math.min(40, font.width(s.name)) + 5;
		WorldUi.submitText(ps, c, TextUtil.ellipsize(font, s.taskId, w - 5 - idx), idx, ry, muted, light);
		// task title, up to two lines
		List<String> lines = TextUtil.wrapPlain(font, s.title, w - 5 - x);
		for (int i = 0; i < Math.min(2, lines.size()); i++) {
			String l = i == 1 && lines.size() > 2 ? TextUtil.ellipsize(font, lines.get(1) + TextUtil.ELLIPSIS, w - 5 - x) : lines.get(i);
			WorldUi.submitText(ps, c, l, x, ry + 11 + i * 9, ink, light);
		}
		// stats + CI
		int sy = h - 13;
		int sx = x;
		if (!s.adds.isEmpty()) {
			WorldUi.submitText(ps, c, s.adds, sx, sy, UiStyle.color("paper.add_fg"), light);
			sx += font.width(s.adds) + 3;
			WorldUi.submitText(ps, c, s.dels, sx, sy, UiStyle.color("paper.del_fg"), light);
			sx += font.width(s.dels) + 4;
		}
		WorldUi.submitSprite(ps, c, Kit.dot(s.ciFamily, false), w - 12, sy, 7, 7, 0xFFFFFFFF, light);
		String ci = s.ciLabel;
		if (!ci.isEmpty() && sx + font.width(ci) <= w - 15) {
			WorldUi.submitText(ps, c, ci, w - 15 - font.width(ci), sy, s.ciInk, light);
		}
		WorldUi.submitFill(ps, c, 2, h - 1, w - 2, h + 1, UiStyle.color("palette.ui.border"), light);
	}

	private static void submitFace(PoseStack ps, SubmitNodeCollector c, @Nullable String agent, float x, float y, int light) {
		if (agent == null) {
			return;
		}
		Identifier tex = AgentCraft.id("textures/gui/portrait/" + agent + ".png");
		if (Minecraft.getInstance().getResourceManager().getResource(tex).isEmpty()) {
			WorldUi.submitFill(ps, c, x, y, x + 8, y + 8, ReviewKit.agentIdentity(agent), light);
			return;
		}
		RenderType type = FACE_TYPES.computeIfAbsent(agent, a -> RenderTypes.textPolygonOffset(tex));
		c.order(1).submitCustomGeometry(ps, type, (pose, vc) -> WorldUi.quad(pose, vc, x, y, x + 8, y + 8, 0, 0, 1, 1, 0xFFFFFFFF, light));
	}
}

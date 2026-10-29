package dev.agentcraft.client.library;

import com.mojang.blaze3d.vertex.PoseStack;
import dev.agentcraft.block.FacingEntityBlock;
import dev.agentcraft.block.ModBlocks;
import dev.agentcraft.block.entity.MemoryArchiveBlockEntity;
import dev.agentcraft.block.entity.StationBlockEntity;
import dev.agentcraft.client.diff.ReviewKit;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.Protocol.MemoryEntry;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.UiStyle;
import dev.agentcraft.client.ui.WorldUi;
import dev.agentcraft.client.world.StationRenderState;
import dev.agentcraft.client.world.StationRenderer;
import dev.agentcraft.client.ui.Tr;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.state.level.CameraRenderState;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.util.LightCoordsUtil;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * Memory archive BER: shelf labels on the board between the two shelves. A row of archives (same
 * facing, same binding = scope, side by side) is one shelf section: its first block (viewer's left)
 * carries a brass-rimmed plate with the scope and the number of notes; each further block labels
 * one note (the plan first, then the order they were written) with an author-coloured tab. A quill
 * marks notes you have not read yet in the library. Right-click opens the library at that scope / note.
 */
public class MemoryArchiveRenderer extends StationRenderer<MemoryArchiveBlockEntity, MemoryArchiveRenderer.State> {
	static final float PX_PER_BLOCK = 96f;
	/** The board between the shelves is texel rows 7-8 of the 16 px front: 42..54 at 96 px per block. */
	static final int LABEL_Y = 40;
	static final int LABEL_H = 16;
	static final float LIFT = 0.0015f;

	public static class State extends StationRenderState {
		public boolean show;
		public boolean plate;
		public String label = "";
		public String count = "";
		public boolean fresh;
		public boolean plan;
		public int tabColor;
		public int light;
	}

	@Override
	public State createRenderState() {
		return new State();
	}

	/** Position in the shelf section (same facing + binding, same height), counted from the viewer's left. */
	public static int rowIndex(Level level, BlockPos pos, BlockState state, String binding) {
		if (!state.hasProperty(FacingEntityBlock.FACING)) {
			return 0;
		}
		Direction facing = state.getValue(FacingEntityBlock.FACING);
		Direction left = facing.getClockWise();
		int k = 0;
		BlockPos p = pos.relative(left);
		while (k < 32) {
			BlockState s = level.getBlockState(p);
			if (!s.is(ModBlocks.MEMORY_ARCHIVE) || s.getValue(FacingEntityBlock.FACING) != facing) {
				break;
			}
			String b = level.getBlockEntity(p) instanceof StationBlockEntity be ? be.binding() : "";
			if (!b.equals(binding)) {
				break;
			}
			k++;
			p = p.relative(left);
		}
		return k;
	}

	/** The note an archive block labels (null for the section's plate block or past the last note). */
	public static @Nullable MemoryEntry entryAt(int index, String scope) {
		List<MemoryEntry> list = MemoryIndex.shelf(scope);
		int i = index - 1;
		return i >= 0 && i < list.size() ? list.get(i) : null;
	}

	@Override
	protected void extractStation(MemoryArchiveBlockEntity be, State s, float partialTicks) {
		Level level = be.getLevel();
		s.show = false;
		if (level == null || Foreman.state() == null || !Foreman.state().hasData()) {
			return;
		}
		s.light = LightCoordsUtil.getLightCoords(level, be.getBlockPos().relative(s.facing));
		int k = rowIndex(level, be.getBlockPos(), be.getBlockState(), s.binding);
		String scope = s.binding;
		if (k == 0) {
			s.show = true;
			s.plate = true;
			s.label = scope.isEmpty() ? Tr.t("Memory") : MemoryIndex.scopeLabel(scope);
			int n = MemoryIndex.count(scope);
			s.count = String.valueOf(n);
			s.fresh = MemoryIndex.unread(scope) > 0;
			return;
		}
		MemoryEntry e = entryAt(k, scope);
		if (e == null) {
			return;
		}
		s.show = true;
		s.plate = false;
		s.label = e.title();
		s.plan = MemoryIndex.isPlan(e);
		String author = e.author() != null ? e.author() : e.scope();
		s.tabColor = s.plan ? UiStyle.BRASS : ReviewKit.agentIdentity(author);
		s.fresh = MemoryIndex.isUnread(e);
	}

	@Override
	public void submit(State s, PoseStack ps, SubmitNodeCollector c, CameraRenderState camera) {
		if (!s.show) {
			return;
		}
		Font font = Minecraft.getInstance().font;
		int light = LightCoordsUtil.pack(Math.max(LightCoordsUtil.block(s.light), 10), LightCoordsUtil.sky(s.light));
		ps.pushPose();
		toFace(ps, s.facing, -0.004f, PX_PER_BLOCK);
		int x0 = 9;
		int x1 = 87;
		int y = LABEL_Y;
		int ink = UiStyle.color("paper.text");
		// labels are paper, not light: tint the bright kit pill down to cream
		int paper = 0xFFF2ECE1;
		if (s.plate) {
			WorldUi.submitNineSlice(ps, c, WorldUi.Layer.SOLID, Kit.PILL, x0, y, x1 - x0, LABEL_H, paper, light);
			String count = s.count;
			int cw = Math.max(10, font.width(count) + 5);
			int cx = x1 - 4 - cw;
			int lx = x0 + 6;
			if (s.fresh) {
				WorldUi.submitSprite(ps, c, Kit.icon("edit"), lx - 1, y + 2, 12, 12, 0xFFFFFFFF, light);
				lx += 12;
			}
			WorldUi.submitText(ps, c, TextUtil.ellipsize(font, s.label.toUpperCase(java.util.Locale.ROOT), cx - 4 - lx), lx, y + 4, ink, light);
			ps.pushPose();
			ps.translate(0, 0, -LIFT);
			WorldUi.submitNineSlice(ps, c, WorldUi.Layer.SOLID, Kit.progressFill("brass"), cx, y + 3, cw, 10, 0xFFFFFFFF, light);
			WorldUi.submitText(ps, c, count, cx + (cw - font.width(count) + 1) / 2, y + 4, ink, light);
			ps.popPose();
		} else {
			WorldUi.submitNineSlice(ps, c, WorldUi.Layer.SOLID, Kit.PILL, x0, y, x1 - x0, LABEL_H, paper, light);
			int lx = x0 + 9;
			int right = x1 - 5;
			if (s.fresh) {
				WorldUi.submitSprite(ps, c, Kit.icon("edit"), right - 11, y + 2, 12, 12, 0xFFFFFFFF, light);
				right -= 13;
			}
			WorldUi.submitText(ps, c, TextUtil.ellipsize(font, s.label, right - lx), lx, y + 4, ink, light);
			ps.pushPose();
			ps.translate(0, 0, -LIFT);
			WorldUi.submitNineSlice(ps, c, WorldUi.Layer.SOLID, s.plan ? Kit.progressFill("brass") : Kit.PROGRESS_TRACK, x0 + 3, y + 3, 4, LABEL_H - 6,
				s.plan ? 0xFFFFFFFF : s.tabColor, light);
			ps.popPose();
		}
		ps.popPose();
	}
}

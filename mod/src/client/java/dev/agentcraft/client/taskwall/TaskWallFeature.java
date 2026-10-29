package dev.agentcraft.client.taskwall;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.agentcraft.block.ModBlocks;
import dev.agentcraft.block.PanelBlock;
import dev.agentcraft.block.entity.ModBlockEntities;
import dev.agentcraft.client.dev.DevBridge;
import dev.agentcraft.client.dev.Fields;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanListener;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.foreman.Protocol.Task;
import dev.agentcraft.client.foreman.Protocol.TaskStatus;
import dev.agentcraft.client.ui.Guard;
import dev.agentcraft.client.world.StationInteractions;
import dev.agentcraft.client.world.StationRenderer;
import dev.agentcraft.client.ui.Tr;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelRenderEvents;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.blockentity.BlockEntityRenderers;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import org.joml.Quaternionf;
import org.joml.Vector3f;
import org.jspecify.annotations.Nullable;

/**
 * Task Wall: a live kanban of {@code Foreman.state().tasks()} on every connected task_board panel
 * ({@link TaskBoardRenderer}); right-click a card to open its {@link TaskScreen} (retry, prioritize,
 * reassign, cancel). The screen is shootable as {@code dev.screen {open:"task"}}.
 *
 * <p>Dev: {@code dev.taskwall} lists the laid-out boards and cards; {@code {open: taskId}} opens a
 * task's screen; {@code {press: buttonId}} presses a button in the open task screen (prev next
 * retry prioritize reassign cancel to:&lt;agent&gt;); {@code {aim: taskId}} returns the world point
 * of that card's centre (on {@code board} "x y z" if given) and an eye position in front of it (point {@code dev.camera} there, then
 * {@code dev.key {mapping:"key.use"}} clicks it through the real crosshair path).
 */
public final class TaskWallFeature {
	/** Bumps on snapshots and task changes: boards re-plan their layout. */
	private static long taskSeq;
	/** Bumps on agent changes the cards show (names, live state dots): boards refresh card contents. */
	private static long agentSeq;
	private static final Map<BlockPos, TaskBoard> BOARDS = new HashMap<>();
	private static @Nullable String selected;
	private static String startHint = "";
	private static long startHintAt;

	private TaskWallFeature() {
	}

	public static void init() {
		BlockEntityRenderers.register(ModBlockEntities.TASK_BOARD, ctx -> new TaskBoardRenderer());
		Foreman.addListener(new ForemanListener() {
			@Override
			public void onSnapshot(ForemanState st) {
				taskSeq++;
			}

			@Override
			public void onTask(@Nullable Task previous, Task task) {
				taskSeq++;
			}

			@Override
			public void onAgent(@Nullable Agent previous, Agent agent) {
				// names and live state dots on the cards
				if (previous == null || previous.state() != agent.state() || previous.isActive() != agent.isActive() || !previous.name().equals(agent.name())
					|| !java.util.Objects.equals(previous.taskId(), agent.taskId())) {
					agentSeq++;
				}
			}
		});
		ClientTickEvents.END_CLIENT_TICK.register(mc -> Guard.run("taskwall.sweep", () -> {
			if (mc.level == null || (mc.level.getGameTime() % 200) != 0) {
				return;
			}
			long now = System.nanoTime();
			Iterator<TaskBoard> it = BOARDS.values().iterator();
			while (it.hasNext()) {
				if (now - it.next().lastUsedNanos > 30_000_000_000L) {
					it.remove();
				}
			}
		}));
		// the brass card outline replaces vanilla's black block box while a card is under the crosshair
		LevelRenderEvents.BEFORE_BLOCK_OUTLINE.register((ctx, outline) -> Guard.call("taskwall.outline", () -> !cardUnderCrosshair(outline.pos()), true));
		StationInteractions.onUse(ModBlocks.TASK_BOARD, (player, pos, state, be) -> {
			Minecraft mc = Minecraft.getInstance();
			HitResult hr = mc.hitResult;
			Vec3 hit = hr instanceof BlockHitResult bh && hr.getType() == HitResult.Type.BLOCK ? bh.getLocation() : Vec3.atCenterOf(pos);
			String id = taskAt(pos, state, hit);
			if (id != null) {
				mc.gui.setScreen(new TaskScreen(id));
			}
		});
		DevBridge.registerScreen("task", mc -> new TaskScreen(defaultTask()));
		DevBridge.register("dev.taskwall", 10_000, "{open?: taskId, press?: button, aim?: taskId, board?: \"x y z\" origin, lightFloor?: 0-15, ppb?: 0-256, relayout?} "
				+ "-> task wall boards/cards; opens/presses/aims; lightFloor/ppb override the light floor / density (0 = auto); relayout re-plans",
			(req, mc) -> {
				Fields f = Fields.of(req);
				String open = f.optStr("open", null);
				String press = f.optStr("press", null);
				String aim = f.optStr("aim", null);
				String onBoard = f.optStr("board", null);
				int floor = f.optInt("lightFloor", -1, -1, 15);
				int ppb = f.optInt("ppb", -1, -1, 256);
				boolean relayout = f.optBool("relayout", false);
				return DevBridge.onClient(mc, () -> {
					JsonObject o = new JsonObject();
					if (floor >= 0) {
						TaskBoardRenderer.lightFloor = floor;
					}
					o.addProperty("lightFloor", TaskBoardRenderer.lightFloor);
					if (ppb >= 0) {
						TaskBoard.densityOverride = ppb;
					}
					if (relayout) {
						taskSeq++;
					}
					if (open != null) {
						ForemanState s = Foreman.state();
						if (s == null || s.task(open) == null) {
							throw new DevBridge.DevException(Tr.t("no task ") + open);
						}
						selected = open;
						mc.gui.setScreen(new TaskScreen(open));
					}
					if (press != null) {
						if (!(mc.gui.screen() instanceof TaskScreen ts)) {
							throw new DevBridge.DevException("no task screen is open");
						}
						ts.press(press);
						o.addProperty("task", ts.taskId());
					}
					if (aim != null) {
						o.add("aim", aimJson(mc, aim, onBoard));
					}
					o.add("boards", boardsJson());
					return o;
				});
			});
	}

	static long taskSeq() {
		return taskSeq;
	}

	static long agentSeq() {
		return agentSeq;
	}

	/**
	 * The console's key as bound in Controls, for the empty board's "Press [key] and type a goal"
	 * (the console feature registers the mapping; the SPEC default is the backtick); "" when the
	 * mapping exists but is unbound. Refreshed every second.
	 */
	static String startKey() {
		long now = System.nanoTime();
		if (startHintAt == 0 || now - startHintAt > 1_000_000_000L) {
			startHintAt = now;
			String key = "`";
			for (KeyMapping km : Minecraft.getInstance().options.keyMappings) {
				String n = km.getName().toLowerCase(java.util.Locale.ROOT);
				if (n.contains("agentcraft") && n.contains("console")) {
					key = km.isUnbound() ? "" : km.getTranslatedKeyMessage().getString();
					break;
				}
			}
			startHint = key;
		}
		return startHint;
	}

	/** True when the crosshair is on a card of the task board at {@code pos} (no screen open). */
	private static boolean cardUnderCrosshair(BlockPos pos) {
		Minecraft mc = Minecraft.getInstance();
		if (mc.level == null || mc.gui.screen() != null || !(mc.hitResult instanceof BlockHitResult bh) || bh.getType() != HitResult.Type.BLOCK
			|| !bh.getBlockPos().equals(pos)) {
			return false;
		}
		BlockState st = mc.level.getBlockState(pos);
		if (!st.is(ModBlocks.TASK_BOARD)) {
			return false;
		}
		BlockPos origin = PanelBlock.origin(mc.level, pos, st);
		TaskBoard b = BOARDS.get(origin);
		if (b == null || b.ppb == 0) {
			return false;
		}
		float[] p = toBoard(origin, st.getValue(PanelBlock.FACING), b.panelH, b.ppb, bh.getLocation());
		return b.cardAt(p[0], p[1]) != null;
	}

	static TaskBoard board(BlockPos origin) {
		return BOARDS.computeIfAbsent(origin.immutable(), TaskBoard::new);
	}

	/** The task the 'task' screen opens with: the last one opened, else the first doing (or blocked) one, else the first. */
	static String defaultTask() {
		ForemanState s = Foreman.state();
		if (s == null) {
			return selected == null ? "t1" : selected;
		}
		if (selected != null && s.task(selected) != null) {
			return selected;
		}
		List<Task> order = TaskScreen.wallOrder();
		for (Task t : order) {
			if (t.status() == TaskStatus.DOING) {
				return t.id();
			}
		}
		return order.isEmpty() ? "t1" : order.get(0).id();
	}

	// ------------------------------------------------------------------ face <-> world mapping

	/** Board pixel of a world point on the panel whose origin (bottom-left block) is {@code origin}. */
	static float[] toBoard(BlockPos origin, Direction facing, int panelH, int ppb, Vec3 world) {
		Vector3f l = new Vector3f((float) (world.x - origin.getX() - 0.5), (float) (world.y - origin.getY()), (float) (world.z - origin.getZ() - 0.5));
		new Quaternionf().rotationY((float) Math.toRadians(StationRenderer.modelRotation(facing))).transform(l);
		float lx = l.x + 0.5f;
		float ly = l.y;
		return new float[] {(1 - lx) * ppb, (panelH - ly) * ppb};
	}

	/** World point of board pixel (px, py) on the linen plane. */
	static Vec3 toWorld(BlockPos origin, Direction facing, int panelH, int ppb, float px, float py) {
		Vector3f l = new Vector3f(1 - px / ppb - 0.5f, panelH - py / ppb, TaskBoardRenderer.LINEN_DEPTH - 0.5f);
		new Quaternionf().rotationY((float) Math.toRadians(-StationRenderer.modelRotation(facing))).transform(l);
		return new Vec3(origin.getX() + 0.5 + l.x, origin.getY() + l.y, origin.getZ() + 0.5 + l.z);
	}

	/** Task id of the card under a world hit point on a task board block (null = none). */
	static @Nullable String taskAt(BlockPos pos, BlockState state, Vec3 hit) {
		Minecraft mc = Minecraft.getInstance();
		if (mc.level == null || !(state.getBlock() instanceof PanelBlock)) {
			return null;
		}
		BlockPos origin = PanelBlock.origin(mc.level, pos, state);
		TaskBoard b = BOARDS.get(origin);
		if (b == null || b.ppb == 0) {
			return null;
		}
		Direction facing = state.getValue(PanelBlock.FACING);
		float[] p = toBoard(origin, facing, b.panelH, b.ppb, hit);
		TaskBoard.Card c = b.cardAt(p[0], p[1]);
		if (c != null) {
			return c.id;
		}
		TaskBoard.Column col = b.columnAt(p[0]);
		if (col != null && col.chip != null && p[1] >= col.chipY - 2 && p[1] <= col.chipY + TaskBoard.CHIP_H + 2 && !col.hidden.isEmpty()) {
			return col.hidden.get(0);
		}
		return null;
	}

	private static JsonObject aimJson(Minecraft mc, String taskId, @Nullable String onBoard) {
		for (TaskBoard b : BOARDS.values()) {
			if (onBoard != null && !onBoard.equals(b.origin.getX() + " " + b.origin.getY() + " " + b.origin.getZ())) {
				continue;
			}
			TaskBoard.Card c = b.cards.get(taskId);
			if (c == null || mc.level == null) {
				continue;
			}
			BlockState st = mc.level.getBlockState(b.origin);
			if (!(st.getBlock() instanceof PanelBlock)) {
				continue;
			}
			Direction facing = st.getValue(PanelBlock.FACING);
			Vec3 w = toWorld(b.origin, facing, b.panelH, b.ppb, c.x + c.w / 2f, c.y + c.h / 2f);
			Vec3 eye = w.add(facing.getStepX() * 2.5, 0.0, facing.getStepZ() * 2.5);
			float[] back = toBoard(b.origin, facing, b.panelH, b.ppb, w);
			JsonObject o = new JsonObject();
			o.add("point", vec(w));
			o.add("eye", vec(eye));
			o.addProperty("visible", c.visible);
			o.addProperty("roundTripPx", Math.hypot(back[0] - (c.x + c.w / 2f), back[1] - (c.y + c.h / 2f)));
			return o;
		}
		throw new DevBridge.DevException("no card " + taskId + " on any laid-out board");
	}

	private static JsonObject vec(Vec3 v) {
		JsonObject o = new JsonObject();
		o.addProperty("x", v.x);
		o.addProperty("y", v.y);
		o.addProperty("z", v.z);
		return o;
	}

	private static JsonArray boardsJson() {
		JsonArray arr = new JsonArray();
		for (TaskBoard b : BOARDS.values()) {
			JsonObject j = new JsonObject();
			j.addProperty("origin", b.origin.getX() + " " + b.origin.getY() + " " + b.origin.getZ());
			j.addProperty("size", b.panelW + "x" + b.panelH);
			j.addProperty("ppb", b.ppb);
			j.addProperty("listMode", b.listMode);
			j.addProperty("layoutUs", b.layoutNanos / 1000);
			j.addProperty("ageMs", (System.nanoTime() - b.lastUsedNanos) / 1_000_000L);
			JsonObject cols = new JsonObject();
			for (TaskBoard.Column c : b.columns) {
				JsonObject cj = new JsonObject();
				cj.addProperty("count", c.count);
				cj.addProperty("blocked", c.blocked);
				cj.addProperty("x", Math.round(c.x * 10) / 10.0);
				cj.addProperty("width", Math.round(c.w * 10) / 10.0);
				cj.addProperty("perRow", c.perRow);
				JsonArray hidden = new JsonArray();
				c.hidden.forEach(hidden::add);
				cj.add("hidden", hidden);
				cols.add(c.col.name().toLowerCase(java.util.Locale.ROOT), cj);
			}
			j.add("columns", cols);
			JsonArray cards = new JsonArray();
			for (TaskBoard.Card c : b.cards.values()) {
				JsonObject cj = new JsonObject();
				cj.addProperty("id", c.id);
				cj.addProperty("col", c.col.name().toLowerCase(java.util.Locale.ROOT));
				cj.addProperty("status", c.task.status().wire());
				cj.addProperty("x", Math.round(c.x * 10) / 10.0);
				cj.addProperty("y", Math.round(c.y * 10) / 10.0);
				cj.addProperty("w", Math.round(c.tw * 10) / 10.0);
				cj.addProperty("h", Math.round(c.th * 10) / 10.0);
				cj.addProperty("size", c.size.name().toLowerCase(java.util.Locale.ROOT));
				cj.addProperty("visible", c.visible);
				cj.addProperty("moving", c.flying);
				cj.addProperty("glowing", c.arrivedAt != 0);
				cj.addProperty("dot", c.cur == null || c.cur.dot == null ? "" : c.cur.dot);
				JsonArray lines = new JsonArray();
				if (c.cur != null) {
					for (net.minecraft.util.FormattedCharSequence l : c.cur.lines) {
						StringBuilder sb = new StringBuilder();
						l.accept((i, style, cp) -> {
							sb.appendCodePoint(cp);
							return true;
						});
						lines.add(sb.toString());
					}
				}
				cj.add("lines", lines);
				cards.add(cj);
			}
			j.add("cards", cards);
			arr.add(j);
		}
		return arr;
	}
}

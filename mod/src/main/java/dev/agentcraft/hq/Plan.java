package dev.agentcraft.hq;

import dev.agentcraft.block.DecisionPodiumBlock;
import dev.agentcraft.block.MergeStationBlock;
import dev.agentcraft.block.MonitorBlock;
import dev.agentcraft.block.PanelBlock;
import dev.agentcraft.block.StatusLampBlock;
import dev.agentcraft.block.entity.StationBlockEntity;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.IntFunction;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.ExperienceOrb;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CopperBulbBlock;
import net.minecraft.world.level.block.CrossCollisionBlock;
import net.minecraft.world.level.block.FenceGateBlock;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.WallBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.lighting.LightEngine;
import net.minecraft.world.phys.AABB;
import org.jspecify.annotations.Nullable;

/**
 * The complete desired contents of an HQ site box, built in memory and then applied to the world as
 * a diff. That is what makes an HQ builder deterministic and idempotent:
 * <ul>
 *   <li>every cell of the box has a desired state (unset cells are the meadow: air above the
 *       ground, grass/dirt below), so a second build changes nothing; nothing outside the box is
 *       ever touched;</li>
 *   <li>only cells that differ are written, with no neighbour or shape updates (fast: no physics, no
 *       drops, no fluid flow);</li>
 *   <li>connecting blocks (stairs, panes, fences, walls, AgentCraft panels) are written in a second
 *       pass with their connections computed from the finished neighbours, and compared without
 *       those connection properties in the first pass, so they never flicker on a rebuild;</li>
 *   <li>state driven live by the Foreman (lamp status, podium open, merge station active, monitor
 *       lit, signal bulbs lit) is kept from the world when the block itself is unchanged;</li>
 *   <li>with the previous build's plan at hand ({@link PlanStore}), a cell the player changed since
 *       that build (it matches neither the old plan nor the new one) is <b>kept</b>, unless the
 *       build is forced: rebuilding never wipes the player's own additions.</li>
 * </ul>
 * The ground is a heightmap ({@link #top}): {@code HqLandscape} shapes it before anything is built.
 */
final class Plan {
	/** Write without neighbour updates, shape updates, drops, block-entity side effects or onPlace. */
	static final int FLAGS = Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE | Block.UPDATE_SUPPRESS_DROPS
		| Block.UPDATE_SKIP_BLOCK_ENTITY_SIDEEFFECTS | Block.UPDATE_SKIP_ON_PLACE;
	private static final Set<String> CONNECTION_PROPS = Set.of("shape", "north", "east", "south", "west", "up", "down", "left", "right",
		"in_wall");

	final int localMinX, localMaxX, localMinZ, localMaxZ;
	final int minX;
	final int minY;
	final int minZ;
	final int maxX;
	final int maxY;
	final int maxZ;
	private final int sx;
	private final int sy;
	private final int sz;
	private final int offsetX;
	private final int offsetY;
	private final int offsetZ;
	private final BlockState[] cells;
	private final int[] top;
	private final Map<BlockPos, String> bindings = new LinkedHashMap<>();

	/**
	 * @param changed cells written in the first pass; {@code connected}: cells whose connections
	 *     changed in the second pass; {@code kept}: cells the player changed since the last build that
	 *     were left alone; {@code foreign}: changed cells that held something neither the old nor the
	 *     new plan has (a forced build, or no record of the previous build); {@code items}: dropped
	 *     items / orbs removed from the box.
	 */
	record Stats(int cells, int changed, int connected, int bound, int kept, int foreign, int items, long micros, List<String> sample,
		List<String> keptSample) {
	}

	/** @param ground desired state of an unset cell by y (the meadow profile); the ground top is {@code groundTop}. */
	Plan(int minX, int minY, int minZ, int maxX, int maxY, int maxZ, int groundTop, IntFunction<BlockState> ground) {
		this(minX, minY, minZ, maxX, maxY, maxZ, groundTop, ground, 0, 0, 0);
	}

	/** Local builder coordinates are translated into a protected world-space site box. */
	Plan(int minX, int minY, int minZ, int maxX, int maxY, int maxZ, int groundTop, IntFunction<BlockState> ground,
		int offsetX, int offsetY, int offsetZ) {
		this.localMinX = minX;
		this.localMaxX = maxX;
		this.localMinZ = minZ;
		this.localMaxZ = maxZ;
		this.offsetX = offsetX;
		this.offsetY = offsetY;
		this.offsetZ = offsetZ;
		this.minX = minX + offsetX;
		this.minY = minY + offsetY;
		this.minZ = minZ + offsetZ;
		this.maxX = maxX + offsetX;
		this.maxY = maxY + offsetY;
		this.maxZ = maxZ + offsetZ;
		this.sx = this.maxX - this.minX + 1;
		this.sy = this.maxY - this.minY + 1;
		this.sz = this.maxZ - this.minZ + 1;
		this.cells = new BlockState[sx * sy * sz];
		this.top = new int[sx * sz];
		java.util.Arrays.fill(top, groundTop);
		for (int y = this.minY; y <= this.maxY; y++) {
			BlockState g = ground.apply(y - offsetY);
			for (int x = this.minX; x <= this.maxX; x++) {
				for (int z = this.minZ; z <= this.maxZ; z++) {
					cells[index(x, y, z)] = g;
				}
			}
		}
	}

	int size() {
		return cells.length;
	}

	BlockState[] cells() {
		return cells;
	}

	boolean in(int x, int y, int z) {
		return x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ;
	}

	boolean inXZ(int x, int z) {
		return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
	}

	private int index(int x, int y, int z) {
		return ((y - minY) * sz + (z - minZ)) * sx + (x - minX);
	}

	BlockState get(int x, int y, int z) {
		int wx = x + offsetX;
		int wy = y + offsetY;
		int wz = z + offsetZ;
		return wx >= minX && wx <= maxX && wy >= minY && wy <= maxY && wz >= minZ && wz <= maxZ
			? cells[index(wx, wy, wz)] : Blocks.AIR.defaultBlockState();
	}

	boolean isAir(int x, int y, int z) {
		return get(x, y, z).isAir();
	}

	void set(int x, int y, int z, BlockState state) {
		int wx = x + offsetX;
		int wy = y + offsetY;
		int wz = z + offsetZ;
		if (wx >= minX && wx <= maxX && wy >= minY && wy <= maxY && wz >= minZ && wz <= maxZ) {
			cells[index(wx, wy, wz)] = state;
		}
	}

	void set(int x, int y, int z, Block block) {
		set(x, y, z, block.defaultBlockState());
	}

	/** Only where the plan currently has air. */
	void setIfAir(int x, int y, int z, BlockState state) {
		if (isAir(x, y, z)) {
			set(x, y, z, state);
		}
	}

	void fill(int x0, int y0, int z0, int x1, int y1, int z1, BlockState state) {
		for (int x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
			for (int y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
				for (int z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
					set(x, y, z, state);
				}
			}
		}
	}

	void fill(int x0, int y0, int z0, int x1, int y1, int z1, Block block) {
		fill(x0, y0, z0, x1, y1, z1, block.defaultBlockState());
	}

	/** Ground top (the grass block's y) of column (x, z); outside the box: the meadow default. */
	int top(int x, int z) {
		int wx = x + offsetX;
		int wz = z + offsetZ;
		return wx >= minX && wx <= maxX && wz >= minZ && wz <= maxZ ? top[(wz - minZ) * sx + (wx - minX)] : StudioHqBuilder.GROUND;
	}

	void setTop(int x, int z, int y) {
		int wx = x + offsetX;
		int wz = z + offsetZ;
		if (wx >= minX && wx <= maxX && wz >= minZ && wz <= maxZ) {
			top[(wz - minZ) * sx + (wx - minX)] = y;
		}
	}

	/** Binding for the station block entity at (x, y, z), applied after the blocks. */
	void bind(int x, int y, int z, String binding) {
		bindings.put(new BlockPos(x + offsetX, y + offsetY, z + offsetZ), binding);
	}

	/**
	 * Vanilla's grass rule applied to the plan (SpreadingSnowyBlock): grass under a full fluid or a
	 * block that stops light from its top face becomes dirt, so the world never "decays" between two
	 * builds (which would make a rebuild change cells).
	 */
	void settleGrass() {
		BlockState grass = Blocks.GRASS_BLOCK.defaultBlockState();
		for (int y = minY; y < maxY; y++) {
			for (int z = minZ; z <= maxZ; z++) {
				for (int x = minX; x <= maxX; x++) {
					BlockState s = cells[index(x, y, z)];
					boolean isGrass = s.is(Blocks.GRASS_BLOCK);
					if (!isGrass && !s.is(Blocks.DIRT)) {
						continue;
					}
					BlockState above = cells[index(x, y + 1, z)];
					boolean lives = !above.getFluidState().isFull()
						&& LightEngine.getLightDampeningInto(grass, above, Direction.UP, above.getLightDampening()) < 15;
					// grass that cannot live decays to dirt; dirt that grass could live on is eventually
					// grown over by a neighbour: both are settled here, so a rebuild never finds them changed
					if (isGrass && !lives) {
						cells[index(x, y, z)] = Blocks.DIRT.defaultBlockState();
					} else if (!isGrass && lives) {
						cells[index(x, y, z)] = grass;
					}
				}
			}
		}
	}

	// ------------------------------------------------------------------ apply

	private static boolean connecting(BlockState s) {
		Block b = s.getBlock();
		return b instanceof StairBlock || b instanceof CrossCollisionBlock || b instanceof WallBlock || b instanceof FenceGateBlock
			|| b instanceof PanelBlock;
	}

	/** Properties the Foreman drives (or that a redstone-less bulb toggles): never part of the design. */
	private static boolean drivenProp(Block b, Property<?> p) {
		return b instanceof StatusLampBlock && p == StatusLampBlock.STATUS || b instanceof DecisionPodiumBlock && p == DecisionPodiumBlock.OPEN
			|| b instanceof MergeStationBlock && p == MergeStationBlock.ACTIVE || b instanceof MonitorBlock && p == MonitorBlock.LIT
			|| b instanceof CopperBulbBlock && (p == CopperBulbBlock.LIT || p == CopperBulbBlock.POWERED);
	}

	/** Same block and same design: ignores connection properties and Foreman-driven properties. */
	static boolean sameDesign(BlockState a, BlockState b) {
		if (a == b) {
			return true;
		}
		if (a.getBlock() != b.getBlock()) {
			return false;
		}
		Block blk = b.getBlock();
		for (Property<?> p : b.getProperties()) {
			if (CONNECTION_PROPS.contains(p.getName()) || drivenProp(blk, p)) {
				continue;
			}
			if (!a.getValue(p).equals(b.getValue(p))) {
				return false;
			}
		}
		return true;
	}

	/** Same block and same properties, ignoring connection properties. */
	private static boolean sameIgnoringConnections(BlockState a, BlockState b) {
		if (a.getBlock() != b.getBlock()) {
			return false;
		}
		for (Property<?> p : b.getProperties()) {
			if (!CONNECTION_PROPS.contains(p.getName()) && !a.getValue(p).equals(b.getValue(p))) {
				return false;
			}
		}
		return true;
	}

	/** Keep the live, Foreman-driven property values of an unchanged station block. */
	private static BlockState keepDriven(BlockState current, BlockState desired) {
		if (current.getBlock() != desired.getBlock()) {
			return desired;
		}
		Block b = desired.getBlock();
		if (b instanceof StatusLampBlock) {
			return desired.setValue(StatusLampBlock.STATUS, current.getValue(StatusLampBlock.STATUS));
		}
		if (b instanceof DecisionPodiumBlock) {
			return desired.setValue(DecisionPodiumBlock.OPEN, current.getValue(DecisionPodiumBlock.OPEN));
		}
		if (b instanceof MergeStationBlock) {
			return desired.setValue(MergeStationBlock.ACTIVE, current.getValue(MergeStationBlock.ACTIVE));
		}
		if (b instanceof MonitorBlock) {
			return desired.setValue(MonitorBlock.LIT, current.getValue(MonitorBlock.LIT));
		}
		if (b instanceof CopperBulbBlock) {
			return desired.setValue(CopperBulbBlock.LIT, current.getValue(CopperBulbBlock.LIT));
		}
		return desired;
	}

	/**
	 * Applies the plan to the world (server thread).
	 *
	 * @param previous the plan applied by the last build of this builder (same box), or null when
	 *     there is no record of it: then every cell is set to the plan.
	 * @param force set every cell to the plan even where the player changed it.
	 */
	Stats apply(ServerLevel level, BlockState @Nullable [] previous, boolean force) {
		long t0 = System.nanoTime();
		int changed = 0;
		int kept = 0;
		int foreign = 0;
		List<String> sample = new ArrayList<>();
		List<String> keptSample = new ArrayList<>();
		BitSet keptCells = new BitSet();
		List<BlockPos> deferred = new ArrayList<>();
		boolean guard = previous != null && previous.length == cells.length && !force;
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (int cx = minX >> 4; cx <= maxX >> 4; cx++) {
			for (int cz = minZ >> 4; cz <= maxZ >> 4; cz++) {
				LevelChunk chunk = level.getChunk(cx, cz);
				int x0 = Math.max(minX, cx << 4);
				int x1 = Math.min(maxX, (cx << 4) + 15);
				int z0 = Math.max(minZ, cz << 4);
				int z1 = Math.min(maxZ, (cz << 4) + 15);
				for (int y = minY; y <= maxY; y++) {
					for (int z = z0; z <= z1; z++) {
						for (int x = x0; x <= x1; x++) {
							int i = index(x, y, z);
							BlockState want = cells[i];
							m.set(x, y, z);
							BlockState cur = chunk.getBlockState(m);
							if (cur != want && !sameDesign(cur, want)) {
								if (guard && !sameDesign(cur, previous[i])) {
									// the player changed this cell after the last build: leave it (terrain that only
									// reacted to a player's block, e.g. grass turned to dirt under it, is kept silently)
									if (!(natural(cur) && natural(previous[i]))) {
										kept++;
									}
									keptCells.set(i);
									if (keptSample.size() < 8) {
										keptSample.add(m.toShortString() + " " + cur.getBlock().getDescriptionId().replace("block.minecraft.", ""));
									}
									continue;
								}
								if (!cur.isAir() && (previous == null || !sameDesign(cur, previous[i])) && !natural(cur)) {
									foreign++;
								}
							}
							if (connecting(want)) {
								deferred.add(m.immutable());
								want = keepDriven(cur, want);
								if (!sameIgnoringConnections(cur, want)) {
									note(sample, m, cur, want);
									level.setBlock(m, want, FLAGS);
									changed++;
								}
								continue;
							}
							want = keepDriven(cur, want);
							if (cur != want) {
								note(sample, m, cur, want);
								level.setBlock(m, want, FLAGS);
								changed++;
							}
						}
					}
				}
			}
		}
		// connections from the finished neighbours
		int connected = 0;
		for (BlockPos p : deferred) {
			BlockState cur = level.getBlockState(p);
			BlockState want = Block.updateFromNeighbourShapes(keepDriven(cur, cells[index(p.getX(), p.getY(), p.getZ())]), level, p);
			if (cur != want) {
				note(sample, p, cur, want);
				level.setBlock(p, want, FLAGS);
				connected++;
			}
		}
		int bound = 0;
		for (var e : bindings.entrySet()) {
			BlockPos p = e.getKey();
			if (in(p.getX(), p.getY(), p.getZ()) && keptCells.get(index(p.getX(), p.getY(), p.getZ()))) {
				continue;
			}
			if (level.getBlockEntity(p) instanceof StationBlockEntity be) {
				if (!be.binding().equals(e.getValue())) {
					bound++;
				}
				be.setBinding(e.getValue());
			}
		}
		int items = clearDrops(level);
		return new Stats(cells.length, changed, connected, bound, kept, foreign, items, (System.nanoTime() - t0) / 1000, sample, keptSample);
	}

	/** Terrain, plants and fluids: replacing them is not "replacing something the player built". */
	/** Leaves may belong to a planted tree or extend into the site from outside it. */
	static boolean protectedOnFirstBuild(BlockState state) {
		return !state.isAir() && (!Plan.natural(state)
			|| state.getBlock() instanceof net.minecraft.world.level.block.LeavesBlock);
	}

	static boolean natural(BlockState s) {
		return s.is(Blocks.GRASS_BLOCK) || s.is(Blocks.DIRT) || s.is(Blocks.STONE) || s.is(Blocks.SHORT_GRASS) || s.is(Blocks.TALL_GRASS)
			|| s.is(Blocks.WATER) || s.is(Blocks.DIRT_PATH) || s.getBlock() instanceof net.minecraft.world.level.block.VegetationBlock
			|| (s.getBlock() instanceof net.minecraft.world.level.block.LeavesBlock
				&& !s.getValue(net.minecraft.world.level.block.LeavesBlock.PERSISTENT));
	}

	/**
	 * Removes dropped items and experience orbs inside the box (a switch from another builder can
	 * leave items behind, e.g. carpets that lost their floor). Players, agents and other mobs stay.
	 */
	private int clearDrops(ServerLevel level) {
		AABB box = new AABB(minX, minY, minZ, maxX + 1, maxY + 1, maxZ + 1);
		int n = 0;
		for (ItemEntity e : level.getEntitiesOfClass(ItemEntity.class, box)) {
			e.discard();
			n++;
		}
		for (ExperienceOrb e : level.getEntitiesOfClass(ExperienceOrb.class, box)) {
			e.discard();
			n++;
		}
		return n;
	}

	private static void note(List<String> sample, BlockPos p, BlockState from, BlockState to) {
		if (sample.size() < 6) {
			sample.add(p.toShortString() + " " + from + " -> " + to);
		}
	}
}

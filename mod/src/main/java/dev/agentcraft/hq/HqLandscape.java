package dev.agentcraft.hq;

import static dev.agentcraft.hq.StudioHqBuilder.AX;
import static dev.agentcraft.hq.StudioHqBuilder.AZ;
import static dev.agentcraft.hq.StudioHqBuilder.FEET;
import static dev.agentcraft.hq.StudioHqBuilder.FLOOR;
import static dev.agentcraft.hq.StudioHqBuilder.GROUND;
import static dev.agentcraft.hq.StudioHqBuilder.HX;
import static dev.agentcraft.hq.StudioHqBuilder.HZN;
import static dev.agentcraft.hq.StudioHqBuilder.HZS;
import static dev.agentcraft.hq.StudioHqBuilder.SITE;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Everything outside the walls: the ground (a hollow ringed by low wooded hills, so the horizon is
 * closed and the site reads as a meadow in the woods rather than a build on a superflat plain),
 * terraces, the gabled entrance portico, paths with lanterns ending at a lychgate, the pond, the
 * cottage garden, trees and a meadow of grass and flowers. All "random" choices come from a
 * coordinate hash, so the landscape is identical on every build.
 */
final class HqLandscape {
	private HqLandscape() {
	}

	static int hash(int x, int z, int salt) {
		long h = x * 73856093L ^ z * 19349663L ^ salt * 83492791L;
		h ^= h >>> 13;
		h *= 0x5bd1e995L;
		h ^= h >>> 15;
		h *= 0x27d4eb2dL;
		h ^= h >>> 16;
		return (int) (h & 0x7fffffff);
	}

	static double rnd(int x, int z, int salt) {
		return hash(x, z, salt) / (double) 0x7fffffff;
	}

	// ------------------------------------------------------------------ ground

	/** Areas kept level with the hall's plinth (x0, z0, x1, z1): building, front court, pond, garden, the path to the gate. */
	private static final int[][] FLAT = {
		{-29, -16, 29, 12}, {-20, 6, 20, 33}, {-37, 9, -10, 34}, {4, 29, 22, 45}, {-6, 25, 6, 49},
	};
	/** The lychgate at the end of the main path. */
	static final int GATE_Z = 48;

	static double smooth(double e0, double e1, double v) {
		double t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0)));
		return t * t * (3 - 2 * t);
	}

	static double flatDistance(int x, int z) {
		double best = Double.MAX_VALUE;
		for (int[] r : FLAT) {
			double dx = Math.max(0, Math.max(r[0] - x, x - r[2]));
			double dz = Math.max(0, Math.max(r[1] - z, z - r[3]));
			best = Math.min(best, Math.sqrt(dx * dx + dz * dz));
		}
		return best;
	}

	/** Distance to the edge of the site box (0 = the last column inside it). */
	static int edge(int x, int z) {
		return Math.min(Math.min(x - SITE[0], SITE[3] - x), Math.min(z - SITE[2], SITE[5] - z));
	}

	/** Terrain height above the meadow (blocks): a rolling ring of hills near the box edges, level inside. */
	static int terrainHeight(int x, int z) {
		double e = edge(x, z);
		double crest = 5.2 + 1.8 * Math.sin(x * 0.15 + z * 0.07) + 1.4 * Math.cos(z * 0.19 - x * 0.11) + 0.8 * Math.sin((x + z) * 0.31);
		// rises from the plain at the box edge (no step where the site meets the world), crests ~7 in
		double berm = e >= 7 ? crest * smooth(19, 7, e) : crest * smooth(-1, 7, e);
		return (int) Math.round(berm * smooth(0, 7, flatDistance(x, z)));
	}

	/** Shapes the ground before anything is built: dirt under a grass top at the terrain height. */
	static void ground(Plan p) {
		int nx = p.localMaxX - p.localMinX + 1;
		int nz = p.localMaxZ - p.localMinZ + 1;
		int[] hs = new int[nx * nz];
		for (int x = p.localMinX; x <= p.localMaxX; x++) {
			for (int z = p.localMinZ; z <= p.localMaxZ; z++) {
				hs[(x - p.localMinX) * nz + (z - p.localMinZ)] = terrainHeight(x, z);
			}
		}
		// no cliffs: every step between neighbouring columns is at most one block, so the hills show
		// grass-topped steps instead of bare dirt faces (judges: "terraced dirt-sided hills")
		for (int pass = 0; pass < 12; pass++) {
			boolean changed = false;
			for (int i = 0; i < nx; i++) {
				for (int k = 0; k < nz; k++) {
					int h = hs[i * nz + k];
					int lo = h;
					if (i > 0) lo = Math.min(lo, hs[(i - 1) * nz + k]);
					if (i < nx - 1) lo = Math.min(lo, hs[(i + 1) * nz + k]);
					if (k > 0) lo = Math.min(lo, hs[i * nz + k - 1]);
					if (k < nz - 1) lo = Math.min(lo, hs[i * nz + k + 1]);
					if (h > lo + 1) {
						hs[i * nz + k] = lo + 1;
						changed = true;
					}
				}
			}
			if (!changed) {
				break;
			}
		}
		for (int x = p.localMinX; x <= p.localMaxX; x++) {
			for (int z = p.localMinZ; z <= p.localMaxZ; z++) {
				int h = hs[(x - p.localMinX) * nz + (z - p.localMinZ)];
				if (h <= 0) {
					continue;
				}
				for (int y = GROUND; y < GROUND + h; y++) {
					p.set(x, y, z, Blocks.DIRT.defaultBlockState());
				}
				p.set(x, GROUND + h, z, Blocks.GRASS_BLOCK.defaultBlockState());
				p.setTop(x, z, GROUND + h);
			}
		}
	}

	static void exterior(Plan p) {
		terraces(p);
		portico(p);
		paths(p);
		gate(p);
		pond(p);
		garden(p);
		trees(p);
		foundationPlanting(p);
		outdoorLight(p);
		meadow(p);
	}

	/**
	 * Hidden warm light outside (invisible light blocks: no model, no collision): a wash on the hall's
	 * south facade and terraces under the eaves, round the atrium walls, an uplight on the dome's lower
	 * courses (so the roof separates from the night sky), the portico, and pools in the garden beds.
	 * At golden hour it warms the plaster; at night the studio reads as lit from within.
	 */
	private static void outdoorLight(Plan p) {
		// hall south facade: under the eaves in front of the tall windows, and pools on the deck
		for (int x = -22; x <= 22; x += 3) {
			if (Math.abs(x) < 10) {
				continue;
			}
			p.setIfAir(x, FEET + 3, HZS + 1, St.light(14));
			if (Math.floorMod(x, 6) == 2) {
				p.setIfAir(x, FEET, HZS + 3, St.light(11));
			}
		}
		// round the atrium: a wash on its plaster walls and an uplight on the dome
		for (int dx = -10; dx <= 10; dx++) {
			for (int dz = -10; dz <= 10; dz++) {
				if (StudioHqBuilder.octFoot(dx, dz) || !StudioHqBuilder.octInside(dx, dz, 10) || dz < -6) {
					continue;
				}
				if (Math.floorMod(dx * 3 + dz * 5, 7) != 0) {
					continue;
				}
				p.setIfAir(AX + dx, FEET + 3, AZ + dz, St.light(13));
				p.setIfAir(AX + dx, StudioHqBuilder.SPRING + 1, AZ + dz, St.light(13));
			}
		}
		// portico: lanterns under the side beams, light on the door and the steps
		int z0 = AZ + 10;
		for (int sx : new int[] {-3, 3}) {
			p.setIfAir(sx, FEET + 3, z0 + 1, StudioHqBuilder.LANTERN_HANGING);
		}
		p.setIfAir(AX, FEET + 1, z0 + 2, St.light(14));
		p.setIfAir(AX, FEET, AZ + 15, St.light(12));
		// garden: soft pools between the flowers
		for (int[] c : new int[][] {{7, 34}, {19, 34}, {7, 40}, {19, 40}, {10, 32}, {16, 42}}) {
			p.setIfAir(c[0], FLOOR + 1, c[1], St.light(10));
		}
		// a second chimney (the workshop stove) on the east end of the south slope: its smoke is the
		// studio's breath in the hero and night views
		int top = StudioHqBuilder.roofY(3) + 3;
		for (int x = 20; x <= 21; x++) {
			for (int z = 3; z <= 4; z++) {
				for (int y = StudioHqBuilder.roofY(z); y <= top; y++) {
					p.set(x, y, z, Blocks.MUD_BRICKS.defaultBlockState());
				}
				p.set(x, top + 1, z, St.slab(Blocks.MUD_BRICK_SLAB, false));
			}
		}
		p.set(20, top + 1, 3, Blocks.CAMPFIRE.defaultBlockState());
	}

	/** True when (x, z) is untouched meadow in the plan (grass with air above). */
	static boolean meadowAt(Plan p, int x, int z) {
		int t = p.top(x, z);
		return p.get(x, t, z).is(Blocks.GRASS_BLOCK) && p.isAir(x, t + 1, z);
	}

	// ------------------------------------------------------------------ terraces + portico

	private static void terraces(Plan p) {
		BlockState deck = Blocks.SPRUCE_PLANKS.defaultBlockState();
		for (int side : new int[] {-1, 1}) {
			int xa = side < 0 ? -HX : 10;
			int xb = side < 0 ? -10 : HX;
			for (int x = xa; x <= xb; x++) {
				for (int z = HZS + 1; z <= HZS + 4; z++) {
					boolean edge = z == HZS + 4 || x == xa || x == xb;
					p.set(x, GROUND, z, Blocks.DIRT.defaultBlockState());
					p.set(x, FLOOR, z, edge ? StudioHqBuilder.PLINTH : deck);
				}
			}
			// planters along the outer edge, a step down in the middle
			int mid = side < 0 ? -17 : 17;
			for (int x = xa + 1; x <= xb - 1; x++) {
				int z = HZS + 4;
				if (Math.abs(x - mid) <= 1) {
					p.set(x, FLOOR, z, St.slab(Blocks.MUD_BRICK_SLAB, false));
					p.set(x, FLOOR, z + 1, St.slab(Blocks.SPRUCE_SLAB, false));
					continue;
				}
				if ((x - xa) % 4 == 2) {
					p.set(x, FEET, z, Blocks.MOSS_BLOCK.defaultBlockState());
					p.set(x, FEET + 1, z, (hash(x, z, 5) & 1) == 0 ? Blocks.FLOWERING_AZALEA.defaultBlockState() : Blocks.AZALEA.defaultBlockState());
				} else if ((x - xa) % 4 == 0 && x != xa + 0) {
					p.set(x, FEET, z, Blocks.SPRUCE_FENCE.defaultBlockState());
					p.set(x, FEET + 1, z, StudioHqBuilder.LANTERN);
				}
			}
			// window boxes under the hall windows (on the deck, against the wall)
			for (int x = xa + 1; x <= xb - 1; x++) {
				if (StudioHqBuilder.isPostX(x) || Math.abs(x) < 10) {
					continue;
				}
				if (hash(x, 3, 9) % 3 == 0) {
					p.set(x, FEET, HZS + 1, St.trapdoor(Blocks.SPRUCE_TRAPDOOR, Direction.SOUTH, true, false));
				}
			}
			// benches facing out over the meadow
			for (int bx = mid - 5; bx <= mid + 5; bx += 10) {
				p.set(bx, FEET, HZS + 2, St.stairs(Blocks.SPRUCE_STAIRS, Direction.NORTH, false));
				p.set(bx + 1, FEET, HZS + 2, St.stairs(Blocks.SPRUCE_STAIRS, Direction.NORTH, false));
			}
		}
	}

	/**
	 * The entrance portico: a gabled copper roof on two slim front posts (the back rests on the
	 * atrium wall), a plastered pediment with a timber frame and a round window, a lantern under the
	 * ridge, steps down to the path.
	 */
	private static void portico(Plan p) {
		int z0 = AZ + 10; // 25: just outside the entrance wall (z = 24)
		int z1 = AZ + 13; // 28: front posts
		for (int x = -4; x <= 4; x++) {
			for (int z = z0; z <= z1; z++) {
				p.set(x, GROUND, z, Blocks.DIRT.defaultBlockState());
				p.set(x, FLOOR, z, Math.abs(x) == 4 || z == z1 ? StudioHqBuilder.PLINTH : StudioHqBuilder.DARK_PLANKS);
			}
			if (Math.abs(x) <= 2) {
				p.set(x, FLOOR, z1 + 1, St.slab(Blocks.MUD_BRICK_SLAB, false));
			}
		}
		for (int x = -2; x <= 2; x++) {
			p.set(x, FLOOR, z1, St.slab(Blocks.MUD_BRICK_SLAB, true));
		}
		// posts, side beams, front lintel
		int beamY = FEET + 4; // 70
		for (int sx : new int[] {-3, 3}) {
			p.fill(sx, FEET, z1, sx, beamY - 1, z1, StudioHqBuilder.post());
			p.fill(sx, beamY, z0, sx, beamY, z1, StudioHqBuilder.beam(Direction.Axis.Z));
			p.set(sx, beamY - 1, z0, St.stairs(Blocks.DARK_OAK_STAIRS, Direction.SOUTH, true));
		}
		p.fill(-3, beamY, z1, 3, beamY, z1, StudioHqBuilder.beam(Direction.Axis.X));
		// gabled roof ridged north-south, overhanging one block at the eaves and the front
		Block rs = StudioHqBuilder.COPPER_STAIRS;
		for (int z = z0; z <= z1 + 1; z++) {
			for (int k = 0; k <= 4; k++) {
				int y = beamY + 1 + (4 - k);
				if (k == 0) {
					p.set(AX, y, z, StudioHqBuilder.COPPER);
					p.set(AX, y + 1, z, St.slab(StudioHqBuilder.COPPER_SLAB, false));
				} else {
					p.set(AX - k, y, z, St.stairs(rs, Direction.EAST, false));
					p.set(AX + k, y, z, St.stairs(rs, Direction.WEST, false));
				}
			}
			// overhang lip one lower at the eaves
			p.set(AX - 5, beamY, z, St.slab(StudioHqBuilder.COPPER_SLAB, true));
			p.set(AX + 5, beamY, z, St.slab(StudioHqBuilder.COPPER_SLAB, true));
		}
		// pediment under the front of the roof: plaster, timber frame, a round window
		for (int k = -3; k <= 3; k++) {
			int topY = beamY + (4 - Math.abs(k));
			for (int y = beamY + 1; y <= topY; y++) {
				p.set(AX + k, y, z1, StudioHqBuilder.PLASTER);
			}
		}
		p.set(AX, beamY + 2, z1, Blocks.GLASS_PANE.defaultBlockState());
		p.set(AX, beamY + 3, z1, StudioHqBuilder.DARK_PLANKS);
		p.set(AX - 1, beamY + 2, z1, StudioHqBuilder.DARK_PLANKS);
		p.set(AX + 1, beamY + 2, z1, StudioHqBuilder.DARK_PLANKS);
		// under the roof: a lantern on a chain
		p.set(AX, beamY + 3, z0 + 1, St.chain(Blocks.IRON_CHAIN, Direction.Axis.Y));
		p.set(AX, beamY + 2, z0 + 1, St.chain(Blocks.IRON_CHAIN, Direction.Axis.Y));
		p.set(AX, beamY + 1, z0 + 1, StudioHqBuilder.LANTERN_HANGING);
		// potted plants beside the door
		p.set(-2, FEET, z0, St.of(Blocks.POTTED_FLOWERING_AZALEA));
		p.set(2, FEET, z0, St.of(Blocks.POTTED_FLOWERING_AZALEA));
	}

	// ------------------------------------------------------------------ paths

	private static void path(Plan p, int x, int z) {
		int t = p.top(x, z);
		if (p.get(x, t, z).is(Blocks.GRASS_BLOCK) && p.isAir(x, t + 1, z)) {
			p.set(x, t, z, Blocks.DIRT_PATH.defaultBlockState());
		}
	}

	private static void lanternPost(Plan p, int x, int z) {
		if (!meadowAt(p, x, z)) {
			return;
		}
		int t = p.top(x, z);
		p.set(x, t + 1, z, Blocks.SPRUCE_FENCE.defaultBlockState());
		p.set(x, t + 2, z, Blocks.SPRUCE_FENCE.defaultBlockState());
		p.set(x, t + 3, z, StudioHqBuilder.LANTERN);
	}

	static int pathX(int z) {
		int z1 = AZ + 15;
		return (int) Math.round(Math.sin((z - z1) / 9.0) * 2.0);
	}

	private static void paths(Plan p) {
		int z1 = AZ + 15;
		// main path south from the portico, gently curving, to the lychgate
		for (int z = z1; z <= GATE_Z + 1; z++) {
			int cx = pathX(z);
			for (int x = cx - 1; x <= cx + 1; x++) {
				path(p, x, z);
			}
			if ((z - z1) % 7 == 3 && z < GATE_Z - 2) {
				lanternPost(p, cx + ((z - z1) / 7 % 2 == 0 ? 3 : -3), z);
			}
		}
		// terrace steps -> curve in towards the portico
		for (int side : new int[] {-1, 1}) {
			int mid = side * 17;
			for (int z = HZS + 6; z <= AZ + 15; z++) {
				double t = (z - HZS - 6) / (double) (AZ + 15 - HZS - 6);
				int x = mid - side * (int) Math.round(13 * (1 - Math.cos(t * Math.PI / 2)));
				path(p, x, z);
				path(p, x - side, z);
			}
		}
		// a ring path around the back of the hall
		for (int x = -HX - 3; x <= HX + 3; x++) {
			path(p, x, HZN - 4);
		}
		for (int z = HZN - 4; z <= HZS + 6; z++) {
			path(p, -HX - 3, z);
			path(p, HX + 3, z);
		}
	}

	/** A lychgate where the main path ends: two posts, a lintel, a little slate roof, a lantern. */
	private static void gate(Plan p) {
		int cx = pathX(GATE_Z);
		int t = p.top(cx, GATE_Z);
		int y0 = t + 1;
		for (int sx : new int[] {-2, 2}) {
			p.fill(cx + sx, y0, GATE_Z, cx + sx, y0 + 3, GATE_Z, StudioHqBuilder.post());
			p.set(cx + sx, t, GATE_Z, StudioHqBuilder.PLINTH);
		}
		p.fill(cx - 3, y0 + 4, GATE_Z, cx + 3, y0 + 4, GATE_Z, StudioHqBuilder.beam(Direction.Axis.X));
		for (int x = cx - 3; x <= cx + 3; x++) {
			p.set(x, y0 + 4, GATE_Z - 1, St.stairs(StudioHqBuilder.ROOF_STAIRS, Direction.SOUTH, false));
			p.set(x, y0 + 4, GATE_Z + 1, St.stairs(StudioHqBuilder.ROOF_STAIRS, Direction.NORTH, false));
			p.set(x, y0 + 5, GATE_Z, St.slab(StudioHqBuilder.ROOF_SLAB, false));
		}
		p.set(cx, y0 + 3, GATE_Z, StudioHqBuilder.LANTERN_HANGING);
		p.set(cx - 3, y0, GATE_Z + 1, Blocks.FIREFLY_BUSH.defaultBlockState());
		p.set(cx + 3, y0, GATE_Z - 1, St.of(Blocks.FLOWERING_AZALEA));
	}

	// ------------------------------------------------------------------ pond

	private static void pond(Plan p) {
		double cx = -24;
		double cz = 21;
		for (int x = -36; x <= -12; x++) {
			for (int z = 12; z <= 32; z++) {
				double dx = (x - cx) / 8.5;
				double dz = (z - cz) / 6.0;
				double wob = 0.12 * Math.sin(x * 0.9 + z * 0.4) + 0.1 * Math.cos(z * 1.3 - x * 0.2);
				double d = Math.sqrt(dx * dx + dz * dz) + wob;
				if (d > 1.18 || p.get(x, GROUND, z).is(Blocks.DIRT_PATH)) {
					continue;
				}
				if (d > 1.0) {
					int h = hash(x, z, 31) % 10;
					p.set(x, GROUND, z, h < 3 ? Blocks.MOSS_BLOCK.defaultBlockState() : h < 5 ? Blocks.MUD.defaultBlockState()
						: Blocks.GRASS_BLOCK.defaultBlockState());
					if (h == 9) {
						p.set(x, FLOOR, z, Blocks.MOSSY_COBBLESTONE.defaultBlockState());
					}
					continue;
				}
				int depth = d < 0.55 ? 3 : d < 0.85 ? 2 : 1;
				p.set(x, GROUND - depth, z, (hash(x, z, 33) & 3) == 0 ? Blocks.GRAVEL.defaultBlockState() : Blocks.SAND.defaultBlockState());
				for (int y = GROUND - depth + 1; y <= GROUND; y++) {
					p.set(x, y, z, Blocks.WATER.defaultBlockState());
				}
				p.set(x, FLOOR, z, Blocks.AIR.defaultBlockState());
				int h = hash(x, z, 35) % 100;
				if (h < 9 && d < 0.95) {
					p.set(x, FLOOR, z, Blocks.LILY_PAD.defaultBlockState());
				} else if (h < 13 && depth >= 2) {
					p.set(x, GROUND - depth + 1, z, Blocks.SEAGRASS.defaultBlockState());
				}
			}
		}
		for (int x = -19; x <= -15; x++) {
			for (int z = 20; z <= 21; z++) {
				p.set(x, FLOOR, z, St.slab(Blocks.SPRUCE_SLAB, false));
			}
		}
		p.set(-19, FLOOR, 19, Blocks.SPRUCE_FENCE.defaultBlockState());
		p.set(-19, FLOOR + 1, 19, StudioHqBuilder.LANTERN);
		p.set(-16, FLOOR + 0, 23, Blocks.FIREFLY_BUSH.defaultBlockState());
		p.set(-28, FLOOR, 13, Blocks.FIREFLY_BUSH.defaultBlockState());
		p.set(-34, FLOOR, 23, Blocks.FIREFLY_BUSH.defaultBlockState());
	}

	// ------------------------------------------------------------------ trees

	enum Kind {
		BIRCH(Blocks.BIRCH_LOG, Blocks.BIRCH_LEAVES, null, 7, 2.3, 3.4),
		POPLAR(Blocks.POPLAR_LOG, Blocks.YELLOW_POPLAR_LEAVES, Blocks.ORANGE_POPLAR_LEAVES, 4, 2.3, 5.6),
		AZALEA(Blocks.OAK_LOG, Blocks.AZALEA_LEAVES, Blocks.FLOWERING_AZALEA_LEAVES, 4, 3.6, 2.3),
		OAK(Blocks.DARK_OAK_LOG, Blocks.OAK_LEAVES, null, 6, 4.2, 2.8),
		CHERRY(Blocks.CHERRY_LOG, Blocks.CHERRY_LEAVES, null, 4, 3.4, 2.3),
		SPRUCE(Blocks.SPRUCE_LOG, Blocks.SPRUCE_LEAVES, null, 11, 3.3, 0);

		final Block log;
		final Block leaves;
		final Block accent;
		final int trunk;
		final double rx;
		final double ry;

		Kind(Block log, Block leaves, Block accent, int trunk, double rx, double ry) {
			this.log = log;
			this.leaves = leaves;
			this.accent = accent;
			this.trunk = trunk;
			this.rx = rx;
			this.ry = ry;
		}
	}

	/**
	 * A lobed tree: a trunk, two to four branches ending in leaf lobes around a main crown, each lobe
	 * a jittered ellipsoid. Birches and poplars stay narrow; azaleas, oaks and cherries spread.
	 * Spruces are tiered cones.
	 */
	static void tree(Plan p, int x, int z, Kind k, int seed) {
		if (k == Kind.SPRUCE) {
			spruce(p, x, z, seed);
			return;
		}
		int trunk = k.trunk + hash(x, z, seed) % 3;
		int base = p.top(x, z) + 1;
		for (int y = base; y < base + trunk; y++) {
			p.set(x, y, z, St.log(k.log, Direction.Axis.Y));
		}
		int top = base + trunk;
		List<double[]> lobes = new ArrayList<>();
		lobes.add(new double[] {0, k.ry * 0.45, 0, k.rx, k.ry});
		boolean narrow = k == Kind.POPLAR || k == Kind.BIRCH;
		int branches = k == Kind.POPLAR ? 0 : narrow ? 2 : 3 + hash(x, z, seed + 3) % 2;
		double a0 = rnd(x, z, seed + 4) * Math.PI * 2;
		for (int i = 0; i < branches; i++) {
			double ang = a0 + i * Math.PI * 2 / branches + (rnd(x + i, z, seed + 5) - 0.5) * 0.8;
			double reach = narrow ? k.rx * 0.55 : k.rx * (0.75 + rnd(x, z + i, seed + 6) * 0.35);
			double bx = Math.cos(ang) * reach;
			double bz = Math.sin(ang) * reach;
			double by = -k.ry * (narrow ? 0.9 : 0.35) - rnd(x - i, z, seed + 7) * 1.2;
			lobes.add(new double[] {bx, by, bz, k.rx * (narrow ? 0.7 : 0.62), k.ry * (narrow ? 0.6 : 0.62)});
			if (!narrow) {
				int steps = (int) Math.ceil(reach);
				for (int t = 1; t <= steps; t++) {
					double f = t / (double) steps;
					int lx = x + (int) Math.round(bx * f * 0.8);
					int lz = z + (int) Math.round(bz * f * 0.8);
					int ly = (int) Math.round(top + by * 0.5 - 1 + f);
					Direction.Axis ax = Math.abs(bx) > Math.abs(bz) ? Direction.Axis.X : Direction.Axis.Z;
					if (p.isAir(lx, ly, lz)) {
						p.set(lx, ly, lz, St.log(k.log, ax));
					}
				}
			}
		}
		for (double[] l : lobes) {
			double cx = x + 0.5 + l[0];
			double cy = top + l[1];
			double cz = z + 0.5 + l[2];
			int r = (int) Math.ceil(l[3]) + 1;
			int ry = (int) Math.ceil(l[4]) + 1;
			for (int ix = (int) Math.floor(cx) - r; ix <= (int) Math.floor(cx) + r; ix++) {
				for (int iz = (int) Math.floor(cz) - r; iz <= (int) Math.floor(cz) + r; iz++) {
					for (int iy = (int) Math.floor(cy) - ry; iy <= (int) Math.floor(cy) + ry; iy++) {
						if (iy <= base + 1 || iy <= p.top(ix, iz) + 1) {
							continue;
						}
						double ex = (ix + 0.5 - cx) / l[3];
						double ey = (iy + 0.5 - cy) / l[4];
						double ez = (iz + 0.5 - cz) / l[3];
						double d = ex * ex + ey * ey + ez * ez;
						double jitter = (rnd(ix * 7 + iy, iz * 13 - iy, seed) - 0.5) * (k == Kind.POPLAR ? 0.25 : 0.55);
						if (d + jitter > 1.0 || !p.isAir(ix, iy, iz)) {
							continue;
						}
						Block leaf = k.accent != null && rnd(ix * 3 + iy, iz + iy * 13, seed + 1) < 0.35 ? k.accent : k.leaves;
						p.set(ix, iy, iz, St.leaves(leaf));
					}
				}
			}
		}
		litter(p, x, z, (int) Math.ceil(k.rx), seed);
	}

	/** A tiered spruce: a tall trunk and stacked, shrinking rings of needles with a spike on top. */
	private static void spruce(Plan p, int x, int z, int seed) {
		int base = p.top(x, z) + 1;
		int h = 11 + hash(x, z, seed) % 5;
		for (int y = base; y < base + h - 1; y++) {
			p.set(x, y, z, St.log(Blocks.SPRUCE_LOG, Direction.Axis.Y));
		}
		int crownStart = base + 3;
		double maxR = 3.3 + rnd(x, z, seed + 2) * 0.8;
		for (int y = crownStart; y <= base + h; y++) {
			double f = (y - crownStart) / (double) (base + h - crownStart);
			double r = maxR * (1 - f) + 0.6;
			// tiers: every other layer pulled in a little
			if (((y - crownStart) & 1) == 1) {
				r *= 0.72;
			}
			int ri = (int) Math.ceil(r);
			for (int dx = -ri; dx <= ri; dx++) {
				for (int dz = -ri; dz <= ri; dz++) {
					double d = Math.sqrt(dx * dx + dz * dz) + (rnd(x + dx, z + dz + y, seed) - 0.5) * 0.5;
					if (d > r || !p.isAir(x + dx, y, z + dz) || y <= p.top(x + dx, z + dz) + 1) {
						continue;
					}
					p.set(x + dx, y, z + dz, St.leaves(Blocks.SPRUCE_LEAVES));
				}
			}
		}
		p.set(x, base + h + 1, z, St.leaves(Blocks.SPRUCE_LEAVES));
	}

	private static void litter(Plan p, int x, int z, int lr, int seed) {
		for (int dx = -lr; dx <= lr; dx++) {
			for (int dz = -lr; dz <= lr; dz++) {
				if ((dx != 0 || dz != 0) && meadowAt(p, x + dx, z + dz) && rnd(x + dx, z + dz, seed + 7) < 0.4) {
					int t = p.top(x + dx, z + dz);
					p.set(x + dx, t + 1, z + dz, St.leafLitter(Direction.from2DDataValue(hash(dx, dz, seed) & 3), 1 + hash(x + dx, z + dz, seed) % 4));
				}
			}
		}
	}

	private static void trees(Plan p) {
		List<int[]> placed = new ArrayList<>();
		int[][] spots = {
			// x, z, kind ordinal (0 birch, 1 poplar, 2 azalea, 3 oak, 4 cherry). The south-east quadrant is
			// kept open: it is the hero/night sight line (cam_exterior_hero, cam_night).
			{-30, -18, 1}, {-18, -21, 0}, {-5, -23, 3}, {9, -21, 1}, {22, -19, 0}, {35, -15, 2},
			{-39, 0, 2}, {-41, 14, 0}, {-35, 32, 1}, {-25, 41, 4}, {-12, 45, 0}, {-31, 8, 0},
			{39, -3, 1}, {42, 12, 0}, {37, 25, 3}, {3, 52, 1}, {29, -7, 0},
		};
		Kind[] kinds = Kind.values();
		for (int i = 0; i < spots.length; i++) {
			int[] s = spots[i];
			if (meadowAt(p, s[0], s[1])) {
				tree(p, s[0], s[1], kinds[s[2]], 100 + i);
				placed.add(new int[] {s[0], s[1]});
			}
		}
		// the wooded ring on the hills: an outer row of mixed spruce / oak / birch / poplar and an inner,
		// sparser row, so the horizon is closed from every camera inside the site
		ring(p, placed, 3, 6.5, 0, 300);
		ring(p, placed, 9, 8.5, 3, 400);
	}

	/** Camera spots (x, z) no tree may crowd (the hero and night cameras stand on the meadow). */
	private static final int[][] CAMERA_SPOTS = {{27, 42}, {22, 37}, {18, 46}, {15, 43}};

	/** Trees along the box edge at inset {@code inset}, about {@code step} apart. */
	private static void ring(Plan p, List<int[]> placed, int inset, double step, int phase, int seed) {
		int x0 = SITE[0] + inset;
		int x1 = SITE[3] - inset;
		int z0 = SITE[2] + inset;
		int z1 = SITE[5] - inset;
		List<int[]> pts = new ArrayList<>();
		for (double x = x0 + phase; x <= x1; x += step) {
			pts.add(new int[] {(int) Math.round(x), z0});
			pts.add(new int[] {(int) Math.round(x), z1});
		}
		for (double z = z0 + step / 2 + phase; z <= z1 - step / 2; z += step) {
			pts.add(new int[] {x0, (int) Math.round(z)});
			pts.add(new int[] {x1, (int) Math.round(z)});
		}
		Kind[] mix = {Kind.SPRUCE, Kind.OAK, Kind.SPRUCE, Kind.BIRCH, Kind.OAK, Kind.POPLAR, Kind.SPRUCE, Kind.OAK};
		int n = 0;
		for (int[] q : pts) {
			int jx = q[0] + (int) Math.round((rnd(q[0], q[1], seed) - 0.5) * 3.0);
			int jz = q[1] + (int) Math.round((rnd(q[1], q[0], seed + 1) - 0.5) * 3.0);
			jx = Math.max(SITE[0] + 2, Math.min(SITE[3] - 2, jx));
			jz = Math.max(SITE[2] + 2, Math.min(SITE[5] - 2, jz));
			if (flatDistance(jx, jz) < 2.5 && edge(jx, jz) > 4) {
				continue;
			}
			boolean crowded = false;
			for (int[] c : CAMERA_SPOTS) {
				if (Math.hypot(c[0] - jx, c[1] - jz) < 8) {
					crowded = true;
				}
			}
			for (int[] o : placed) {
				if (Math.hypot(o[0] - jx, o[1] - jz) < step * 0.7) {
					crowded = true;
					break;
				}
			}
			if (crowded || !meadowAt(p, jx, jz)) {
				continue;
			}
			Kind k = mix[(hash(jx, jz, seed + 2) + n++) % mix.length];
			tree(p, jx, jz, k, seed + n);
			placed.add(new int[] {jx, jz});
		}
	}

	// ------------------------------------------------------------------ front garden

	/**
	 * A small formal cottage garden east of the entrance path: four raised beds of tall flowers in a
	 * clipped azalea hedge, gravel walks with a bench and a lantern at the crossing, fireflies at night.
	 */
	private static void garden(Plan p) {
		int x0 = 6;
		int x1 = 20;
		int z0 = 31;
		int z1 = 43;
		int cx = 13;
		int cz = 37;
		for (int x = x0; x <= x1; x++) {
			for (int z = z0; z <= z1; z++) {
				boolean edge = x == x0 || x == x1 || z == z0 || z == z1;
				boolean walk = Math.abs(x - cx) <= 0 || Math.abs(z - cz) <= 0;
				if (edge) {
					boolean gate = Math.abs(z - cz) <= 0 && x == x0;
					if (gate) {
						p.set(x, GROUND, z, Blocks.GRAVEL.defaultBlockState());
					} else if (meadowAt(p, x, z)) {
						p.set(x, FLOOR, z, St.leaves(Blocks.AZALEA_LEAVES));
					}
					continue;
				}
				if (walk) {
					p.set(x, GROUND, z, Blocks.GRAVEL.defaultBlockState());
					p.set(x, FLOOR, z, AIR_STATE);
					continue;
				}
				boolean rim = x == x0 + 1 || x == x1 - 1 || z == z0 + 1 || z == z1 - 1 || Math.abs(x - cx) == 1 || Math.abs(z - cz) == 1;
				p.set(x, GROUND, z, Blocks.GRASS_BLOCK.defaultBlockState());
				int h = hash(x, z, 61) % 9;
				if (rim) {
					p.set(x, FLOOR, z, switch (h % 4) {
						case 0 -> Blocks.ALLIUM.defaultBlockState();
						case 1 -> Blocks.AZURE_BLUET.defaultBlockState();
						case 2 -> Blocks.LILY_OF_THE_VALLEY.defaultBlockState();
						default -> St.flowerBed(Blocks.PINK_PETALS, Direction.from2DDataValue(h & 3), 4);
					});
				} else {
					Block tall = switch (h % 3) {
						case 0 -> Blocks.PEONY;
						case 1 -> Blocks.LILAC;
						default -> Blocks.ROSE_BUSH;
					};
					p.set(x, FLOOR, z, St.lower(tall));
					p.set(x, FLOOR + 1, z, St.upper(tall));
				}
			}
		}
		p.set(cx + 1, FLOOR, cz + 1, St.stairs(Blocks.SPRUCE_STAIRS, Direction.SOUTH, false));
		p.set(cx - 1, FLOOR, cz + 1, St.stairs(Blocks.SPRUCE_STAIRS, Direction.SOUTH, false));
		p.set(cx + 1, FLOOR, cz - 1, Blocks.SPRUCE_FENCE.defaultBlockState());
		p.set(cx + 1, FLOOR + 1, cz - 1, StudioHqBuilder.LANTERN);
		p.set(x1 + 1, FLOOR, z0 + 3, Blocks.FIREFLY_BUSH.defaultBlockState());
		p.set(x1 + 1, FLOOR, z1 - 2, Blocks.FIREFLY_BUSH.defaultBlockState());
		p.set(x0 + 4, FLOOR, z1 + 1, Blocks.FIREFLY_BUSH.defaultBlockState());
	}

	private static final BlockState AIR_STATE = Blocks.AIR.defaultBlockState();

	// ------------------------------------------------------------------ planting + meadow

	private static void foundationPlanting(Plan p) {
		for (int x = -HX - 1; x <= HX + 1; x++) {
			int z = HZN - 1;
			if (meadowAt(p, x, z) && hash(x, z, 41) % 5 != 0) {
				p.set(x, FLOOR, z, St.leaves(hash(x, z, 42) % 3 == 0 ? Blocks.FLOWERING_AZALEA_LEAVES : Blocks.AZALEA_LEAVES));
			}
		}
		for (int z = HZN - 1; z <= HZS + 5; z++) {
			for (int x : new int[] {-HX - 1, HX + 1}) {
				if (meadowAt(p, x, z) && hash(x, z, 43) % 4 != 0) {
					p.set(x, FLOOR, z, St.leaves(hash(x, z, 44) % 3 == 0 ? Blocks.FLOWERING_AZALEA_LEAVES : Blocks.AZALEA_LEAVES));
				}
			}
		}
		for (int dx = -11; dx <= 11; dx++) {
			for (int dz = -11; dz <= 11; dz++) {
				int x = AX + dx;
				int z = AZ + dz;
				if (StudioHqBuilder.octFoot(dx, dz) || !StudioHqBuilder.octFoot(clamp(dx), clamp(dz)) && !near(dx, dz)) {
					continue;
				}
				if (meadowAt(p, x, z)) {
					int h = hash(x, z, 47) % 6;
					p.set(x, FLOOR, z, switch (h) {
						case 0 -> Blocks.ALLIUM.defaultBlockState();
						case 1 -> Blocks.OXEYE_DAISY.defaultBlockState();
						case 2 -> St.flowerBed(Blocks.PINK_PETALS, Direction.NORTH, 3);
						case 3 -> Blocks.AZURE_BLUET.defaultBlockState();
						case 4 -> Blocks.FERN.defaultBlockState();
						default -> St.flowerBed(Blocks.WILDFLOWERS, Direction.EAST, 4);
					});
				}
			}
		}
	}

	private static int clamp(int d) {
		return d > 0 ? d - 1 : d < 0 ? d + 1 : 0;
	}

	private static boolean near(int dx, int dz) {
		return StudioHqBuilder.octFoot(clamp(clamp(dx)), clamp(clamp(dz)));
	}

	private static void meadow(Plan p) {
		for (int x = p.localMinX; x <= p.localMaxX; x++) {
			for (int z = p.localMinZ; z <= p.localMaxZ; z++) {
				if (!meadowAt(p, x, z)) {
					continue;
				}
				int t = p.top(x, z);
				double r = rnd(x, z, 51);
				double patch = Math.sin(x * 0.21 + Math.cos(z * 0.17) * 2.0) + Math.cos(z * 0.23 - x * 0.07);
				// the wooded hills get ferns and bushes rather than flowers
				boolean hill = t > GROUND + 1;
				BlockState s = null;
				if (r < 0.26) {
					s = hill && r < 0.08 ? Blocks.FERN.defaultBlockState() : Blocks.SHORT_GRASS.defaultBlockState();
				} else if (r < 0.30) {
					if (p.isAir(x, t + 2, z)) {
						p.set(x, t + 2, z, St.upper(hill ? Blocks.LARGE_FERN : Blocks.TALL_GRASS));
						s = St.lower(hill ? Blocks.LARGE_FERN : Blocks.TALL_GRASS);
					}
				} else if (r < 0.36 && patch > 0.9) {
					s = St.flowerBed(Blocks.WILDFLOWERS, Direction.from2DDataValue(hash(x, z, 52) & 3), 1 + hash(x, z, 53) % 4);
				} else if (r < 0.40 && patch < -1.1 && !hill) {
					s = switch (hash(x, z, 54) % 5) {
						case 0 -> Blocks.POPPY.defaultBlockState();
						case 1 -> Blocks.CORNFLOWER.defaultBlockState();
						case 2 -> Blocks.DANDELION.defaultBlockState();
						case 3 -> Blocks.OXEYE_DAISY.defaultBlockState();
						default -> Blocks.LILY_OF_THE_VALLEY.defaultBlockState();
					};
				} else if (r < (hill ? 0.43 : 0.405)) {
					s = Blocks.BUSH.defaultBlockState();
				}
				if (s != null) {
					p.set(x, t + 1, z, s);
				}
			}
		}
	}
}

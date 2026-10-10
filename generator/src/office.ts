import { type Layout, CAST_IDS } from "./anchors.js";
import { Volume } from "./schematic.js";

const WIDTH = 25;
const HEIGHT = 8;
const LENGTH = 19;

const FLOOR = "minecraft:spruce_planks";
const WALL = "minecraft:stone_bricks";
const GLASS = "minecraft:glass";
const ROOF = "minecraft:smooth_stone";
const DESK = "minecraft:spruce_slab";
const MONITOR = "minecraft:black_concrete";
const STATION = "minecraft:lectern";
const TASK_WALL = "minecraft:dark_oak_planks";

// Yaw follows Minecraft: 0 = +Z (south), 90 = -X, 180 = -Z, -90 = +X.
const SOUTH = 0;
const NORTH = 180;
const EAST = -90;

export type Placement = { origin: readonly [number, number, number]; name: string };

/**
 * A fixed placeholder office: stone-brick box, glass south wall, one desk row, one station row.
 * Fixtures are vanilla stand-ins; the mod's own blocks are not placed yet.
 */
export function buildOffice({ origin, name }: Placement): { volume: Volume; layout: Layout } {
  const v = new Volume(WIDTH, HEIGHT, LENGTH);
  const [ox, oy, oz] = origin;
  const anchors: Layout["anchors"] = {};
  const put = (anchor: string, x: number, y: number, z: number, yaw: number, pitch = 0) => {
    anchors[anchor] = { x: ox + x, y: oy + y, z: oz + z, yaw, pitch };
  };
  /** A standing spot at the centre of block column (x, z), feet on the floor surface. */
  const spot = (anchor: string, x: number, z: number, yaw: number) => put(anchor, x + 0.5, 1, z + 0.5, yaw);

  v.fill([0, 0, 0], [WIDTH - 1, 0, LENGTH - 1], FLOOR);
  v.fill([0, 6, 0], [WIDTH - 1, 6, LENGTH - 1], ROOF);
  for (const [a, b] of [
    [[0, 1, 0], [WIDTH - 1, 5, 0]],
    [[0, 1, LENGTH - 1], [WIDTH - 1, 5, LENGTH - 1]],
    [[0, 1, 0], [0, 5, LENGTH - 1]],
    [[WIDTH - 1, 1, 0], [WIDTH - 1, 5, LENGTH - 1]],
  ] as const) {
    v.fill(a, b, WALL);
  }
  v.fill([1, 2, LENGTH - 1], [WIDTH - 2, 5, LENGTH - 1], GLASS);

  const doorX = 12;
  v.fill([doorX, 1, 0], [doorX, 2, 0], "minecraft:air");
  spot("entrance", doorX, 1, SOUTH);
  spot("spawn", doorX, 2, SOUTH);

  const deskZ = 14;
  CAST_IDS.forEach((id, i) => {
    const x = 2 + 4 * i;
    v.set(x, 1, deskZ, DESK);
    v.set(x, 2, deskZ, MONITOR);
    spot(`desk_${id}`, x, deskZ - 1, SOUTH);
    put(`monitor_${id}`, x + 0.5, 2.5, deskZ, NORTH);
  });

  const stationZ = 5;
  (["library", "terminal", "testbench", "mergestation", "meeting", "lounge"] as const).forEach((station, i) => {
    const x = 3 + 4 * i;
    v.set(x, 1, stationZ + 1, STATION);
    spot(station, x, stationZ, SOUTH);
  });

  spot("user", doorX, 7, SOUTH);
  v.set(doorX, 1, 9, STATION);
  put("decision_podium", doorX + 0.5, 2, 9.5, NORTH);
  put("goal_atrium", doorX + 0.5, 1, 11.5, SOUTH);

  v.fill([0, 2, 7], [0, 4, 11], TASK_WALL);
  put("task_wall", 1, 3.5, 9.5, EAST);

  put("cam_overview", 23.5, 5.5, 1.5, 150, 35);

  const layout: Layout = {
    layout: name,
    revision: 1,
    bounds: { minX: ox, minY: oy, minZ: oz, maxX: ox + WIDTH - 1, maxY: oy + HEIGHT - 1, maxZ: oz + LENGTH - 1 },
    anchors,
  };
  return { volume: v, layout };
}

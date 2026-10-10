import { z } from "zod";

const anchorSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  yaw: z.number().default(0),
  pitch: z.number().default(0),
});

const boundsSchema = z.object({
  minX: z.number().int(),
  minY: z.number().int(),
  minZ: z.number().int(),
  maxX: z.number().int(),
  maxY: z.number().int(),
  maxZ: z.number().int(),
});

/** Mirrors `agentcraft-anchors.json` as read by `Anchors.fromJson` in the mod. */
export const layoutSchema = z.object({
  layout: z.string().default("unknown"),
  revision: z.number().int().default(1),
  bounds: boundsSchema.optional(),
  anchors: z.record(z.string(), anchorSchema).default({}),
});

export type Anchor = z.infer<typeof anchorSchema>;
export type Bounds = z.infer<typeof boundsSchema>;
export type Layout = z.infer<typeof layoutSchema>;

export const ANCHORS_FILE = "agentcraft-anchors.json";

/** Agent ids from the mod's `cast.json`. */
export const CAST_IDS = ["marlow", "juniper", "kit", "wren", "rowan", "tove"] as const;

/** Shared stations; extra slots are `<station>_2` and up. */
export const SHARED_STATIONS = ["library", "terminal", "testbench", "mergestation", "meeting", "lounge", "user"] as const;

export const FIXTURES = ["task_wall", "decision_podium", "goal_atrium", "entrance", "spawn"] as const;

export function requiredAnchorNames(agentIds: readonly string[] = CAST_IDS): string[] {
  return [
    ...agentIds.flatMap((id) => [`desk_${id}`, `monitor_${id}`]),
    ...SHARED_STATIONS,
    ...FIXTURES,
  ];
}

export function parseLayout(json: unknown): Layout {
  return layoutSchema.parse(json);
}

export function serializeLayout(layout: Layout): string {
  return JSON.stringify(layout, null, 2) + "\n";
}

export type Problem = { anchor: string; message: string };

export function validateLayout(layout: Layout, agentIds: readonly string[] = CAST_IDS): Problem[] {
  const problems: Problem[] = [];

  for (const name of requiredAnchorNames(agentIds)) {
    if (!(name in layout.anchors)) {
      problems.push({ anchor: name, message: "missing required anchor" });
    }
  }

  const { bounds } = layout;
  if (bounds) {
    for (const [name, a] of Object.entries(layout.anchors)) {
      if (name.startsWith("cam_")) continue;
      const inside =
        a.x >= bounds.minX && a.x <= bounds.maxX + 1 &&
        a.y >= bounds.minY && a.y <= bounds.maxY + 1 &&
        a.z >= bounds.minZ && a.z <= bounds.maxZ + 1;
      if (!inside) {
        problems.push({ anchor: name, message: "outside layout bounds" });
      }
    }
  }

  return problems;
}

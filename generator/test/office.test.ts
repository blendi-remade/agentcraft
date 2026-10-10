import { describe, expect, it } from "vitest";
import { validateLayout } from "../src/anchors.js";
import { buildOffice } from "../src/office.js";

describe("buildOffice", () => {
  const origin = [100, 64, -200] as const;
  const { volume, layout } = buildOffice({ origin, name: "t" });

  it("satisfies the anchor contract, with every anchor inside the bounds", () => {
    expect(validateLayout(layout)).toEqual([]);
  });

  it("places each agent's feet on floor level above a solid floor block", () => {
    for (const [name, a] of Object.entries(layout.anchors)) {
      if (!name.startsWith("desk_")) continue;
      const [lx, lz] = [Math.floor(a.x) - origin[0], Math.floor(a.z) - origin[2]];
      expect(a.y).toBe(origin[1] + 1);
      expect(volume.get(lx, 0, lz)).not.toBe("minecraft:air");
      expect(volume.get(lx, 1, lz)).toBe("minecraft:air");
      expect(volume.get(lx, 2, lz)).toBe("minecraft:air");
    }
  });

  it("keeps the door open and the spawn clear", () => {
    expect(volume.get(12, 1, 0)).toBe("minecraft:air");
    expect(volume.get(12, 2, 0)).toBe("minecraft:air");
    expect(volume.get(12, 1, 2)).toBe("minecraft:air");
  });
});

import { describe, expect, it } from "vitest";
import { type Layout, parseLayout, requiredAnchorNames, serializeLayout, validateLayout } from "../src/anchors.js";

function fullLayout(): Layout {
  const anchors = Object.fromEntries(
    requiredAnchorNames().map((name) => [name, { x: 1.5, y: 64, z: 1.5, yaw: 0, pitch: 0 }]),
  );
  return { layout: "test", revision: 1, anchors };
}

describe("validateLayout", () => {
  it("accepts a layout with every required anchor", () => {
    expect(validateLayout(fullLayout())).toEqual([]);
  });

  it("reports each missing anchor", () => {
    const layout = fullLayout();
    delete layout.anchors["spawn"];
    delete layout.anchors["desk_kit"];
    expect(validateLayout(layout).map((p) => p.anchor).sort()).toEqual(["desk_kit", "spawn"]);
  });

  it("flags anchors outside bounds but ignores cam_ points", () => {
    const layout: Layout = {
      ...fullLayout(),
      bounds: { minX: 0, minY: 60, minZ: 0, maxX: 10, maxY: 80, maxZ: 10 },
    };
    layout.anchors["lounge"] = { x: 50, y: 64, z: 1.5, yaw: 0, pitch: 0 };
    layout.anchors["cam_far"] = { x: 500, y: 64, z: 1.5, yaw: 0, pitch: 0 };
    expect(validateLayout(layout)).toEqual([{ anchor: "lounge", message: "outside layout bounds" }]);
  });
});

describe("parse and serialize", () => {
  it("round-trips and fills yaw/pitch defaults like the mod does", () => {
    const parsed = parseLayout({ layout: "x", anchors: { spawn: { x: 1, y: 2, z: 3 } } });
    expect(parsed.anchors["spawn"]).toEqual({ x: 1, y: 2, z: 3, yaw: 0, pitch: 0 });
    expect(parseLayout(JSON.parse(serializeLayout(parsed)))).toEqual(parsed);
  });
});

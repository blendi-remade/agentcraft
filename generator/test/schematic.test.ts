import { gunzipSync } from "node:zlib";
import { parseUncompressed, simplify } from "prismarine-nbt";
import { describe, expect, it } from "vitest";
import { Volume, varints } from "../src/schematic.js";

describe("varints", () => {
  it("encodes LEB128 across the one/two/three byte boundaries", () => {
    expect(varints([0, 127, 128, 300, 16384])).toEqual([0, 127, 128, 1, 172, 2, 128, 128, 1]);
  });
});

describe("Volume.toSchem", () => {
  it("writes a Sponge v3 file with x-fastest block order and palette ids in the data", () => {
    const v = new Volume(2, 2, 2);
    v.set(1, 0, 0, "minecraft:stone");
    v.set(0, 0, 1, "minecraft:glass");
    v.set(0, 1, 0, "minecraft:stone");

    const nbt = simplify(parseUncompressed(gunzipSync(v.toSchem())));
    const s = nbt.Schematic;
    expect([s.Version, s.Width, s.Height, s.Length]).toEqual([3, 2, 2, 2]);
    expect(s.Blocks.Palette).toEqual({ "minecraft:air": 0, "minecraft:stone": 1, "minecraft:glass": 2 });
    // index = x + z*W + y*W*L
    expect(Array.from(s.Blocks.Data)).toEqual([0, 1, 2, 0, 1, 0, 0, 0]);
  });

  it("rejects writes outside the volume", () => {
    expect(() => new Volume(1, 1, 1).set(1, 0, 0, "minecraft:stone")).toThrow(RangeError);
  });
});

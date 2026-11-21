"""Headless Blender: render AgentCraft block models (3/4 lit cubes) and a studio vignette.

Usage: blender -b --factory-startup -P render_blocks.py -- jobs.json
jobs.json = {
  "out_dir": str, "roots": {"agentcraft": dir, "minecraft": dir}, "size": [w,h], "samples": n,
  "lighting": "mc" (default; calibrated to vanilla face shading, see studio.mc_block_lights) | "studio",
  "blocks": [{"name": str, "block": "agentcraft:monitor", "props": {...}}       # via blockstate
             | {"name": str, "model": "agentcraft:block/x"}                     # direct model
             | {"name": str, "inline": {model json}}],                          # e.g. vanilla refs
  "scenes": [{"name": str, "size": [w,h], "ortho": f, "az": f, "el": f, "target": [x,y,z],
              "night": bool, "blocks": [{"block"|"model"|"inline": ..., "props": {}, "pos": [x,y,z]}]}]
}
"""
import importlib
import json
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
mcblock = importlib.import_module("mcblock")
studio = importlib.import_module("studio")


def add_entry(assets, b, name, pos=(0, 0, 0)):
    if "block" in b:
        return mcblock.place_block(assets, b["block"], b.get("props", {}), pos, name)
    rl = b.get("model")
    if "inline" in b:
        rl = f"minecraft:inline/{name}"
        assets.extra_models[rl] = b["inline"]
    return [mcblock.build_model(assets, rl, name, offset=pos)]


def clear_objects(objs):
    for o in objs:
        me = o.data if o.type == "MESH" else None
        bpy.data.objects.remove(o, do_unlink=True)
        if me is not None and me.users == 0:
            bpy.data.meshes.remove(me)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    cfg = json.load(open(argv[0], "r", encoding="utf-8"))
    out_dir = cfg["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    studio.reset_scene()
    scene = bpy.context.scene
    w, h = cfg.get("size", [256, 256])
    studio.setup_render(scene, w, h, cfg.get("samples", 48))
    studio.setup_world(scene, strength=0.6)
    assets = mcblock.Assets(cfg["roots"])
    mc = cfg.get("lighting", "mc") == "mc"

    for b in cfg.get("blocks", []):
        scene.render.resolution_x, scene.render.resolution_y = w, h
        objs = add_entry(assets, b, b["name"])
        target = Vector((0, 0, 8))
        cam = studio.ortho_camera(scene, target, cfg.get("az", 215), cfg.get("el", 30), ortho_scale=cfg.get("ortho", 29.0))
        lights = studio.mc_block_lights(scene) if mc else studio.studio_lights(scene, target, cfg.get("az", 215))
        scene.render.filepath = os.path.join(out_dir, f"{b['name']}.png")
        bpy.ops.render.render(write_still=True)
        print("RENDERED", scene.render.filepath, flush=True)
        clear_objects(objs + lights + [cam])

    for sc in cfg.get("scenes", []):
        sw, sh = sc.get("size", [1200, 800])
        scene.render.resolution_x, scene.render.resolution_y = sw, sh
        objs = []
        for i, b in enumerate(sc["blocks"]):
            objs += add_entry(assets, b, f"{sc['name']}_{i}", tuple(b.get("pos", (0, 0, 0))))
        tgt = Vector(sc.get("target", [0, 0, 16]))
        cam = studio.ortho_camera(scene, tgt, sc.get("az", 215), sc.get("el", 28), ortho_scale=sc.get("ortho", 120.0),
                                  dist=600.0)
        cam.data.clip_end = 2000.0
        if mc:
            # night: moonlight at ~6 % of day; emissive faces stay at 1.0 x texture (as in game)
            lights = studio.mc_block_lights(scene, scale=0.06 if sc.get("night") else 1.0,
                                            color=(0.85, 0.9, 1.0) if sc.get("night") else (1.0, 0.98, 0.95))
        elif sc.get("night"):
            scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.06
            lights = studio.studio_lights(scene, tgt, sc.get("az", 215), key=0.25, fill=0.08, rim=0.1)
        else:
            scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
            lights = studio.studio_lights(scene, tgt, sc.get("az", 215))
        scene.render.filepath = os.path.join(out_dir, f"{sc['name']}.png")
        bpy.ops.render.render(write_still=True)
        print("RENDERED", scene.render.filepath, flush=True)
        clear_objects(objs + lights + [cam])


if __name__ == "__main__":
    main()

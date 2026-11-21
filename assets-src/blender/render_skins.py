"""Headless Blender: render Minecraft player skins on a correct box model.

Usage: blender -b --factory-startup -P render_skins.py -- jobs.json
jobs.json = {"out_dir": str, "size": [w, h], "samples": int,
             "jobs": [{"name": str, "skin": path, "slim": bool, "lighting": "studio" | "mc_entity",
                       "views": ["front","right","back","left","threequarter","hero"]}]}
Writes <out_dir>/<name>_<view>.png with transparent background.
"""
import importlib
import json
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
mcplayer = importlib.import_module("mcplayer")
studio = importlib.import_module("studio")

HERO_POSE = {
    "head": (0, 0, -12),       # look slightly to camera-left
    "right_arm": (18, 0, 0),
    "left_arm": (-16, 0, 4),
    "right_leg": (-14, 0, 0),
    "left_leg": (12, 0, 0),
}

VIEWS = {
    #            azimuth (deg, 0 = camera at -Y looking +Y), elevation
    "front": (0, 0),
    "right": (-90, 0),     # camera at -X -> sees the character's right side
    "back": (180, 0),
    "left": (90, 0),
    "threequarter": (-35, 14),
    "hero": (-30, 12),
    "face": (0, 4),            # close-up views (head only)
    "face34": (-38, 10),
    "faceback": (150, 10),
    # head close-up set used by gen/preview.py --heads (8 angles, review under entity light)
    "h_front": (0, 3),
    "h_f34": (-38, 16),
    "h_f34l": (38, 16),
    "h_right": (-90, 3),
    "h_left": (90, 3),
    "h_back": (180, 3),
    "h_b34": (145, 20),
    "h_top": (-25, 68),
    "h_desk": (-18, 34),
}
CLOSEUP = {"face", "face34", "faceback"} | {v for v in VIEWS if v.startswith("h_")}


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    cfg = json.load(open(argv[0], "r", encoding="utf-8"))
    out_dir = cfg["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    w, h = cfg.get("size", [512, 768])
    studio.reset_scene()
    scene = bpy.context.scene
    studio.setup_render(scene, w, h, cfg.get("samples", 64))
    studio.setup_world(scene, strength=0.55)
    target = Vector((0, 0, 16.5))

    for job in cfg["jobs"]:
        mc = job.get("lighting") == "mc_entity"
        img = bpy.data.images.load(job["skin"], check_existing=False)
        # mc_entity shading scales raw sRGB texels like the game shader does
        img.colorspace_settings.name = "Non-Color" if mc else "sRGB"
        for view in job["views"]:
            # fresh model per view so poses don't leak
            pose = HERO_POSE if view == "hero" else None
            root = mcplayer.build_player(job["name"], img, job["slim"], pose=pose,
                                         shading="mc_entity" if mc else "pbr")
            az, el = VIEWS[view]
            if view in CLOSEUP:
                tgt = Vector((0, 0, 27.5))
                cam = studio.ortho_camera(scene, tgt, az, el, ortho_scale=cfg.get("face_ortho", 14.0))
            else:
                tgt = target
                cam = studio.ortho_camera(scene, tgt, az, el, ortho_scale=cfg.get("ortho", 38.0))
            if mc:
                lights = []     # exact vanilla entity shading is in the material (emission)
            else:
                studio.setup_world(scene, strength=0.55)
                lights = studio.studio_lights(scene, tgt, az)
            scene.render.filepath = os.path.join(out_dir, f"{job['name']}_{view}.png")
            bpy.ops.render.render(write_still=True)
            studio.delete_hierarchy(root)
            for l in lights:
                bpy.data.objects.remove(l, do_unlink=True)
            bpy.data.objects.remove(cam, do_unlink=True)
            print("RENDERED", scene.render.filepath, flush=True)


if __name__ == "__main__":
    main()

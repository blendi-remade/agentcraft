"""Shared Blender studio setup: render settings, soft top-left lighting, ortho cameras."""
import math

import bpy
from mathutils import Vector


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def setup_render(scene, w, h, samples=64):
    scene.render.engine = "CYCLES"
    addon = bpy.context.preferences.addons.get("cycles")
    prefs = addon.preferences if addon is not None else None
    if prefs is not None and hasattr(prefs, "compute_device_type") and hasattr(prefs, "get_devices"):
        prefs.compute_device_type = "OPTIX"
        prefs.get_devices()
        available = [d for d in prefs.devices if d.type == "OPTIX"]
        for d in prefs.devices:
            d.use = d in available
        if available:
            scene.cycles.device = "GPU"
        else:
            print("GPU setup: nessun dispositivo OPTIX, uso la CPU")
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.render.film_transparent = True
    scene.render.resolution_x = w
    scene.render.resolution_y = h
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.filter_size = 1.0
    # Standard view transform keeps palette colours true (AgX/Filmic desaturate them)
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0


def setup_world(scene, strength=0.5, color=(1.0, 0.96, 0.9)):
    world = bpy.data.worlds.new("studio")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (*color, 1.0)
    bg.inputs[1].default_value = strength
    scene.world = world


def _dir(az_deg, el_deg):
    az, el = math.radians(az_deg), math.radians(el_deg)
    return Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))


def ortho_camera(scene, target, az, el, ortho_scale=38.0, dist=200.0):
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = ortho_scale
    cam_data.clip_start = 1.0
    cam_data.clip_end = 1000.0
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    d = _dir(az, el)
    cam.location = target + d * dist
    cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    return cam


def sun(scene, name, az, el, strength, angle_deg=12.0, color=(1.0, 0.97, 0.92)):
    ld = bpy.data.lights.new(name, "SUN")
    ld.energy = strength
    ld.angle = math.radians(angle_deg)
    ld.color = color
    ob = bpy.data.objects.new(name, ld)
    scene.collection.objects.link(ob)
    d = _dir(az, el)
    ob.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    return ob


def studio_lights(scene, target, cam_az, key=2.6, fill=0.7, rim=1.4):
    """Key light from the camera's upper-left, warm; cool soft fill from the right; rim from behind."""
    return [
        sun(scene, "key", cam_az - 48, 52, key, 14.0, (1.0, 0.95, 0.86)),
        sun(scene, "fill", cam_az + 65, 18, fill, 30.0, (0.88, 0.92, 1.0)),
        sun(scene, "rim", cam_az + 165, 38, rim, 10.0, (1.0, 0.93, 0.85)),
    ]


def _az_el(d):
    d = Vector(d).normalized()
    el = math.degrees(math.asin(d.z))
    az = math.degrees(math.atan2(d.x, -d.y))
    return az, el


def mc_block_lights(scene, ambient=0.4, top=1.0, north=0.8, west=0.6, scale=1.0, color=(1.0, 0.98, 0.95)):
    """Lighting calibrated to Minecraft's own block shading so renders predict the game.

    Vanilla multiplies a fully lit face by 1.0 (up), 0.8 (north/south) and 0.6 (east/west) and
    never goes brighter than the texture. With a uniform world of strength `ambient` and one
    sun, a diffuse face gets albedo * (ambient + S/pi * cos). Solve for the sun so the three
    faces the review camera sees (up, north = front, west) land on exactly those factors. The
    world is set neutral; emissive (light_emission) faces render at 1.0 x texture, as in game.
    """
    world = scene.world.node_tree.nodes["Background"]
    world.inputs[0].default_value = (1.0, 1.0, 1.0, 1.0)
    world.inputs[1].default_value = ambient * scale
    # Blender coords: up = +Z, MC north = +Y, MC west = -X
    k = Vector(((west - ambient) * -1.0, north - ambient, top - ambient))
    strength = k.length * math.pi
    az, el = _az_el(k)
    return [sun(scene, "mc_key", az, el, strength * scale, 8.0, color)]


def mc_entity_lights(scene, scale=1.0):
    """Vanilla entity lighting (Lighting.setupLevel): ambient 0.4 + two diffuse lights of 0.6 at
    MC directions (0.2, 1, -0.7) and (-0.2, 1, 0.7). MC coords (x, y, z) -> Blender (x, -z, y)."""
    world = scene.world.node_tree.nodes["Background"]
    world.inputs[0].default_value = (1.0, 1.0, 1.0, 1.0)
    world.inputs[1].default_value = 0.4 * scale
    out = []
    for i, (x, y, z) in enumerate(((0.2, 1.0, -0.7), (-0.2, 1.0, 0.7))):
        az, el = _az_el((x, -z, y))
        out.append(sun(scene, f"mc_ent{i}", az, el, 0.6 * math.pi * scale, 2.0, (1.0, 1.0, 1.0)))
    return out


def delete_hierarchy(root):
    objs = [root]
    i = 0
    while i < len(objs):
        objs.extend(objs[i].children)
        i += 1
    meshes = [o.data for o in objs if o.type == "MESH"]
    for o in reversed(objs):
        bpy.data.objects.remove(o, do_unlink=True)
    for m in meshes:
        if m.users == 0:
            bpy.data.meshes.remove(m)

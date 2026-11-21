"""Import Minecraft block models (JSON) into Blender, faithfully enough for review renders.

Supports: parent chains (with built-in vanilla block/cube* parents), texture variables,
element rotation (+rescale), explicit/default face UVs, face uv rotation, light_emission
(rendered as unlit emission = Minecraft's full-bright faces), cutout alpha, and blockstate
variant / multipart selection with x/y rotations.

Coordinate mapping (MC pixels -> Blender units): B = (x - 8, 8 - z, y)
so MC north (-Z) faces Blender +Y and MC up is Blender +Z.
"""
import json
import math
import os

import bmesh
import bpy

VANILLA = {
    "minecraft:block/block": {},
    "minecraft:block/cube": {"parent": "minecraft:block/block", "elements": [
        {"from": [0, 0, 0], "to": [16, 16, 16], "faces": {
            "down": {"texture": "#down", "cullface": "down"}, "up": {"texture": "#up", "cullface": "up"},
            "north": {"texture": "#north", "cullface": "north"}, "south": {"texture": "#south", "cullface": "south"},
            "west": {"texture": "#west", "cullface": "west"}, "east": {"texture": "#east", "cullface": "east"}}}]},
    "minecraft:block/cube_all": {"parent": "minecraft:block/cube", "textures": {
        "particle": "#all", "down": "#all", "up": "#all", "north": "#all", "east": "#all", "south": "#all", "west": "#all"}},
    "minecraft:block/cube_column": {"parent": "minecraft:block/cube", "textures": {
        "particle": "#side", "down": "#end", "up": "#end", "north": "#side", "east": "#side", "south": "#side", "west": "#side"}},
    "minecraft:block/cube_bottom_top": {"parent": "minecraft:block/cube", "textures": {
        "particle": "#side", "down": "#bottom", "up": "#top", "north": "#side", "east": "#side", "south": "#side", "west": "#side"}},
    "minecraft:block/orientable": {"parent": "minecraft:block/cube", "textures": {
        "particle": "#front", "down": "#top", "up": "#top", "north": "#front", "east": "#side", "south": "#side", "west": "#side"}},
}


class Assets:
    def __init__(self, roots):
        """roots: {namespace: assets_dir} e.g. {"agentcraft": ".../out/assets/agentcraft",
        "minecraft": ".../_ref/vanilla_assets/minecraft"}; vanilla textures may also be flat files."""
        self.roots = roots
        self.images = {}
        self.materials = {}
        self.extra_models = {}   # rl -> inline model json (used for vanilla reference cubes)

    def _norm(self, rl):
        if ":" not in rl:
            rl = "minecraft:" + rl
        return rl

    def load_model(self, rl):
        rl = self._norm(rl)
        if rl in self.extra_models:
            return self.extra_models[rl]
        if rl in VANILLA:
            return VANILLA[rl]
        ns, path = rl.split(":", 1)
        p = os.path.join(self.roots[ns], "models", path + ".json")
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)

    def resolve(self, rl):
        chain = []
        cur = rl
        while cur:
            mdl = self.load_model(cur)
            chain.append(mdl)
            cur = mdl.get("parent")
        textures, elements = {}, None
        for mdl in reversed(chain):
            textures.update(mdl.get("textures", {}))
            if "elements" in mdl:
                elements = mdl["elements"]
        return textures, elements or [], chain[0].get("ambientocclusion", True)

    def texture_path(self, rl):
        rl = self._norm(rl)
        ns, path = rl.split(":", 1)
        root = self.roots[ns]
        p = os.path.join(root, "textures", path + ".png")
        if os.path.exists(p):
            return p
        flat = os.path.join(root, os.path.basename(path) + ".png")  # flat reference folder
        return flat

    def image(self, rl):
        p = self.texture_path(rl)
        if p not in self.images:
            img = bpy.data.images.load(p, check_existing=True)
            img.colorspace_settings.name = "sRGB"
            self.images[p] = img
        return self.images[p]

    def material(self, rl, emissive=False):
        key = (self._norm(rl), emissive)
        if key in self.materials:
            return self.materials[key]
        img = self.image(rl)
        mat = bpy.data.materials.new(f"{rl}{'_E' if emissive else ''}")
        mat.use_nodes = True
        nt = mat.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        tex.interpolation = "Closest"
        transp = nt.nodes.new("ShaderNodeBsdfTransparent")
        mix = nt.nodes.new("ShaderNodeMixShader")
        if emissive:
            sh = nt.nodes.new("ShaderNodeEmission")
            nt.links.new(tex.outputs["Color"], sh.inputs["Color"])
            sh.inputs["Strength"].default_value = 1.0
            out_sock = sh.outputs["Emission"]
        else:
            sh = nt.nodes.new("ShaderNodeBsdfPrincipled")
            nt.links.new(tex.outputs["Color"], sh.inputs["Base Color"])
            sh.inputs["Roughness"].default_value = 0.8
            if "Specular IOR Level" in sh.inputs:
                sh.inputs["Specular IOR Level"].default_value = 0.2
            out_sock = sh.outputs["BSDF"]
        nt.links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
        nt.links.new(transp.outputs["BSDF"], mix.inputs[1])
        nt.links.new(out_sock, mix.inputs[2])
        nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
        try:
            mat.blend_method = "CLIP"
        except AttributeError as exc:
            print(f"[agentcraft] blend_method non disponibile in questa versione di Blender: {exc}")
        self.materials[key] = mat
        return mat


def _rot_point(p, axis, ang_deg, origin, rescale=False):
    a = math.radians(ang_deg)
    c, s = math.cos(a), math.sin(a)
    x, y, z = p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]
    if rescale and abs(c) > 1e-6:
        k = 1.0 / c
        if axis == "x":
            y, z = y * k, z * k
        elif axis == "y":
            x, z = x * k, z * k
        else:
            x, y = x * k, y * k
    if axis == "x":
        y, z = y * c - z * s, y * s + z * c
    elif axis == "y":
        x, z = x * c + z * s, -x * s + z * c
    else:
        x, y = x * c - y * s, x * s + y * c
    return (x + origin[0], y + origin[1], z + origin[2])


EMISSIVE_EPS = 0.05  # MC pixels


def _push_out(corners, eps):
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = corners[0], corners[1], corners[2]
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    # corners run TL, TR, BR, BL seen from outside (clockwise) -> outward normal = v x u
    nx, ny, nz = vy * uz - vz * uy, vz * ux - vx * uz, vx * uy - vy * ux
    ln = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    nx, ny, nz = nx / ln * eps, ny / ln * eps, nz / ln * eps
    return [(x + nx, y + ny, z + nz) for (x, y, z) in corners]


def _face_corners(d, f, t):
    x1, y1, z1 = f
    x2, y2, z2 = t
    return {
        "north": [(x2, y2, z1), (x1, y2, z1), (x1, y1, z1), (x2, y1, z1)],
        "south": [(x1, y2, z2), (x2, y2, z2), (x2, y1, z2), (x1, y1, z2)],
        "west": [(x1, y2, z1), (x1, y2, z2), (x1, y1, z2), (x1, y1, z1)],
        "east": [(x2, y2, z2), (x2, y2, z1), (x2, y1, z1), (x2, y1, z2)],
        "up": [(x1, y2, z1), (x2, y2, z1), (x2, y2, z2), (x1, y2, z2)],
        "down": [(x1, y1, z2), (x2, y1, z2), (x2, y1, z1), (x1, y1, z1)],
    }[d]


def _default_uv(d, f, t):
    x1, y1, z1 = f
    x2, y2, z2 = t
    return {
        "down": [x1, 16 - z2, x2, 16 - z1], "up": [x1, z1, x2, z2],
        "north": [16 - x2, 16 - y2, 16 - x1, 16 - y1], "south": [x1, 16 - y2, x2, 16 - y1],
        "west": [z1, 16 - y2, z2, 16 - y1], "east": [16 - z2, 16 - y2, 16 - z1, 16 - y1],
    }[d]


def _resolve_tex(textures, ref, depth=0):
    while ref.startswith("#") and depth < 16:
        ref = textures.get(ref[1:], ref)
        depth += 1
    return ref


def _bs_rotate(p, xrot, yrot):
    """blockstate rotation: x then y, both clockwise (= negative right-handed), about block centre."""
    if xrot:
        p = _rot_point(p, "x", -xrot, (8, 8, 8))
    if yrot:
        p = _rot_point(p, "y", -yrot, (8, 8, 8))
    return p


def build_model(assets, rl, name, offset=(0, 0, 0), xrot=0, yrot=0, collection=None):
    """Create a mesh object for model `rl`, positioned at block offset (MC block units)."""
    textures, elements, _ao = assets.resolve(rl)
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("UVMap")
    mats = []
    mat_index = {}
    for e in elements:
        f, t = e["from"], e["to"]
        rot = e.get("rotation")
        emissive = bool(e.get("light_emission"))
        for d, fc in e["faces"].items():
            tex_rl = _resolve_tex(textures, fc["texture"])
            if tex_rl.startswith("#"):
                continue
            key = (tex_rl, emissive)
            if key not in mat_index:
                mat_index[key] = len(mats)
                mats.append(assets.material(tex_rl, emissive))
            corners = _face_corners(d, f, t)
            if rot:
                corners = [_rot_point(c, rot["axis"], rot["angle"], rot["origin"], rot.get("rescale", False))
                           for c in corners]
            corners = [_bs_rotate(c, xrot, yrot) for c in corners]
            if emissive:
                # Minecraft draws a coplanar duplicate element after the base with depth LEQUAL,
                # so the emissive copy wins. Cycles would z-fight, so push emissive faces out
                # along their normal by a hair (1/320 block) to reproduce the in-game result.
                corners = _push_out(corners, EMISSIVE_EPS)
            u1, v1, u2, v2 = fc.get("uv") or _default_uv(d, f, t)
            uvc = [(u1, v1), (u2, v1), (u2, v2), (u1, v2)]
            r = (fc.get("rotation", 0) // 90) % 4
            uvc = [uvc[(i - r) % 4] for i in range(4)]
            verts = []
            for (x, y, z) in corners:
                bx = x - 8 + offset[0] * 16
                by = 8 - z - offset[2] * 16
                bz = y + offset[1] * 16
                verts.append(bm.verts.new((bx, by, bz)))
            # corners are TL,TR,BR,BL seen from outside (clockwise) -> reverse for Blender
            try:
                face_ = bm.faces.new(list(reversed(verts)))
            except ValueError:
                continue
            face_.material_index = mat_index[key]
            for loop, (u, v) in zip(face_.loops, list(reversed(uvc))):
                loop[uvl].uv = (u / 16.0, 1.0 - v / 16.0)
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    for mt in mats:
        mesh.materials.append(mt)
    obj = bpy.data.objects.new(name, mesh)
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def _match(cond, props):
    if "OR" in cond:
        return any(_match(c, props) for c in cond["OR"])
    if "AND" in cond:
        return all(_match(c, props) for c in cond["AND"])
    for k, v in cond.items():
        if str(props.get(k)) not in str(v).split("|"):
            return False
    return True


def blockstate_models(assets, block_rl, props):
    """Return [(model_rl, x, y)] selected by the blockstate for the given properties."""
    ns, path = block_rl.split(":", 1)
    with open(os.path.join(assets.roots[ns], "blockstates", path + ".json"), "r", encoding="utf-8") as fh:
        bs = json.load(fh)
    out = []
    if "variants" in bs:
        for key, val in bs["variants"].items():
            want = dict(kv.split("=") for kv in key.split(",") if kv)
            if all(str(props.get(k)) == v for k, v in want.items()):
                v = val[0] if isinstance(val, list) else val
                out.append((v["model"], v.get("x", 0), v.get("y", 0)))
                break
    for part in bs.get("multipart", []):
        if "when" not in part or _match(part["when"], props):
            a = part["apply"]
            a = a[0] if isinstance(a, list) else a
            out.append((a["model"], a.get("x", 0), a.get("y", 0)))
    return out


def place_block(assets, block_rl, props, pos, name):
    objs = []
    for i, (mrl, x, y) in enumerate(blockstate_models(assets, block_rl, props)):
        objs.append(build_model(assets, mrl, f"{name}_{i}", offset=pos, xrot=x, yrot=y))
    return objs

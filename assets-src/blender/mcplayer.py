"""Build a Minecraft player model (classic or slim) in Blender with exact skin UVs.

Coordinates: 1 Blender unit = 1 skin pixel. Character faces -Y (towards a camera at -Y),
character's right side is -X, Z is up. Feet at z=0, top of head at z=32.

UV mapping follows vanilla ModelPart.Cuboid (verified against the documented 64x64 layout):
  front(-Y): u: x0->x1          back(+Y): u: x1->x0
  right(-X): u: y1(back)->y0    left(+X): u: y0(front)->y1(back)
  top(+Z)  : u: x0->x1, v-top = back edge
  bottom(-Z): same orientation as top (x-ray from above)
"""
import math

import bmesh
import bpy

TEX = 64.0

# part -> (base uv, overlay uv, size(w,h,d), pivot, box_min) in skin pixels
def part_table(slim):
    aw = 3 if slim else 4
    return {
        "head":      ((0, 0),   (32, 0),  (8, 8, 8),   (0, 0, 24),   (-4, -4, 24)),
        "body":      ((16, 16), (16, 32), (8, 12, 4),  (0, 0, 24),   (-4, -2, 12)),
        "right_arm": ((40, 16), (40, 32), (aw, 12, 4), (-5, 0, 22),  (-4 - aw, -2, 12)),
        "left_arm":  ((32, 48), (48, 48), (aw, 12, 4), (5, 0, 22),   (4, -2, 12)),
        "right_leg": ((0, 16),  (0, 32),  (4, 12, 4),  (-2, 0, 12),  (-4, -2, 0)),
        "left_leg":  ((16, 48), (0, 48),  (4, 12, 4),  (2, 0, 12),   (0, -2, 0)),
    }


INFLATE = {"head": 0.5, "body": 0.25, "right_arm": 0.25, "left_arm": 0.25,
           "right_leg": 0.25, "left_leg": 0.25}


def _uv(px, py):
    return (px / TEX, 1.0 - py / TEX)


def _faces_uv(u, v, w, h, d):
    return {
        "top": (u + d, v, w, d),
        "bottom": (u + d + w, v, w, d),
        "right": (u, v + d, d, h),
        "front": (u + d, v + d, w, h),
        "left": (u + d + w, v + d, d, h),
        "back": (u + d + w + d, v + d, w, h),
    }


def make_box(name, uvorigin, size, bmin, inflate, mat):
    w, h, d = size  # w along X, h along Z, d along Y
    x0, y0, z0 = bmin[0] - inflate, bmin[1] - inflate, bmin[2] - inflate
    x1, y1, z1 = bmin[0] + w + inflate, bmin[1] + d + inflate, bmin[2] + h + inflate
    rects = _faces_uv(uvorigin[0], uvorigin[1], w, h, d)

    # Each face: 4 verts in CCW order seen from outside, paired with the texture-space
    # corner they map to: tl, tr, br, bl of the face's UV rectangle.
    def corners(rect):
        rx, ry, rw, rh = rect
        return [_uv(rx, ry), _uv(rx + rw, ry), _uv(rx + rw, ry + rh), _uv(rx, ry + rh)]

    faces = {
        # front (-Y): tl=(x0,z1) tr=(x1,z1) br=(x1,z0) bl=(x0,z0)
        "front": [(x0, y0, z1), (x1, y0, z1), (x1, y0, z0), (x0, y0, z0)],
        # back (+Y): tl=(x1,z1) tr=(x0,z1)
        "back": [(x1, y1, z1), (x0, y1, z1), (x0, y1, z0), (x1, y1, z0)],
        # right (-X): tl=(y1,z1) tr=(y0,z1)
        "right": [(x0, y1, z1), (x0, y0, z1), (x0, y0, z0), (x0, y1, z0)],
        # left (+X): tl=(y0,z1) tr=(y1,z1)
        "left": [(x1, y0, z1), (x1, y1, z1), (x1, y1, z0), (x1, y0, z0)],
        # top (+Z): tl=(x0,y1) tr=(x1,y1) br=(x1,y0) bl=(x0,y0)
        "top": [(x0, y1, z1), (x1, y1, z1), (x1, y0, z1), (x0, y0, z1)],
        # bottom (-Z): same texture orientation as top, seen from above
        "bottom": [(x0, y1, z0), (x1, y1, z0), (x1, y0, z0), (x0, y0, z0)],
    }
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("UVMap")
    for fname, verts in faces.items():
        # verts are tl,tr,br,bl as seen from outside = clockwise; Blender wants CCW.
        bv = [bm.verts.new(p) for p in reversed(verts)]
        uvs = list(reversed(corners(rects[fname])))
        f = bm.faces.new(bv)
        for loop, uv in zip(f.loops, uvs):
            loop[uvl].uv = uv
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(mat)
    return obj


# Vanilla entity light directions (Lighting.DIFFUSE_LIGHT_0/1, world space), MC (x, y, z) ->
# Blender (x, -z, y). The entity shader does
#   light = min(1, 0.4 + 0.6 * (max(0, N.L0) + max(0, N.L1)));  rgb = texture_srgb * light
# i.e. tops render at exactly the texture colour (1.0), north/south faces at 0.74, east/west 0.50.
MC_L0 = (0.2, 0.7, 1.0)
MC_L1 = (-0.2, -0.7, 1.0)


def _norm(v):
    n = math.sqrt(sum(c * c for c in v))
    return tuple(c / n for c in v)


def _mc_entity_shading(nt, tex):
    """Emission shader reproducing vanilla's clamped entity lighting (no shadows, no bounce)."""
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    acc = None
    for i, L in enumerate((MC_L0, MC_L1)):
        dot = nt.nodes.new("ShaderNodeVectorMath")
        dot.operation = "DOT_PRODUCT"
        nt.links.new(geo.outputs["Normal"], dot.inputs[0])
        dot.inputs[1].default_value = _norm(L)
        mx = nt.nodes.new("ShaderNodeMath")
        mx.operation = "MAXIMUM"
        nt.links.new(dot.outputs["Value"], mx.inputs[0])
        mx.inputs[1].default_value = 0.0
        if acc is None:
            acc = mx
        else:
            add = nt.nodes.new("ShaderNodeMath")
            add.operation = "ADD"
            nt.links.new(acc.outputs[0], add.inputs[0])
            nt.links.new(mx.outputs[0], add.inputs[1])
            acc = add
    lit = nt.nodes.new("ShaderNodeMath")
    lit.operation = "MULTIPLY_ADD"                         # acc * 0.6 + 0.4
    nt.links.new(acc.outputs[0], lit.inputs[0])
    lit.inputs[1].default_value = 0.6
    lit.inputs[2].default_value = 0.4
    clamp = nt.nodes.new("ShaderNodeMath")
    clamp.operation = "MINIMUM"
    nt.links.new(lit.outputs[0], clamp.inputs[0])
    clamp.inputs[1].default_value = 1.0
    # texture is sampled as raw sRGB (Non-Color), scaled in sRGB space like the game, then
    # linearised (gamma 2.2) so the Standard view transform writes it back out unchanged.
    mul = nt.nodes.new("ShaderNodeVectorMath")
    mul.operation = "SCALE"
    nt.links.new(tex.outputs["Color"], mul.inputs[0])
    nt.links.new(clamp.outputs[0], mul.inputs["Scale"])
    gam = nt.nodes.new("ShaderNodeGamma")
    nt.links.new(mul.outputs["Vector"], gam.inputs["Color"])
    gam.inputs["Gamma"].default_value = 2.2
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(gam.outputs["Color"], em.inputs["Color"])
    em.inputs["Strength"].default_value = 1.0
    return em


def skin_material(name, image, overlay=False, shading="pbr"):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.interpolation = "Closest"
    if shading == "mc_entity":
        surf = _mc_entity_shading(nt, tex).outputs["Emission"]
    else:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = 0.85
        if "Specular IOR Level" in bsdf.inputs:
            bsdf.inputs["Specular IOR Level"].default_value = 0.15
        bsdf.inputs["Alpha"].default_value = 1.0
        surf = bsdf.outputs["BSDF"]
    if overlay:
        # binary alpha cut-out: mix to transparent where the overlay texel is empty
        tr = nt.nodes.new("ShaderNodeBsdfTransparent")
        mix = nt.nodes.new("ShaderNodeMixShader")
        nt.links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
        nt.links.new(tr.outputs["BSDF"], mix.inputs[1])
        nt.links.new(surf, mix.inputs[2])
        surf = mix.outputs["Shader"]
        try:
            mat.blend_method = "CLIP"
        except AttributeError as exc:
            print(f"[agentcraft] blend_method non disponibile in questa versione di Blender: {exc}")
        try:
            mat.surface_render_method = "DITHERED"
        except AttributeError as exc:
            print(f"[agentcraft] surface_render_method non disponibile in questa versione di Blender: {exc}")
        mat.use_backface_culling = False
    else:
        mat.use_backface_culling = True
    nt.links.new(surf, out.inputs["Surface"])
    return mat


def build_player(name, image, slim, pose=None, collection=None, shading="pbr"):
    """Returns the root empty. pose: dict part -> (rx, ry, rz) degrees about the joint pivot.
    shading: "pbr" (studio renders, lit by scene lights) or "mc_entity" (exact vanilla entity
    shading as an emission shader; needs the image loaded as Non-Color)."""
    pose = pose or {}
    col = collection or bpy.context.scene.collection
    base_mat = skin_material(name + "_base", image, overlay=False, shading=shading)
    over_mat = skin_material(name + "_over", image, overlay=True, shading=shading)
    root = bpy.data.objects.new(name, None)
    col.objects.link(root)
    for part, (buv, ouv, size, pivot, bmin) in part_table(slim).items():
        pivot_obj = bpy.data.objects.new(f"{name}_{part}_pivot", None)
        col.objects.link(pivot_obj)
        pivot_obj.parent = root
        pivot_obj.location = pivot
        rel_min = (bmin[0] - pivot[0], bmin[1] - pivot[1], bmin[2] - pivot[2])
        b = make_box(f"{name}_{part}", buv, size, rel_min, 0.0, base_mat)
        o = make_box(f"{name}_{part}_layer", ouv, size, rel_min, INFLATE[part], over_mat)
        for ob in (b, o):
            col.objects.link(ob)
            ob.parent = pivot_obj
        if part in pose:
            rx, ry, rz = pose[part]
            pivot_obj.rotation_euler = (math.radians(rx), math.radians(ry), math.radians(rz))
    return root

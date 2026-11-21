"""Block models, blockstates, item definitions and lang for AgentCraft blocks.

Targets Minecraft 26.3 resource format (items/<id>.json item definitions, 1.21.4+ style).
Emissive parts follow vanilla's cross_emissive pattern: a duplicate element with exactly the
same from/to as the part it lights (so the two faces are bit-identical and the later one wins the
depth test deterministically, never z-fights), "light_emission": 15,
"shade_direction_override": "up" (26.3's replacement for the old "shade": false, which it no
longer parses) and an *_emissive cut-out texture. In 26.3 the render layer is chosen per quad
from the alpha of the texture region it samples (ChunkSectionLayer.byTransparency), so cut-out
overlays land in CUTOUT, drawn after their SOLID base, with a GREATER_OR_EQUAL (reversed-Z) depth
test: the overlay wins. No BlockRenderLayerMap is needed. A face that is emissive everywhere (a
lit monitor screen) is a single emissive face instead - no shaded copy behind it at all. Every
model with an emissive element sets "ambientocclusion": false, as vanilla cross_emissive does,
so AO never darkens a full-bright face.

The block-state property contract (names/values the Java side must declare) is in
BLOCKS below and documented in assets-src/README.md.
"""
from __future__ import annotations

from common import OUT, write_json

NS = "agentcraft"
MODELS = {}
BLOCKSTATES = {}
ITEMS = {}

HORIZONTAL_Y = {"north": 0, "east": 90, "south": 180, "west": 270}


def t(name):
    return f"{NS}:block/{name}"


def m(name):
    return f"{NS}:block/{name}"


def face(tex, uv=None, cull=None, rot=None, tint=None):
    f = {"texture": tex}
    if uv is not None:
        f["uv"] = uv
    if cull:
        f["cullface"] = cull
    if rot:
        f["rotation"] = rot
    return f


def el(frm, to, faces, rotation=None, light=None, shade=None):
    """shade=False -> "shade_direction_override": "up": the face takes the up-face brightness (1.0),
    i.e. no directional darkening. 26.3 no longer reads the old "shade": false key (the cuboid
    deserializer only parses shade_direction_override; vanilla cross_emissive uses "up")."""
    e = {"from": frm, "to": to, "faces": faces}
    if rotation:
        e["rotation"] = rotation
    if shade is False:
        e["shade_direction_override"] = "up"
    if light:
        e["light_emission"] = light
    return e


def model(name, data):
    if any("light_emission" in e for e in data.get("elements", [])):
        data = {"ambientocclusion": False, **data}
    MODELS[name] = data
    return m(name)


def simple_item(block, model_name=None):
    ITEMS[block] = {"model": {"type": "minecraft:model", "model": m(model_name or block)}}


def horizontal_variants(model_name, extra=None):
    """variants for facing=north|east|south|west (+ optional extra prop string)."""
    v = {}
    for f, y in HORIZONTAL_Y.items():
        key = f"facing={f}" + (f",{extra}" if extra else "")
        entry = {"model": m(model_name)}
        if y:
            entry["y"] = y
        v[key] = entry
    return v


# =========================================================================================
# Simple cubes (decorative)
# =========================================================================================
def cube_all(name, tex=None):
    model(name, {"parent": "minecraft:block/cube_all", "textures": {"all": t(tex or name)}})
    BLOCKSTATES[name] = {"variants": {"": {"model": m(name)}}}
    simple_item(name)


def emissive_cube(name, base_tex, emis_tex, faces_all=True):
    """Full cube + emissive overlay on all six faces."""
    six = {d: face("#base", cull=d) for d in ("down", "up", "north", "south", "west", "east")}
    six_e = {d: face("#glow", cull=d) for d in ("down", "up", "north", "south", "west", "east")}
    model(name, {
        "parent": "minecraft:block/block",
        "textures": {"particle": t(base_tex), "base": t(base_tex), "glow": t(emis_tex)},
        "elements": [
            el([0, 0, 0], [16, 16, 16], six),
            el([0, 0, 0], [16, 16, 16], six_e, light=15, shade=False),
        ],
    })


def decorative():
    for n in ("plaster_panel", "plaster_frame", "walnut_panel", "terracotta_tile", "oak_parquet"):
        cube_all(n)
    # walnut_trim: brass rail on the sides, plain walnut top/bottom
    model("walnut_trim", {"parent": "minecraft:block/cube_column",
                          "textures": {"side": t("walnut_trim"), "end": t("walnut_panel")}})
    BLOCKSTATES["walnut_trim"] = {"variants": {"": {"model": m("walnut_trim")}}}
    simple_item("walnut_trim")
    # glow panel: full emissive cube
    emissive_cube("glow_panel", "glow_panel", "glow_panel_emissive")
    BLOCKSTATES["glow_panel"] = {"variants": {"": {"model": m("glow_panel")}}}
    simple_item("glow_panel")
    # glow strip: brass channel with a glowing diffuser, lying on the floor face (facing=up)
    model("glow_strip", {
        "parent": "minecraft:block/block",
        "ambientocclusion": False,
        "textures": {"particle": t("glow_strip"), "strip": t("glow_strip")},
        "elements": [
            el([0, 0, 6], [16, 1, 10], {
                "down": face("#strip", [0, 0, 16, 4], cull="down"),
                "up": face("#strip", [0, 0, 16, 4]),
                "north": face("#strip", [0, 0, 16, 1]),
                "south": face("#strip", [0, 0, 16, 1]),
                "west": face("#strip", [0, 0, 4, 1], cull="west"),
                "east": face("#strip", [0, 0, 4, 1], cull="east"),
            }),
            el([0, 1, 6.5], [16, 2, 9.5], {
                "up": face("#strip", [0, 4, 16, 7]),
                "north": face("#strip", [0, 5, 16, 6]),
                "south": face("#strip", [0, 5, 16, 6]),
                "west": face("#strip", [0, 5, 3, 6], cull="west"),
                "east": face("#strip", [0, 5, 3, 6], cull="east"),
            }, light=15, shade=False),
        ],
        "display": {"gui": {"rotation": [30, 225, 0], "translation": [0, 3, 0], "scale": [0.625, 0.625, 0.625]}},
    })
    # facing = direction the lit face points (vanilla end_rod rotation table); axis = which way the
    # strip runs when it lies on a floor/ceiling (x or z, from the placer's horizontal facing).
    # On walls it always runs horizontally along the wall, so axis is ignored there.
    v = {}
    for axis in ("x", "z"):
        ay = 90 if axis == "z" else 0
        v[f"axis={axis},facing=up"] = {"model": m("glow_strip"), **({"y": ay} if ay else {})}
        v[f"axis={axis},facing=down"] = {"model": m("glow_strip"), "x": 180, **({"y": ay} if ay else {})}
        v[f"axis={axis},facing=north"] = {"model": m("glow_strip"), "x": 90}
        v[f"axis={axis},facing=south"] = {"model": m("glow_strip"), "x": 90, "y": 180}
        v[f"axis={axis},facing=east"] = {"model": m("glow_strip"), "x": 90, "y": 90}
        v[f"axis={axis},facing=west"] = {"model": m("glow_strip"), "x": 90, "y": 270}
    BLOCKSTATES["glow_strip"] = {"variants": v}
    simple_item("glow_strip")


# =========================================================================================
# Monitor + task board: connectable thin panels (multipart)
# =========================================================================================
def panel_models(prefix, z_front, depth_tex_uv_w, screen_variants, frame_tex, back_tex, side_tex, emissive_variants=()):
    """Builds <prefix>_panel_<variant>, edge and corner models for a panel whose screen faces
    north at z = z_front and whose back is flush with z = 16. Bezel/trim is 2 px wide, 1 px proud.
    Viewer's left (looking at the screen) is +X for the north-facing model."""
    zf, zb = z_front - 1, z_front
    names = {}
    for variant, (screen_tex, emissive) in screen_variants.items():
        faces = {
            "south": face("#back", cull="south"),
            "east": face("#side", [0, 0, depth_tex_uv_w, 16], cull="east"),
            "west": face("#side", [0, 0, depth_tex_uv_w, 16], cull="west"),
            "up": face("#side", [0, 0, 16, depth_tex_uv_w], cull="up"),
            "down": face("#side", [0, 0, 16, depth_tex_uv_w], cull="down"),
        }
        if emissive:
            # the whole screen glows: one emissive face, nothing coplanar behind it
            elements = [el([0, 0, z_front], [16, 16, 16], faces),
                        el([0, 0, z_front], [16, 16, z_front], {"north": face("#screen")}, light=15, shade=False)]
        else:
            elements = [el([0, 0, z_front], [16, 16, 16], {"north": face("#screen"), **faces})]
        names[variant] = model(f"{prefix}_panel_{variant}", {
            "parent": "minecraft:block/block",
            "textures": {"particle": t(back_tex), "screen": t(screen_tex), "back": t(back_tex), "side": t(side_tex)},
            "elements": elements,
        })
    tx = {"particle": t(frame_tex), "frame": t(frame_tex)}

    def bez(name, frm, to, uv_front, inner_dir, inner_uv):
        faces = {"north": face("#frame", uv_front)}
        # inner lip face (towards the screen) + outer faces in walnut/side region
        faces[inner_dir] = face("#frame", inner_uv)
        for d in ("up", "down", "east", "west"):
            if d not in faces:
                faces[d] = face("#frame", [8, 8, 9, 9])
        return model(f"{prefix}_{name}", {"parent": "minecraft:block/block", "textures": tx,
                                         "elements": [el(frm, to, faces)]})

    # straight edges (12 px long, between the corners)
    edges = {
        "left":   bez("edge_left",   [14, 2, zf], [16, 14, zb], [0, 2, 2, 14],  "west", [1, 2, 2, 14]),
        "right":  bez("edge_right",  [0, 2, zf],  [2, 14, zb],  [2, 2, 0, 14],  "east", [1, 2, 2, 14]),
        "up":     bez("edge_up",     [2, 14, zf], [14, 16, zb], [2, 0, 14, 2],  "down", [2, 1, 14, 2]),
        "down":   bez("edge_down",   [2, 0, zf],  [14, 2, zb],  [2, 2, 14, 0],  "up",   [2, 1, 14, 2]),
    }
    # corners: L = both edges open, h = horizontal edge continues, v = vertical edge continues
    corners = {}
    spec = {
        # corner: (from, to, uv_L, uv_h, uv_v, horizontal edge name, vertical edge name)
        "tl": ([14, 14, zf], [16, 16, zb], [4, 4, 6, 6], [4, 0, 6, 2], [0, 4, 2, 6], "up", "left"),
        "tr": ([0, 14, zf],  [2, 16, zb],  [6, 4, 4, 6], [4, 0, 6, 2], [2, 4, 0, 6], "up", "right"),
        "bl": ([14, 0, zf],  [16, 2, zb],  [4, 6, 6, 4], [4, 2, 6, 0], [0, 4, 2, 6], "down", "left"),
        "br": ([0, 0, zf],   [2, 2, zb],   [6, 6, 4, 4], [4, 2, 6, 0], [2, 4, 0, 6], "down", "right"),
    }
    # A corner piece that continues an edge (h: the horizontal edge runs on into the neighbour,
    # v: the vertical one does) has one face looking at the screen; it carries the brass lip like
    # the edges do, so the lip runs unbroken across block seams. L corners' inner faces are hidden.
    lip_dir = {"h": {"tl": "down", "tr": "down", "bl": "up", "br": "up"},
               "v": {"tl": "west", "bl": "west", "tr": "east", "br": "east"}}
    lip_uv = {"h": [4, 1, 6, 2], "v": [1, 4, 2, 6]}
    for c, (frm, to, uvL, uvh, uvv, he, ve) in spec.items():
        for kind, uv in (("L", uvL), ("h", uvh), ("v", uvv)):
            faces = {"north": face("#frame", uv)}
            for d in ("up", "down", "east", "west"):
                faces[d] = face("#frame", [8, 8, 9, 9])
            if kind in lip_dir:
                faces[lip_dir[kind][c]] = face("#frame", lip_uv[kind])
            # resource paths must be [a-z0-9_.-/]: an uppercase letter makes Minecraft drop the file
            # and fail every blockstate that names it
            corners[(c, kind)] = model(f"{prefix}_corner_{c}_{CORNER_NAME[kind]}", {
                "parent": "minecraft:block/block", "textures": tx, "elements": [el(frm, to, faces)]})
    return names, edges, corners, spec


CORNER_NAME = {"L": "outer", "h": "h", "v": "v"}


def connectable_blockstate(block, names, edges, corners, spec, variant_prop=None):
    parts = []
    for f, y in HORIZONTAL_Y.items():
        def apply(model_id):
            a = {"model": model_id}
            if y:
                a["y"] = y
            return a
        if variant_prop:
            prop, mapping = variant_prop
            for val, vname in mapping.items():
                if vname + "_glint" in names:
                    # one reflection per connected screen: the top-left block (no neighbour above
                    # or to the viewer's left) gets the glint, every other block plain glass
                    parts.append({"when": {"OR": [{"facing": f, prop: val, "up": "true"},
                                                  {"facing": f, prop: val, "left": "true"}]},
                                  "apply": apply(names[vname])})
                    parts.append({"when": {"facing": f, prop: val, "up": "false", "left": "false"},
                                  "apply": apply(names[vname + "_glint"])})
                else:
                    parts.append({"when": {"facing": f, prop: val}, "apply": apply(names[vname])})
        else:
            parts.append({"when": {"facing": f}, "apply": apply(names["default"])})
        for side, mid in edges.items():
            parts.append({"when": {"facing": f, side: "false"}, "apply": apply(mid)})
        for (c, kind), mid in corners.items():
            he, ve = spec[c][5], spec[c][6]
            cond = {"facing": f}
            if kind == "L":
                cond.update({he: "false", ve: "false"})
            elif kind == "h":
                cond.update({he: "false", ve: "true"})
            else:
                cond.update({he: "true", ve: "false"})
            parts.append({"when": cond, "apply": apply(mid)})
    BLOCKSTATES[block] = {"multipart": parts}


def inventory_model(name, part_names):
    """Merge several of our generated models' elements into one (for item rendering)."""
    elements, textures = [], {}
    for pn in part_names:
        key = pn.split("/")[-1]
        src = MODELS[key]
        prefix = key.replace("-", "_")
        remap = {}
        for k, v in src["textures"].items():
            nk = f"{prefix}_{k}"
            textures[nk] = v
            remap[f"#{k}"] = f"#{nk}"
        for e in src["elements"]:
            e2 = {**e, "faces": {d: {**fc, "texture": remap.get(fc["texture"], fc["texture"])}
                                 for d, fc in e["faces"].items()}}
            elements.append(e2)
    textures["particle"] = MODELS[part_names[0].split("/")[-1]]["textures"]["particle"]
    return model(name, {"parent": "minecraft:block/block", "textures": textures, "elements": elements})


def monitor():
    names, edges, corners, spec = panel_models(
        "monitor", 12, 4,
        {"off": ("monitor_screen_off", False), "off_glint": ("monitor_screen_off_glint", False),
         "on": ("monitor_screen_on", True)},
        "monitor_frame", "monitor_back", "monitor_side")
    connectable_blockstate("monitor", names, edges, corners, spec,
                           variant_prop=("lit", {"false": "off", "true": "on"}))
    inv = inventory_model("monitor_inventory",
                          [names["on"]] + list(edges.values()) +
                          [corners[(c, "L")] for c in ("tl", "tr", "bl", "br")])
    ITEMS["monitor"] = {"model": {"type": "minecraft:model", "model": inv}}


def task_board():
    names, edges, corners, spec = panel_models(
        "task_board", 14, 2,
        {"default": ("task_board_surface", False)},
        "task_board_frame", "task_board_back", "task_board_back")
    connectable_blockstate("task_board", names, edges, corners, spec)
    inv = inventory_model("task_board_inventory",
                          [names["default"]] + list(edges.values()) +
                          [corners[(c, "L")] for c in ("tl", "tr", "bl", "br")])
    ITEMS["task_board"] = {"model": {"type": "minecraft:model", "model": inv}}


# =========================================================================================
# Status lamp
# =========================================================================================
STATUSES = ["off", "idle", "thinking", "working", "waiting", "error", "done"]


def status_lamp():
    v = {}
    for s in STATUSES:
        six = {d: face("#side", cull=d) for d in ("north", "south", "west", "east")}
        six["up"] = face("#cap", cull="up")
        six["down"] = face("#cap", cull="down")
        elements = [el([0, 0, 0], [16, 16, 16], six)]
        tex = {"particle": t(f"status_lamp_{s}"), "side": t(f"status_lamp_{s}"), "cap": t("status_lamp_cap")}
        if s != "off":
            tex["glow"] = t(f"status_lamp_{s}_emissive")
            elements.append(el([0, 0, 0], [16, 16, 16],
                               {d: face("#glow", cull=d) for d in ("north", "south", "west", "east")},
                               light=15, shade=False))
        model(f"status_lamp_{s}", {"parent": "minecraft:block/block", "textures": tex, "elements": elements})
        v[f"status={s}"] = {"model": m(f"status_lamp_{s}")}
    BLOCKSTATES["status_lamp"] = {"variants": v}
    ITEMS["status_lamp"] = {"model": {"type": "minecraft:model", "model": m("status_lamp_working")}}


# =========================================================================================
# Memory archive + catalog, merge station (orientable cubes)
# =========================================================================================
def orientable(name, front, side, top, bottom=None, emissive_top=None, extra_variants=None):
    faces = {
        "north": face("#front", cull="north"), "south": face("#side", cull="south"),
        "east": face("#side", cull="east"), "west": face("#side", cull="west"),
        "up": face("#top", cull="up"), "down": face("#bottom", cull="down"),
    }
    tex = {"particle": t(side), "front": t(front), "side": t(side), "top": t(top), "bottom": t(bottom or top)}
    elements = [el([0, 0, 0], [16, 16, 16], faces)]
    if emissive_top:
        tex["glow"] = t(emissive_top)
        elements.append(el([0, 0, 0], [16, 16, 16], {"up": face("#glow", cull="up")}, light=15, shade=False))
    return model(name, {"parent": "minecraft:block/block", "textures": tex, "elements": elements})


def archive_blocks():
    orientable("memory_archive", "memory_archive_front", "memory_archive_side", "memory_archive_top")
    BLOCKSTATES["memory_archive"] = {"variants": horizontal_variants("memory_archive")}
    simple_item("memory_archive")
    orientable("memory_catalog", "memory_catalog_front", "memory_archive_side", "memory_archive_top")
    BLOCKSTATES["memory_catalog"] = {"variants": horizontal_variants("memory_catalog")}
    simple_item("memory_catalog")
    orientable("merge_station", "merge_station_front", "merge_station_side", "merge_station_top",
               bottom="memory_archive_top")
    orientable("merge_station_active", "merge_station_front", "merge_station_side", "merge_station_top",
               bottom="memory_archive_top", emissive_top="merge_station_top_emissive")
    v = {}
    for f, y in HORIZONTAL_Y.items():
        for active, mn in (("false", "merge_station"), ("true", "merge_station_active")):
            e = {"model": m(mn)}
            if y:
                e["y"] = y
            v[f"active={active},facing={f}"] = e
    BLOCKSTATES["merge_station"] = {"variants": v}
    simple_item("merge_station", "merge_station_active")


# =========================================================================================
# Console terminal: cabinet + keyboard deck + screen leaning back
# =========================================================================================
def console_terminal():
    tex = {"particle": t("console_side"), "side": t("console_side"), "front": t("console_front"),
           "top": t("console_top"), "screen": t("console_screen"), "back": t("monitor_back"),
           "frame": t("monitor_frame")}
    rot = {"origin": [8, 9, 11], "axis": "x", "angle": 22.5}
    elements = [
        # cabinet
        el([0, 0, 0], [16, 9, 16], {
            "north": face("#front", [0, 7, 16, 16], cull="north"),
            "south": face("#side", [0, 7, 16, 16], cull="south"),
            "east": face("#side", [0, 7, 16, 16], cull="east"),
            "west": face("#side", [0, 7, 16, 16], cull="west"),
            "up": face("#top"),
            "down": face("#side", cull="down"),
        }),
        # screen housing (walnut), leaning back 22.5 deg. Its front is built from geometry, not
        # stacked planes: a 1-px bezel ring (walnut outside, brass inside, brass inner lips) in
        # front, and the emissive screen recessed 0.5 px behind it. No two faces are coplanar,
        # so nothing can z-fight at any distance; the housing box itself has no north face.
        el([1, 9, 9.5], [15, 18, 13], {
            "south": face("#back", [1, 0, 15, 9]),
            "east": face("#side", [0, 0, 4, 9]),
            "west": face("#side", [0, 0, 4, 9]),
            "up": face("#side", [1, 0, 15, 4]),
            "down": face("#side", [1, 0, 15, 4]),
        }, rotation=rot),
        el([1, 17, 9], [15, 18, 9.5], {"north": face("#frame", [2, 0, 14, 2]), "up": face("#frame", [2, 0, 14, 1]),
                                      "down": face("#frame", [2, 1, 14, 2]),
                                      "east": face("#frame", [0, 0, 1, 1]), "west": face("#frame", [0, 0, 1, 1])},
           rotation=rot),
        el([1, 9, 9], [15, 10, 9.5], {"north": face("#frame", [2, 2, 14, 0]), "down": face("#frame", [2, 0, 14, 1]),
                                     "up": face("#frame", [2, 1, 14, 2]),
                                     "east": face("#frame", [0, 0, 1, 1]), "west": face("#frame", [0, 0, 1, 1])},
           rotation=rot),
        el([1, 10, 9], [2, 17, 9.5], {"north": face("#frame", [2, 2, 0, 14]), "west": face("#frame", [0, 2, 1, 14]),
                                     "east": face("#frame", [1, 2, 2, 14])}, rotation=rot),
        el([14, 10, 9], [15, 17, 9.5], {"north": face("#frame", [0, 2, 2, 14]), "east": face("#frame", [0, 2, 1, 14]),
                                       "west": face("#frame", [1, 2, 2, 14])}, rotation=rot),
        # the screen glass: one emissive face, 0.5 px behind the bezel
        el([2, 10, 9.5], [14, 17, 9.5], {"north": face("#screen", [2, 2, 14, 9])}, rotation=rot, light=15, shade=False),
    ]
    model("console_terminal", {"parent": "minecraft:block/block", "textures": tex, "elements": elements})
    BLOCKSTATES["console_terminal"] = {"variants": horizontal_variants("console_terminal")}
    simple_item("console_terminal")


# =========================================================================================
# Decision podium: plinth, fluted column with emblem, sloped desk, bell on a back ledge
# =========================================================================================
def decision_podium():
    for state in ("closed", "open"):
        lit = state == "open"
        tex = {"particle": t("decision_podium_base"), "base": t("decision_podium_base"),
               "column": t("decision_podium_column"),
               "front": t("decision_podium_front_lit" if lit else "decision_podium_front"),
               "top": t("decision_podium_top_lit" if lit else "decision_podium_top"),
               "wood": t("walnut_panel"), "bell": t("decision_podium_bell")}
        desk_rot = {"origin": [8, 11, 8], "axis": "x", "angle": -22.5}
        elements = [
            el([2, 0, 2], [14, 2, 14], {
                "north": face("#base", [2, 0, 14, 2]), "south": face("#base", [2, 0, 14, 2]),
                "east": face("#base", [2, 0, 14, 2]), "west": face("#base", [2, 0, 14, 2]),
                "up": face("#wood", [2, 2, 14, 14]), "down": face("#wood", [2, 2, 14, 14], cull="down"),
            }),
            el([4, 2, 4], [12, 11, 12], {
                "north": face("#front", [4, 2, 12, 11]), "south": face("#column", [4, 5, 12, 14]),
                "east": face("#column", [4, 5, 12, 14]), "west": face("#column", [4, 5, 12, 14]),
            }),
            el([0.5, 10, 1], [15.5, 13, 14], {
                "up": face("#top", [0.5, 1, 15.5, 14]),
                "north": face("#wood", [0, 0, 15, 3]), "south": face("#wood", [0, 0, 15, 3]),
                "east": face("#wood", [0, 0, 13, 3]), "west": face("#wood", [0, 0, 13, 3]),
                "down": face("#wood", [0, 0, 15, 13]),
            }, rotation=desk_rot),
            # back ledge for the bell
            el([2, 12, 12], [14, 15, 16], {
                "up": face("#wood", [2, 0, 14, 4]), "north": face("#base", [2, 0, 14, 3]),
                "south": face("#wood", [2, 0, 14, 3]), "east": face("#wood", [0, 0, 4, 3]),
                "west": face("#wood", [0, 0, 4, 3]),
            }),
            # desk bell: base, dome, button
            el([9, 15, 12.5], [13, 15.5, 15.5], {d: face("#wood", [0, 0, 4, 1]) for d in ("north", "south", "east", "west")}
               | {"up": face("#wood", [0, 0, 4, 3])}),
            el([9.5, 15.5, 13], [12.5, 17, 15], {
                "north": face("#bell", [0, 0, 3, 2]), "south": face("#bell", [10, 10, 13, 12]),
                "east": face("#bell", [8, 4, 10, 6]), "west": face("#bell", [0, 4, 2, 6]),
                "up": face("#bell", [2, 0, 5, 2]),
            }, light=15 if lit else None, shade=False if lit else None),
            el([10.5, 17, 13.5], [11.5, 17.75, 14.5], {d: face("#bell", [4, 4, 5, 5]) for d in ("north", "south", "east", "west", "up")}),
        ]
        if lit:
            elements.append(el([4, 2, 4], [12, 11, 12], {"north": face("#glow_front", [4, 2, 12, 11])},
                               light=15, shade=False))
            tex["glow_front"] = t("decision_podium_front_emissive")
            elements.append(el([0.5, 10, 1], [15.5, 13, 14], {"up": face("#glow_top", [0.5, 1, 15.5, 14])},
                               rotation=desk_rot, light=15, shade=False))
            tex["glow_top"] = t("decision_podium_top_emissive")
        model(f"decision_podium_{state}", {"parent": "minecraft:block/block", "textures": tex, "elements": elements})
    v = {}
    for f, y in HORIZONTAL_Y.items():
        for openv, mn in (("false", "decision_podium_closed"), ("true", "decision_podium_open")):
            e = {"model": m(mn)}
            if y:
                e["y"] = y
            v[f"facing={f},open={openv}"] = e
    BLOCKSTATES["decision_podium"] = {"variants": v}
    simple_item("decision_podium", "decision_podium_open")


# Block-state property domains: the contract the Java side declares. validate.py walks every
# combination and checks the blockstate resolves (variants: exactly one match; multipart: >= 1 part).
B = ("false", "true")
H4 = ("north", "east", "south", "west")
PROPERTY_DOMAINS = {
    "monitor": {"facing": H4, "lit": B, "up": B, "down": B, "left": B, "right": B},
    "task_board": {"facing": H4, "up": B, "down": B, "left": B, "right": B},
    "decision_podium": {"facing": H4, "open": B},
    "memory_archive": {"facing": H4},
    "memory_catalog": {"facing": H4},
    "merge_station": {"facing": H4, "active": B},
    "status_lamp": {"status": tuple(STATUSES)},
    "console_terminal": {"facing": H4},
    "glow_panel": {},
    "glow_strip": {"facing": ("up", "down") + H4, "axis": ("x", "z")},
    "plaster_panel": {}, "plaster_frame": {}, "walnut_panel": {}, "walnut_trim": {},
    "terracotta_tile": {}, "oak_parquet": {},
}

LANG = {
    "monitor": "Monitor", "task_board": "Task Board", "decision_podium": "Decision Podium",
    "memory_archive": "Memory Archive", "memory_catalog": "Memory Catalog",
    "merge_station": "Merge Station", "status_lamp": "Status Lamp", "console_terminal": "Console Terminal",
    "plaster_panel": "Plaster Panel", "plaster_frame": "Framed Plaster Panel", "walnut_panel": "Walnut Panel",
    "walnut_trim": "Walnut Brass Trim", "terracotta_tile": "Terracotta Tile", "oak_parquet": "Oak Parquet",
    "glow_panel": "Glow Panel", "glow_strip": "Glow Strip",
}


def build():
    decorative()
    monitor()
    task_board()
    status_lamp()
    archive_blocks()
    console_terminal()
    decision_podium()
    for name, data in MODELS.items():
        write_json(OUT / "models" / "block" / f"{name}.json", data)
    for name, data in BLOCKSTATES.items():
        write_json(OUT / "blockstates" / f"{name}.json", data)
    for name, data in ITEMS.items():
        write_json(OUT / "items" / f"{name}.json", data)
    lang = {f"block.{NS}.{k}": v for k, v in LANG.items()}
    lang.update({f"item.{NS}.{k}": v for k, v in LANG.items()})
    lang["itemGroup.agentcraft"] = "AgentCraft Studio"
    write_json(OUT / "lang" / "en_us.json", lang)
    assert set(BLOCKSTATES) == set(LANG), set(BLOCKSTATES) ^ set(LANG)
    assert set(PROPERTY_DOMAINS) == set(LANG), set(PROPERTY_DOMAINS) ^ set(LANG)
    assert set(ITEMS) == set(LANG), set(ITEMS) ^ set(LANG)
    print(f"{len(MODELS)} models, {len(BLOCKSTATES)} blockstates, {len(ITEMS)} items")
    return MODELS, BLOCKSTATES, ITEMS


if __name__ == "__main__":
    build()

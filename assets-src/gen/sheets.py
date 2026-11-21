"""Review renders + contact sheets (artifacts/art/**) and GUI portraits.

python gen/sheets.py [skins|cast|blocks|gui|portraits|all]
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from common import (
    ART,
    OUT,
    PALETTE,
    PROJECT,
    ROOT,
    ensure_dir,
    hex2rgba,
    mix,
    pc,
    save_png,
    scale_nearest,
)
from PIL import Image, ImageDraw, ImageFont

BLENDER = r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
VANILLA_ASSETS = PROJECT / "artifacts" / "art" / "_ref" / "vanilla_assets" / "minecraft"
CAST = json.load(open(ROOT / "cast.json", encoding="utf-8"))["agents"]

BG = pc("ui.inset")
BG2 = pc("ui.panel")
INK = pc("ui.text")
MUTED = pc("ui.text_muted")
BRASS = pc("colors.brass")
CLAY = pc("colors.clay")


def font(size, bold=False, serif=False):
    name = ("georgiab.ttf" if bold else "georgia.ttf") if serif else ("seguisb.ttf" if bold else "segoeui.ttf")
    try:
        return ImageFont.truetype(str(Path(r"C:\Windows\Fonts") / name), size)
    except OSError:
        return ImageFont.load_default()


def run_blender(script, jobs, tag):
    work = ensure_dir(ART / "_work")
    jp = work / f"{tag}_jobs.json"
    jp.write_text(json.dumps(jobs, indent=1), encoding="utf-8")
    logp = ensure_dir(PROJECT / "artifacts" / "logs") / f"blender_{tag}.log"
    with open(logp, "w", encoding="utf-8") as log:
        r = subprocess.run([BLENDER, "-b", "--factory-startup", "-P", str(ROOT / "blender" / script), "--", str(jp)],
                           stdout=log, stderr=subprocess.STDOUT)
    text = logp.read_text(encoding="utf-8", errors="replace")
    if r.returncode != 0 or "Traceback" in text:
        raise SystemExit(f"blender {tag} failed, see {logp}")
    return text.count("RENDERED")


def paper_canvas(w, h):
    img = Image.new("RGBA", (w, h), BG)
    return img


def title_block(img, title, subtitle):
    d = ImageDraw.Draw(img)
    d.text((40, 28), title, fill=INK, font=font(34, bold=True, serif=True))
    d.text((42, 74), subtitle, fill=MUTED, font=font(17))
    d.line([(40, 106), (img.width - 40, 106)], fill=BRASS, width=2)


# ======================================================================= portraits
def portraits():
    import portraits as _p  # shipped asset: lives in gen/portraits.py
    _p.build()


# ======================================================================= skins
def skin_renders(samples=96):
    rd = ensure_dir(ART / "agents")
    jobs = {"out_dir": str(rd), "size": [480, 720], "samples": samples, "ortho": 37.0,
            "jobs": [{"name": a["id"], "skin": str(OUT / "textures/entity/agent" / f"{a['id']}.png"),
                      "slim": a["model"] == "slim", "views": ["front", "right", "back", "threequarter", "hero"]}
                     for a in CAST] +
                    # the same skins under vanilla entity lighting: what they will look like in game
                    [{"name": f"{a['id']}_mc", "skin": str(OUT / "textures/entity/agent" / f"{a['id']}.png"),
                      "slim": a["model"] == "slim", "lighting": "mc_entity", "views": ["threequarter", "back"]}
                     for a in CAST]}
    n = run_blender("render_skins.py", jobs, "skins")
    print("skin renders:", n)
    return rd


def skins_turnaround(rd):
    views = ["front", "right", "back", "threequarter"]
    cw, ch = 240, 360
    label_w = 230
    W = 40 + label_w + len(views) * cw + 160 + 40
    H = 130 + len(CAST) * (ch + 16) + 30
    img = paper_canvas(W, H)
    title_block(img, "AgentCraft cast: skin turnaround",
                "64x64 player-format skins on the vanilla box model (Blender 5.2, ortho, nearest-neighbour). "
                "Front / right / back / three-quarter + flat texture.")
    d = ImageDraw.Draw(img)
    for vi, v in enumerate(views):
        d.text((40 + label_w + vi * cw + cw // 2 - 30, 116), v, fill=MUTED, font=font(15))
    y = 140
    for a in CAST:
        card = Image.new("RGBA", (W - 80, ch), BG2)
        img.alpha_composite(card, (40, y))
        d.rectangle([40, y, 46, y + ch - 1], fill=hex2rgba(a["color"]))
        d.text((62, y + 24), a["name"], fill=INK, font=font(28, bold=True, serif=True))
        d.text((62, y + 62), a["title"], fill=MUTED, font=font(16))
        d.text((62, y + 86), f"{a['role']} | {a['model']} arms", fill=MUTED, font=font(14))
        sw = hex2rgba(a["color"])
        d.rounded_rectangle([62, y + 116, 102, y + 136], 4, fill=sw)
        d.text((110, y + 116), a["color"], fill=INK, font=font(14))
        d.rounded_rectangle([62, y + 142, 102, y + 162], 4, fill=hex2rgba(a["accent"]), outline=pc("ui.paper_deep"))
        d.text((110, y + 142), f"accent {a['accent']}", fill=INK, font=font(14))
        fr = Image.open(OUT / "textures/gui/portrait" / f"{a['id']}_framed.png")
        img.alpha_composite(scale_nearest(fr, 4), (62, y + 180))
        for vi, v in enumerate(views):
            r = Image.open(rd / f"{a['id']}_{v}.png").resize((cw, ch), Image.LANCZOS)
            img.alpha_composite(r, (40 + label_w + vi * cw, y))
        skin = scale_nearest(Image.open(OUT / "textures/entity/agent" / f"{a['id']}.png"), 2)
        chk = Image.new("RGBA", skin.size, pc("ui.panel_edge"))
        chk.alpha_composite(skin)
        img.alpha_composite(chk, (40 + label_w + len(views) * cw + 16, y + (ch - 128) // 2))
        y += ch + 16
    save_png(img.convert("RGB").convert("RGBA"), ART / "skins_turnaround.png")
    print("->", ART / "skins_turnaround.png")


def _wrap(d, text, f, width):
    lines, cur = [], ""
    for wd in text.split():
        t = (cur + " " + wd).strip()
        if d.textlength(t, font=f) > width and cur:
            lines.append(cur)
            cur = wd
        else:
            cur = t
    lines.append(cur)
    return lines


def cast_sheet(rd):
    cw, ch = 300, 450
    f = font(13)
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    wrapped = {a["id"]: _wrap(probe, a["description"], f, cw - 36) for a in CAST}
    n_lines = max(len(v) for v in wrapped.values())        # card grows to fit; never truncate
    text_h = 64 + n_lines * 18 + 14
    card_h = ch + text_h + 40
    lineup_h = 370
    W = 40 + 6 * (cw + 20) + 20
    H = 126 + card_h + 30 + lineup_h + 30
    img = paper_canvas(W, H)
    title_block(img, "AgentCraft cast", "Lead + five workers. Identity colours sit in the blue-violet-magenta arc so they "
                "never read as a status colour (status is a separate dot/particle).")
    d = ImageDraw.Draw(img)
    x = 40
    for a in CAST:
        img.alpha_composite(Image.new("RGBA", (cw, card_h), BG2), (x, 126))
        d.rectangle([x, 126, x + cw - 1, 131], fill=hex2rgba(a["color"]))
        hero = Image.open(rd / f"{a['id']}_hero.png").resize((cw, ch), Image.LANCZOS)
        img.alpha_composite(hero, (x, 136))
        ty = 136 + ch - 10
        d.text((x + 18, ty), a["name"], fill=INK, font=font(26, bold=True, serif=True))
        d.text((x + 18, ty + 36), a["title"], fill=hex2rgba(a["text_on_light"]), font=font(16, bold=True))
        for i, ln in enumerate(wrapped[a["id"]]):
            d.text((x + 18, ty + 64 + i * 18), ln, fill=MUTED, font=f)
        sy = ty + text_h
        for i, hx in enumerate(a["ramp"]):
            d.rectangle([x + 18 + i * 26, sy, x + 40 + i * 26, sy + 16], fill=hex2rgba(hx))
        fr = Image.open(OUT / "textures/gui/portrait" / f"{a['id']}_framed.png")
        img.alpha_composite(scale_nearest(fr, 3), (x + cw - 78, ty + 4))
        x += cw + 20
    # lineup under vanilla entity lighting, on a mid-tone studio wall, at two distances
    y = 126 + card_h + 30
    d.text((40, y), "In-game lighting check: exact vanilla entity shading (min(1, 0.4 + 0.6 x two lights), "
           "sRGB), three-quarter and back, then at roughly 12 and 4 blocks away", fill=INK, font=font(17, bold=True))
    wall = mix(pc("ramps.plaster[3]"), pc("ramps.walnut[1]"), 0.35)
    band = Image.new("RGBA", (W - 80, lineup_h - 40), wall)
    img.alpha_composite(band, (40, y + 30))
    bx = 60
    for a in CAST:
        for v in ("threequarter", "back"):
            r = Image.open(rd / f"{a['id']}_mc_{v}.png")
            r = r.resize((int(r.width * 300 / r.height), 300), Image.LANCZOS)
            img.alpha_composite(r, (bx - 44, y + 52))
            bx += 122
    sx = W - 40 - 6 * 46 - 60
    for k, hgt in ((0, 96), (1, 34)):
        for i, a in enumerate(CAST):
            r = Image.open(rd / f"{a['id']}_mc_threequarter.png")
            r = r.resize((int(r.width * hgt / r.height), hgt), Image.LANCZOS)
            img.alpha_composite(r, (sx + i * 46, y + 60 + k * 150))
    save_png(img, ART / "cast_sheet.png")
    print("->", ART / "cast_sheet.png")


# ======================================================================= blocks
OURS = [
    # (render name, entry, flat textures to show, label, note)
    ("monitor_on", {"block": "agentcraft:monitor", "props": {"facing": "north", "lit": "true", "up": "false", "down": "false", "left": "false", "right": "false"}},
     ["monitor_screen_on", "monitor_frame", "monitor_back"], "Monitor (on)", "connectable panel, emissive screen"),
    ("monitor_off", {"block": "agentcraft:monitor", "props": {"facing": "north", "lit": "false", "up": "false", "down": "false", "left": "false", "right": "false"}},
     ["monitor_screen_off", "monitor_screen_off_glint", "monitor_side"], "Monitor (off)", "smoked glass, one glint per pane"),
    ("task_board", {"block": "agentcraft:task_board", "props": {"facing": "north", "up": "false", "down": "false", "left": "false", "right": "false"}},
     ["task_board_surface", "task_board_frame"], "Task Board", "walnut pinboard, brass trim, connectable"),
    ("decision_podium_open", {"block": "agentcraft:decision_podium", "props": {"facing": "north", "open": "true"}},
     ["decision_podium_front_lit", "decision_podium_top_lit", "decision_podium_column"], "Decision Podium (open)", "desk glows, bell + lens lit"),
    ("decision_podium_closed", {"block": "agentcraft:decision_podium", "props": {"facing": "north", "open": "false"}},
     ["decision_podium_front", "decision_podium_top"], "Decision Podium (closed)", ""),
    ("memory_archive", {"block": "agentcraft:memory_archive", "props": {"facing": "north"}},
     ["memory_archive_front", "memory_archive_side", "memory_archive_top"], "Memory Archive", "shelf: books + archive boxes"),
    ("memory_catalog", {"block": "agentcraft:memory_catalog", "props": {"facing": "north"}},
     ["memory_catalog_front"], "Memory Catalog", "card-index drawers"),
    ("merge_station_active", {"block": "agentcraft:merge_station", "props": {"facing": "north", "active": "true"}},
     ["merge_station_top", "merge_station_front", "merge_station_side"], "Merge Station (active)", "brass merge inlay glows"),
    ("console_terminal", {"block": "agentcraft:console_terminal", "props": {"facing": "north"}},
     ["console_screen", "console_top", "console_front"], "Console Terminal", "keyboard deck + leaning screen"),
    ("glow_panel", {"block": "agentcraft:glow_panel", "props": {}}, ["glow_panel"], "Glow Panel", "ceiling light, emissive panes"),
    ("glow_strip", {"block": "agentcraft:glow_strip", "props": {"facing": "up", "axis": "x"}}, ["glow_strip"], "Glow Strip", "brass channel + diffuser"),
    ("plaster_panel", {"block": "agentcraft:plaster_panel", "props": {}}, ["plaster_panel"], "Plaster Panel", "warm calcite-like wall"),
    ("plaster_frame", {"block": "agentcraft:plaster_frame", "props": {}}, ["plaster_frame"], "Framed Plaster", "wall articulation"),
    ("walnut_panel", {"block": "agentcraft:walnut_panel", "props": {}}, ["walnut_panel"], "Walnut Panel", "dark-oak companion"),
    ("walnut_trim", {"block": "agentcraft:walnut_trim", "props": {}}, ["walnut_trim"], "Walnut Brass Trim", "wainscot cap rail"),
    ("terracotta_tile", {"block": "agentcraft:terracotta_tile", "props": {}}, ["terracotta_tile"], "Terracotta Tile", "clay floor/wall tile"),
    ("oak_parquet", {"block": "agentcraft:oak_parquet", "props": {}}, ["oak_parquet"], "Oak Parquet", "stripped-oak basketweave"),
]
LAMPS = ["off", "idle", "thinking", "working", "waiting", "error", "done"]
VANILLA_REFS = [
    ("v_calcite", "cube_all", {"all": "minecraft:block/calcite"}, "calcite"),
    ("v_white_concrete", "cube_all", {"all": "minecraft:block/white_concrete"}, "white_concrete"),
    ("v_stripped_oak", "cube_column", {"side": "minecraft:block/stripped_oak_log", "end": "minecraft:block/stripped_oak_log_top"}, "stripped_oak_log"),
    ("v_birch_planks", "cube_all", {"all": "minecraft:block/birch_planks"}, "birch_planks"),
    ("v_dark_oak_planks", "cube_all", {"all": "minecraft:block/dark_oak_planks"}, "dark_oak_planks"),
    ("v_cut_copper", "cube_all", {"all": "minecraft:block/cut_copper"}, "cut_copper"),
    ("v_terracotta", "cube_all", {"all": "minecraft:block/terracotta"}, "terracotta"),
    ("v_bookshelf", "cube_column", {"side": "minecraft:block/bookshelf", "end": "minecraft:block/oak_planks"}, "bookshelf"),
]


def _inline(parent, textures):
    return {"parent": f"minecraft:block/{parent}", "textures": textures}


def vignette_blocks():
    """A small studio corner mixing our blocks with vanilla materials (MC coords x east, y up, z south)."""
    B = []

    def add(pos, block=None, props=None, inline=None):
        e = {"pos": list(pos)}
        if block:
            e["block"] = block
            e["props"] = props or {}
        else:
            e["inline"] = inline
        B.append(e)

    def V(parent, **tx):
        return _inline(parent, {k: f"minecraft:block/{v}" for k, v in tx.items()})
    # floor
    for x in range(10):
        for z in range(7):
            if x >= 7:
                add((x, 0, z), inline=V("cube_all", all="birch_planks"))
            elif z <= 1:
                add((x, 0, z), "agentcraft:terracotta_tile")
            else:
                add((x, 0, z), "agentcraft:oak_parquet")
    # south wall (z=7) facing the camera; east wall (x=10)
    for x in range(-0, 10):
        add((x, 1, 7), "agentcraft:walnut_panel")
        add((x, 2, 7), "agentcraft:walnut_trim")
        for y in (3, 4, 5):
            if x in (0, 9):
                add((x, y, 7), inline=V("cube_column", side="stripped_oak_log", end="stripped_oak_log_top"))
            elif x == 6:
                add((x, y, 7), inline=V("cube_all", all="calcite"))
            else:
                add((x, y, 7), "agentcraft:plaster_frame" if y == 5 else "agentcraft:plaster_panel")
    for z in range(7):
        add((10, 1, z), "agentcraft:walnut_panel")
        add((10, 2, z), "agentcraft:walnut_trim")
        for y in (3, 4, 5):
            add((10, y, z), inline=V("cube_all", all="white_concrete") if z == 3 else None, block=None if z == 3 else "agentcraft:plaster_panel")
    # desk with 2 connected monitors + console
    for x in (1, 2, 3):
        add((x, 1, 6), inline=V("cube_column", side="stripped_dark_oak_log", end="stripped_dark_oak_log_top"))
    add((3, 2, 6), "agentcraft:monitor", {"facing": "north", "lit": "true", "up": "false", "down": "false", "left": "false", "right": "true"})
    add((2, 2, 6), "agentcraft:monitor", {"facing": "north", "lit": "true", "up": "false", "down": "false", "left": "true", "right": "true"})
    add((1, 2, 6), "agentcraft:monitor", {"facing": "north", "lit": "true", "up": "false", "down": "false", "left": "true", "right": "false"})
    add((1, 2, 5), "agentcraft:console_terminal", {"facing": "north"})
    # an unlit 2x2 wall screen on the east wall (faces west; viewer's left = north): one pane,
    # one reflection - the glint sits only on the top-left block
    for y, u, dn in ((4, "false", "true"), (3, "true", "false")):
        for z, l, r in ((4, "false", "true"), (5, "true", "false")):
            add((9, y, z), "agentcraft:monitor", {"facing": "west", "lit": "false", "up": u, "down": dn,
                                                 "left": l, "right": r})
    # task board 3x2 on the wall
    for x, l, r in ((5, "false", "true"), (4, "true", "false")):
        for y, u, dn in ((4, "false", "true"), (3, "true", "false")):
            add((x, y, 6), "agentcraft:task_board", {"facing": "north", "up": u, "down": dn, "left": l, "right": r})
    # CI lamps on the wall trim
    for i, s in enumerate(["working", "thinking", "waiting", "done", "error", "idle"]):
        add((7 + (i % 2), 3 + i // 2, 6), "agentcraft:status_lamp", {"status": s})
    # library along the east wall (facing west)
    for z in (1, 2):
        add((9, 1, z), "agentcraft:memory_archive", {"facing": "west"})
        add((9, 2, z), "agentcraft:memory_catalog" if z == 1 else "agentcraft:memory_archive", {"facing": "west"})
    add((9, 1, 3), inline=V("cube_column", side="bookshelf", end="oak_planks"))
    add((9, 2, 3), inline=V("cube_column", side="bookshelf", end="oak_planks"))
    add((9, 1, 0), inline=V("cube_all", all="cut_copper"))
    add((9, 2, 0), inline=V("cube_all", all="cut_copper"))
    # podium + merge station
    add((5, 1, 2), "agentcraft:decision_podium", {"facing": "north", "open": "true"})
    add((7, 1, 4), "agentcraft:merge_station", {"facing": "north", "active": "true"})
    add((3, 1, 2), "agentcraft:glow_strip", {"facing": "up", "axis": "z"})
    add((0, 1, 3), "agentcraft:glow_panel")
    add((0, 1, 1), inline=V("cube_all", all="moss_block"))
    return B


def block_renders(samples=64):
    rd = ensure_dir(ART / "blocks")
    blocks = [{"name": n, **e} for n, e, *_ in OURS]
    blocks += [{"name": f"status_lamp_{s}", "block": "agentcraft:status_lamp", "props": {"status": s}} for s in LAMPS]
    blocks += [{"name": n, "inline": _inline(p, tx)} for n, p, tx, _ in VANILLA_REFS]
    jobs = {"out_dir": str(rd), "size": [256, 256], "samples": samples,
            "roots": {"agentcraft": str(OUT), "minecraft": str(VANILLA_ASSETS)},
            "blocks": blocks,
            "scenes": [
                {"name": "vignette_day", "size": [1600, 1000], "ortho": 228.0, "az": 215, "el": 30,
                 "target": [0, 8, 56], "blocks": vignette_blocks()},
                {"name": "vignette_night", "size": [1600, 1000], "ortho": 228.0, "az": 215, "el": 30,
                 "target": [0, 8, 56], "night": True, "blocks": vignette_blocks()},
            ]}
    # camera target: MC block centre of the scene -> Blender coords (x-8, 8-z, y) in px
    cx, cz = 5 * 16, 3.5 * 16
    for sc in jobs["scenes"]:
        sc["target"] = [cx - 8, 8 - cz, 46]
    n = run_blender("render_blocks.py", jobs, "blocks")
    print("block renders:", n)
    return rd


def blocks_sheet(rd):
    k = 8
    card_w, card_h = 760, 240
    cols = 2
    rows = (len(OURS) + cols - 1) // cols
    lamp_h = 300
    ref_h = 330
    W = 40 + cols * (card_w + 20) + 20
    vig_w = W - 80
    vig_h = int(vig_w * 1000 / 1600)
    H = 126 + rows * (card_h + 16) + 10 + lamp_h + ref_h + 34 + 2 * vig_h + 20 + 40
    img = paper_canvas(W, H)
    title_block(img, "AgentCraft blocks", "16x16 textures at 8x beside Blender renders of the actual block models "
                "(multipart/blockstates resolved). Bottom: vanilla neighbours and a studio vignette mixing both.")
    d = ImageDraw.Draw(img)
    y0 = 126
    for i, (name, entry, flats, label, note) in enumerate(OURS):
        cx = 40 + (i % cols) * (card_w + 20)
        cy = y0 + (i // cols) * (card_h + 16)
        img.alpha_composite(Image.new("RGBA", (card_w, card_h), BG2), (cx, cy))
        r = Image.open(rd / f"{name}.png").resize((220, 220), Image.LANCZOS)
        img.alpha_composite(r, (cx + 6, cy + 10))
        fx = cx + 236
        for f in flats[:3]:
            t = scale_nearest(Image.open(OUT / "textures/block" / f"{f}.png").convert("RGBA"), k)
            img.alpha_composite(t, (fx, cy + 34))
            d.text((fx, cy + 34 + 130), f, fill=MUTED, font=font(11))
            fx += 128 + 10
        d.text((cx + 236, cy + 8), label, fill=INK, font=font(17, bold=True))
        if note:
            d.text((cx + 236 + d.textlength(label, font=font(17, bold=True)) + 12, cy + 11), note, fill=MUTED, font=font(13))
    y = y0 + rows * (card_h + 16) + 10
    d.text((40, y), "Status lamp states", fill=INK, font=font(20, bold=True, serif=True))
    for i, s in enumerate(LAMPS):
        r = Image.open(rd / f"status_lamp_{s}.png").resize((180, 180), Image.LANCZOS)
        x = 40 + i * 214
        img.alpha_composite(r, (x, y + 34))
        t = scale_nearest(Image.open(OUT / "textures/block" / f"status_lamp_{s}.png").convert("RGBA"), 4)
        img.alpha_composite(t, (x + 140, y + 34 + 180 - 64))
        d.text((x + 10, y + 34 + 186), s, fill=INK, font=font(14, bold=True))
        col = PALETTE["status"].get(s, "unlit smoked glass")
        d.text((x + 10, y + 34 + 206), col, fill=MUTED, font=font(12))
    y += lamp_h
    d.text((40, y), "Vanilla neighbours (reference)", fill=INK, font=font(20, bold=True, serif=True))
    for i, (n, p, tx, label) in enumerate(VANILLA_REFS):
        r = Image.open(rd / f"{n}.png").resize((160, 160), Image.LANCZOS)
        x = 40 + i * 182
        img.alpha_composite(r, (x, y + 34))
        tname = list(tx.values())[0].split("/")[-1]
        t = scale_nearest(Image.open(VANILLA_ASSETS / "textures/block" / f"{tname}.png").convert("RGBA").crop((0, 0, 16, 16)), 6)
        img.alpha_composite(t, (x + 30, y + 200))
        d.text((x + 10, y + 300), label, fill=MUTED, font=font(12))
    y += ref_h
    d.text((40, y), "Studio vignette: our blocks among vanilla calcite, white concrete, stripped oak, birch, "
           "cut copper, bookshelf, moss (day / night emissive)", fill=INK, font=font(17, bold=True))
    vd = Image.open(rd / "vignette_day.png").resize((vig_w, vig_h), Image.LANCZOS)
    vn = Image.open(rd / "vignette_night.png").resize((vig_w, vig_h), Image.LANCZOS)
    bgd = Image.new("RGBA", vd.size, mix(pc("ui.inset"), pc("ui.panel_edge"), 0.4))
    bgd.alpha_composite(vd)
    bgn = Image.new("RGBA", vn.size, pc("ramps.screen_off[3]"))
    bgn.alpha_composite(vn)
    img.alpha_composite(bgd, (40, y + 34))
    img.alpha_composite(bgn, (40, y + 34 + vig_h + 20))
    save_png(img, ART / "blocks_sheet.png")
    print("->", ART / "blocks_sheet.png")


def main(what):
    import extract_ref
    extract_ref.ensure()          # vanilla reference textures + font from Loom's cached client jar
    if what in ("portraits", "skins", "cast", "all"):
        portraits()
    if what in ("skins", "cast", "all"):
        rd = skin_renders()
        skins_turnaround(rd)
        cast_sheet(rd)
    if what in ("blocks", "all"):
        rd = block_renders()
        blocks_sheet(rd)
    if what in ("gui", "all"):
        import gui_sheet
        gui_sheet.build()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "all")

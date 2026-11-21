"""AgentCraft GUI kit: 9-slice-friendly sprites for the vanilla GUI sprite atlas.

Output: out/assets/agentcraft/textures/gui/sprites/kit/<name>.png (+ .png.mcmeta with
vanilla "gui.scaling" nine_slice metadata for the stretchable ones) so the mod can draw them with
the 26.3 (Mojang-named) API
    graphics.blitSprite(RenderPipelines.GUI_TEXTURED,
                        Identifier.fromNamespaceAndPath("agentcraft", "kit/<name>"), x, y, w, h)
(graphics = net.minecraft.client.gui.GuiGraphicsExtractor) and get correct 9-slice scaling for free. A full manifest (sizes, insets, content padding,
text colours) is written to out/assets/agentcraft/gui/kit.json.

python gen/gui.py
"""
from __future__ import annotations

import math

from common import OUT, PALETTE, hex2rgba, mix, pal_hex, pc, save_png, write_json
from tex import CLEAR, from_grid, new

H = hex2rgba
SPRITES = {}   # name -> (img, meta)

# ---- UI tones
CREAM, CREAM_HI, PAPER, PAPER_SH, PAPER_DK, PAPER_DEEP = (pc("ui.panel"), pc("ui.panel_hi"), pc("ui.inset"),
                                                          pc("ui.panel_shade"), pc("ui.panel_edge"), pc("ui.paper_deep"))
EDGE = pc("ui.edge")
RIM = pc("ui.control_rim")
WHITE = pc("colors.white")
INK, INK2, INK3 = pc("ramps.ink[2]"), pc("ramps.ink[1]"), pc("ramps.ink[0]")
# text colours recorded in the manifest (hex strings, all from the palette)
T_INK, T_INK2, T_MUTED = pal_hex("ui.text"), pal_hex("ramps.ink[1]"), pal_hex("ui.text_muted")
T_CREAM, T_HI, T_DISABLED = pal_hex("ui.panel"), pal_hex("ui.panel_hi"), pal_hex("ramps.stone[2]")
BR = [H(c) for c in PALETTE["ramps"]["brass"]["tones"]]   # 0 hi .. 4 deep
CL = [H(c) for c in PALETTE["ramps"]["clay"]["tones"]]
WAL = pc("colors.walnut")


def shadow(a):
    return (31, 30, 29, a)


def reg(name, img, slice_=None, padding=None, note="", scaling="nine_slice", text=None):
    meta = {"size": list(img.size), "note": note}
    if slice_:
        l, t, r, b = slice_
        meta["slice"] = {"left": l, "top": t, "right": r, "bottom": b}
        meta["scaling"] = scaling
    if padding:
        meta["content_padding"] = {"left": padding[0], "top": padding[1], "right": padding[2], "bottom": padding[3]}
    if text:
        meta["text_color"] = text
    SPRITES[name] = (img, meta)
    return img


def rounded_box(w, h, *, border, fill, hi=None, lo=None, radius=1, corner_fill=None):
    """Box with 1px border, rounded corners (radius 1 or 2), top highlight row, bottom shade row."""
    img = new(w, h)
    px = img.load()
    for y in range(h):
        for x in range(w):
            edge = x in (0, w - 1) or y in (0, h - 1)
            c = border if edge else fill
            if not edge:
                if hi is not None and y == 1:
                    c = hi
                if lo is not None and y == h - 2:
                    c = lo
            px[x, y] = c
    # round corners
    for (cx, cy, dx, dy) in ((0, 0, 1, 1), (w - 1, 0, -1, 1), (0, h - 1, 1, -1), (w - 1, h - 1, -1, -1)):
        px[cx, cy] = CLEAR
        if radius >= 2:
            px[cx + dx, cy] = CLEAR
            px[cx, cy + dy] = CLEAR
            px[cx + dx, cy + dy] = border
    return img


def with_drop_shadow(img, rows=2, alphas=(70, 30)):
    """Extend the image downward by `rows` px of soft ink shadow (inside the sprite bounds)."""
    w, h = img.size
    out = new(w, h + rows)
    out.paste(img, (0, 0))
    px = out.load()
    for i in range(rows):
        y = h + i
        for x in range(1 + i, w - 1 - i):
            px[x, y] = shadow(alphas[i])
    return out


# ============================================================== panels & frames
def panels():
    body = rounded_box(32, 30, border=EDGE, fill=CREAM, hi=CREAM_HI, lo=PAPER, radius=2)
    reg("panel_paper", with_drop_shadow(body), (6, 6, 6, 8), (8, 8, 8, 9),
        "Matte paper panel, soft drop shadow. Main window background.", text=T_INK)

    inset = new(16, 16)
    px = inset.load()
    for y in range(16):
        for x in range(16):
            c = PAPER
            if y == 0 or x == 0:
                c = PAPER_DEEP
            elif y == 1 or x == 1:
                c = PAPER_DK
            elif y == 15 or x == 15:
                c = CREAM_HI
            px[x, y] = c
    for (x, y) in ((0, 0), (15, 0), (0, 15), (15, 15)):
        px[x, y] = CLEAR
    reg("panel_inset", inset, (3, 3, 3, 3), (4, 4, 4, 4), "Recessed well for logs, lists, diff bodies.", text=T_INK)

    # brass frame: deep edge, lit brass (top/left) / brass (bottom/right), dark inner line, paper
    w, h = 32, 30
    fr = new(w, h)
    px = fr.load()
    for y in range(h):
        for x in range(w):
            d = min(x, y, w - 1 - x, h - 1 - y)
            if d == 0:
                c = BR[4]
            elif d == 1:
                c = BR[1] if (x == 1 or y == 1) and x < w - 2 and y < h - 2 else BR[2]
            elif d == 2:
                c = BR[3]
            elif d == 3:
                c = CREAM_HI if y == 3 else CREAM
            else:
                c = CREAM
            px[x, y] = c
    for (cx, cy) in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        px[cx, cy] = CLEAR
    reg("frame_brass", with_drop_shadow(fr), (6, 6, 6, 8), (8, 8, 8, 9),
        "Brass-bordered frame for dialogs that need attention (decisions, merges).", text=T_INK)

    # header strip for frames/panels (title bar), clay accent underline
    hd = new(16, 14)
    px = hd.load()
    for y in range(14):
        for x in range(16):
            c = PAPER if y < 11 else (CL[1] if y == 11 else (CL[2] if y == 12 else CLEAR))
            if y == 0:
                c = PAPER_SH
            px[x, y] = c
    reg("header", hd, (2, 2, 2, 3), (6, 2, 6, 4), "Title strip with clay underline; place at the top inside a panel.", text=T_INK)


# ============================================================== buttons & tabs
def button_family(prefix, face, hi, sh, lip1, lip2, border, hover_border, text, text_disabled, disabled):
    w, h = 32, 20

    def make(face_c, hi_c, sh_c, lip_a, lip_b, border_c, pressed=False):
        img = new(w, h)
        px = img.load()
        for y in range(h):
            for x in range(w):
                edge_x = x in (0, w - 1)
                if y == 0 or y == h - 1 or edge_x:
                    c = border_c
                elif pressed:
                    c = sh_c if y in (1, 2) else face_c
                else:
                    if y == 1:
                        c = hi_c
                    elif y <= 15:
                        c = face_c
                    elif y == 16:
                        c = sh_c
                    elif y == 17:
                        c = lip_a
                    else:
                        c = lip_b
                px[x, y] = c
        for (cx, cy) in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
            px[cx, cy] = CLEAR
        return img

    reg(f"{prefix}", make(face, hi, sh, lip1, lip2, border), (4, 3, 4, 5), (6, 5, 6, 6),
        f"{prefix}: normal", text=text)
    reg(f"{prefix}_hover", make(mix(face, WHITE, 0.25), WHITE, sh, lip1, lip2, hover_border),
        (4, 3, 4, 5), (6, 5, 6, 6), f"{prefix}: hover (brass outline)", text=text)
    reg(f"{prefix}_pressed", make(sh, sh, lip1, lip1, lip1, border, pressed=True), (4, 4, 4, 4), (6, 7, 6, 4),
        f"{prefix}: pressed (face drops 2px; offset label by +2y)", text=text)
    dface, dborder = disabled
    reg(f"{prefix}_disabled", make(dface, dface, dface, mix(dface, dborder, 0.4), mix(dface, dborder, 0.6), dborder),
        (4, 3, 4, 5), (6, 5, 6, 6), f"{prefix}: disabled", text=text_disabled)


def buttons_tabs():
    button_family("button", CREAM, CREAM_HI, PAPER_SH, PAPER_DK, EDGE, RIM, BR[2],
                  T_INK, T_DISABLED, (PAPER, PAPER_DK))
    button_family("button_primary", CL[1], CL[0], pc("ui.primary_shade"), CL[2], CL[3], pc("ui.primary_rim"), BR[2],
                  T_HI, T_CREAM, (pc("ui.primary_disabled"), pc("ui.primary_disabled_rim")))
    # tabs
    w, h = 32, 20
    act = new(w, h)
    px = act.load()
    for y in range(h):
        for x in range(w):
            if x in (0, w - 1) or y == 0:
                c = EDGE
            elif y in (1, 2):
                c = CL[1] if y == 1 else CL[2]
            elif y == 3:
                c = CREAM_HI
            else:
                c = CREAM
            px[x, y] = c
    px[0, 0] = CLEAR
    px[w - 1, 0] = CLEAR
    reg("tab_active", act, (4, 4, 4, 2), (6, 6, 6, 3), "Active tab: clay cap, opens into the panel below.", text=T_INK)
    ina = new(w, h)
    px = ina.load()
    for y in range(h):
        for x in range(w):
            if y < 2:
                c = CLEAR
            elif x in (0, w - 1) or y == 2 or y == h - 1:
                c = EDGE
            elif y == 3:
                c = PAPER
            else:
                c = PAPER_SH
            px[x, y] = c
    px[0, 2] = CLEAR
    px[w - 1, 2] = CLEAR
    reg("tab_inactive", ina, (4, 4, 4, 2), (6, 7, 6, 3), "Inactive tab: sits 2px lower, darker paper.", text=T_MUTED)


# ============================================================== fields, scrollbars, tooltip
def fields():
    for name, border, inner in (("text_field", PAPER_DEEP, PAPER_SH), ("text_field_focused", CL[1], pc("ui.field_focus"))):
        img = new(16, 16)
        px = img.load()
        for y in range(16):
            for x in range(16):
                if x in (0, 15) or y in (0, 15):
                    c = border
                elif y == 1 or x == 1 or (name.endswith("focused") and (x == 14 or y == 14)):
                    c = inner
                else:
                    c = CREAM_HI
                px[x, y] = c
        for (x, y) in ((0, 0), (15, 0), (0, 15), (15, 15)):
            px[x, y] = CLEAR
        reg(name, img, (3, 3, 3, 3), (5, 4, 5, 3), "Single-line input (console). Caret: ink 1px, blink 500ms.", text=T_INK)

    track = new(6, 16)
    px = track.load()
    for y in range(16):
        for x in range(6):
            c = PAPER_SH
            if x == 0 or y == 0:
                c = PAPER_DK
            if x == 5 or y == 15:
                c = PAPER
            px[x, y] = c
    for (x, y) in ((0, 0), (5, 0), (0, 15), (5, 15)):
        px[x, y] = CLEAR
    reg("scroll_track", track, (2, 3, 2, 3), None, "Vertical scrollbar track (6px wide).")
    # thumb: plain 9-slice body (nothing in the tiled centre, so any height is clean) + a separate
    # grip sprite the renderer centres on the thumb.
    for name, body, hi, rim in (("scroll_thumb", pc("ui.thumb"), PAPER_SH, RIM),
                                ("scroll_thumb_hover", BR[2], BR[1], BR[3])):
        th = new(6, 16)
        px = th.load()
        for y in range(16):
            for x in range(6):
                c = body
                if x in (0, 5) or y in (0, 15):
                    c = rim
                elif x == 1 or y == 1:
                    c = hi
                px[x, y] = c
        for (x, y) in ((0, 0), (5, 0), (0, 15), (5, 15)):
            px[x, y] = CLEAR
        reg(name, th, (2, 3, 2, 3), None, "Scrollbar thumb body (any height); draw scroll_grip centred on it.")
    grip = from_grid(["rr", "..", "rr"], {"r": RIM, ".": None})
    reg("scroll_grip", grip, None, None, "Grip lines for the scrollbar thumb: draw at the thumb's centre "
        "(x + 2, y + h/2 - 1); skip when the thumb is under 10 px tall.")

    tip = new(16, 16)
    px = tip.load()
    for y in range(16):
        for x in range(16):
            c = pc("ui.tooltip", 244)
            if x in (0, 15) or y in (0, 15):
                c = INK3
            elif y == 1:
                c = BR[2]
            px[x, y] = c
    for (x, y) in ((0, 0), (15, 0), (0, 15), (15, 15)):
        px[x, y] = CLEAR
    reg("tooltip", tip, (4, 4, 4, 4), (5, 5, 5, 4), "Dark ink tooltip with a brass top rule. Text cream (ui.panel).", text=T_CREAM)

    plate = new(16, 12)
    px = plate.load()
    for y in range(12):
        for x in range(16):
            px[x, y] = pc("ui.nameplate")
    for (x, y) in ((0, 0), (15, 0), (0, 11), (15, 11)):
        px[x, y] = CLEAR
    reg("nameplate", plate, (3, 3, 3, 3), (4, 2, 4, 1), "In-world nameplate pill (translucent ink, alpha 220 so names keep >= 4.5:1 even over a bright wall).", text=T_CREAM)


# ============================================================== status dots
DOT = ["..xxx..", ".xxxxx.", "xxxxxxx", "xxxxxxx", "xxxxxxx", ".xxxxx.", "..xxx.."]
STATUS_KEYS = ["idle", "thinking", "working", "waiting", "error", "done"]


def dots():
    for s in STATUS_KEYS:
        r = [H(c) for c in PALETTE["status_ramps"][s]]
        img = new(7, 7)
        px = img.load()
        for y, row in enumerate(DOT):
            for x, ch in enumerate(row):
                if ch != "x":
                    continue
                edge = (y in (0, 6)) or (x in (0, 6)) or (y in (1, 5) and x in (1, 5))
                c = r[2] if edge else r[1]
                px[x, y] = c
        px[2, 2] = r[0]
        px[3, 2] = mix(r[0], r[1], 0.5)
        px[2, 3] = mix(r[0], r[1], 0.5)
        reg(f"dot_{s}", img, None, None, f"Status dot: {s} {PALETTE['status'][s]}")
        # soft halo for pulsing (waiting) or emphasis: 11x11
        halo = new(11, 11)
        hp = halo.load()
        for y in range(11):
            for x in range(11):
                d = math.hypot(x - 5, y - 5)
                if 3.6 < d <= 5.2:
                    a = int(max(0, 1 - (d - 3.6) / 1.6) * 110)
                    hp[x, y] = (r[1][0], r[1][1], r[1][2], a)
        halo.alpha_composite(img, (2, 2))
        reg(f"dot_{s}_halo", halo, None, None, f"Status dot with halo (animate alpha for pulsing): {s}")


# ============================================================== tool icons (12x12)
IC = {
    "i": INK2, "I": INK3, "c": CREAM_HI, "C": CREAM, "p": PAPER_DK, "P": PAPER_DEEP,
    "y": BR[1], "Y": BR[2], "k": BR[3], "o": CL[1], "O": CL[2], "t": pc("ramps.teal[1]"), "T": pc("ramps.teal[0]"),
    "s": pc("ramps.sage[1]"), "S": pc("ramps.sage[2]"), "w": WAL, "W": pc("ramps.walnut[1]"), "r": pc("status.error"),
}
ICONS = {
    "read": [
        "............",
        ".iii....iii.",
        "iccciiiicCCi",
        "icppcicpppCi",
        "icccciccCCCi",
        "icppcicpppCi",
        "icccciccCCCi",
        "icppciYpppCi",
        "icccciYcCCCi",
        "iiiiiiYiiiii",
        "......k.....",
        "............",
    ],
    "edit": [
        "............",
        "........ii..",
        ".......icPi.",
        "......iyYi..",
        ".....ioOi...",
        "....ioOi....",
        "...ioOi.....",
        "..ioOi......",
        "..iWi.......",
        "..ii........",
        ".i..........",
        "............",
    ],
    "bash": [
        "............",
        "iiiiiiiiiiii",
        "iIIIIIIIIIIi",
        "iwwwwwwwwwwi",
        "iwywwwwwwwwi",
        "iwwywwwwwwwi",
        "iwywwwwwwwwi",
        "iwwwwccccwwi",
        "iwwwwwwwwwwi",
        "iiiiiiiiiiii",
        "............",
        "............",
    ],
    "test": [
        "............",
        "....iiii....",
        ".....ii.....",
        ".....cc.....",
        "....icci....",
        "...icccci...",
        "..icTcccci..",
        "..itttTtti..",
        ".itTtttttti.",
        ".itttttTtti.",
        "..iiiiiiii..",
        "............",
    ],
    "git": [
        "............",
        "..iii.......",
        "..iyi.......",
        "..iii...iii.",
        "...i....iti.",
        "...i....iii.",
        "...i...i....",
        "...i..i.....",
        "...iii......",
        "..iii.......",
        "..iyi.......",
        "..iii.......",
    ],
    "message": [
        "............",
        ".iiiiiiiiii.",
        "icccccccccci",
        "icccccccccCi",
        "icoccoccocCi",
        "icccccccccCi",
        "iCCCCCCCCCCi",
        ".iiiiCiiiii.",
        "....iCi.....",
        "....ii......",
        "............",
        "............",
    ],
    "memory": [
        "............",
        "..iiiiiiii..",
        ".iCccccccCi.",
        ".iiiiiiiiii.",
        ".iWWWWWWWWi.",
        ".iWicccciWi.",
        ".iWWWWWWWWi.",
        ".iWWWyyWWWi.",
        ".iWWWkkWWWi.",
        ".iwwwwwwwwi.",
        "..iiiiiiii..",
        "............",
    ],
    "decision": [
        "............",
        ".....ii.....",
        ".....yi.....",
        "....iiii....",
        "...iyYYki...",
        "..iyYYYYki..",
        "..iYYYYYki..",
        ".iyYYYYYYki.",
        ".iiiiiiiiii.",
        "iWWWWWWWWWWi",
        "iwwwwwwwwwwi",
        ".iiiiiiiiii.",
    ],
    "merge": [
        "............",
        ".iii....iii.",
        ".ioi....iti.",
        ".iii....iii.",
        "..i......i..",
        "...i....i...",
        "....i..i....",
        ".....ii.....",
        ".....ii.....",
        "....iyyi....",
        "....iyyi....",
        ".....ii.....",
    ],
}


def icons():
    for name, rows in ICONS.items():
        rows = [r.replace(" ", ".") for r in rows]
        img = from_grid(rows, {**IC, ".": None})
        reg(f"icon_{name}", img, None, None, f"Tool icon '{name}' (12x12, ink + one accent).")


# ============================================================== progress
# Quarter of a 32 px ring placed as a clean pixel circle (outer r = 16, inner r = 13, sampled at pixel
# centres once and frozen here, so no cardinal bumps): per row of the
# top-left quadrant, the first ring column and the first hole column (16 = no hole in this row).
# It is mirrored into all four quadrants, so the ring is exactly symmetric.
RING_OUTER = [12, 9, 7, 6, 5, 4, 3, 2, 2, 1, 1, 1, 0, 0, 0, 0]
RING_HOLE = [16, 16, 16, 12, 10, 8, 7, 6, 5, 5, 4, 4, 3, 3, 3, 3]


def ring_mask():
    m = [[0] * 32 for _ in range(32)]
    for y in range(16):
        for x in range(16):
            if RING_OUTER[y] <= x < RING_HOLE[y]:
                for (xx, yy) in ((x, y), (31 - x, y), (x, 31 - y), (31 - x, 31 - y)):
                    m[yy][xx] = 1
    return m


def progress():
    # ring 32x32: track + 16 fill steps (00..16), brass fill lit on its outer edge
    mask = ring_mask()
    c0 = 15.5

    def inside(x, y):
        return 0 <= x < 32 and 0 <= y < 32 and mask[y][x]

    def hole(x, y):          # inside the ring's inner circle
        return math.hypot(x - c0, y - c0) < 14 and not mask[y][x]

    for step in range(17):
        frac = step / 16
        img = new(32, 32)
        px = img.load()
        for y in range(32):
            for x in range(32):
                if not mask[y][x]:
                    continue
                nb = ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
                outer = any(not inside(a, b) and not hole(a, b) for a, b in nb)
                inner = any(0 <= a < 32 and 0 <= b < 32 and hole(a, b) for a, b in nb)
                ang = (math.degrees(math.atan2(x - c0, c0 - y)) + 360) % 360  # 0 = 12 o'clock, clockwise
                if step == 16 or ang < frac * 360 - 1e-6:
                    c = BR[1] if outer else (BR[3] if inner else BR[2])
                else:
                    c = PAPER_DEEP if inner else PAPER_DK
                px[x, y] = c
        reg(f"progress_ring_{step:02d}", img, None, None, f"Progress ring {step}/16 (draw the frame for round(p*16)).")
    track = new(16, 6)
    px = track.load()
    for y in range(6):
        for x in range(16):
            c = PAPER_SH
            if y == 0:
                c = PAPER_DEEP
            elif y == 5:
                c = CREAM_HI
            px[x, y] = c
    for (x, y) in ((0, 0), (15, 0), (0, 5), (15, 5)):
        px[x, y] = CLEAR
    reg("progress_track", track, (2, 2, 2, 2), None, "Progress bar track (6px tall).")
    fills = {"brass": PALETTE["ramps"]["brass"]["tones"][1:4], "teal": PALETTE["status_ramps"]["working"][:3],
             "sage": PALETTE["status_ramps"]["done"][:3], "clay": PALETTE["status_ramps"]["waiting"][:3],
             "red": PALETTE["status_ramps"]["error"][:3]}
    for n, (hi, base, sh) in fills.items():
        f = new(16, 6)
        px = f.load()
        for y in range(6):
            for x in range(16):
                c = H(base)
                if y in (0, 5):
                    c = H(sh)
                elif y == 1:
                    c = H(hi)
                px[x, y] = c
        for (x, y) in ((0, 0), (15, 0), (0, 5), (15, 5)):
            px[x, y] = CLEAR
        reg(f"progress_fill_{n}", f, (2, 2, 2, 2), None, f"Progress bar fill ({n}); draw over the track, width = p * w.")


# ============================================================== task cards
CARD_STATUS = {"todo": "idle", "doing": "working", "review": "thinking", "done": "done", "blocked": "error"}


def task_cards():
    w, h = 24, 24
    for status, ramp_key in CARD_STATUS.items():
        r = [H(c) for c in PALETTE["status_ramps"][ramp_key]]
        img = new(w, h)
        px = img.load()
        for y in range(h - 1):
            for x in range(w):
                if y == 0 or y == h - 2 or x == w - 1:
                    c = EDGE
                elif x == 0:
                    c = r[2]
                elif x in (1, 2):
                    c = r[1] if x == 1 else r[2]
                elif x == 3:
                    c = CREAM_HI if status != "done" else PAPER
                elif y == 1:
                    c = CREAM_HI
                elif y == h - 3:
                    c = PAPER
                else:
                    c = CREAM if status != "done" else PAPER
                px[x, y] = c
        px[1, 1] = r[0]
        for x in range(1, w - 1):
            px[x, h - 1] = shadow(60)
        for (x, y) in ((0, 0), (w - 1, 0), (0, h - 2), (w - 1, h - 2)):
            px[x, y] = CLEAR
        reg(f"card_{status}", img, (5, 4, 4, 5), (7, 5, 5, 6),
            f"Task card ({status}): status stripe uses the {ramp_key} ramp.", text=T_INK if status != "done" else T_MUTED)


# ============================================================== speech bubble + small widgets
def bubble_and_widgets():
    b = rounded_box(16, 16, border=INK3, fill=CREAM_HI, hi=None, lo=CREAM, radius=2)
    reg("bubble", b, (5, 5, 5, 5), (6, 4, 6, 5), "Speech bubble body (billboard). Draw bubble_tail centred under it.", text=T_INK)
    tail = from_grid([
        "iCCCCCCCi",
        ".iCCCCCi.",
        "..iCCCi..",
        "...iCi...",
        "....i....",
    ], {"i": INK3, "C": CREAM, ".": None})
    reg("bubble_tail", tail, None, None, "Speech bubble tail; overlap its first row with the bubble's bottom border.")
    pill = rounded_box(12, 11, border=BR[2], fill=CREAM_HI, hi=None, lo=CREAM, radius=2)
    reg("pill", pill, (4, 4, 4, 4), (5, 2, 5, 1), "Badge/pill for tags (@agent, branch, file).", text=T_INK)
    key = new(12, 12)
    px = key.load()
    for y in range(12):
        for x in range(12):
            c = CREAM
            if x in (0, 11) or y in (0, 11):
                c = PAPER_DEEP
            elif y == 1:
                c = CREAM_HI
            elif y >= 9:
                c = PAPER_DK
            px[x, y] = c
    for (x, y) in ((0, 0), (11, 0), (0, 11), (11, 11)):
        px[x, y] = CLEAR
    reg("keycap", key, (3, 3, 3, 4), (4, 2, 4, 4), "Keycap for keybind hints (` / Enter / Esc).", text=T_INK2)
    div = new(16, 3)
    px = div.load()
    for x in range(16):
        px[x, 0] = PAPER_DK
        px[x, 1] = CREAM_HI
    px[7, 0] = BR[2]
    px[8, 0] = BR[2]
    reg("divider", div, (4, 1, 4, 1), None, "Horizontal rule; stretch horizontally.", scaling="nine_slice")
    for name, on in (("checkbox", False), ("checkbox_checked", True)):
        img = new(10, 10)
        px = img.load()
        for y in range(10):
            for x in range(10):
                c = CREAM_HI
                if x in (0, 9) or y in (0, 9):
                    c = PAPER_DEEP
                elif y == 1 or x == 1:
                    c = PAPER_SH
                px[x, y] = c
        for (x, y) in ((0, 0), (9, 0), (0, 9), (9, 9)):
            px[x, y] = CLEAR
        if on:
            for (x, y) in ((2, 5), (3, 6), (4, 7), (5, 6), (6, 5), (7, 4), (7, 3), (3, 5), (4, 6)):
                px[x, y] = CL[2] if (x, y) in ((4, 7), (7, 3)) else CL[1]
        reg(name, img, None, None, "Checkbox (permissions: 'always allow').")


def build():
    panels()
    buttons_tabs()
    fields()
    dots()
    icons()
    progress()
    task_cards()
    bubble_and_widgets()
    base = OUT / "textures" / "gui" / "sprites" / "kit"
    manifest = {"version": 1, "atlas_prefix": "agentcraft:kit/",
                "how_to_draw": "graphics.blitSprite(RenderPipelines.GUI_TEXTURED, Identifier.fromNamespaceAndPath(\"agentcraft\", "
                               "\"kit/<name>\"), x, y, w, h) with graphics = net.minecraft.client.gui.GuiGraphicsExtractor "
                               "(Minecraft 26.3, Mojang names). Sprites with a 'slice' entry ship <name>.png.mcmeta "
                               "(gui.scaling nine_slice) so vanilla nine-slices them; the rest (icons, dots, ring "
                               "frames, grip, tail, checkboxes) are fixed-size and drawn at their own size.",
                "gui_scale_note": "Sprites are authored at 1 texel = 1 GUI pixel; never scale by non-integers.",
                "sprites": {}}
    for name, (img, meta) in sorted(SPRITES.items()):
        save_png(img, base / f"{name}.png")
        if "slice" in meta:
            s = meta["slice"]
            mc = {"gui": {"scaling": {"type": meta["scaling"], "width": img.width, "height": img.height,
                                      "border": {"left": s["left"], "top": s["top"], "right": s["right"], "bottom": s["bottom"]}}}}
            write_json(base / f"{name}.png.mcmeta", mc)
        manifest["sprites"][name] = {"id": f"agentcraft:kit/{name}", **meta}
    write_json(OUT / "gui" / "kit.json", manifest)
    print(f"{len(SPRITES)} gui sprites ->", base)
    return SPRITES


if __name__ == "__main__":
    build()

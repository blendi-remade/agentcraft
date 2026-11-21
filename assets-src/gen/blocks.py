"""AgentCraft block textures (16x16, vanilla-compatible style, Warm Studio palette).

Light comes from the top-left. Each material uses 4-6 tones from palette.json ramps.
Tileable textures (plaster, walnut, parquet, tile, screens) tile seamlessly in both
directions so multi-block walls/screens read as one surface.

python gen/blocks.py   -> out/assets/agentcraft/textures/block/*.png
"""
from __future__ import annotations

from common import OUT, PALETTE, hex2rgba, mix, pc, save_png
from tex import CLEAR, alpha_mask, from_grid, grid, hsh, new, rect, tones

W = tones("walnut")      # 0 lightest .. 5 darkest
O = tones("oak")         # 0 light .. 4 dark
B = tones("brass")       # 0 lightest .. 4 deepest
P = tones("plaster")
TC = tones("terracotta")
GL = tones("glow")
GS = tones("glass")
CR = tones("cream")
PA = tones("paper")
CL = tones("clay")
SG = tones("sage")
INK = tones("ink")
GR = tones("graphite")
SON = tones("screen_on")
SGW = tones("screen_glow")
WHITE = pc("colors.white")

TEX = {}


def reg(name, img):
    assert img.size == (16, 16), (name, img.size)
    TEX[name] = img
    return img


# ------------------------------------------------------------------ walnut panel
WALNUT_ROWS = [
    "dabbcbbbdabbbabb",
    "dabbcbbbdabbbabb",
    "dabbcbbbdabcbabb",
    "dabbbbabdabcbbbb",
    "dabbbbabdabcbbcb",
    "dabcbbabdabbbbcb",
    "dabcbbbbdaabbbcb",
    "dabcbbbbdaabbbbb",
    "dabbbcbbdabbbabb",
    "dabbbcbbdabbbabb",
    "dbabbcbbdabcbabb",
    "dbabbbbbdabcbbbb",
    "dbabbbcbdabbbbcb",
    "dabbbbcbdabbbbcb",
    "dabbcbcbdabbbbcb",
    "dabbcbbbdabbbabb",
]
WL = {"a": W[1], "b": W[2], "c": W[3], "d": W[4], "e": W[0]}


def walnut_panel():
    return reg("walnut_panel", from_grid(WALNUT_ROWS, WL))


def walnut_trim():
    img = from_grid(WALNUT_ROWS, WL)
    # brass cap rail: lit top edge, specular line, body, shade, cast shadow on the wood
    rows = [
        "1111111111111111",
        "0000000000000000",
        "2232222222222322",
        "3333333333333333",
        "5555555555555555",
    ]
    grid(img, rows, {"0": B[0], "1": B[1], "2": B[2], "3": B[3], "5": W[5]})
    return reg("walnut_trim", img)


# ------------------------------------------------------------------ oak parquet
def oak_parquet():
    img = new()
    px = img.load()
    for y in range(16):
        for x in range(16):
            cx, cy = x // 8, y // 8
            lx, ly = x % 8, y % 8
            horizontal = (cx + cy) % 2 == 0
            a, b = (lx, ly) if horizontal else (ly, lx)  # a = along slat, b = across
            slat = b // 4
            bb = b % 4
            sid = hsh(cx, cy, slat)
            # alternate slats a tone lighter/darker (judges: the parquet read as one flat beige)
            base = O[1] if (cx + cy + slat) % 2 == 0 else O[2]
            if bb == 3:
                c = O[4]                           # seam between slats
            elif bb == 0:
                c = mix(base, O[0], 0.5)           # lit edge of the slat (top/left)
            else:
                # one calm grain streak per slat (3 px, one tone darker), like vanilla plank grain
                g0, row = sid % 4, 1 + (sid >> 3) % 2
                c = mix(base, O[3], 0.55) if (bb == row and g0 <= a < g0 + 3) else base
            # end-grain joints between cells darken the last pixel of each slat
            if a == 7 and bb != 3:
                c = mix(c, O[3], 0.5)
            px[x, y] = c
    return reg("oak_parquet", img)


# ------------------------------------------------------------------ plaster
PLASTER_ROWS = [
    "bbbbbaaabbbbbbbb",
    "bbbbbbbbaabbbbcb",
    "bcbbbbbbbbbbbbbb",
    "bbccbbbbbbbaaabb",
    "bbbbbbbbbbbbbbaa",
    "aabbbbcbbbbbbbbb",
    "bbaaabbccbbbbbbb",
    "bbbbbbbbbbbbbcbb",
    "bbbbbbbbbaaabbbb",
    "bbbcbbbbbbbbaabb",
    "bbbbccbbbbbbbbbb",
    "bbbbbbbbbbbbbbbc",
    "baabbbbbbbccbbbb",
    "bbbaaabbbbbbbbbb",
    "bbbbbbbbcbbbbbaa",
    "bbbbbbbbbbbbbbbb",
]
PL = {"a": P[0], "b": P[1], "c": P[2], "d": P[3]}


def plaster_panel():
    return reg("plaster_panel", from_grid(PLASTER_ROWS, PL))


def plaster_frame():
    img = from_grid(PLASTER_ROWS, PL)
    # raised molding: outer joint, lit top/left, shaded bottom/right, then a recessed field
    rect(img, 0, 0, 15, 0, P[2]); rect(img, 0, 0, 0, 15, P[2])
    rect(img, 0, 15, 15, 15, P[3]); rect(img, 15, 0, 15, 15, P[3])
    rect(img, 1, 1, 14, 1, P[0]); rect(img, 1, 1, 1, 14, P[0])
    rect(img, 1, 14, 14, 14, P[2]); rect(img, 14, 1, 14, 14, P[2])
    rect(img, 2, 2, 13, 2, P[2]); rect(img, 2, 2, 2, 13, P[2])      # recess in shadow
    rect(img, 3, 13, 13, 13, P[0]); rect(img, 13, 3, 13, 13, P[0])  # recess lit lip
    img.putpixel((2, 13), P[1]); img.putpixel((13, 2), P[1])
    return reg("plaster_frame", img)


# ------------------------------------------------------------------ terracotta tile
def terracotta_tile():
    img = new()
    px = img.load()
    grout = PA[2]
    grout_d = PA[3]
    bases = [TC[1], mix(TC[1], TC[2], 0.35), mix(TC[1], TC[0], 0.25), mix(TC[1], TC[2], 0.15)]
    for ty in range(2):
        for tx in range(2):
            base = bases[ty * 2 + tx]
            x0, y0 = tx * 8, ty * 8
            for ly in range(8):
                for lx in range(8):
                    x, y = x0 + lx, y0 + ly
                    if lx == 0 or ly == 0:
                        c = grout_d if (lx == 0 and ly == 0) else grout
                    elif ly == 1 or lx == 1:
                        c = TC[0] if not (ly == 7 or lx == 7) else base
                    elif ly == 7 or lx == 7:
                        c = TC[2]
                    else:
                        c = base
                        k = hsh(tx, ty, lx, ly)
                        if k % 23 == 0:
                            c = TC[2]
                        elif k % 19 == 0:
                            c = mix(base, TC[0], 0.5)
                    px[x, y] = c
            px[x0 + 7, y0 + 1] = mix(TC[0], TC[2], 0.5)
            px[x0 + 1, y0 + 7] = mix(TC[0], TC[2], 0.5)
    return reg("terracotta_tile", img)


# ------------------------------------------------------------------ frames (monitor bezel / board trim)
def frame_texture(name, outer, inner, side_rows):
    """Regions: rows 0-1 = horizontal strip (row0 outer, row1 inner);
    cols 0-1, rows 2-15 = vertical strip (col0 outer, col1 inner);
    (4..5, 4..5) = outer L corner; rest = side material."""
    img = from_grid(side_rows, WL)
    for x in range(16):
        img.putpixel((x, 0), outer[0] if x < 15 else outer[1])
        img.putpixel((x, 1), inner[0] if x < 15 else inner[1])
    for y in range(2, 16):
        img.putpixel((0, y), outer[0] if y < 15 else outer[1])
        img.putpixel((1, y), inner[0] if y < 15 else inner[1])
    img.putpixel((4, 4), outer[0]); img.putpixel((5, 4), outer[0])
    img.putpixel((4, 5), outer[0]); img.putpixel((5, 5), inner[0])
    return reg(name, img)


def monitor_textures():
    # bezel: walnut outer, brass inner lip
    frame_texture("monitor_frame", (W[3], W[4]), (B[1], B[2]), WALNUT_ROWS)
    # screen off: unlit smoked glass (palette screen_off) with faint 1-texel scanlines. It is
    # uniform so a connected NxM screen reads as one pane; the single reflection lives in
    # monitor_screen_off_glint, which the blockstate puts only on the panel's top-left block.
    # No emissive element, so it takes the room's shading.
    so = tones("screen_off")
    off = new()
    for y in range(16):
        for x in range(16):
            off.putpixel((x, y), so[2] if y % 2 == 0 else so[3])
    reg("monitor_screen_off", off)
    glint = off.copy()
    # one soft diagonal sheen from the top-left (inside the 2-px bezel), fading out well before
    # the block's right/bottom edges so it never meets the neighbouring block's plain glass
    for x in range(2, 9):
        for y in range(2, 9):
            d = x + y
            if d == 7 and x <= 5:
                glint.putpixel((x, y), GR[1])
            elif d in (6, 8) and 2 <= x <= 5 and y <= 6 or d == 11 and 4 <= x <= 7 and y <= 7:
                glint.putpixel((x, y), so[0])
    reg("monitor_screen_off_glint", glint)
    # screen on: warm charcoal glass (palette screen_glow) with faint 1-texel scanlines, rendered
    # full-bright (light_emission 15). Chosen over the first take (warm e-ink paper, screen_on) by a
    # side-by-side test in game: lit paper screens read as framed notes / plaster at mid distance,
    # the dark glass with glowing cream text reads as a screen. The monitor BER draws the same
    # background (plus a soft top glow) and the log in ui-style.json monitor_dark.* colours; this
    # texture is what shows beyond the BER's view distance and on the item. The console terminal
    # keeps the paper screen (console_screen).
    on = new()
    for y in range(16):
        for x in range(16):
            on.putpixel((x, y), SGW[2] if y % 2 == 0 else SGW[3])
    reg("monitor_screen_on", on)
    # back: walnut with vent slots and a small brass maker plate
    back = from_grid(WALNUT_ROWS, WL)
    for y in (3, 5, 7):
        for x in range(4, 12):
            back.putpixel((x, y), W[5])
        for x in range(4, 12):
            back.putpixel((x, y + 1), W[1] if x == 4 else W[2])
    grid(back, ["1111", "0223", "3333"], {"0": B[0], "1": B[1], "2": B[2], "3": B[3]}, 6, 11)
    reg("monitor_back", back)
    # side/edge strip: rounded walnut edge, symmetric so east/west/up/down faces all match
    side = new()
    edge = [W[3], W[2], W[2], W[4]]
    for y in range(16):
        for x in range(16):
            k = min(x, y)
            side.putpixel((x, y), edge[k] if k < 4 else W[3])
    reg("monitor_side", side)


def pinboard():
    """Task Wall surface: the walnut boards one tone deeper than the wainscot (walnut_panel), so the
    cream task cards stand off it and the board does not read as wall. Replaced the first take
    (cream linen, task_board_linen) after a side-by-side test in game: cream cards on linen had too
    little contrast to read the board's structure from across the room. The Task Wall BER tiles
    this same sprite under its cards, so near and far views match."""
    # Phase 3 QA (judges, orch-p3): the deep walnut read as "noisy dark bark" and made the Task Wall the
    # darkest shot. Now pale birch boards (the same calm grain), two tones under the cream cards so the
    # cards still stand off the board, with darker seams so the board keeps its structure from afar.
    BI = tones("birch")
    birch = {"a": BI[2], "b": mix(BI[1], BI[2], 0.55), "c": BI[2], "d": BI[3], "e": BI[1]}
    return reg("task_board_surface", from_grid(WALNUT_ROWS, birch))


def task_board_textures():
    pinboard()
    frame_texture("task_board_frame", (B[1], B[2]), (W[3], W[4]), WALNUT_ROWS)
    reg("task_board_back", from_grid(WALNUT_ROWS, WL))


# ------------------------------------------------------------------ status lamp
def _lamp_frame(x, y):
    """Walnut cage, 2 px, lit top/left; brass only as four corner rivets so no status colour
    (thinking = brass) can merge with the frame. Returns None inside the lens."""
    d = min(x, y, 15 - x, 15 - y)
    if d >= 2:
        return None
    lit = (x == d or y == d) and not (x == 15 - d or y == 15 - d)
    shade = (x == 15 - d or y == 15 - d) and not (x == d or y == d)
    if d == 0:
        return W[3] if lit else (W[5] if shade else W[4])
    if (x, y) in ((1, 1), (14, 1), (1, 14), (14, 14)):
        return B[1] if (x, y) == (1, 1) else B[3]
    return W[1] if lit else (W[4] if shade else W[2])


def status_lamp_textures():
    """Big clean lens per status. Lit states glow from a hot centre to a saturated body with a
    1 px darker rim against the cage; 'off' is dark smoked glass with only a glint, so it can
    never be mistaken for idle (warm grey light)."""
    states = dict(PALETTE["status_ramps"])
    white = WHITE
    smoke = tones("ink")      # off: dark smoked glass
    for state in ["off"] + list(states):
        img = new()
        emis = new()
        r = [hex2rgba(h) for h in states[state]] if state != "off" else None
        for y in range(16):
            for x in range(16):
                f = _lamp_frame(x, y)
                if f is not None:
                    img.putpixel((x, y), f)
                    continue
                i, j = x - 2, y - 2                       # lens 12x12
                rad = ((i - 5.5) ** 2 + (j - 5.5) ** 2) ** 0.5
                rim = i in (0, 11) or j in (0, 11)
                if state == "off":
                    c = smoke[1] if not rim else smoke[2]
                    if rad < 3.0:
                        c = mix(smoke[1], smoke[0], 0.5)
                else:
                    # the status colour itself (r[1]) owns most of the lens so lamps read at range
                    if rim:
                        c = r[2]
                    elif rad < 2.0:
                        c = mix(r[0], white, 0.5)
                    elif rad < 3.4:
                        c = r[0]
                    else:
                        c = r[1]
                # glass glint, top-left, the same for every state
                if (i, j) in ((1, 1), (2, 1), (1, 2)):
                    c = mix(c, white, 0.7 if state != "off" else 0.35)
                img.putpixel((x, y), c)
                if state != "off":
                    emis.putpixel((x, y), c)
        reg(f"status_lamp_{state}", img)
        if state != "off":
            reg(f"status_lamp_{state}_emissive", emis)
    cap = new()
    for y in range(16):
        for x in range(16):
            f = _lamp_frame(x, y)
            if f is None:
                c = W[3] if (x + y) % 5 else W[2]
                if 6 <= x <= 9 and 6 <= y <= 9:           # brass vent boss
                    c = B[2] if (x in (6, 9) or y in (6, 9)) else W[5]
                    if (x, y) == (6, 6):
                        c = B[0]
                f = c
            cap.putpixel((x, y), f)
    reg("status_lamp_cap", cap)


# ------------------------------------------------------------------ glow panel + strip
def glow_textures():
    """Ceiling light: plaster frame, brass inner frame + centre cross, four rice-paper panes lit
    by one source behind the block centre (radial falloff across all panes, not four flat tiles)."""
    img = new()
    px = img.load()
    for y in range(16):
        for x in range(16):
            d = min(x, y, 15 - x, 15 - y)
            if d == 0:                                   # plaster frame, lit top/left
                lit = (x == 0 or y == 0) and not (x == 15 or y == 15)
                shade = (x == 15 or y == 15) and not (x == 0 or y == 0)
                c = P[0] if lit else (P[3] if shade else P[2])
            elif d == 1:                                 # brass inner frame, lit top/left
                lit = (x == 1 or y == 1) and not (x == 14 or y == 14)
                shade = (x == 14 or y == 14) and not (x == 1 or y == 1)
                c = B[1] if lit else (B[3] if shade else B[2])
            elif x in (7, 8) or y in (7, 8):             # centre cross: lit left/top bar, shaded right/bottom
                if x in (7, 8) and y in (7, 8):
                    c = B[2]
                elif x in (7, 8):
                    c = B[1] if x == 7 else B[3]
                else:
                    c = B[1] if y == 7 else B[3]
            else:
                c = None                                  # pane, filled below
            px[x, y] = c if c else CLEAR
    emis = new()
    for y in range(16):
        for x in range(16):
            if px[x, y][3]:
                continue
            r = ((x - 7.5) ** 2 + (y - 7.5) ** 2) ** 0.5
            t = 0 if r < 3.2 else 1 if r < 5.0 else 2 if r < 6.6 else 3
            # the pane edge right under the brass (top/left of each pane) sits in its shadow
            if (x in (2, 9) or y in (2, 9)) and t < 3:
                t += 1
            c = GL[t]
            px[x, y] = c
            emis.putpixel((x, y), c)
    # a faint horizontal paper fibre in each pane (one tone, never white)
    for (x0, y0) in ((3, 4), (10, 5), (4, 11), (10, 12)):
        for i in range(3):
            c = mix(px[x0 + i, y0], GL[3], 0.35)
            px[x0 + i, y0] = c
            emis.putpixel((x0 + i, y0), c)
    reg("glow_panel", img)
    reg("glow_panel_emissive", emis)
    strip = new()
    for y in range(16):
        for x in range(16):
            if y < 4:      # brass channel
                c = [B[1], B[2], B[2], B[3]][y]
            elif y < 8:    # diffuser
                c = [GL[1], GL[0], GL[0], GL[1]][y - 4]
            else:
                c = B[2]
            strip.putpixel((x, y), c)
    reg("glow_strip", strip)


# ------------------------------------------------------------------ memory archive (books + boxes)
ARCHIVE_FRONT = [
    "dccccccccccccccd",
    "cWWWWWWWWWWWWWWc",
    "cWkmnnoppqKKKWWc",
    "cWkmnnoppqKLKWWc",
    "cWkmnnoppqKKKmWc",
    "cWkmnnoppqKKKmWc",
    "cWkmnnoppqKKKmWc",
    "caaaaaaaaaaaaaac",
    "cbbbbbbbbbbbbbbc",
    "cWWWWWWWWWWWWWWc",
    "cWRRRrRRRstuvwWc",
    "cWRYYrRYYstuvwWc",
    "cWRRRrRRRstuvwxc",
    "cWRRRrRRRstuvwxc",
    "caaaaaaaaaaaaaac",
    "dbbbbbbbbbbbbbbd",
]


def memory_textures():
    legend = {
        "a": W[1], "b": W[3], "c": W[2], "d": W[4], "W": W[5],
        # top shelf: book spines in palette colours (light edge, body)
        "k": CL[2], "m": SG[2], "n": CR[2], "o": INK[1], "p": B[3], "q": TC[2],
        "K": PA[1], "L": B[1],
        # bottom shelf: archive boxes (paper) with brass label frames + books
        "R": PA[1], "r": PA[2], "Y": B[2],
        "s": CL[1], "t": SG[1], "u": W[0], "v": TC[1], "w": CR[1], "x": INK[0],
    }
    front = from_grid(ARCHIVE_FRONT, legend)
    # spine highlights on the top shelf (light from the left): brighten the first row
    for x in range(2, 10):
        c = front.getpixel((x, 2))
        front.putpixel((x, 2), mix(c, WHITE, 0.18))
    # gilt bands on a few spines
    for x, y in ((3, 4), (6, 3), (7, 5), (12, 11)):
        front.putpixel((x, y), B[1])
    reg("memory_archive_front", front)

    catalog = from_grid([
        "dccccccccccccccd",
        "cooooooccoooooob",
        "cPPPPPpccPPPPPpb",
        "cPLLLPpccPLLLPpb",
        "cPPYYPpccPPYYPpb",
        "cpppppqccpppppqb",
        "cooooooccoooooob",
        "cPPPPPpccPPPPPpb",
        "cPLLLPpccPLLLPpb",
        "cPPYYPpccPPYYPpb",
        "cpppppqccpppppqb",
        "cooooooccoooooob",
        "cPPPPPpccPPPPPpb",
        "cPLLLPpccPLLLPpb",
        "cPPYYPpccPPYYPpb",
        "dbbbbbbbbbbbbbbd",
    ], {"a": W[1], "b": W[3], "c": W[2], "d": W[4],
        "o": O[1], "P": O[2], "p": O[3], "q": O[4],
        "L": CR[0], "Y": B[2]})
    reg("memory_catalog_front", catalog)

    side = from_grid(WALNUT_ROWS, WL)
    for y in range(16):
        side.putpixel((0, y), W[4]); side.putpixel((15, y), W[4])
    for x in range(16):
        side.putpixel((x, 0), W[1]); side.putpixel((x, 15), W[4])
    reg("memory_archive_side", side)
    top = new()
    for y in range(16):
        for x in range(16):
            c = W[2]
            if y in (0, 15) or x in (0, 15):
                c = W[4] if (y == 15 or x == 15) else W[1]
            elif y % 4 == 0:
                c = W[3]
            elif hsh(x // 4, y, 3) % 6 == 0:
                c = W[1]
            top.putpixel((x, y), c)
    reg("memory_archive_top", top)


# ------------------------------------------------------------------ merge station
def merge_textures():
    # top: stripped-oak worktop with a brass inlay: two branches merging into one
    top = new()
    for y in range(16):
        for x in range(16):
            c = O[2]
            if y % 5 == 4:
                c = O[3]
            elif hsh(x // 3, y, 11) % 5 == 0:
                c = O[1]
            top.putpixel((x, y), c)
    inlay = [
        "................",
        "..y..........y..",
        "..Yk........kY..",
        "...Yk......kY...",
        "....Yk....kY....",
        ".....Yk..kY.....",
        "......YkkY......",
        ".......YY.......",
        ".......YY.......",
        "......yYYk......",
        "......YooY......",
        "......kYYk......",
        ".......YY.......",
        ".......YY.......",
        ".......YY.......",
        "................",
    ]
    lg = {"y": B[0], "Y": B[1], "k": B[3], "o": CL[1]}
    emis = new()
    for j, r in enumerate(inlay):
        for i, ch in enumerate(r):
            if ch != ".":
                top.putpixel((i, j), lg[ch])
                emis.putpixel((i, j), lg[ch] if ch != "k" else B[2])
    # walnut border around the worktop
    for i in range(16):
        top.putpixel((i, 0), W[2]); top.putpixel((0, i), W[2])
        top.putpixel((i, 15), W[4]); top.putpixel((15, i), W[4])
    reg("merge_station_top", top)
    reg("merge_station_top_emissive", emis)
    front = from_grid([
        "aaaaaaaaaaaaaaaa",
        "bccccccccccccccd",
        "bcooooooooooooed",
        "bcoPPPPPPPPPPped",
        "bcoPPPPLLPPPPped",
        "bcoPPPYYYYPPPped",
        "bcoppppppppppped",
        "bceeeeeeeeeeeeed",
        "bcooooooooooooed",
        "bcoPPPPPPPPPPped",
        "bcoPPPPLLPPPPped",
        "bcoPPPYYYYPPPped",
        "bcoppppppppppped",
        "bceeeeeeeeeeeeed",
        "bccccccccccccccd",
        "dddddddddddddddd",
    ], {"a": W[1], "b": W[2], "c": W[3], "d": W[4], "o": O[1], "P": O[2], "p": O[3], "e": O[4],
        "L": CR[0], "Y": B[1]})
    reg("merge_station_front", front)
    side = from_grid(WALNUT_ROWS, WL)
    for x in range(16):
        side.putpixel((x, 0), W[1]); side.putpixel((x, 15), W[4])
    for y in range(16):
        side.putpixel((0, y), W[3]); side.putpixel((15, y), W[4])
    for x in range(2, 14):
        side.putpixel((x, 7), B[2]); side.putpixel((x, 8), B[3])
    reg("merge_station_side", side)


# ------------------------------------------------------------------ console terminal
def console_textures():
    keyboard = from_grid([
        "aaaaaaaaaaaaaaaa",
        "bnmnmnmnmnmnmnmb",
        "bkKkKKKKKKKkKkKb",
        "bnmnmnmnmnmnmnmb",
        "bKkKkKkKkKkKyYkb",
        "bmnmnmnmnmnmnmnb",
        "bkKkKkKkKkKkKkKb",
        "cccccccccccccccc",
        "dWWWWWWWWWWWWWWd",
        "dWxxxxxxxxxxxxWd",
        "dWxxxxxxxxxxxxWd",
        "dWxxxxxxxxxxxxWd",
        "dWxxxxxxxxxxxxWd",
        "dWxxxxxxxxxxxxWd",
        "dWWWWWWWWWWWWWWd",
        "dddddddddddddddd",
    ], {"a": W[1], "b": W[2], "c": W[4], "d": W[3], "W": W[4], "x": W[5],
        "k": CR[1], "K": PA[1], "m": PA[3], "n": CR[3], "y": B[1], "Y": B[3]})
    reg("console_top", keyboard)
    screen = new()
    for y in range(16):
        for x in range(16):
            screen.putpixel((x, y), SON[1] if y % 2 == 0 else SON[2])
    # paper screen (same e-ink look as the monitors): clay prompt chevron, ink input, clay caret,
    # two quiet lines of prior output
    for x, y in ((2, 3), (3, 4), (2, 5)):
        screen.putpixel((x, y), CL[2])
    for x in range(5, 9):
        screen.putpixel((x, 4), INK[1])
    screen.putpixel((10, 4), CL[1]); screen.putpixel((10, 5), CL[2])
    for x in range(2, 12):
        if x % 4 != 1:
            screen.putpixel((x, 8), mix(SON[1], INK[0], 0.35))
    for x in range(2, 9):
        if x % 3 != 2:
            screen.putpixel((x, 10), mix(SON[1], INK[0], 0.35))
    reg("console_screen", screen)
    front = from_grid(WALNUT_ROWS, WL)
    for x in range(16):
        front.putpixel((x, 0), W[1])
    for y in (5, 7, 9):
        for x in range(4, 12):
            front.putpixel((x, y), W[5])
    grid(front, ["1111", "0223"], {"0": B[0], "1": B[1], "2": B[2], "3": B[3]}, 6, 12)
    reg("console_front", front)
    side = from_grid(WALNUT_ROWS, WL)
    for x in range(16):
        side.putpixel((x, 0), W[1])
    reg("console_side", side)


# ------------------------------------------------------------------ decision podium
def podium_textures():
    # column: fluted walnut with brass bands top/bottom and the decision emblem
    col = new()
    for y in range(16):
        for x in range(16):
            f = x % 4
            c = [W[1], W[2], W[2], W[4]][f]
            col.putpixel((x, y), c)
    for x in range(16):
        col.putpixel((x, 0), B[1]); col.putpixel((x, 1), B[3])
        col.putpixel((x, 14), B[1]); col.putpixel((x, 15), B[3])
    reg("decision_podium_column", col)
    emblem = from_grid([
        "aaaaaaaaaaaaaaaa",
        "3333333333333333",
        "bcbbcbbcbbcbbcbb",
        "bcbbc1100cbbcbbb",
        "bcbb10LLL03bcbbb",
        "bcbb0LoooL3bcbbb",
        "bcbb0LoOoL3bcbbb",
        "bcbb0LoooL3bcbbb",
        "bcbb30LLL33bcbbb",
        "bcbbc3333cbbcbbb",
        "bcbbcbbcbbcbbcbb",
        "bcbbcbbcbbcbbcbb",
        "bcbbcbbcbbcbbcbb",
        "bcbbcbbcbbcbbcbb",
        "1111111111111111",
        "3333333333333333",
    ], {"a": B[1], "1": B[1], "0": B[2], "3": B[3], "b": W[2], "c": W[4],
        "L": W[4], "o": CL[3], "O": CL[2]})
    reg("decision_podium_front", emblem)
    emis = new()
    for (x, y) in ((6, 5), (7, 5), (8, 5), (6, 6), (8, 6), (6, 7), (7, 7), (8, 7)):
        emis.putpixel((x, y), CL[0])
    emis.putpixel((7, 6), mix(CL[0], WHITE, 0.6))
    reg("decision_podium_front_emissive", emis)
    lit = emblem.copy()
    for (x, y) in ((6, 5), (7, 5), (8, 5), (6, 6), (8, 6), (6, 7), (7, 7), (8, 7)):
        lit.putpixel((x, y), CL[0])
    lit.putpixel((7, 6), mix(CL[0], WHITE, 0.6))
    reg("decision_podium_front_lit", lit)
    # desk: walnut frame with brass edge and a paper sheet (lit when a decision is open)
    desk_rows = [
        "1111111111111111",
        "0aaaaaaaaaaaaaa3",
        "0aSSSSSSSSSSSSa3",
        "0aSppppppppppSa3",
        "0aSpqqqqqqqqpSa3",
        "0aSppppppppppSa3",
        "0aSpqqqqqqqppSa3",
        "0aSppppppppppSa3",
        "0aSpqqqqqqppSSa3",
        "0aSppppppppppSa3",
        "0aSpqqqqqpppppa3",
        "0aSppppppppppSa3",
        "0aSppppppppppSa3",
        "0aSSSSSSSSSSSSa3",
        "0aaaaaaaaaaaaaa3",
        "3333333333333333",
    ]
    base_lg = {"1": B[1], "0": B[2], "3": B[3], "a": W[3], "S": W[4]}
    reg("decision_podium_top", from_grid(desk_rows, {**base_lg, "p": PA[2], "q": PA[3]}))
    lit_top = from_grid(desk_rows, {**base_lg, "p": CR[0], "q": PA[3]})
    reg("decision_podium_top_lit", lit_top)
    reg("decision_podium_top_emissive", alpha_mask(lit_top, lambda x, y, c: 3 <= x <= 12 and 3 <= y <= 12))
    base = from_grid(WALNUT_ROWS, WL)
    for x in range(16):
        base.putpixel((x, 0), B[1]); base.putpixel((x, 1), B[3])
    reg("decision_podium_base", base)
    bell = new()
    for y in range(16):
        for x in range(16):
            c = B[2]
            if y < 3:
                c = B[0] if x < 8 else B[1]
            elif x < 3:
                c = B[1]
            elif x > 12 or y > 12:
                c = B[3]
            bell.putpixel((x, y), c)
    reg("decision_podium_bell", bell)


def build():
    for fn in (walnut_panel, walnut_trim, oak_parquet, plaster_panel, plaster_frame, terracotta_tile,
               monitor_textures, task_board_textures, status_lamp_textures, glow_textures,
               memory_textures, merge_textures, console_textures, podium_textures):
        fn()
    out = OUT / "textures" / "block"
    for name, img in sorted(TEX.items()):
        if not name.endswith("_emissive"):
            holes = [xy for xy in ((x, y) for y in range(16) for x in range(16)) if img.getpixel(xy)[3] != 255]
            assert not holes, f"{name}: non-opaque pixels {holes[:5]} (only *_emissive may have alpha)"
        save_png(img, out / f"{name}.png")
    print(f"{len(TEX)} block textures ->", out)
    return TEX


if __name__ == "__main__":
    build()

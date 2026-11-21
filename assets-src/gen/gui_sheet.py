"""GUI review sheet: mock screens composed from the kit at 1 GUI px, then shown at 3x.

Text uses Minecraft's own bitmap font (read from the Loom-cached client jar, reference only),
so the mock shows exactly how labels will rasterise in game.
"""
from __future__ import annotations

import json

from common import ART, OUT, PROJECT, ROOT, hex2rgba, save_png, scale_nearest
from PIL import Image, ImageDraw, ImageFilter

H = hex2rgba
KIT = OUT / "textures" / "gui" / "sprites" / "kit"
MANIFEST = json.load(open(OUT / "gui" / "kit.json", encoding="utf-8"))["sprites"]
CAST = {a["id"]: a for a in json.load(open(ROOT / "cast.json", encoding="utf-8"))["agents"]}
UI = json.load(open(ROOT / "ui-style.json", encoding="utf-8"))
INK, MUTED = UI["paper"]["text"], UI["paper"]["muted"]
FONT_DIR = PROJECT / "artifacts" / "art" / "_ref" / "font"


class MCFont:
    """Minimal renderer for Minecraft's ascii.png bitmap font (8x8 cells, ascent 7)."""

    def __init__(self):
        self.sheet = Image.open(FONT_DIR / "ascii.png").convert("RGBA")
        prov = json.load(open(FONT_DIR / "ascii_provider.json", encoding="utf-8"))
        self.cells = {}
        for r, row in enumerate(prov["chars"]):
            for c, ch in enumerate(row):
                if ch != "\x00":
                    self.cells[ch] = (c * 8, r * 8)
        self.widths = {}
        for ch, (x0, y0) in self.cells.items():
            w = 0
            for x in range(8):
                if any(self.sheet.getpixel((x0 + x, y0 + y))[3] > 0 for y in range(8)):
                    w = x + 1
            self.widths[ch] = w

    def advance(self, ch):
        if ch == " ":
            return 4
        return self.widths.get(ch, 5) + 1

    def width(self, s):
        return sum(self.advance(c) for c in s) - (1 if s else 0)

    def draw(self, img, x, y, s, color, shadow=None):
        if shadow:
            self.draw(img, x + 1, y + 1, s, shadow)
        cx = x
        for ch in s:
            if ch != " " and ch in self.cells:
                x0, y0 = self.cells[ch]
                glyph = self.sheet.crop((x0, y0, x0 + 8, y0 + 8))
                tint = Image.new("RGBA", glyph.size, color)
                tint.putalpha(glyph.getchannel("A"))
                img.alpha_composite(tint, (cx, y))
            cx += self.advance(ch)
        return cx

    def wrap(self, s, width):
        lines, cur = [], ""
        for w in s.split():
            t = (cur + " " + w).strip()
            if self.width(t) > width and cur:
                lines.append(cur)
                cur = w
            else:
                cur = t
        lines.append(cur)
        return lines


F = None
BOUNDS = []          # stack of ((x0, y0, x1, y1), name) containers; draws must stay inside the top one


class region:
    """Layout guard: `with region(x0, y0, x1, y1):` makes every text/sprite/button drawn inside it
    assert that it fits, so a mock that overflows its panel fails the sheet build instead of
    shipping a broken reference layout."""

    def __init__(self, x0, y0, x1, y1, name=""):
        self.r = (x0, y0, x1, y1)
        self.name = name

    def __enter__(self):
        BOUNDS.append((self.r, self.name))
        return self

    def __exit__(self, *a):
        BOUNDS.pop()


def _check(x, y, w, h, what):
    if not BOUNDS:
        return
    (x0, y0, x1, y1), name = BOUNDS[-1]
    if x < x0 or y < y0 or x + w > x1 or y + h > y1:
        raise SystemExit(f"gui_sheet layout: {what} at ({x},{y},{w}x{h}) overflows {name or 'region'} "
                         f"({x0},{y0})-({x1},{y1})")


def spr(name):
    return Image.open(KIT / f"{name}.png").convert("RGBA")


def blit(img, name, x, y):
    im = spr(name)
    _check(x, y, im.width, im.height, name)
    img.alpha_composite(im, (x, y))


def _tile(dst, src, x, y, w, h):
    if w <= 0 or h <= 0:
        return
    sw, sh = src.size
    for yy in range(0, h, sh):
        for xx in range(0, w, sw):
            piece = src.crop((0, 0, min(sw, w - xx), min(sh, h - yy)))
            dst.alpha_composite(piece, (x + xx, y + yy))


def nine(img, name, x, y, w, h):
    """Vanilla-style nine_slice: corners copied, edges and centre tiled."""
    _check(x, y, w, h, name)
    s = spr(name)
    sl = MANIFEST[name]["slice"]
    l, t, r, b = sl["left"], sl["top"], sl["right"], sl["bottom"]
    sw, sh = s.size
    cw, ch = sw - l - r, sh - t - b
    parts = {
        "tl": (0, 0, l, t), "tr": (sw - r, 0, sw, t), "bl": (0, sh - b, l, sh), "br": (sw - r, sh - b, sw, sh),
        "t": (l, 0, sw - r, t), "b": (l, sh - b, sw - r, sh), "l": (0, t, l, sh - b), "r": (sw - r, t, sw, sh - b),
        "c": (l, t, sw - r, sh - b),
    }
    P = {k: s.crop(v) for k, v in parts.items()}
    img.alpha_composite(P["tl"], (x, y))
    img.alpha_composite(P["tr"], (x + w - r, y))
    img.alpha_composite(P["bl"], (x, y + h - b))
    img.alpha_composite(P["br"], (x + w - r, y + h - b))
    _tile(img, P["t"], x + l, y, w - l - r, t)
    _tile(img, P["b"], x + l, y + h - b, w - l - r, b)
    _tile(img, P["l"], x, y + t, l, h - t - b)
    _tile(img, P["r"], x + w - r, y + t, r, h - t - b)
    _tile(img, P["c"], x + l, y + t, w - l - r, h - t - b)


def text(img, x, y, s, hexcol, shadow=None):
    _check(x, y, F.width(s), 8, repr(s))
    return F.draw(img, x, y, s, H(hexcol), H(shadow) if shadow else None)


def face(cid, k=1):
    p = Image.open(OUT / "textures/gui/portrait" / f"{cid}.png")
    return scale_nearest(p, k) if k > 1 else p


def button(img, x, y, w, label, kind="button", state=""):
    name = kind + (f"_{state}" if state else "")
    nine(img, name, x, y, w, 20)
    col = MANIFEST[name].get("text_color", INK)
    dy = 2 if state == "pressed" else 0
    text(img, x + (w - F.width(label)) // 2, y + 6 + dy, label, col)


def button_row(img, x, y, w, buttons, gap=4, min_w=40):
    """Lay out buttons [(label, kind, state)] left to right inside width w: each gets its label
    width + 16 px padding (at least min_w); the first (primary) one absorbs the spare width.
    Raises if they cannot fit, instead of letting the last one run past the frame."""
    widths = [max(min_w, F.width(lbl) + 16) for lbl, _, _ in buttons]
    spare = w - sum(widths) - gap * (len(buttons) - 1)
    if spare < 0:
        raise SystemExit(f"gui_sheet layout: buttons {[b[0] for b in buttons]} need {w - spare} px, have {w}")
    widths[0] += spare
    for (lbl, kind, state), bw in zip(buttons, widths):
        button(img, x, y, bw, lbl, kind, state)
        x += bw + gap


def keycap(img, x, y, label):
    w = F.width(label) + 8
    nine(img, "keycap", x, y, w, 12)
    text(img, x + 4, y + 2, label, MANIFEST["keycap"]["text_color"])
    return x + w


def mock_screen():
    W, Hh = 480, 290
    img = Image.new("RGBA", (W, Hh), H(UI["monitor"]["scanline"]))
    vig = ART / "blocks" / "vignette_day.png"
    if vig.exists():
        bg = Image.open(vig).convert("RGBA").resize((W, int(W * 1000 / 1600)), Image.LANCZOS)
        bg = bg.filter(ImageFilter.GaussianBlur(2.2))
        dim = Image.new("RGBA", bg.size, (24, 20, 18, 150))
        bg.alpha_composite(dim)
        img.alpha_composite(bg, (0, (Hh - bg.height) // 2))

    # ---------------- decision dialog
    x, y, w, h = 12, 14, 230, 176
    nine(img, "frame_brass", x, y, w, h)
    # everything inside the brass border (4 px frame + 1 px air)
    with region(x + 5, y + 4, x + w - 5, y + h - 6, "decision dialog"):
        nine(img, "header", x + 5, y + 4, w - 10, 14)
        text(img, x + 11, y + 6, "Decision needed", INK)
        kx = keycap(img, x + w - 7 - (F.width("1/2") + 8), y + 5, "1/2")
        blit(img, "dot_waiting_halo", x + w - 7 - (F.width("1/2") + 8) - 15, y + 6)
        fr = Image.open(OUT / "textures/gui/portrait/juniper_framed.png")
        img.alpha_composite(fr, (x + 10, y + 24))
        a = CAST["juniper"]
        nx = text(img, x + 36, y + 26, a["name"], a["text_on_light"])
        text(img, nx + 4, y + 26, "asks you", MUTED)
        text(img, x + 36, y + 36, "question - 2m ago", MUTED)
        q = "Store OAuth tokens in the existing session table, or add a Redis cache?"
        for i, line in enumerate(F.wrap(q, w - 24)):
            text(img, x + 10, y + 52 + i * 10, line, INK)
        ix, iy, iw, ih = x + 10, y + 76, w - 20, 48
        nine(img, "panel_inset", ix, iy, iw, ih)
        text(img, ix + 5, iy + 4, "auth/session.ts", UI["paper"]["path"])
        img.alpha_composite(Image.new("RGBA", (iw - 6, 10), H(UI["paper"]["add_bg"])), (ix + 3, iy + 14))
        text(img, ix + 5, iy + 15, "+ oauth_token: text", UI["paper"]["add_fg"])
        img.alpha_composite(Image.new("RGBA", (iw - 6, 10), H(UI["paper"]["del_bg"])), (ix + 3, iy + 24))
        text(img, ix + 5, iy + 25, "- tokens.json (file)", UI["paper"]["del_fg"])
        text(img, ix + 5, iy + 36, "2 files, +14 -3", MUTED)
        button_row(img, x + 10, y + 132, w - 20,
                   [("Session table", "button_primary", ""), ("Add Redis", "button", "hover"), ("Later", "button", "")])
        kx = keycap(img, x + 10, y + 158, "Enter")
        kx = text(img, kx + 3, y + 160, "choose", MUTED)
        kx = keycap(img, kx + 8, y + 158, "Tab")
        kx = text(img, kx + 3, y + 160, "next", MUTED)
        kx = keycap(img, kx + 8, y + 158, "Esc")
        text(img, kx + 3, y + 160, "later", MUTED)

    # ---------------- task wall panel with tabs
    px0, py0, pw, ph = 250, 30, 220, 168
    nine(img, "tab_inactive", px0 + 52, py0 - 18, 46, 20)
    text(img, px0 + 52 + 9, py0 - 18 + 8, "Goal", MUTED)
    nine(img, "panel_paper", px0, py0, pw, ph)
    nine(img, "tab_active", px0 + 4, py0 - 18, 48, 20)
    text(img, px0 + 4 + 9, py0 - 18 + 7, "Board", INK)
    BOUNDS.append(((px0 + 2, py0 + 2, px0 + pw - 2, py0 + ph - 2), "task wall panel"))
    text(img, px0 + 10, py0 + 7, "add OAuth to life-tracker", INK)
    blit(img, "progress_ring_10", px0 + pw - 40, py0 + 3)
    text(img, px0 + pw - 40 + (32 - F.width("62%")) // 2, py0 + 15, "62%", UI["paper"]["path"])
    nine(img, "progress_track", px0 + 10, py0 + 20, 140, 6)
    nine(img, "progress_fill_brass", px0 + 10, py0 + 20, 87, 6)
    cols = [("TODO", "todo", [("Setup docs", "tove", "idle"), ("Rate limits", "juniper", "idle")]),
            ("DOING", "doing", [("OAuth callback", "kit", "working"), ("Token store", "rowan", "thinking")]),
            ("REVIEW", "review", [("Login tests", "wren", "waiting")])]
    cx = px0 + 8
    for title, status, cards in cols:
        text(img, cx + 2, py0 + 36, title, MUTED)
        text(img, cx + 8 + F.width(title), py0 + 36, str(len(cards)), MUTED)
        cy = py0 + 48
        cw_ = 66
        for n_, (t, who, st) in enumerate(cards):
            lines = F.wrap(t, cw_ - 22)
            chh = 21 + 10 * len(lines)
            nine(img, f"card_{status}", cx, cy, cw_, chh)
            for li, ln in enumerate(lines):
                text(img, cx + 7, cy + 5 + li * 10, ln, INK)
            blit(img, f"dot_{st}", cx + cw_ - 12, cy + 5)
            ry = cy + 6 + 10 * len(lines)
            img.alpha_composite(face(who), (cx + 7, ry))
            text(img, cx + 18, ry, CAST[who]["name"], CAST[who]["text_on_light"])
            cy += chh + 4
        cx += cw_ + 4
    nine(img, "divider", px0 + 8, py0 + ph - 20, pw - 16, 3)
    text(img, px0 + 10, py0 + ph - 14, "5 tasks  2 agents busy  1 waiting", MUTED)
    BOUNDS.pop()

    # ---------------- console with autocomplete
    cx0, cy0, cw = 14, 266, 454
    tw, th = 150, 34
    nine(img, "tooltip", cx0 + 18, cy0 - th - 2, tw, th)
    with region(cx0 + 18 + 3, cy0 - th - 2 + 3, cx0 + 18 + tw - 3, cy0 - 2 - 2, "autocomplete tooltip"):
        img.alpha_composite(face("juniper"), (cx0 + 25, cy0 - th + 4))
        text(img, cx0 + 37, cy0 - th + 4, "Juniper", CAST["juniper"]["text_on_dark"])
        blit(img, "dot_waiting", cx0 + 37 + F.width("Juniper") + 4, cy0 - th + 5)
        text(img, cx0 + 25, cy0 - th + 16, "Tab complete", UI["ink_ui"]["activity"])
        keycap(img, cx0 + 25 + F.width("Tab complete") + 6, cy0 - th + 14, "Tab")
    nine(img, "text_field_focused", cx0, cy0, cw, 18)
    with region(cx0 + 3, cy0 + 2, cx0 + cw - 3, cy0 + 16, "console field"):
        xx = text(img, cx0 + 6, cy0 + 5, ">", UI["paper"]["path"])
        xx = text(img, xx + 4, cy0 + 5, "@ju", INK)
        text(img, xx, cy0 + 5, "niper", UI["ink_ui"]["ghost_on_paper"])
        img.alpha_composite(Image.new("RGBA", (1, 9), H(INK)), (xx, cy0 + 4))
        text(img, cx0 + cw - 6 - F.width("message an agent"), cy0 + 5, "message an agent", MUTED)

    # ---------------- in-world bits: bubble + nameplate
    bx, byy, bw, bh = 300, 200, 128, 26
    nine(img, "bubble", bx, byy, bw, bh)
    blit(img, "bubble_tail", bx + bw // 2 - 4, byy + bh - 1)
    with region(bx + 3, byy + 3, bx + bw - 3, byy + bh - 2, "speech bubble"):
        for i, line in enumerate(F.wrap("Tests pass. Ready for your review!", bw - 12)):
            text(img, bx + 6, byy + 5 + i * 10, line, INK)
    label = "Kit"
    act = "running tests"
    nw = 7 + 3 + F.width(label) + 5 + F.width(act) + 8
    nxp = bx + bw // 2 - nw // 2
    nine(img, "nameplate", nxp, byy + bh + 8, nw, 12)
    blit(img, "dot_working", nxp + 4, byy + bh + 10)
    t2 = text(img, nxp + 14, byy + bh + 10, label, CAST["kit"]["text_on_dark"])
    text(img, t2 + 5, byy + bh + 10, act, UI["ink_ui"]["activity"])
    return img


def monitor_mock():
    """In-world monitor screen (2x3 blocks): log kinds per ui-style.json, at 1 texel = 1 px."""
    W, Hh = 220, 120
    m = UI["monitor"]
    img = Image.new("RGBA", (W, Hh), H(m["bg"]))
    for y in range(1, Hh, 2):
        img.alpha_composite(Image.new("RGBA", (W, 1), H(m["scanline"])), (0, y))
    a = CAST["kit"]
    text(img, 6, 5, a["name"], a["text_on_light"])
    text(img, 6 + F.width(a["name"]) + 5, 5, "running   auth/session.ts", m["muted"])
    img.alpha_composite(Image.new("RGBA", (W - 12, 1), H(m["rule"])), (6, 16))
    rows = [
        ("text", "Adding the token column first."),
        ("tool", "Edit  auth/session.ts"),
        ("diff_hunk", "@@ -40,6 +40,7 @@"),
        ("diff_add", "+  oauth_token: text,"),
        ("diff_del", "-  token_file: string,"),
        ("tool", "Bash  npm test -- auth"),
        ("result", "12 passed, 0 failed (1.8s)"),
        ("error", "warn: session.ts:88 unused import"),
        ("text", "Done. Asking Marlow for review."),
    ]
    y = 20
    for kind, s in rows:
        col = m[kind]
        if kind in ("diff_add", "diff_del"):
            img.alpha_composite(Image.new("RGBA", (W - 8, 10), H(m[kind + "_bg"])), (4, y - 1))
        icon = {"tool": "icon_edit" if s.startswith("Edit") else "icon_bash"}.get(kind)
        if icon:
            ic = spr(icon)
            img.alpha_composite(ic.crop((0, 1, 12, 11)), (5, y - 1))
            text(img, 19, y, s, col)
        else:
            text(img, 6, y, s, col)
        y += 11
    # bezel
    fr = Image.open(OUT / "textures/block/monitor_frame.png").convert("RGBA")
    outer = Image.new("RGBA", (W + 4, Hh + 4), fr.getpixel((0, 8)))
    for x in range(W + 4):
        outer.putpixel((x, 1), fr.getpixel((8, 1)))
        outer.putpixel((x, Hh + 2), fr.getpixel((8, 1)))
    for yy in range(Hh + 4):
        outer.putpixel((1, yy), fr.getpixel((1, 8)))
        outer.putpixel((W + 2, yy), fr.getpixel((1, 8)))
    outer.alpha_composite(img, (2, 2))
    return outer


def build():
    global F
    import extract_ref
    extract_ref.ensure()          # the vanilla font comes from Loom's cached client jar
    F = MCFont()
    k = 3
    mock = scale_nearest(mock_screen(), k)
    mon = scale_nearest(monitor_mock(), k)
    pad = 40
    W = pad * 2 + mock.width
    legend_h = 560
    Hh = 130 + mock.height + 40 + max(mon.height, 420) + legend_h
    sheet = Image.new("RGBA", (W, Hh), H(UI["paper"]["inset"]))
    from sheets import font, title_block  # reuse the review-sheet chrome
    title_block(sheet, "AgentCraft GUI kit", "Mock screen assembled only from kit sprites (vanilla nine_slice tiling) "
                "with Minecraft's own font, shown at GUI scale 3. Below: in-world monitor style and every kit sprite.")
    sheet.alpha_composite(mock, (pad, 126))
    d = ImageDraw.Draw(sheet)
    y = 126 + mock.height + 30
    d.text((pad, y), "In-world monitor display (2x3 block screen, emissive)", fill=H(INK), font=font(20, bold=True, serif=True))
    sheet.alpha_composite(mon, (pad, y + 34))
    # swatches for log kinds
    sx = pad + mon.width + 40
    d.text((sx, y + 34), f"Log kinds on the monitor (worst contrast vs {UI['monitor']['bg']} and its scanline)", fill=H(INK), font=font(16, bold=True))
    yy = y + 64
    for kind in ("text", "tool", "result", "error", "diff_hunk", "diff_add", "diff_del", "muted"):
        col = UI["monitor"][kind]
        bgc = UI["monitor"].get(kind + "_bg", UI["monitor"]["bg"])
        d.rectangle([sx, yy, sx + 46, yy + 22], fill=H(bgc))
        d.rectangle([sx + 8, yy + 6, sx + 38, yy + 16], fill=H(col))
        d.text((sx + 58, yy + 2), f"{kind:10s} {col}  {UI['contrast'][kind]}:1", fill=H(INK), font=font(14))
        yy += 30
    y = 126 + mock.height + 40 + max(mon.height, 420) + 10
    d.text((pad, y), "Kit sprites (3x)", fill=H(INK), font=font(20, bold=True, serif=True))
    x, yy, rowh = pad, y + 36, 0
    lf = font(11)
    for name in sorted(MANIFEST):
        if name.startswith("progress_ring_") and name not in ("progress_ring_00", "progress_ring_08", "progress_ring_16"):
            continue
        im = scale_nearest(spr(name), 3)
        cell = max(im.width, int(d.textlength(name, font=lf)) + 1)
        if x + cell > W - pad:
            x = pad
            yy += rowh + 26
            rowh = 0
        sheet.alpha_composite(im, (x, yy))
        d.text((x, yy + im.height + 3), name, fill=H(MUTED), font=lf)
        x += cell + 16
        rowh = max(rowh, im.height)
    sheet = sheet.crop((0, 0, W, min(Hh, yy + rowh + 40)))
    save_png(sheet, ART / "gui_sheet.png")
    print("->", ART / "gui_sheet.png")


if __name__ == "__main__":
    build()

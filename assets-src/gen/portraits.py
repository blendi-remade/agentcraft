"""GUI portraits derived from the skins (shipped): 8x8 face (+ hat layer) and a 20x20 framed
version (brass rim lit top-left, identity-colour ring, 2x face).

python gen/portraits.py
"""
from __future__ import annotations

import json

from common import OUT, ROOT, hex2rgba, pc, save_png, scale_nearest
from PIL import Image


def make(skin, ring):
    """(8x8 face with hat layer, 20x20 framed portrait) from a 64x64 skin image."""
    rim_lit, rim_shade = pc("ramps.brass[1]"), pc("ramps.brass[3]")
    face = skin.crop((8, 8, 16, 16))
    face.alpha_composite(skin.crop((40, 8, 48, 16)))
    fr = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
    px = fr.load()
    for y in range(20):
        for x in range(20):
            if x in (0, 19) and y in (0, 19):
                continue                              # rounded corners
            if x in (0, 19) or y in (0, 19):
                px[x, y] = rim_shade if (x == 19 or y == 19) else rim_lit
            elif x in (1, 18) or y in (1, 18):
                px[x, y] = ring
    fr.paste(scale_nearest(face, 2), (2, 2))
    return face, fr


def build():
    cast = json.load(open(ROOT / "cast.json", encoding="utf-8"))["agents"]
    out = OUT / "textures" / "gui" / "portrait"
    for a in cast:
        skin = Image.open(OUT / "textures" / "entity" / "agent" / f"{a['id']}.png").convert("RGBA")
        face, fr = make(skin, hex2rgba(a["color"]))
        save_png(face, out / f"{a['id']}.png")
        save_png(fr, out / f"{a['id']}_framed.png")
    print("portraits ->", out)


if __name__ == "__main__":
    build()

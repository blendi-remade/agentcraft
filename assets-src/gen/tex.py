"""Tiny pixel-texture toolkit for 16x16 block textures and GUI sprites."""
from __future__ import annotations

from common import PALETTE, hex2rgba, paint_grid
from PIL import Image

CLEAR = (0, 0, 0, 0)


def tones(name):
    for g in ("ramps",):
        if name in PALETTE[g]:
            return [hex2rgba(t) for t in PALETTE[g][name]["tones"]]
    for g in ("status_ramps", "cast_ramps", "skin_tones", "hair"):
        if name in PALETTE[g]:
            return [hex2rgba(t) for t in PALETTE[g][name]]
    raise KeyError(name)


def new(w=16, h=16, fill=CLEAR):
    return Image.new("RGBA", (w, h), fill)


def grid(img, rows, legend, x=0, y=0):
    return paint_grid(img, x, y, rows, legend)


def from_grid(rows, legend):
    img = new(len(rows[0]), len(rows))
    for r in rows:
        assert len(r) == len(rows[0]), f"ragged grid row {r!r}"
    return grid(img, rows, legend)


def rect(img, x0, y0, x1, y1, c):
    """Fill inclusive rect."""
    px = img.load()
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            px[x, y] = c


def hline(img, x0, x1, y, c):
    rect(img, x0, y, x1, y, c)


def vline(img, x, y0, y1, c):
    rect(img, x, y0, x, y1, c)


def hsh(*vals) -> int:
    """Deterministic integer hash (no global RNG state)."""
    h = 2166136261
    for v in vals:
        h ^= (int(v) & 0xFFFFFFFF)
        h = (h * 16777619) & 0xFFFFFFFF
        h ^= h >> 13
        h = (h * 0x5BD1E995) & 0xFFFFFFFF
        h ^= h >> 15
    return h


def hf(*vals) -> float:
    return (hsh(*vals) % 10000) / 10000.0


def alpha_mask(img, keep):
    """Copy of img where pixels for which keep(x, y, rgba) is False become transparent."""
    out = img.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            if not keep(x, y, px[x, y]):
                px[x, y] = CLEAR
    return out


def ntones(img):
    return len(set(img.getdata()))

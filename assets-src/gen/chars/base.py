"""Shared legend/painting helpers for character modules."""
from __future__ import annotations

from common import PALETTE, hex2rgba, pc
from skinlib import Skin

__all__ = ["E4", "E8", "E3x4", "E3x12", "E4x12", "H", "P", "Skin", "T", "blank", "faces", "legend_hair", "legend_skin", "row_only"]


def T(group, name):
    """Tones of a palette group entry as an RGBA list (lightest -> darkest)."""
    g = PALETTE[group][name]
    return [hex2rgba(t) for t in (g["tones"] if isinstance(g, dict) else g)]


def H(h):
    return hex2rgba(h)


def P(path):
    """A palette entry by path, e.g. P("ramps.cream[1]"), P("details.kit.eye")."""
    return pc(path)


def legend_skin(tone):
    t = T("skin_tones", tone)
    return {"h": t[0], "S": t[1], "s": t[2], "d": t[3]}


def legend_hair(name):
    t = T("hair", name)
    return {"J": t[0], "H": t[1], "G": t[2], "K": t[3]}


def faces(sk, part, layer, legend, **grids):
    for face, rows in grids.items():
        sk.grid(part, layer, face, rows, legend)


def blank(w, h):
    return ["." * w] * h


E8 = blank(8, 8)
E4 = blank(4, 4)
E3x4 = blank(3, 4)
E4x12 = blank(4, 12)
E3x12 = blank(3, 12)


def row_only(w, h, rows: dict):
    """Overlay grid that is transparent except the given {row_index: row_string}."""
    out = ["." * w] * h
    out = list(out)
    for i, r in rows.items():
        assert len(r) == w, (r, w)
        out[i] = r
    return out

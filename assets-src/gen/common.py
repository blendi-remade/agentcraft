"""Shared helpers for the AgentCraft art pipeline.

Everything here is deterministic: no randomness without an explicit seed, and PNGs are
written without timestamps so re-running a generator produces byte-identical files.
"""
from __future__ import annotations

import json
import random
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent          # assets-src/
PROJECT = ROOT.parent                                   # repo root
OUT = ROOT / "out" / "assets" / "agentcraft"            # mirrors mod resources
ART = PROJECT / "artifacts" / "art"                     # review renders / sheets


def load_json(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


PALETTE = load_json(ROOT / "palette.json")


def hex2rgba(h: str, a: int = 255):
    h = h.lstrip("#")
    if len(h) == 8:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4, 6))
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def rgba2hex(c) -> str:
    return "#%02X%02X%02X" % tuple(c[:3])


def ramp(name: str):
    """Return the tones of a material ramp (lightest -> darkest) as RGBA tuples."""
    for group in ("ramps",):
        if name in PALETTE[group]:
            return [hex2rgba(t) for t in PALETTE[group][name]["tones"]]
    for group in ("status_ramps", "cast_ramps", "skin_tones", "hair"):
        if name in PALETTE[group]:
            return [hex2rgba(t) for t in PALETTE[group][name]]
    raise KeyError(name)


def ramp_base(name: str) -> int:
    if name in PALETTE["ramps"]:
        return PALETTE["ramps"][name]["base"]
    return 1


def color(name: str):
    for group in ("colors", "status", "ui"):
        if name in PALETTE[group]:
            return hex2rgba(PALETTE[group][name])
    raise KeyError(name)


def pal_hex(path: str) -> str:
    """Hex string of a palette entry by path: 'colors.cream', 'ui.edge', 'details.kit.eye',
    'ramps.brass[2]' (ramp tones), 'status_ramps.error[0]', 'hair.flax[3]'."""
    m = path.rstrip("]").split("[")
    keys, idx = m[0].split("."), (int(m[1]) if len(m) > 1 else None)
    node = PALETTE
    for k in keys:
        node = node[k]
    if isinstance(node, dict) and "tones" in node:
        node = node["tones"]
    if idx is not None:
        node = node[idx]
    if not isinstance(node, str):
        raise KeyError(f"palette path {path!r} is not a single colour")
    return node


def pc(path: str, a: int = 255):
    """RGBA of a palette entry by path (see pal_hex)."""
    return hex2rgba(pal_hex(path), a)


def mix(c1, c2, t: float):
    return tuple(int(round(c1[i] + (c2[i] - c1[i]) * t)) for i in range(3)) + (
        int(round(c1[3] + (c2[3] - c1[3]) * t)) if len(c1) > 3 and len(c2) > 3 else 255,)


def with_alpha(c, a: int):
    return (c[0], c[1], c[2], a)


def ensure_dir(p: Path):
    p.mkdir(parents=True, exist_ok=True)
    return p


def save_png(img: Image.Image, path: Path):
    ensure_dir(path.parent)
    # No metadata, fixed compression -> byte-identical re-runs.
    img.save(path, format="PNG", optimize=False, compress_level=9)


def write_json(path: Path, data, compact=False):
    ensure_dir(path.parent)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        if compact:
            json.dump(data, f, separators=(",", ":"))
        else:
            json.dump(data, f, indent=2)
            f.write("\n")


def rng(seed) -> random.Random:
    return random.Random(seed)


def paint_grid(img: Image.Image, x0: int, y0: int, rows, legend, transparent=".", skip=" "):
    """Paint a literal character grid. `legend` maps chars to RGBA (or None = transparent).

    '.' writes transparent pixels, ' ' leaves the existing pixel untouched.
    """
    px = img.load()
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == skip:
                continue
            if ch == transparent:
                px[x0 + x, y0 + y] = (0, 0, 0, 0)
                continue
            if ch not in legend:
                raise KeyError(f"legend missing {ch!r} (row {y}: {row!r})")
            c = legend[ch]
            px[x0 + x, y0 + y] = (0, 0, 0, 0) if c is None else c
    return img


def scale_nearest(img: Image.Image, k: int) -> Image.Image:
    return img.resize((img.width * k, img.height * k), Image.NEAREST)

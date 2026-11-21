"""Validate + sync the cast identity palette.

- identity colour = palette.cast_ramps[id][2]  -> cast.json `color`
- checks CIEDE2000 distance vs every status colour (>= 25) and between agents (>= 18)
- checks every `accent` is >= 20 CIEDE2000 from every status colour (accents are trims; they must
  never read as a state either)
- derives text tints with WCAG contrast against EVERY surface a name is drawn on:
  `text_on_dark`  >= 4.5:1 on all DARK_SURFACES (and >= 5.5:1 on plain ink),
  `text_on_light` >= 4.5:1 on all LIGHT_SURFACES
Writes the results (and the measured worst case per agent) back into cast.json.
"""
from __future__ import annotations

import itertools
import json
import math
import sys

from common import PALETTE, ROOT, hex2rgba, mix, pal_hex, rgba2hex


def _lin(c):
    c = c / 255
    return ((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92


def lab(h):
    r, g, b = (_lin(v) for v in hex2rgba(h)[:3])
    x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
    y = r * 0.2126 + g * 0.7152 + b * 0.0722
    z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883
    def f(t):
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    return 116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))


def de00(c1, c2):
    L1, a1, b1 = lab(c1)
    L2, a2, b2 = lab(c2)
    C1, C2 = math.hypot(a1, b1), math.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360
    h2p = math.degrees(math.atan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dhp = h2p - h1p
    if C1p * C2p == 0:
        dhp = 0
    elif dhp > 180:
        dhp -= 360
    elif dhp < -180:
        dhp += 360
    dHp = 2 * math.sqrt(C1p * C2p) * math.sin(math.radians(dhp / 2))
    Lbp, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    if C1p * C2p == 0:
        hbp = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        hbp = (h1p + h2p) / 2
    elif h1p + h2p < 360:
        hbp = (h1p + h2p + 360) / 2
    else:
        hbp = (h1p + h2p - 360) / 2
    T = (1 - 0.17 * math.cos(math.radians(hbp - 30)) + 0.24 * math.cos(math.radians(2 * hbp))
         + 0.32 * math.cos(math.radians(3 * hbp + 6)) - 0.20 * math.cos(math.radians(4 * hbp - 63)))
    dth = 30 * math.exp(-((hbp - 275) / 25) ** 2)
    Rc = 2 * math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
    Sl = 1 + 0.015 * (Lbp - 50) ** 2 / math.sqrt(20 + (Lbp - 50) ** 2)
    Sc, Sh = 1 + 0.045 * Cbp, 1 + 0.015 * Cbp * T
    Rt = -math.sin(math.radians(2 * dth)) * Rc
    return math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))


def luminance(h):
    r, g, b = (_lin(v) for v in hex2rgba(h)[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def toward(h, target, ratio, bg):
    """Mix colour h toward target until contrast with bg >= ratio."""
    return toward_all(h, target, {bg: ratio})


def toward_all(h, target, ratios):
    """Mix colour h toward target until contrast with every bg in ratios {bg_hex: ratio} holds."""
    c, t = hex2rgba(h), hex2rgba(target)
    for k in range(101):
        m = tuple(round(c[i] + (t[i] - c[i]) * k / 100) for i in range(3))
        hx = rgba2hex(m)
        if all(contrast(hx, bg) >= r for bg, r in ratios.items()):
            return hx
    return target


def _nameplate_worst():
    """kit/nameplate is translucent ink (palette ui.nameplate, alpha included) over the world;
    worst case = composited over the brightest palette surface (ui.panel_hi)."""
    plate, hi = hex2rgba(pal_hex("ui.nameplate")), hex2rgba(pal_hex("ui.panel_hi"))
    return rgba2hex(mix(hi, plate[:3] + (255,), plate[3] / 255))


DARK_SURFACES = {
    "nameplate over a bright wall": _nameplate_worst(),
    "ink (HUD, console)": pal_hex("ramps.ink[2]"),
    "tooltip": pal_hex("ui.tooltip"),
}
LIGHT_SURFACES = {
    "cream panel": pal_hex("ui.panel"),
    "panel highlight / field": pal_hex("ui.panel_hi"),
    "paper inset / done card": pal_hex("ui.inset"),
    "panel shade / inactive tab": pal_hex("ui.panel_shade"),
    "monitor screen (paper)": pal_hex("ramps.screen_on[1]"),
    "monitor scanline": pal_hex("ramps.screen_on[2]"),
}


def worst_contrast(fg, surfaces):
    name = min(surfaces, key=lambda k: contrast(fg, surfaces[k]))
    return round(contrast(fg, surfaces[name]), 2), name


def main():
    cast_path = ROOT / "cast.json"
    cast = json.load(open(cast_path, encoding="utf-8"))
    status = PALETTE["status"]
    ok = True
    ids = [a["id"] for a in cast["agents"]]
    colors = {}
    for a in cast["agents"]:
        ramp = PALETTE["cast_ramps"][a["id"]]
        a["color"] = ramp[2]
        a["ramp"] = ramp
        dark = {v: 4.5 for v in DARK_SURFACES.values()}
        dark[DARK_SURFACES["ink (HUD, console)"]] = 5.5
        a["text_on_dark"] = toward_all(ramp[2], pal_hex("colors.white"), dark)
        a["text_on_light"] = toward_all(ramp[2], pal_hex("ui.text"), {v: 4.5 for v in LIGHT_SURFACES.values()})
        a["contrast"] = {"text_on_dark_min": worst_contrast(a["text_on_dark"], DARK_SURFACES),
                         "text_on_light_min": worst_contrast(a["text_on_light"], LIGHT_SURFACES)}
        colors[a["id"]] = ramp[2]
    print("identity vs status (CIEDE2000, need >= 25):")
    for i in ids:
        ds = {s: de00(colors[i], v) for s, v in status.items()}
        worst = min(ds, key=ds.get)
        flag = "" if ds[worst] >= 25 else "  <-- TOO CLOSE"
        ok &= ds[worst] >= 25
        print(f"  {i:8s} {colors[i]}  min {ds[worst]:5.1f} ({worst}){flag}")
    print("accent vs status (CIEDE2000, need >= 20):")
    for a in cast["agents"]:
        ds = {k: de00(a["accent"], v) for k, v in status.items()}
        w_ = min(ds, key=ds.get)
        ok &= ds[w_] >= 20
        print(f"  {a['id']:8s} {a['accent']}  min {ds[w_]:5.1f} ({w_}){'' if ds[w_] >= 20 else '  <-- TOO CLOSE'}")
    print("name tints, worst contrast over all surfaces (need >= 4.5):")
    for a in cast["agents"]:
        d_, l_ = a["contrast"]["text_on_dark_min"], a["contrast"]["text_on_light_min"]
        ok &= d_[0] >= 4.5 and l_[0] >= 4.5
        print(f"  {a['id']:8s} dark {a['text_on_dark']} {d_[0]}:1 ({d_[1]})   light {a['text_on_light']} {l_[0]}:1 ({l_[1]})")
    print("identity vs identity (need >= 18):")
    pairs = []
    for x, y in itertools.combinations(ids, 2):
        d = de00(colors[x], colors[y])
        pairs.append((d, x, y))
        ok &= d >= 18
    for d, x, y in sorted(pairs)[:6]:
        print(f"  {x:8s} {y:8s} {d:5.1f}{'  <-- TOO CLOSE' if d < 18 else ''}")
    cast["checks"] = {
        "min_de_vs_status": round(min(de00(colors[i], v) for i in ids for v in status.values()), 1),
        "min_de_between_agents": round(min(p[0] for p in pairs), 1),
        "min_de_accent_vs_status": round(min(de00(a["accent"], v) for a in cast["agents"] for v in status.values()), 1),
        "min_contrast_text_on_dark": min(a["contrast"]["text_on_dark_min"][0] for a in cast["agents"]),
        "min_contrast_text_on_light": min(a["contrast"]["text_on_light_min"][0] for a in cast["agents"]),
        "dark_surfaces": DARK_SURFACES,
        "light_surfaces": LIGHT_SURFACES,
    }
    with open(cast_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(cast, f, indent=2)
        f.write("\n")
    print("checks", cast["checks"], "OK" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.exit(0 if main() else 1)

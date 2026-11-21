"""AgentCraft agent skins: six hand-authored 64x64 player-format skins.

Each character lives in gen/chars/<id>.py and paints every face as a literal pixel grid
(see skinlib.py for face orientation rules). Shared letter conventions keep grids readable:
  skin  h S s d  (hi, base, shade, deep)     hair  J H G K (hi, base, shade, deep)
  eyes  w e                                   mouth m
  '.' transparent (overlay only)
Left limbs are mirrored from right limbs, then touched up where asymmetry matters.

python gen/skins.py [id ...]
"""
from __future__ import annotations

import importlib
import sys

from common import OUT, save_png

CAST = ["marlow", "juniper", "kit", "wren", "rowan", "tove"]


def build(ids=None):
    out = OUT / "textures" / "entity" / "agent"
    results = {}
    for cid in CAST:
        if ids and cid not in ids:
            continue
        mod = importlib.import_module(f"chars.{cid}")
        sk = mod.build()
        probs = sk.validate()
        if probs:
            raise SystemExit(f"{cid}: skin validation failed:\n  " + "\n  ".join(probs[:20]))
        save_png(sk.img, out / f"{cid}.png")
        results[cid] = out / f"{cid}.png"
        print("skin", cid, "ok")
    return results


if __name__ == "__main__":
    build(sys.argv[1:] or None)

"""Regenerate every AgentCraft art asset.

    assets-src/.venv/Scripts/python assets-src/build.py            # all shipped assets (no Blender, ~3 s)
    assets-src/.venv/Scripts/python assets-src/build.py --sheets   # + Blender renders + review sheets
    assets-src/.venv/Scripts/python assets-src/build.py --verify   # rebuild in 2 fresh processes with different
                                                                   # PYTHONHASHSEEDs, assert byte-identical output

Outputs land in assets-src/out/assets/agentcraft (mirrors the mod's resources); review renders
and sheets in artifacts/art/. Nothing here writes into mod/ - use sync.py for that.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "gen"))

blocks = importlib.import_module("blocks")
cast_check = importlib.import_module("cast_check")
gui = importlib.import_module("gui")
models = importlib.import_module("models")
portraits = importlib.import_module("portraits")
sheets = importlib.import_module("sheets")
skins = importlib.import_module("skins")
ui_style = importlib.import_module("ui_style")
common = importlib.import_module("common")
OUT, ROOT, write_json = common.OUT, common.ROOT, common.write_json


def build_assets():
    t = time.time()
    if OUT.exists():
        shutil.rmtree(OUT)
    if not cast_check.main():
        raise SystemExit("cast palette check failed")
    skins.build()
    portraits.build()
    blocks.build()
    models.build()
    gui.build()
    ui_style.build()
    # ship the palette + cast so the mod can read colours at runtime
    import json
    write_json(OUT / "palette.json", json.load(open(ROOT / "palette.json", encoding="utf-8")))
    write_json(OUT / "cast.json", json.load(open(ROOT / "cast.json", encoding="utf-8")))
    n = sum(1 for p in OUT.rglob("*") if p.is_file())
    import validate
    if not validate.main():
        raise SystemExit("resource validation failed")
    import readme
    readme.build()
    print(f"built {n} files in {time.time() - t:.1f}s -> {OUT}")


def tree_hash():
    h = hashlib.sha256()
    for p in sorted(OUT.rglob("*")):
        if p.is_file():
            h.update(p.relative_to(OUT).as_posix().encode())
            h.update(p.read_bytes())
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheets", action="store_true", help="also run Blender renders + contact sheets")
    ap.add_argument("--verify", action="store_true", help="build twice and check determinism")
    a = ap.parse_args()
    build_assets()
    if a.verify:
        # Fresh interpreters with different hash seeds: catches set/dict-order dependence and any
        # state carried between builds in one process. Pillow is pinned (requirements.txt) because
        # PNG bytes depend on the Pillow/zlib build.
        hashes = [tree_hash()]
        for seed in ("1", "987654"):
            env = dict(os.environ, PYTHONHASHSEED=seed)
            r = subprocess.run([sys.executable, str(Path(__file__).resolve())], env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
            if r.returncode != 0:
                sys.exit(f"rebuild with PYTHONHASHSEED={seed} failed")
            hashes.append(tree_hash())
        same = len(set(hashes)) == 1
        print("determinism:", "OK" if same else "MISMATCH", " ".join(h[:16] for h in hashes))
        if not same:
            sys.exit(1)
    if a.sheets:
        sheets.main("all")


if __name__ == "__main__":
    main()

"""Quick WIP preview: render one or more skins in Blender and montage them with the flat texture.

python gen/preview.py marlow [kit ...]      -> artifacts/art/_wip/<id>.png
python gen/preview.py --faces <ids>          -> artifacts/art/_wip/faces.png (studio light close-ups)
python gen/preview.py --heads <ids|all>      -> artifacts/art/_wip/heads_<id>.png + heads_all.png
    8-angle head close-ups (front, 3/4 both sides, sides, back, back 3/4, top, desk-height view
    from above) under vanilla entity lighting, next to the 8x flat face, the 8x portrait and the
    portrait at 1x/2x/3x GUI scale. This is the review view for faces/hair.
"""
import json
import subprocess
import sys
from pathlib import Path

import portraits
from common import ART, OUT, ROOT, ensure_dir, hex2rgba, scale_nearest
from PIL import Image, ImageDraw

BLENDER = r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
HEAD_VIEWS = ("h_front", "h_f34", "h_f34l", "h_right", "h_left", "h_back", "h_b34", "h_top", "h_desk")
BG = (233, 225, 211, 255)


def _cast():
    return {c["id"]: c for c in json.load(open(ROOT / "cast.json", encoding="utf-8"))["agents"]}


def _skin_path(i):
    """Skin for a cast id, or a prototype 'name=path[:slim]' (scratch skins for A/B tests)."""
    if "=" in i:
        name, rest = i.split("=", 1)
        slim = rest.endswith(":slim")
        return name, Path(rest[:-5] if slim else rest), slim
    return i, OUT / "textures/entity/agent" / f"{i}.png", _cast()[i]["model"] == "slim"


def _blender(ids, views, size, samples, lighting="studio", face_ortho=None, tag="preview"):
    wip = ensure_dir(ART / "_wip")
    jl = []
    for i in ids:
        name, path, slim = _skin_path(i)
        jl.append({"name": name, "skin": str(path).replace("\\", "/"), "slim": slim,
                   "views": list(views), "lighting": lighting})
    jobs = {"out_dir": str(wip).replace("\\", "/"), "size": list(size), "samples": samples, "jobs": jl}
    if face_ortho:
        jobs["face_ortho"] = face_ortho
    jp = wip / f"jobs_{tag}.json"
    jp.write_text(json.dumps(jobs), encoding="utf-8")
    with open(ensure_dir(ART.parent / "logs") / f"blender_{tag}.log", "w") as log:
        subprocess.run([BLENDER, "-b", "--factory-startup", "-P", str(ROOT / "blender/render_skins.py"), "--",
                        str(jp)], stdout=log, stderr=subprocess.STDOUT, check=True)
    return wip


def _checker(im, cell):
    chk = Image.new("RGBA", im.size, (200, 192, 180, 255))
    px = chk.load()
    for yy in range(im.height):
        for xx in range(im.width):
            if ((xx // cell) + (yy // cell)) % 2:
                px[xx, yy] = (214, 206, 194, 255)
    chk.alpha_composite(im)
    return chk


def render(ids, views=("front", "right", "back", "left", "threequarter"), size=(300, 450), samples=24):
    wip = _blender(ids, views, size, samples)
    for i in ids:
        ims = [Image.open(wip / f"{i}_{v}.png") for v in views]
        flat = scale_nearest(Image.open(OUT / "textures/entity/agent" / f"{i}.png"), 7)
        W = sum(im.width for im in ims) + flat.width + 20
        H = max(size[1], flat.height)
        m = Image.new("RGBA", (W, H), BG)
        x = 0
        for im in ims:
            m.alpha_composite(im, (x, 0))
            x += im.width
        m.alpha_composite(_checker(flat, 7), (x + 10, (H - flat.height) // 2))
        m.save(wip / f"{i}.png")
        print("wrote", wip / f"{i}.png")


def faces(ids):
    """Close-up head renders: front / 3-4 / back for each id, one row per agent."""
    views = ("face", "face34", "faceback")
    size = (360, 360)
    wip = _blender(ids, views, size, 32)
    rows = [[Image.open(wip / f"{i}_{v}.png") for v in views] for i in ids]
    m = Image.new("RGBA", (size[0] * 3, size[1] * len(ids)), BG)
    for r, row in enumerate(rows):
        for c, im in enumerate(row):
            m.alpha_composite(im, (c * size[0], r * size[1]))
    m.save(wip / "faces.png")
    print("wrote", wip / "faces.png")


def heads(ids):
    """8-angle head close-ups under vanilla entity lighting + flat face + portrait scales."""
    cell = 260
    wip = _blender(ids, HEAD_VIEWS, (cell, cell), 32, lighting="mc_entity", face_ortho=12.5, tag="heads")
    rows = []
    for spec in ids:
        i, path, _ = _skin_path(spec)
        skin = Image.open(path).convert("RGBA")
        face = skin.crop((8, 8, 16, 16))
        face.alpha_composite(skin.crop((40, 8, 48, 16)))
        # head unwrapped: base strip and overlay strip (top/bottom row + 4 side faces), 8x
        head_base = _checker(scale_nearest(skin.crop((0, 0, 32, 16)), 8), 8)
        head_over = _checker(scale_nearest(skin.crop((32, 0, 64, 16)), 8), 8)
        W = cell * len(HEAD_VIEWS)
        strip_h = head_base.height
        H = cell + 24 + strip_h + 20
        m = Image.new("RGBA", (W, H), BG)
        d = ImageDraw.Draw(m)
        for k, v in enumerate(HEAD_VIEWS):
            m.alpha_composite(Image.open(wip / f"{i}_{v}.png"), (k * cell, 0))
            d.text((k * cell + 6, cell + 4), v[2:], fill=(60, 50, 40, 255))
        y = cell + 24
        m.alpha_composite(head_base, (0, y))
        m.alpha_composite(head_over, (head_base.width + 12, y))
        x = head_base.width * 2 + 24
        m.alpha_composite(scale_nearest(face, 16), (x, y))         # 128 px: the face as authored
        x += 128 + 16
        cid = i.split("_")[0]
        ring = hex2rgba(_cast()[cid]["color"]) if cid in _cast() else (128, 128, 128, 255)
        _, framed = portraits.make(skin, ring)
        for s in (1, 2, 3, 6):                                     # portrait at GUI scales
            p = scale_nearest(framed, s)
            m.alpha_composite(p, (x, y))
            x += p.width + 10
        d.text((6, H - 16), i, fill=(31, 30, 29, 255))
        m.save(wip / f"heads_{i}.png")
        rows.append(m)
        print("wrote", wip / f"heads_{i}.png")
    if len(rows) > 1:
        allm = Image.new("RGBA", (rows[0].width, sum(r.height for r in rows)), BG)
        y = 0
        for r in rows:
            allm.alpha_composite(r, (0, y))
            y += r.height
        allm.save(wip / "heads_all.png")
        print("wrote", wip / "heads_all.png")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--faces"]:
        faces(sys.argv[2:])
    elif sys.argv[1:2] == ["--heads"]:
        ids = sys.argv[2:]
        if not ids or ids == ["all"]:
            ids = list(_cast())
        heads(ids)
    elif sys.argv[1:2] == ["--compare"]:
        # --compare out.png name=path ... : heads for prototypes stacked into one image
        dst, ids = sys.argv[2], sys.argv[3:]
        heads(ids)
        ims = [Image.open(ART / "_wip" / f"heads_{_skin_path(i)[0]}.png") for i in ids]
        mm = Image.new("RGBA", (max(im.width for im in ims), sum(im.height for im in ims)), BG)
        y = 0
        for im in ims:
            mm.alpha_composite(im, (0, y))
            y += im.height
        mm.save(dst)
        print("wrote", dst)
    else:
        render(sys.argv[1:])

"""Static checks on the generated resource tree (run by build.py; exits non-zero on problems).

- every blockstate model / item model / model parent / texture reference resolves to a file
- element coordinates within vanilla limits (-16..32), rotation angle in the legal set, light 0..15
- face uv within 0..16; every face texture variable resolves
- GUI .mcmeta nine_slice borders fit inside their sprites
- skins: base layer opaque, overlay alpha binary (re-checked on the written PNGs)
- palette is the single source of colour: no quoted hex literal in any shipping generator; every
  cast colour/accent is a palette entry; reports how many distinct shipped colours are palette
  entries vs derived blends
- framed textures (glow panel, status lamps) have mirror-symmetric frames (catches off-by-one rows)
- every kit sprite that declares a 9-slice has its .mcmeta, and nothing else does
- emissive models: "ambientocclusion": false and every light_emission element
  "shade_direction_override": "up"; the obsolete "shade" key (ignored by 26.3) is refused anywhere
- no z-fight hazards: two same-direction faces in one model that overlap and lie closer than
  0.25 px without being bit-identical planes (exactly coplanar is only allowed for an emissive
  duplicate drawn after its base, vanilla's cross_emissive pattern)
- connectable panels: every property combination applies exactly one panel body (monitor glint)
- resource ids: every shipped file path and every identifier referenced from JSON (models,
  parents, textures, blockstate/item model refs) matches Minecraft's rules - namespace
  [a-z0-9_.-], path [a-z0-9_.-/] - an uppercase letter makes the game drop the file and fail every
  blockstate that names it (found in game: monitor_corner_*_L)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from common import OUT, PALETTE
from PIL import Image

VANILLA_PARENTS = {"minecraft:block/block", "minecraft:block/cube", "minecraft:block/cube_all",
                   "minecraft:block/cube_column", "minecraft:block/cube_bottom_top", "minecraft:block/orientable"}


def rl_path(rl, kind):
    ns, path = rl.split(":", 1)
    if kind == "model":
        return OUT.parent / ns / "models" / f"{path}.json"
    return OUT.parent / ns / "textures" / f"{path}.png"


def main():
    problems = []
    models = {}
    for p in (OUT / "models").rglob("*.json"):
        rl = "agentcraft:" + p.relative_to(OUT / "models").with_suffix("").as_posix()
        models[rl] = json.loads(p.read_text(encoding="utf-8"))

    def resolve_textures(rl, seen=()):
        if rl in VANILLA_PARENTS:
            return {}
        m = models.get(rl)
        if m is None:
            problems.append(f"missing model {rl}")
            return {}
        tex = {}
        if "parent" in m:
            tex.update(resolve_textures(m["parent"], seen + (rl,)))
        tex.update(m.get("textures", {}))
        return tex

    for rl, m in models.items():
        par = m.get("parent")
        if par and par not in VANILLA_PARENTS and par not in models:
            problems.append(f"{rl}: unknown parent {par}")
        tex = resolve_textures(rl)
        for k, v in tex.items():
            if not v.startswith("#") and not rl_path(v, "texture").exists():
                problems.append(f"{rl}: texture {k}={v} missing")
        for i, e in enumerate(m.get("elements", [])):
            for c in e["from"] + e["to"]:
                if not -16 <= c <= 32:
                    problems.append(f"{rl} el{i}: coord {c} out of range")
            r = e.get("rotation")
            if r and r["angle"] not in (-45, -22.5, 0, 22.5, 45):
                problems.append(f"{rl} el{i}: rotation {r['angle']}")
            le = e.get("light_emission", 0)
            if not 0 <= le <= 15:
                problems.append(f"{rl} el{i}: light_emission {le}")
            for d, f in e["faces"].items():
                for u in f.get("uv", []):
                    if not 0 <= u <= 16:
                        problems.append(f"{rl} el{i} {d}: uv {u}")
                ref = f["texture"]
                name = ref[1:] if ref.startswith("#") else None
                seen = 0
                while name is not None and seen < 10:
                    val = tex.get(name)
                    if val is None:
                        problems.append(f"{rl} el{i} {d}: unresolved #{name}")
                        break
                    name = val[1:] if val.startswith("#") else None
                    seen += 1
    for p in (OUT / "blockstates").glob("*.json"):
        bs = json.loads(p.read_text(encoding="utf-8"))
        refs = [v["model"] for v in bs.get("variants", {}).values()]
        refs += [part["apply"]["model"] for part in bs.get("multipart", [])]
        for r in refs:
            if r not in models:
                problems.append(f"blockstate {p.stem}: model {r} missing")
    for p in (OUT / "items").glob("*.json"):
        it = json.loads(p.read_text(encoding="utf-8"))
        r = it["model"]["model"]
        if r not in models:
            problems.append(f"item {p.stem}: model {r} missing")
        if not (OUT / "blockstates" / p.name).exists():
            problems.append(f"item {p.stem}: no matching blockstate")
    for p in (OUT / "textures" / "gui" / "sprites").rglob("*.png.mcmeta"):
        meta = json.loads(p.read_text(encoding="utf-8"))["gui"]["scaling"]
        img = Image.open(p.with_suffix(""))
        b = meta["border"]
        if (meta["width"], meta["height"]) != img.size:
            problems.append(f"{p.name}: mcmeta size {meta['width']}x{meta['height']} != {img.size}")
        if b["left"] + b["right"] >= img.width or b["top"] + b["bottom"] >= img.height:
            problems.append(f"{p.name}: border {b} leaves no centre in {img.size}")
    lang = json.loads((OUT / "lang" / "en_us.json").read_text(encoding="utf-8"))
    for p in (OUT / "blockstates").glob("*.json"):
        if f"block.agentcraft.{p.stem}" not in lang:
            problems.append(f"lang: block.agentcraft.{p.stem} missing")
    from skinlib import FACES, PARTS, face_rect
    cast = json.loads((OUT / "cast.json").read_text(encoding="utf-8"))["agents"]
    for a in cast:
        img = Image.open(OUT / "textures" / "entity" / "agent" / f"{a['id']}.png").convert("RGBA")
        assert img.size == (64, 64)
        slim = a["model"] == "slim"
        for part in PARTS:
            for f in FACES:
                x, y, w, h = face_rect(part, "base", f, slim)
                if any(img.getpixel((x + i, y + j))[3] != 255 for j in range(h) for i in range(w)):
                    problems.append(f"skin {a['id']}: base {part}.{f} not opaque")
                x, y, w, h = face_rect(part, "overlay", f, slim)
                if any(img.getpixel((x + i, y + j))[3] not in (0, 255) for j in range(h) for i in range(w)):
                    problems.append(f"skin {a['id']}: overlay {part}.{f} has partial alpha")
    problems += blockstate_coverage()
    problems += palette_checks(cast)
    problems += frame_symmetry()
    problems += kit_meta_checks()
    problems += emissive_and_coplanar(models)
    problems += resource_ids()
    print(f"validate: {len(models)} models, {len(list((OUT / 'blockstates').glob('*.json')))} blockstates, "
          f"{len(list((OUT / 'items').glob('*.json')))} items, {len(cast)} skins -> "
          + ("OK" if not problems else f"{len(problems)} problems"))
    for pr in problems[:50]:
        print("  ", pr)
    return not problems


def _match(cond, props):
    if "OR" in cond:
        return any(_match(c, props) for c in cond["OR"])
    if "AND" in cond:
        return all(_match(c, props) for c in cond["AND"])
    return all(str(props.get(k)) in str(v).split("|") for k, v in cond.items())


def blockstate_coverage():
    """Every combination of the declared property values must resolve: variants -> exactly one
    key matches; multipart -> at least one part applies. Also no variant key may use an
    undeclared property or value."""
    import itertools

    from models import PROPERTY_DOMAINS
    probs, combos = [], 0
    for block, dom in PROPERTY_DOMAINS.items():
        bs = json.loads((OUT / "blockstates" / f"{block}.json").read_text(encoding="utf-8"))
        names = sorted(dom)
        for key in bs.get("variants", {}):
            for kv in filter(None, key.split(",")):
                k, v = kv.split("=")
                if k not in dom or v not in dom[k]:
                    probs.append(f"{block}: variant key {key!r} uses undeclared {k}={v}")
        for values in itertools.product(*(dom[n] for n in names)):
            props = dict(zip(names, values))
            combos += 1
            if "variants" in bs:
                hits = [k for k in bs["variants"]
                        if all(props.get(a) == b for a, b in (kv.split("=") for kv in k.split(",") if kv))]
                if len(hits) != 1:
                    probs.append(f"{block} {props}: {len(hits)} variant matches")
            if "multipart" in bs:
                applied = [part["apply"]["model"] for part in bs["multipart"]
                           if "when" not in part or _match(part["when"], props)]
                if not applied:
                    probs.append(f"{block} {props}: no multipart part applies")
                panels = [mm for mm in applied if "_panel_" in mm]
                if any("_panel_" in part["apply"]["model"] for part in bs["multipart"]) and len(panels) != 1:
                    probs.append(f"{block} {props}: {len(panels)} panel bodies apply {panels}")
    print(f"blockstates: {combos} property combinations resolve")
    return probs


SHIPPING_GENERATORS = ["common.py", "tex.py", "skinlib.py", "skins.py", "portraits.py", "blocks.py", "models.py",
                       "gui.py", "ui_style.py", "cast_check.py", "chars/*.py"]


def _palette_values():
    vals = set()

    def walk(n):
        if isinstance(n, str) and n.startswith("#"):
            vals.add(n.upper()[:7])
        elif isinstance(n, dict):
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for v in n:
                walk(v)
    walk(PALETTE)
    return vals


def palette_checks(cast):
    import re
    probs = []
    gen = Path(__file__).parent
    lit = re.compile(r"""["']#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?["']""")
    for pat in SHIPPING_GENERATORS:
        for f in sorted(gen.glob(pat)):
            for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
                for m in lit.finditer(line):
                    probs.append(f"{f.relative_to(gen).as_posix()}:{n}: colour literal {m.group(0)} (use a palette entry)")
    vals = _palette_values()
    for a in cast:
        for k in ("color", "accent"):
            if a[k].upper() not in vals:
                probs.append(f"cast {a['id']}.{k} {a[k]} is not a palette entry")
    # coverage report (informational): distinct opaque colours in shipped PNGs
    seen = set()
    for p in OUT.rglob("*.png"):
        im = Image.open(p).convert("RGBA")
        for c in set(im.getdata()):
            if c[3] == 255:
                seen.add("#%02X%02X%02X" % c[:3])
    inpal = len([c for c in seen if c in vals])
    print(f"palette: {len(seen)} distinct opaque colours shipped, {inpal} are palette entries, "
          f"{len(seen) - inpal} are blends of palette entries")
    return probs


FRAMED = ["glow_panel", "status_lamp_cap"] + [f"status_lamp_{s}" for s in
                                              ("off", "idle", "thinking", "working", "waiting", "error", "done")]


def frame_symmetry(width=2):
    """Lit-top-left frames must be mirror-symmetric about the main diagonal (top row == left column,
    bottom row == right column, ...) within the outer `width` px."""
    probs = []
    for name in FRAMED:
        im = Image.open(OUT / "textures" / "block" / f"{name}.png").convert("RGBA")
        px = im.load()
        for y in range(16):
            for x in range(16):
                if min(x, y, 15 - x, 15 - y) < width and px[x, y] != px[y, x]:
                    probs.append(f"{name}: frame not symmetric at ({x},{y}) vs ({y},{x})")
                    break
    return probs


def resource_ids():
    import re
    ns_ok, path_ok = re.compile(r"^[a-z0-9_.-]+$"), re.compile(r"^[a-z0-9_./-]+$")
    probs, n_files, n_refs = [], 0, 0
    root = OUT.parent
    for p in sorted(root.rglob("*")):
        if p.is_file():
            n_files += 1
            rel = p.relative_to(root).as_posix()
            ns, _, rest = rel.partition("/")
            if not ns_ok.match(ns) or not path_ok.match(rest):
                probs.append(f"invalid resource path (must be [a-z0-9_.-/]): {rel}")

    def walk(o, where):
        nonlocal n_refs
        if isinstance(o, dict):
            for k, v in o.items():
                if k in ("model", "parent", "texture") or (where.endswith("textures") and isinstance(v, str)):
                    if isinstance(v, str) and not v.startswith("#"):
                        n_refs += 1
                        ns, _, path = v.rpartition(":")
                        if (ns and not ns_ok.match(ns)) or not path_ok.match(path):
                            probs.append(f"invalid identifier {v!r} in {where}")
                walk(v, where + "/" + k if k == "textures" else where)
        elif isinstance(o, list):
            for v in o:
                walk(v, where)

    for p in sorted(OUT.rglob("*.json")):
        if any(part in ("blockstates", "models", "items") for part in p.relative_to(OUT).parts):
            walk(json.loads(p.read_text(encoding="utf-8")), p.relative_to(OUT).as_posix())
    print(f"resource ids: {n_files} file paths and {n_refs} identifier references valid" if not probs
          else f"resource ids: {len(probs)} problems")
    return probs


_PLANE = {"north": (2, "from"), "south": (2, "to"), "west": (0, "from"), "east": (0, "to"),
          "down": (1, "from"), "up": (1, "to")}


def emissive_and_coplanar(models, gap=0.25):
    probs, pairs = [], 0
    for rl, m in sorted(models.items()):
        els = m.get("elements", [])
        for i, e in enumerate(els):
            if "shade" in e:
                probs.append(f"{rl}: element {i} uses \"shade\", which 26.3 ignores (use shade_direction_override)")
        if any("light_emission" in e for e in els):
            if m.get("ambientocclusion", True):
                probs.append(f"{rl}: has emissive elements but ambientocclusion is not false")
            for i, e in enumerate(els):
                if "light_emission" in e and e.get("shade_direction_override") != "up":
                    probs.append(f"{rl}: emissive element {i} without \"shade_direction_override\": \"up\"")
        for i in range(len(els)):
            for j in range(i + 1, len(els)):
                a, b = els[i], els[j]
                if a.get("rotation") != b.get("rotation"):
                    continue
                for d in set(a["faces"]) & set(b["faces"]):
                    ax, side = _PLANE[d]
                    pa, pb = a[side][ax], b[side][ax]
                    if abs(pa - pb) >= gap:
                        continue
                    others = [k for k in range(3) if k != ax]
                    if not all(min(a["to"][k], b["to"][k]) - max(a["from"][k], b["from"][k]) > 0 for k in others):
                        continue
                    pairs += 1
                    if pa != pb:
                        probs.append(f"{rl}: elements {i}/{j} {d} faces {abs(pa - pb):.3f} px apart (z-fight)")
                    elif "light_emission" not in b:
                        probs.append(f"{rl}: elements {i}/{j} {d} faces coplanar without an emissive duplicate")
                    elif a["from"] != b["from"] or a["to"] != b["to"]:
                        probs.append(f"{rl}: emissive element {j} is coplanar with {i} but not an exact duplicate")
    print(f"emissive/coplanar: {pairs} coplanar face pairs, all exact emissive duplicates" if not probs
          else f"emissive/coplanar: {len(probs)} problems")
    return probs


def kit_meta_checks():
    probs = []
    kit = json.loads((OUT / "gui" / "kit.json").read_text(encoding="utf-8"))["sprites"]
    base = OUT / "textures" / "gui" / "sprites" / "kit"
    for name, m in kit.items():
        has = (base / f"{name}.png.mcmeta").exists()
        if ("slice" in m) != has:
            probs.append(f"kit {name}: slice={'slice' in m} but mcmeta={'yes' if has else 'no'}")
    n9 = sum(1 for m in kit.values() if "slice" in m)
    print(f"kit: {len(kit)} sprites, {n9} nine-slice (with .mcmeta), {len(kit) - n9} fixed-size")
    return probs


if __name__ == "__main__":
    sys.exit(0 if main() else 1)

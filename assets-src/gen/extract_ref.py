"""Extract the vanilla reference assets that the review sheets compare against (never shipped).

The sheets put our blocks next to vanilla materials (calcite, stripped oak, dark oak, cut
copper...) and lay out GUI mock-ups with the real Minecraft font, so they need a few files from
the Minecraft client jar. Nothing is downloaded here: the jar is the one Fabric Loom fetches from
Mojang and caches the first time the mod is built (`mod/gradlew build`, run with
GRADLE_USER_HOME=<repo>/.gradle-home as the project rules require).

Writes (gitignored, under artifacts/art/_ref/):
  font/ascii.png, font/ascii_provider.json      vanilla bitmap font + its glyph table
  vanilla_assets/minecraft/textures/block/*.png every vanilla block texture (+ .mcmeta)
  vanilla_assets/minecraft/models/block/*.json  every vanilla block model
  vanilla/<name>.png                            flat copies of the reference materials + steve/alex
  SOURCE.json                                   which jar it came from (re-extracts when that changes)

python gen/extract_ref.py [--jar PATH] [--force]
Jar search order: --jar, $AGENTCRAFT_MC_JAR, $GRADLE_USER_HOME, <repo>/.gradle-home, ~/.gradle
(fabric-loom/<minecraft_version>/minecraft-client.jar, then Loom's minecraftMaven client jar).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import zipfile
from pathlib import Path

from common import ART, PROJECT, ensure_dir

REF = ART / "_ref"
FLAT = ["calcite", "white_concrete", "stripped_oak_log", "stripped_oak_log_top", "birch_planks",
        "dark_oak_planks", "dark_oak_log", "stripped_dark_oak_log", "stripped_dark_oak_log_top",
        "cut_copper", "copper_block", "terracotta", "white_terracotta", "bookshelf", "oak_planks",
        "pale_oak_planks", "oak_log", "smooth_stone", "quartz_block_bottom", "glass", "lantern",
        "moss_block", "redstone_lamp", "redstone_lamp_on", "lectern_base", "lectern_front",
        "lectern_sides", "lectern_top", "loom_front", "chiseled_bookshelf_occupied"]


def mc_version():
    props = PROJECT / "mod" / "gradle.properties"
    if props.exists():
        for line in props.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("minecraft_version="):
                return line.split("=", 1)[1].strip()
    return None


def candidate_jars(explicit=None):
    out = []
    if explicit:
        out.append(Path(explicit))
    if os.environ.get("AGENTCRAFT_MC_JAR"):
        out.append(Path(os.environ["AGENTCRAFT_MC_JAR"]))
    homes = []
    if os.environ.get("GRADLE_USER_HOME"):
        homes.append(Path(os.environ["GRADLE_USER_HOME"]))
    homes += [PROJECT / ".gradle-home", Path.home() / ".gradle"]
    ver = mc_version()
    for h in homes:
        loom = h / "caches" / "fabric-loom"
        vers = [ver] if ver else sorted((p.name for p in loom.glob("*")
                                         if p.is_dir() and p.name[:1].isdigit()), reverse=True)
        for v in vers or ["<minecraft_version>"]:
            out.append(loom / v / "minecraft-client.jar")
            out.append(loom / "minecraftMaven" / "net" / "minecraft" / "minecraft-clientonly-deobf" / v /
                       f"minecraft-clientonly-deobf-{v}.jar")
    return out


def find_jar(explicit=None):
    for p in candidate_jars(explicit):
        if p.is_file():
            try:
                with zipfile.ZipFile(p) as z:
                    z.getinfo("assets/minecraft/textures/font/ascii.png")
                return p
            except (KeyError, zipfile.BadZipFile):
                continue
    return None


def _stamp(jar: Path):
    st = jar.stat()
    return {"jar": str(jar), "size": st.st_size, "mtime": int(st.st_mtime), "minecraft_version": mc_version()}


def is_current(jar=None):
    sp = REF / "SOURCE.json"
    if not sp.exists() or not (REF / "font" / "ascii.png").exists():
        return False
    if jar is None:
        return True
    try:
        old = json.loads(sp.read_text(encoding="utf-8"))
    except ValueError:
        return False
    new = _stamp(jar)
    return all(old.get(k) == new[k] for k in ("size", "mtime", "minecraft_version"))


def extract(jar: Path):
    if REF.exists():
        shutil.rmtree(REF)
    va = REF / "vanilla_assets" / "minecraft"
    n = 0
    with zipfile.ZipFile(jar) as z:
        names = z.namelist()
        for name in names:
            for pre, dst in (("assets/minecraft/textures/block/", va / "textures" / "block"),
                             ("assets/minecraft/models/block/", va / "models" / "block")):
                if name.startswith(pre) and not name.endswith("/") and "/" not in name[len(pre):]:
                    ensure_dir(dst)
                    (dst / name[len(pre):]).write_bytes(z.read(name))
                    n += 1
        font = ensure_dir(REF / "font")
        (font / "ascii.png").write_bytes(z.read("assets/minecraft/textures/font/ascii.png"))
        prov = None
        for fname in ("assets/minecraft/font/include/default.json", "assets/minecraft/font/default.json"):
            if fname in names:
                for p in json.loads(z.read(fname).decode("utf-8")).get("providers", []):
                    if p.get("type") == "bitmap" and p.get("file") == "minecraft:font/ascii.png":
                        prov = p
                        break
            if prov:
                break
        if not prov:
            raise SystemExit("extract_ref: no ascii bitmap provider in the jar's font definitions")
        (font / "ascii_provider.json").write_text(json.dumps(prov), encoding="utf-8")
        flat = ensure_dir(REF / "vanilla")
        for t in FLAT:
            src = va / "textures" / "block" / f"{t}.png"
            if src.exists():
                shutil.copyfile(src, flat / f"{t}.png")
        for name, dst in (("assets/minecraft/textures/entity/player/wide/steve.png", "wide_steve.png"),
                          ("assets/minecraft/textures/entity/player/slim/alex.png", "slim_alex.png")):
            if name in names:
                (flat / dst).write_bytes(z.read(name))
    (REF / "SOURCE.json").write_text(json.dumps(_stamp(jar), indent=2) + "\n", encoding="utf-8")
    print(f"extract_ref: {n} vanilla block textures/models + font from {jar} -> {REF}")


def ensure(jar=None, force=False):
    """Make sure artifacts/art/_ref exists (and matches the cached client jar). Called by the
    sheet scripts so `build.py --sheets` works from a clean checkout once the mod has been built."""
    found = find_jar(jar)
    if not force and is_current(found):
        return REF
    if not found:
        if is_current(None):
            return REF        # extracted earlier, jar since cleaned: keep using the extraction
        tried = "\n  ".join(str(p) for p in candidate_jars(jar))
        raise SystemExit(
            "extract_ref: the review sheets need the Minecraft client jar for vanilla reference "
            "textures and the font, and none was found. Build the mod once so Fabric Loom caches it:\n"
            "  $env:GRADLE_USER_HOME='<repo>\\.gradle-home'; cd mod; .\\gradlew build\n"
            "or point AGENTCRAFT_MC_JAR at a minecraft client jar. Looked in:\n  " + tried)
    extract(found)
    return REF


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--jar")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    ensure(a.jar, a.force)
    print("ok", REF)

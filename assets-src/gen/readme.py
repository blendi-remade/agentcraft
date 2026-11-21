"""Generate assets-src/README.md from the real out/ tree (so the manifest never drifts).

python gen/readme.py
"""
from __future__ import annotations

import fnmatch
import json
from collections import OrderedDict

from common import OUT, ROOT

# id: (properties, render layer the quads land in (automatic in 26.3), luminance, shape, notes)
BLOCK_CONTRACT = OrderedDict([
    ("monitor", ("facing=north|east|south|west, lit=bool, up|down|left|right=bool", "solid", "lit ? 7 : 0",
                 "thin panel (back 4 px), nonOpaque",
                 "Connectable screen. up/down/left/right = true when the neighbour on that side (as seen by a viewer "
                 "looking at the screen) is a monitor with the same facing; the bezel on that side is then omitted, so "
                 "NxM monitors read as one screen. left = facing.getClockWise(), right = facing.getCounterClockWise(). "
                 "Screen surface is the plane z = 12/16 from the front of a north-facing model (recessed 1 px behind "
                 "the 2 px bezel); draw text there in the BER, inside the bezel (2 px inset on unconnected sides)."))
    ,
    ("task_board", ("facing, up|down|left|right=bool", "solid", "0", "thin panel (back 2 px), nonOpaque",
                    "Task Wall surface (walnut pinboard); same connection rules as monitor. Cards are drawn by the BER "
                    "on the plane z = 14/16 (just proud of the board)."))
    ,
    ("decision_podium", ("facing, open=bool", "solid + cutout (auto)", "open ? 9 : 0", "lectern-like, nonOpaque",
                         "Front (emblem) faces the player who placed it (vanilla lectern rule). open=true lights the "
                         "desk paper, the clay lens and the desk bell."))
    ,
    ("memory_archive", ("facing", "solid", "0", "full cube", "Library shelf: books + archive boxes."))
    ,
    ("memory_catalog", ("facing", "solid", "0", "full cube", "Card-index drawers (memory index)."))
    ,
    ("merge_station", ("facing, active=bool", "solid + cutout (auto)", "active ? 6 : 0", "full cube",
                       "Worktop with brass branch-merge inlay; active=true when a merge review is waiting."))
    ,
    ("status_lamp", ("status=off|idle|thinking|working|waiting|error|done", "solid + cutout (auto)", "off ? 0 : 12", "full cube",
                     "CI / agent status lamp; colours are the status palette. Animate 'waiting' in-world with particles, "
                     "not by flipping states."))
    ,
    ("console_terminal", ("facing", "solid", "6", "cabinet + leaning screen, nonOpaque",
                          "Command console; use (Enter) opens the console screen."))
    ,
    ("glow_panel", ("(none)", "solid + cutout (auto)", "15", "full cube", "Ceiling light: plaster frame, brass mullions, glowing panes."))
    ,
    ("glow_strip", ("facing=up|down|north|south|east|west, axis=x|z", "solid", "12", "2 px strip, nonOpaque, no collision",
                    "facing = direction the lit face points (vanilla end_rod rotation table); it attaches to the "
                    "opposite neighbour. axis = the run direction on a floor/ceiling (set from the placer's horizontal "
                    "facing axis); on walls it always runs horizontally and axis is ignored."))
    ,
    ("plaster_panel", ("(none)", "solid", "0", "full cube", "Warm plaster wall (calcite / white concrete companion)."))
    ,
    ("plaster_frame", ("(none)", "solid", "0", "full cube", "Raised-molding plaster panel for wall articulation."))
    ,
    ("walnut_panel", ("(none)", "solid", "0", "full cube", "Vertical walnut boards (dark oak companion)."))
    ,
    ("walnut_trim", ("(none)", "solid", "0", "full cube (column)", "Walnut with a brass cap rail: wainscot top course."))
    ,
    ("terracotta_tile", ("(none)", "solid", "0", "full cube", "2x2 clay tiles with cream grout."))
    ,
    ("oak_parquet", ("(none)", "solid", "0", "full cube", "Stripped-oak basketweave parquet floor."))
    ,
])

# glob (relative to out/assets/agentcraft) -> description; first match wins
DESCRIBE = [
    ("textures/entity/agent/*.png", "64x64 player-format agent skin (base + overlay layers; see cast.json for model)"),
    ("textures/gui/portrait/*_framed.png", "20x20 framed portrait (brass rim + identity ring + 2x face) for GUI lists"),
    ("textures/gui/portrait/*.png", "8x8 agent face (base + hat layer) for inline GUI use"),
    ("textures/gui/sprites/kit/*.png.mcmeta", "vanilla gui.scaling nine_slice metadata for the sprite of the same name"),
    ("textures/gui/sprites/kit/icon_*.png", "12x12 tool icon (log lines, chips, feed)"),
    ("textures/gui/sprites/kit/dot_*_halo.png", "11x11 status dot with soft halo (pulse by animating alpha)"),
    ("textures/gui/sprites/kit/dot_*.png", "7x7 status dot"),
    ("textures/gui/sprites/kit/progress_ring_*.png", "32x32 progress ring frame (draw frame round(p*16))"),
    ("textures/gui/sprites/kit/progress_*.png", "progress bar piece (9-slice)"),
    ("textures/gui/sprites/kit/scroll_grip.png", "scrollbar grip lines, drawn centred on the thumb (fixed size)"),
    ("textures/gui/sprites/kit/card_*.png", "task card background per status (9-slice)"),
    ("textures/gui/sprites/kit/button*.png", "button state (9-slice, 20 px tall)"),
    ("textures/gui/sprites/kit/tab_*.png", "tab state (9-slice)"),
    ("textures/gui/sprites/kit/*.png", "GUI kit sprite (see gui/kit.json for insets and use)"),
    ("textures/block/*_emissive.png", "emissive overlay (cutout, used by a light_emission=15 element)"),
    ("textures/block/status_lamp_*.png", "status lamp face for one status"),
    ("textures/block/monitor_*.png", "monitor part texture"),
    ("textures/block/task_board_*.png", "task board part texture"),
    ("textures/block/decision_podium_*.png", "decision podium part texture"),
    ("textures/block/memory_*.png", "memory archive / catalog texture"),
    ("textures/block/merge_station_*.png", "merge station texture"),
    ("textures/block/console_*.png", "console terminal texture"),
    ("textures/block/*.png", "block texture"),
    ("models/block/monitor_corner_*.json", "monitor bezel corner (outer = both edges open, h/v = that edge continues)"),
    ("models/block/task_board_corner_*.json", "task board trim corner (outer/h/v as monitor)"),
    ("models/block/*_edge_*.json", "connectable bezel/trim edge (omitted when connected on that side)"),
    ("models/block/*_panel_*.json", "connectable panel body (screen/board surface + back + sides)"),
    ("models/block/*_inventory.json", "merged model for the item (panel + all bezels)"),
    ("models/block/status_lamp_*.json", "status lamp model for one status"),
    ("models/block/*.json", "block model"),
    ("blockstates/*.json", "blockstate (property contract below)"),
    ("items/*.json", "1.21.4+/26.x item model definition"),
    ("lang/en_us.json", "English names for every block and item + creative tab"),
    ("gui/kit.json", "GUI kit manifest: every sprite's id, size, 9-slice insets, content padding, text colour"),
    ("gui/ui-style.json", "display/UI colour tokens (monitor log kinds, paper GUI, status, agent text colours)"),
    ("palette.json", "runtime copy of the Warm Studio palette"),
    ("cast.json", "runtime copy of the cast (ids, names, colours, skins, portraits)"),
]


def describe(rel):
    for pat, d in DESCRIBE:
        if fnmatch.fnmatch(rel, pat):
            return d
    return ""


def build():
    files = sorted(p.relative_to(OUT).as_posix() for p in OUT.rglob("*") if p.is_file())
    groups = OrderedDict()
    for r in files:
        top = r.split("/")[0] if r.count("/") == 0 else "/".join(r.split("/")[:2 if not r.startswith("textures/gui/sprites") else 4])
        groups.setdefault(top, []).append(r)
    cast = json.load(open(ROOT / "cast.json", encoding="utf-8"))
    kit = json.load(open(OUT / "gui" / "kit.json", encoding="utf-8"))["sprites"]

    lines = []
    w = lines.append
    w("# assets-src: AgentCraft art pipeline")
    w("")
    w("Deterministic generators for every AgentCraft texture, skin, model and GUI sprite, plus Blender")
    w("verification renders. Style: \"Warm Studio\" (docs/visual-bar.md). This README is generated by")
    w("`gen/readme.py`; the manifest below is read from the real `out/` tree.")
    w("")
    w("## Regenerate")
    w("")
    w("```powershell")
    w("# one-time: project venv (no global installs)")
    w("py -3.9 -m venv assets-src\\.venv")
    w("assets-src\\.venv\\Scripts\\python -m pip install -r assets-src\\requirements.txt")
    w("")
    w("assets-src\\.venv\\Scripts\\python assets-src\\build.py            # all shipped assets, ~5 s, no Blender")
    w("assets-src\\.venv\\Scripts\\python assets-src\\build.py --verify   # rebuild in 2 fresh processes (PYTHONHASHSEED 1, 987654), assert byte-identical")
    w("assets-src\\.venv\\Scripts\\python assets-src\\build.py --sheets   # + Blender 5.2 renders and review sheets")
    w("```")
    w("")
    w("`requirements.txt` pins Pillow (11.3.0): PNG bytes depend on the Pillow/zlib build, and `sync.py --check` compares bytes.")
    w("")
    w("Single steps: `python gen/skins.py [id]`, `gen/blocks.py`, `gen/models.py`, `gen/gui.py`, `gen/ui_style.py`,")
    w("`gen/cast_check.py`, `gen/sheets.py [portraits|skins|blocks|gui|all]`, `gen/preview.py <id>` (quick WIP turnaround),")
    w("`gen/preview.py --heads <id...|all>` (8-angle head close-ups under exact vanilla entity shading, next to the 8x")
    w("face and the portrait at GUI scales: the review view for faces and hair), `gen/preview.py --compare out.png")
    w("name=path[:slim] ...` (the same for scratch prototypes, for A/B tests). Blender is called headless")
    w("(`blender -b --factory-startup -P blender/render_*.py -- jobs.json`, Cycles/OptiX, Standard view transform).")
    w("Block renders use lighting calibrated to vanilla face shading (up 1.0, north/south 0.8, east/west 0.6; emissive")
    w("faces at 1.0 x texture; see `blender/studio.py: mc_block_lights`). Skins under `lighting: mc_entity` use an")
    w("emission shader that reproduces the game's entity shader exactly: `min(1, 0.4 + 0.6 * (N.L0 + N.L1))` with")
    w("vanilla's two light directions, applied to the raw sRGB texel (`blender/mcplayer.py`; a uniform grey skin renders")
    w("at 1.00 / 0.74 / 0.50 on top / front / side, matching the formula), so the cast sheet's lineup predicts the game.")
    w("")
    w("Review sheets compare against vanilla textures and use the vanilla font, extracted from the Minecraft client jar")
    w("that Fabric Loom caches when the mod is built (nothing is downloaded): `gen/extract_ref.py` (called automatically")
    w("by `gen/sheets.py` / `gen/gui_sheet.py`) writes `artifacts/art/_ref/` (reference only, never shipped; gitignored)")
    w("and re-extracts when the jar changes. On a clean checkout, build the mod once first")
    w(r"(`$env:GRADLE_USER_HOME='<repo>\.gradle-home'; cd mod; .\gradlew build`) or set `AGENTCRAFT_MC_JAR`.")
    w("")
    w("## In-game check")
    w("")
    w("```powershell")
    w(r"assets-src\.venv\Scripts\python assets-src\ingame_check.py   # ~2-3 min, muted, never takes focus")
    w("```")
    w("")
    w("Runs the real 26.3 client from a temp copy of `mod/` (OS temp dir; `mod/` itself is never touched) with a test")
    w("resource pack: our namespace plus vanilla stand-in blocks whose blockstates apply our models for chosen property")
    w("combinations (connected monitors, glint, every lamp state, podium open/closed, ...), our kit buttons in place of")
    w("vanilla's, and the six skins on vanilla mannequins (`profile.texture`). Shots go to `artifacts/art/ingame/`")
    w("through the mod's DevBridge (port 7893); the client log is scanned for model/texture/sprite errors")
    w("(`artifacts/art/ingame/report.json`). It refuses to start while another Minecraft client is running.")
    w("")
    w("## Sync into the mod")
    w("")
    w("```powershell")
    w("python assets-src\\sync.py --dry-run   # what would change")
    w("python assets-src\\sync.py             # copy out\\assets -> mod\\src\\main\\resources\\assets")
    w("python assets-src\\sync.py --check     # exit 1 if the mod copy is stale (use before a build)")
    w("```")
    w("")
    w("`sync.py` is stdlib-only. It never deletes files it did not put there (ledger:")
    w("`mod/src/main/resources/assets/agentcraft/.art-sync.json`), so mod-owned files such as `icon.png` are safe.")
    w("")
    w("**Lang files are merged, not copied.** Minecraft loads one `lang/<locale>.json` per namespace per pack, so the")
    w("mod's own keys (keybinds, screen titles, messages) and the generated block/item names share")
    w("`assets/agentcraft/lang/en_us.json`. Edit that file in `mod/` as usual: sync owns only the keys it generates")
    w("(`block.agentcraft.*`, `item.agentcraft.*`, `itemGroup.agentcraft`), updates them in place, removes ones")
    w("assets-src stopped generating, and keeps every other key verbatim in the file's order (a mod value for a")
    w("generated key is overwritten with a warning). `--check` compares the merged result by content, so mod-added keys")
    w("or CRLF line endings never count as stale.")
    w("")
    w("## Source files")
    w("")
    w("| file | role |")
    w("|---|---|")
    for f, d in [
        ("palette.json", "Warm Studio palette: named colours, material ramps (light to dark, `base` index), status / cast / skin / hair ramps"),
        ("cast.json", "the six agents: id, name, role, title, color, accent, text_on_dark/light, model (default/slim), skin + portrait ids, description; `checks` = measured colour distances"),
        ("ui-style.md / ui-style.json", "in-world monitor + GUI text style guide and tokens (generated by gen/ui_style.py)"),
        ("build.py", "regenerate everything (`--verify` determinism, `--sheets` renders)"),
        ("sync.py", "copy out/assets into the mod (lang files merged with the mod's own keys)"),
        ("ingame_check.py", "real-client check: test pack + temp mod copy + DevBridge shots + log scan"),
        ("gen/extract_ref.py", "vanilla reference textures/models/font for the review sheets, from Loom's cached client jar"),
        ("gen/common.py, gen/tex.py", "palette loading, grid painting, deterministic hashing, PNG writing"),
        ("gen/skinlib.py", "64x64 skin layout (classic + slim), face orientation rules, validation (opaque base layer, binary overlay alpha)"),
        ("gen/skins.py + gen/chars/<id>.py", "one module per agent; every face is a literal pixel grid"),
        ("gen/cast_check.py", "CIEDE2000 distances (identity vs status >= 25, agent vs agent >= 18, accent vs status >= 20) + WCAG name tints checked against every surface they are drawn on, written back into cast.json"),
        ("gen/portraits.py", "8x8 and 20x20 framed GUI portraits cut from the skins"),
        ("gen/blocks.py", "16x16 block textures (hand grids + structured procedural for tileable materials); asserts opacity"),
        ("gen/models.py", "block models, multipart/variant blockstates, item definitions, lang"),
        ("gen/gui.py", "GUI kit sprites + nine_slice .mcmeta + gui/kit.json"),
        ("gen/ui_style.py", "display tokens, contrast table, ui-style.md"),
        ("gen/sheets.py, gen/gui_sheet.py", "Blender jobs and contact sheets in artifacts/art/ (gui_sheet layouts are bounds-checked: anything drawn outside its panel fails the build)"),
        ("gen/validate.py", "resource checks + palette single-source check (no colour literals in shipping generators) + frame symmetry + 9-slice metadata + emissive rules (AO off, shade_direction_override, no obsolete `shade`) + z-fight check (near-coplanar faces) + one panel body per connectable state"),
        ("gen/preview.py", "fast WIP renders: turnarounds, head close-ups under exact entity shading, prototype A/B comparisons"),
        ("gen/readme.py", "this README"),
        ("blender/mcplayer.py", "player box model with exact vanilla skin UVs (verified on vanilla Steve/Alex)"),
        ("blender/mcblock.py", "Minecraft block-model importer: parents, element rotation/rescale, default UVs, light_emission, blockstate variant/multipart + x/y rotation (verified on vanilla lectern)"),
        ("blender/render_skins.py, blender/render_blocks.py, blender/studio.py", "headless render drivers, soft top-left studio lighting, vanilla-calibrated block lighting, exact entity shading"),
    ]:
        w(f"| `{f}` | {d} |")
    w("")
    w("## Palette")
    w("")
    w("`palette.json` holds every colour value the shipping generators use (named colours, material ramps, status,")
    w("cast, skin, hair, per-character details, UI). Generators reference entries by name (`pc(\"ramps.brass[2]\")`,")
    w("`P(\"details.kit.eye\")`); `gen/validate.py` fails the build if a quoted hex literal appears in any shipping")
    w("generator and checks that every cast colour and accent is a palette entry. Generators may still blend two palette")
    w("entries (`mix`) for glints and falloffs, so not every shipped pixel colour is listed: the build prints the split")
    w("(currently about 4 in 5 distinct shipped colours are exact palette entries, the rest are such blends).")
    w("")
    w("## Cast")
    w("")
    w(cast["palette_rationale"])
    w("")
    w(f"Measured: min CIEDE2000 identity-vs-status **{cast['checks']['min_de_vs_status']}**, "
      f"min agent-vs-agent **{cast['checks']['min_de_between_agents']}**.")
    w("")
    w("| id | name | role | model | color | name on dark | look |")
    w("|---|---|---|---|---|---|---|")
    for a in cast["agents"]:
        w(f"| {a['id']} | {a['name']} | {a['role']} ({a['title']}) | {a['model']} | `{a['color']}` | `{a['text_on_dark']}` | "
          f"{a['description'].split('. ')[1] if '. ' in a['description'] else a['description']} |")
    w("")
    w("Skins: `agentcraft:textures/entity/agent/<id>.png`. Base-layer faces are fully opaque (vanilla strips their")
    w("alpha), overlay alpha is binary. Render agents with the player model (`model` = default -> wide arms, slim -> 3 px).")
    w("")
    w("## Block contract (what the Java side must declare)")
    w("")
    w("`facing` = direction the front faces = towards the placing player (`ctx.getHorizontalPlayerFacing().getOpposite()`),")
    w("like vanilla lecterns/furnaces. Emissive parts follow vanilla `cross_emissive`: an exact duplicate element with")
    w("`\"light_emission\": 15` and `\"shade_direction_override\": \"up\"` (26.3 no longer parses the old `\"shade\": false`),")
    w("and every model with one sets `\"ambientocclusion\": false`. **Render layers are automatic in 26.3**: each quad")
    w("goes to SOLID / CUTOUT / TRANSLUCENT from the alpha of the texture region it samples")
    w("(`ChunkSectionLayer.byTransparency`), so no `BlockRenderLayerMap` call is needed; the column below says where")
    w("the quads end up. Non-cube shapes still need `noOcclusion()`. Suggested luminance is for the block's light level")
    w("(separate from the full-bright faces).")
    w("")
    w("| block id | properties | render layer (auto) | luminance | shape | notes |")
    w("|---|---|---|---|---|---|")
    def esc(v):
        return v.replace("|", "\\|")  # pipes inside cells break GFM tables

    for bid, (props, layer, lum, shape, notes) in BLOCK_CONTRACT.items():
        w(f"| `agentcraft:{bid}` | `{esc(props)}` | {layer} | {esc(lum)} | {shape} | {esc(notes)} |")
    w("")
    w("## GUI kit")
    w("")
    n9 = sum(1 for m in kit.values() if "slice" in m)
    w("Sprites live in the vanilla GUI sprite atlas: `assets/agentcraft/textures/gui/sprites/kit/<name>.png`. Draw them")
    w("with the Minecraft 26.3 (Mojang-named) API:")
    w("")
    w("```java")
    w("// graphics: net.minecraft.client.gui.GuiGraphicsExtractor")
    w("graphics.blitSprite(RenderPipelines.GUI_TEXTURED,")
    w("        Identifier.fromNamespaceAndPath(\"agentcraft\", \"kit/panel_paper\"), x, y, w, h);")
    w("```")
    w("")
    w(f"{n9} of the {len(kit)} sprites are stretchable and ship a `.png.mcmeta` with `gui.scaling` nine_slice insets, so")
    w(f"vanilla nine-slices them; the other {len(kit) - n9} (icons, dots, ring frames, grip, bubble tail, checkboxes) are")
    w("fixed-size and drawn at their own size. 1 texel = 1 GUI px. Full manifest with content padding and text colours:")
    w("`assets/agentcraft/gui/kit.json`. Colour/typography rules: `ui-style.md`.")
    w("")
    w("| sprite | size | 9-slice (l,t,r,b) | use |")
    w("|---|---|---|---|")
    for name, m in sorted(kit.items()):
        if name.startswith("progress_ring_") and name not in ("progress_ring_00", "progress_ring_16"):
            continue
        sl = m.get("slice")
        sls = f"{sl['left']},{sl['top']},{sl['right']},{sl['bottom']}" if sl else "-"
        nm = "progress_ring_00 .. _16" if name == "progress_ring_00" else name
        if name == "progress_ring_16":
            continue
        w(f"| `{nm}` | {m['size'][0]}x{m['size'][1]} | {sls} | {m['note']} |")
    w("")
    w("## Review artifacts (artifacts/art/, gitignored)")
    w("")
    w("- `skins_turnaround.png`: front/right/back/three-quarter of every agent on the real box model + flat skin")
    w("- `cast_sheet.png`: hero render, portrait, description and ramp per agent")
    w("- `blocks_sheet.png`: each block at 8x flat + lit Blender render of the actual model, status lamp states, vanilla")
    w("  neighbours, and a day/night studio vignette mixing our blocks with vanilla materials")
    w("- `gui_sheet.png`: mock decision dialog / task wall / console / bubble / nameplate built only from kit sprites with")
    w("  the Minecraft font at GUI scale 3, the in-world monitor log style, and every sprite")
    w("- `agents/<id>_<view>.png`, `blocks/<name>.png`: individual renders")
    w("")
    w("## Asset manifest (every shipped file)")
    w("")
    w(f"{len(files)} files under `out/assets/agentcraft/`.")
    w("")
    for g, rels in groups.items():
        w(f"### {g}")
        w("")
        w("| file | use |")
        w("|---|---|")
        for r in rels:
            w(f"| `{r}` | {describe(r)} |")
        w("")
    with open(ROOT / "README.md", "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
    print("README.md:", len(files), "files listed")


if __name__ == "__main__":
    build()

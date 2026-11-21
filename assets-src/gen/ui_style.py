"""UI / in-world display style tokens -> ui-style.json (+ shipped copy) and ui-style.md.

python gen/ui_style.py
"""
from __future__ import annotations

import json

from cast_check import contrast, toward_all
from common import OUT, PALETTE, ROOT, hex2rgba, mix, pal_hex, rgba2hex, write_json

# Every token is a palette entry (by name), nudged toward ink (both the lit paper monitor screen
# and paper GUI are light surfaces; cream for the dark ink UI) only as far as needed to reach its
# minimum WCAG contrast on the surface it is drawn on.
MONITOR_BG = pal_hex("ramps.screen_on[1]")      # = monitor_screen_on even rows
MONITOR_SCAN = pal_hex("ramps.screen_on[2]")    # odd rows (scanlines)
PAPER_BG = pal_hex("ui.panel")
INSET_BG = pal_hex("ui.inset")
LIFT, SINK = pal_hex("ramps.cream[0]"), pal_hex("ui.text")


def _blend(a, b, t):
    return rgba2hex(mix(hex2rgba(pal_hex(a)), hex2rgba(pal_hex(b)), t))


# The lit monitor is warm paper (e-ink look), so its log colours are the paper GUI's deep tones.
MONITOR_ROW_BG = {
    "diff_add_bg": rgba2hex(mix(hex2rgba(MONITOR_BG), hex2rgba(pal_hex("ramps.sage[0]")), 0.45)),
    "diff_del_bg": rgba2hex(mix(hex2rgba(MONITOR_BG), hex2rgba(pal_hex("ramps.clay[0]")), 0.30)),
}
# kind: (palette source, minimum contrast, background token or None = the screen + scanline)
MONITOR_RECIPES = {
    "text": ("ui.text", 9.0, None),                 # assistant prose
    "muted": ("ui.text_muted", 4.5, None),          # timestamps, context lines, activity
    "tool": ("ramps.brass[4]", 6.0, None),          # tool call lines (icon + tool name)
    "tool_arg": ("ui.text", 9.0, None),
    "result": ("ramps.sage[3]", 5.5, None),         # tool results / success summaries
    "error": ("status_ramps.error[2]", 5.5, None),  # errors, failed tests, warnings
    "path": ("ramps.oak[4]", 5.5, None),            # file paths
    "diff_hunk": ("ramps.teal[3]", 5.5, None),      # @@ hunk headers
    "diff_add": ("ramps.sage[3]", 5.5, "diff_add_bg"),
    "diff_del": ("ramps.clay[3]", 5.5, "diff_del_bg"),
    "diff_ctx": ("ui.text_muted", 4.5, None),
}
MONITOR_RECIPES["attention"] = ("ramps.clay[2]", 5.5, None)   # "waiting for you" footer

# The lit desk monitor is warm charcoal glass (chosen over the paper take by a side-by-side test in
# game, see gen/blocks.py monitor_textures): the BER draws a soft top glow (top -> bg) with the
# block texture's scanlines, and the log in light tones nudged toward cream until they reach their
# minimum contrast on every tone of the glass.
MDARK_TOP = pal_hex("ramps.screen_glow[1]")
MDARK_BG = pal_hex("ramps.screen_glow[2]")      # = monitor_screen_on even rows
MDARK_SCAN = pal_hex("ramps.screen_glow[3]")    # odd rows (scanlines)
MDARK_ROW_BG = {
    "diff_add_bg": rgba2hex(mix(hex2rgba(MDARK_BG), hex2rgba(pal_hex("ramps.sage[3]")), 0.45)),
    "diff_del_bg": rgba2hex(mix(hex2rgba(MDARK_BG), hex2rgba(pal_hex("ramps.clay[3]")), 0.40)),
}
MDARK_RECIPES = {
    "text": ("ramps.screen_on[1]", 9.0, None),       # paper-coloured prose on the glass
    "muted": ("ramps.stone[2]", 4.5, None),
    "tool": ("ramps.brass[1]", 6.0, None),
    "tool_arg": ("ramps.screen_on[1]", 9.0, None),
    "result": ("ramps.sage[0]", 5.5, None),
    "error": ("status_ramps.error[0]", 5.5, None),
    "path": ("ramps.oak[1]", 5.5, None),
    "diff_hunk": ("ramps.teal[0]", 5.5, None),
    "diff_add": ("ramps.sage[0]", 5.5, "diff_add_bg"),
    "diff_del": ("status_ramps.waiting[0]", 5.5, "diff_del_bg"),
    "diff_ctx": ("ramps.stone[2]", 4.5, None),
    "attention": ("status_ramps.waiting[0]", 5.5, None),
}
PAPER_ROW_BG = {
    "add_bg": _blend("ui.panel", "ramps.sage[0]", 0.5),
    "del_bg": _blend("ui.panel", "ramps.clay[0]", 0.3),
}
PAPER_RECIPES = {
    "text": ("ui.text", 4.5, None),
    "muted": ("ui.text_muted", 4.5, None),
    "path": ("ramps.brass[4]", 5.5, None),
    "hunk": ("ramps.teal[3]", 5.5, None),
    "add_fg": ("ramps.sage[3]", 5.5, "add_bg"),
    "del_fg": ("ramps.clay[3]", 5.5, "del_bg"),
    "link": ("ramps.clay[2]", 5.5, None),
    "disabled": ("ramps.stone[2]", 0, None),        # deliberately low contrast (disabled)
}


# small text on the other dark UI surfaces (tooltip, nameplate worst case, console ink)
INK_RECIPES = {
    "activity": ("status_ramps.idle[0]", 4.5, None),   # nameplate activity, tooltip hints
    "ghost": ("ramps.stone[3]", 0, None),               # console ghost completion: deliberately quiet
}


def _derive(recipes, row_bgs, default_bgs, target):
    out = {}
    for k, (src, ratio, bgk) in recipes.items():
        bgs = [row_bgs[bgk]] if bgk else default_bgs
        out[k] = toward_all(pal_hex(src), target, {b: ratio for b in bgs}) if ratio else pal_hex(src)
    return out


def build():
    monitor = {"bg": MONITOR_BG, "scanline": MONITOR_SCAN, "rule": pal_hex("ramps.screen_on[3]")}
    monitor.update(_derive(MONITOR_RECIPES, MONITOR_ROW_BG, [MONITOR_BG, MONITOR_SCAN], SINK))
    monitor.update(MONITOR_ROW_BG)
    paper = {"bg": PAPER_BG, "inset": INSET_BG}
    paper.update(_derive(PAPER_RECIPES, PAPER_ROW_BG, [PAPER_BG, INSET_BG], SINK))
    paper.update(PAPER_ROW_BG)
    contrast_table = {}
    for k, (src, ratio, bgk) in MONITOR_RECIPES.items():
        bgs = [MONITOR_ROW_BG[bgk]] if bgk else [MONITOR_BG, MONITOR_SCAN]
        contrast_table[k] = round(min(contrast(monitor[k], b) for b in bgs), 1)
    glass = [MDARK_TOP, MDARK_BG, MDARK_SCAN]
    mdark = {"bg_top": MDARK_TOP, "bg": MDARK_BG, "scanline": MDARK_SCAN, "header_bg": MDARK_TOP,
             "rule": pal_hex("ramps.screen_glow[0]"), "badge_bg": pal_hex("ui.panel"), "badge_text": pal_hex("ui.text")}
    mdark.update(_derive(MDARK_RECIPES, MDARK_ROW_BG, glass, LIFT))
    mdark.update(MDARK_ROW_BG)
    mdark["caret"] = mdark["text"]
    mdark_contrast = {}
    for k, (src, ratio, bgk) in MDARK_RECIPES.items():
        bgs = [MDARK_ROW_BG[bgk]] if bgk else glass
        mdark_contrast[k] = round(min(contrast(mdark[k], b) for b in bgs), 1)
    cast_agents = json.load(open(ROOT / "cast.json", encoding="utf-8"))["agents"]
    mdark_names = round(min(contrast(a["text_on_dark"], b) for a in cast_agents for b in glass), 2)
    if mdark_names < 4.5:
        raise SystemExit(f"agent text_on_dark only reaches {mdark_names}:1 on the dark monitor glass")
    # Task Wall (in-world kanban on the walnut pinboard, gen/blocks.py pinboard): brass hairlines
    # between the columns, paper column labels, a quiet paper "+N more" chip.
    board = {"rule": pal_hex("colors.brass"), "label": pal_hex("ui.panel"), "chip": pal_hex("ui.inset"),
             "chip_edge": pal_hex("ui.edge")}
    paper_contrast = {}
    for k, (src, ratio, bgk) in PAPER_RECIPES.items():
        if bgk:
            paper_contrast[k] = (round(contrast(paper[k], PAPER_ROW_BG[bgk]), 1),)
        else:
            paper_contrast[k] = (round(contrast(paper[k], PAPER_BG), 1), round(contrast(paper[k], INSET_BG), 1))
    cast_doc = json.load(open(ROOT / "cast.json", encoding="utf-8"))
    ink_bgs = list(cast_doc["checks"]["dark_surfaces"].values())
    ink_ui = _derive(INK_RECIPES, {}, ink_bgs, LIFT)
    ink_ui["ghost_on_paper"] = pal_hex("ui.paper_deep")
    ink_contrast = {k: round(min(contrast(ink_ui[k], b) for b in ink_bgs), 1) for k in INK_RECIPES}
    cast = cast_doc["agents"]
    data = {
        "version": 1,
        "monitor": monitor,
        "monitor_dark": mdark,
        "board": board,
        "paper": paper,
        "status": PALETTE["status"],
        "agents": {a["id"]: {"color": a["color"], "text_on_dark": a["text_on_dark"], "text_on_light": a["text_on_light"]}
                   for a in cast},
        "contrast": contrast_table,
        "monitor_dark_contrast": dict(mdark_contrast, agent_names_min=mdark_names),
        "paper_contrast": paper_contrast,
        "ink_ui": ink_ui,
        "ink_ui_contrast": ink_contrast,
        "name_contrast": {"dark_surfaces": cast_doc["checks"]["dark_surfaces"],
                          "light_surfaces": cast_doc["checks"]["light_surfaces"],
                          "min_text_on_dark": cast_doc["checks"]["min_contrast_text_on_dark"],
                          "min_text_on_light": cast_doc["checks"]["min_contrast_text_on_light"]},
        "metrics": {
            "monitor_font_px_per_block": {"desk": 96, "desk_one_high": 128, "wall": 64},
            "monitor_line_height": 10, "monitor_pad_side_blocks": 0.09, "monitor_pad_top": 5,
            "board_px_per_block": {"up_to_3_high": 64, "4_high": 72, "taller_board_px": 320},
            "board_light_floor": 10,
            "gui_panel_padding": 8, "gui_gap": 4, "button_height": 20, "field_height": 18,
            "card_min": [60, 40], "pulse_ms": 1200, "caret_blink_ms": 500,
        },
    }
    write_json(ROOT / "ui-style.json", data)
    write_json(OUT / "gui" / "ui-style.json", data)
    write_md(data)
    print("ui-style.json + ui-style.md written")
    return data


def write_md(d):
    m, p, c, pc = d["monitor"], d["paper"], d["contrast"], d["paper_contrast"]
    md_, mc = d["monitor_dark"], d["monitor_dark_contrast"]
    drows = "\n".join(
        f"| `{k}` | `{md_[k]}` | {('on `' + md_[k + '_bg'] + '`') if (k + '_bg') in md_ else 'on glass'} | {mc[k]}:1 | {use} |"
        for k, use in [
            ("text", "assistant prose, plans, replies (paper-coloured)"),
            ("muted", "activity, unchanged diff context, '+3 more'"),
            ("tool", "tool-call line: 12px kit icon + tool name (`Read`, `Edit`, `$`...)"),
            ("tool_arg", "the tool's argument after the name (path, command)"),
            ("result", "tool results, passing tests, success summaries"),
            ("error", "errors, failing tests, warnings, permission denials"),
            ("path", "file paths when shown on their own (diff file line)"),
            ("diff_hunk", "`@@ -a,b +c,d @@` hunk headers"),
            ("diff_add", "added lines (`+`), full-width tinted row"),
            ("diff_del", "removed lines (`-`), full-width tinted row"),
            ("diff_ctx", "diff context lines"),
            ("attention", "'Waiting for you' footer (pulses)"),
        ])
    rows = "\n".join(
        f"| `{k}` | `{m[k]}` | {('on `' + m[k + '_bg'] + '`') if (k + '_bg') in m else 'on screen'} | {c[k]}:1 | {use} |"
        for k, use in [
            ("text", "assistant prose, plans, replies"),
            ("muted", "timestamps, activity, unchanged diff context"),
            ("tool", "tool-call line: 12px kit icon + tool name (`Read`, `Edit`, `Bash`...)"),
            ("tool_arg", "the tool's argument after the name (path, command)"),
            ("result", "tool results, passing tests, success summaries"),
            ("error", "errors, failing tests, warnings, permission denials"),
            ("path", "file paths when shown on their own"),
            ("diff_hunk", "`@@ -a,b +c,d @@` hunk headers"),
            ("diff_add", "added lines (`+`), full-width tinted row"),
            ("diff_del", "removed lines (`-`), full-width tinted row"),
            ("diff_ctx", "diff context lines"),
        ])
    prow = "\n".join(
        f"| `{k}` | `{p[k]}` | {' / '.join(str(x) + ':1' for x in pc[k])} |"
        for k in ("text", "muted", "path", "hunk", "link", "disabled", "add_fg", "del_fg"))
    agents = "\n".join(f"| {k} | `{v['color']}` | `{v['text_on_dark']}` | `{v['text_on_light']}` |" for k, v in d["agents"].items())
    status = "\n".join(f"| {k} | `{v}` |" for k, v in d["status"].items())
    nc = d["name_contrast"]
    dark_s = ", ".join(f"{k} `{v}`" for k, v in nc["dark_surfaces"].items())
    light_s = ", ".join(f"{k} `{v}`" for k, v in nc["light_surfaces"].items())
    md = f"""# AgentCraft display and UI style guide

Generated by `gen/ui_style.py` (edit the tokens there, not this file). Tokens ship to the mod as
`assets/agentcraft/gui/ui-style.json`; GUI sprites are documented in `assets/agentcraft/gui/kit.json`.

Three surfaces, never mixed on one panel:

- **Paper** (every GUI screen, the Task Wall cards and the console terminal's screen): matte cream
  panels, ink text, *no* text shadow, thin brass for emphasis, clay for the one primary action. Never the
  default grey Minecraft GUI. The console terminal is warm e-ink paper `{m['bg']}` with faint scanlines
  (`{m['scanline']}`), full-bright. Ink text, colour only where it carries meaning.
- **Glass** (lit desk monitors): warm charcoal glass `{md_['bg']}` with a soft top glow (`{md_['bg_top']}`) and
  faint scanlines (`{md_['scanline']}` every other texel row), rendered full-bright, log text in light tones.
  This replaced the first take (paper monitors) after a side-by-side test in game: lit paper screens read
  as framed notes or plaster at mid distance, the glass with glowing cream text reads as a screen. The
  unlit `monitor_screen_off` smoked glass is cooler and carries no text, so on/off still reads.
- **Ink** (tooltips, nameplates, HUD, the console input bar): translucent or solid ink with cream text.

## 1. Monitor text (in-world)

**Font and scale.** Vanilla font, unshadowed. One font pixel = 1/{d['metrics']['monitor_font_px_per_block']['desk']} block on
desk monitors at least 2 blocks high and wide, 1/{d['metrics']['monitor_font_px_per_block']['desk_one_high']} on 1-block-high (or wide) ones (so a tail
of 7 rows fits), and 1/{d['metrics']['monitor_font_px_per_block']['wall']} block on wall screens read from across a room. Line height
{d['metrics']['monitor_line_height']} font px (tool lines 13, for the 12 px icon), top padding {d['metrics']['monitor_pad_top']}, side padding
{d['metrics']['monitor_pad_side_blocks']} block (12 px at 128 px/block, 9 at 96): the brass lip stands 1/16 block in front of the
glass, so text closer to the bezel disappears behind it at oblique views (a desk camera looking at the neighbours).
The 2 px walnut bezel and brass lip come from the block model, so do not draw a border in the renderer.

**Header line.** The state dot (`kit/dot_<state>`, 7 px; waiting pulses its halo), the agent name in the
agent's `text_on_dark` colour (worst case {mc['agent_names_min']}:1 on the glass), the activity in `muted`
(`editing auth/session.ts`; on a second line when the screen is narrow), the task id right-aligned. A 1 px
rule in `{md_['rule']}` underneath.

**Log kinds on the glass** (`monitor_dark.*`). Contrast is the WCAG ratio against the worst tone of the glass
(computed, not eyeballed):

| kind | colour | background | contrast | use |
|---|---|---|---|---|
{drows}

Paper monitor tokens (`monitor.*`, the first take; still shipped, e.g. for paper-screen variants):

| kind | colour | background | contrast | use |
|---|---|---|---|---|
{rows}

Rules:
- Draw the text full-bright like the screen face (`LightCoordsUtil.FULL_BRIGHT`, 15728880) and with
  `Font.DisplayMode.POLYGON_OFFSET`, unshadowed, so it never dims at night and never z-fights the screen face.
- Newest line at the bottom, auto-scroll; when the log is longer than the screen, fade the top line to 50 % alpha.
- Truncate long lines with `...`; never wrap a tool line, do wrap prose. On narrow screens long snake_case
  tool names shorten (`request_merge` -> `merge`, `create_task` -> `new task`) so the argument still shows.
- Prose drops markdown markup the screen cannot show (`` `code` ``, `**bold**`, `# heading`).
- Diff rows: tint the full row background (`diff_add_bg` / `diff_del_bg`) and keep the `+`/`-` sigil in the text colour,
  so the diff reads at a distance even when individual characters do not.
- Never pure white, pure black, or vanilla `§` formatting colours. Identity colours only for agent names.
- The idle screen (no agent) uses `monitor_screen_off` (lit=false); a screen that is "on" but empty shows only the header.
- States: a blinking `caret` block at the bottom while the agent works or thinks; `attention` "Waiting for you"
  when it waits on the user ("Needs you" on narrow screens); "Off shift" centred when the agent is off shift;
  before the Foreman was ever reached, the agent's name stays in the header and the centre says
  "Foreman not running" (the HUD pill's wording); when the link is lost the last known log stays, dimmed,
  under a paper "Foreman offline" badge (`badge_bg` / `badge_text`; "Offline" on 1-block screens).

**Task Wall** (`board.*`, cards on the walnut pinboard `task_board_surface`; 64 px per block up to 3 blocks
high, 72 on a 4-high wall, then ~{d['metrics']['board_px_per_block']['taller_board_px']} px of board height): columns Todo / Doing / Review / Done split by 1 px
`{d['board']['rule']}` brass rules, a paper label per column (`{d['board']['label']}`) with a 2 px underline in the column's
status colour and the count (a red dot when the column holds blocked cards). Column widths follow the content:
an empty column is a slim lane, a crowded one borrows width. Kit `card_<status>` cards (blocked = `card_blocked`,
at the top of the column where the task stalled, the reason in the footer) come in three sizes: full (title 1-3
lines, face + name, one hint), brief (title, 2 lines) and compact (1 line); a column steps down through them
before the tail collapses into a `{d['board']['chip']}` "+N more" chip. The board was cream linen in the first take;
cream cards on it had too little contrast from across the room (side-by-side test in game). Cards take the
room's light with a block-light floor of {d['metrics']['board_light_floor']} (12 made the wall look backlit at night).

## 2. Paper GUI text

| token | colour | contrast on cream / on inset |
|---|---|---|
{prow}

- Labels are ink; secondary info is `muted`. Paths in `path` (dark brass), hunk headers in `hunk` (dark teal).
- Diff review screen: rows tinted `add_bg` / `del_bg`, text `add_fg` / `del_fg`, a 2 px gutter in the status colour.
- One `button_primary` (clay) per dialog, all other actions are `button` (paper). Disabled text `disabled`.

## 3. Identity vs status

Status is **only** shown by status colours (dot, lamp, card stripe, particles); identity is **only** shown by agent
colours (name tint, scarf, desk accent). The two palettes are disjoint by construction (see `cast.json` checks).

| status | colour |
|---|---|
{status}

Agent names: `text_on_dark` / `text_on_light` are derived per agent (gen/cast_check.py) so that the worst case
over **every** surface the name is drawn on stays >= 4.5:1. Dark surfaces: {dark_s}. Light surfaces: {light_s}.
Measured minimum over all agents: {nc['min_text_on_dark']}:1 on dark, {nc['min_text_on_light']}:1 on light.

| agent | identity | name on dark | name on paper |
|---|---|---|---|
{agents}

Task card stripes: todo = idle, doing = working, review = thinking (brass), done = done (card body dims to paper),
blocked = error. Waiting-on-user is the only state that pulses (`kit/dot_waiting_halo`, alpha 0 to 110 over
{d['metrics']['pulse_ms']} ms, ease in-out).

## 4. Layout metrics (GUI px, 1 texel = 1 GUI px)

- Panel padding {d['metrics']['gui_panel_padding']}, gap {d['metrics']['gui_gap']}. Buttons {d['metrics']['button_height']} px tall (label baseline +6, pressed +2).
- Console field {d['metrics']['field_height']} px tall, prefix `>` in brass, ghost completion in `{d['ink_ui']['ghost_on_paper']}`,
  1 px ink caret blinking every {d['metrics']['caret_blink_ms']} ms. Autocomplete list is a `kit/tooltip` above the field.
- Cards at least {d['metrics']['card_min'][0]}x{d['metrics']['card_min'][1]}: title (ink, wraps, 9 px kept free on the right), status dot top-right,
  then assignee face (8x8 portrait) + name (agent `text_on_light`).
- Speech bubbles: `kit/bubble` + `kit/bubble_tail` centred below; max 3 lines, then `...`.
- Nameplates: `kit/nameplate` pill (ink at alpha 220), dot + name (`text_on_dark`) + activity (`ink_ui.activity`
  `{d['ink_ui']['activity']}`, {d['ink_ui_contrast']['activity']}:1 worst case). Tooltip hints use the same token.
- Keybind hints: `kit/keycap` with the key name, followed by a muted verb ("Enter choose").
"""
    with open(ROOT / "ui-style.md", "w", encoding="utf-8", newline="\n") as fh:
        fh.write(md)


if __name__ == "__main__":
    build()

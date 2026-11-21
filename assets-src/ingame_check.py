"""In-game check of the art assets in real Minecraft 26.3, without touching mod/.

    python assets-src/ingame_check.py            # pack + temp mod copy + runClient + shots + quit
    python assets-src/ingame_check.py --pack-only

What it does
  1. Builds a test resource pack from assets-src/out/assets: our namespace as-is, plus overrides of
     plain vanilla blocks (wool / terracotta / concrete) whose blockstates apply OUR block models for
     a chosen property combination (evaluated from our own blockstates, so connected-monitor
     bezels, glints, lamp states... are exactly what the mod will show), and our kit button sprites
     in place of vanilla's widget/button* (to see nine-slice scaling in a real GUI).
  2. Copies mod/ as committed at HEAD (git archive; the working tree may be mid-edit by another
     track) to <OS temp>/agentcraft-artcheck/mod, enables the pack in that copy's
     options.txt, and launches `gradlew runClient --no-daemon` there (GRADLE_USER_HOME = the repo's
     .gradle-home; DevBridge on port 7893 (AGENTCRAFT_ARTCHECK_PORT) so it never collides with
     another client; muted and never focused - the mod's defaults). It refuses to start while
     any other Minecraft client is running (one client at a time on a shared GPU) or the port is busy.
  3. Drives tools/shoot.mjs through ingame_scene.json -> PNGs in artifacts/art/ingame/.
  4. Quits through the DevBridge, waits for the processes it started, and scans the client log for
     resource errors (models, blockstates, textures, sprites) -> artifacts/art/ingame/report.json.
Our blocks are not registered yet (that is integration's job), so models are shown on vanilla
blocks: geometry, textures, emissive faces, AO and shading are the real game's; block light levels
and BlockEntity text are not part of this check.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
OUT = HERE / "out" / "assets"
WORK = Path(tempfile.gettempdir()) / "agentcraft-artcheck"
MODCOPY = WORK / "mod"
PACK_NAME = "agentcraft-artcheck"
SHOTS = REPO / "artifacts" / "art" / "ingame"
LOGS = REPO / "artifacts" / "logs"
PORT = int(os.environ.get("AGENTCRAFT_ARTCHECK_PORT", "7893"))
NS = "agentcraft"


def _match(cond, props):
    if "OR" in cond:
        return any(_match(c, props) for c in cond["OR"])
    if "AND" in cond:
        return all(_match(c, props) for c in cond["AND"])
    return all(str(props.get(k)) in str(v).split("|") for k, v in cond.items())


def resolve(block, props):
    """Our blockstate for `block` evaluated at `props` -> list of {model, x?, y?} applies."""
    bs = json.loads((OUT / NS / "blockstates" / f"{block}.json").read_text(encoding="utf-8"))
    if "variants" in bs:
        for key, v in bs["variants"].items():
            kv = dict(p.split("=") for p in key.split(",") if p)
            if all(str(props.get(k)) == val for k, val in kv.items()):
                return [v if isinstance(v, dict) else v[0]]
        raise SystemExit(f"{block} {props}: no variant")
    return [p["apply"] for p in bs["multipart"] if "when" not in p or _match(p["when"], props)]


def mon(lit, up, down, left, right):
    b = lambda v: "true" if v else "false"  # noqa: E731
    return ("monitor", {"facing": "north", "lit": b(lit), "up": b(up), "down": b(down), "left": b(left), "right": b(right)})


# vanilla stand-in block -> (our block, props). Monitors face north (screens look at -Z); the
# viewer stands north of them looking south, so the viewer's left is +X (east). Thin / non-cube
# models sit on stained glass: like the real blocks (noOcclusion, thin collision) it does not
# occlude, cull the floor, cast AO or block light. On wool (full collision, opaque) inner faces such
# as the bezel lip sample the opaque neighbour's light (0) and render black - a stand-in artefact.
STANDINS = {
    # 3x2 lit wall screen at x=1..3, y=67..68 (x=3 is the viewer's left column)
    "white_stained_glass": mon(True, False, True, False, True), "orange_stained_glass": mon(True, False, True, True, True),
    "magenta_stained_glass": mon(True, False, True, True, False), "light_blue_stained_glass": mon(True, True, False, False, True),
    "yellow_stained_glass": mon(True, True, False, True, True), "lime_stained_glass": mon(True, True, False, True, False),
    # 2x2 unlit screen at x=-3..-2 (glint on the top-left block, x=-2 y=68)
    "pink_stained_glass": mon(False, False, True, False, True), "gray_stained_glass": mon(False, False, True, True, False),
    "light_gray_stained_glass": mon(False, True, False, False, True), "cyan_stained_glass": mon(False, True, False, True, False),
    # 1x1 lit desk monitor
    "purple_stained_glass": mon(True, False, False, False, False),
    "orange_terracotta": ("status_lamp", {"status": "off"}),
    "magenta_terracotta": ("status_lamp", {"status": "idle"}),
    "light_blue_terracotta": ("status_lamp", {"status": "thinking"}),
    "yellow_terracotta": ("status_lamp", {"status": "working"}),
    "lime_terracotta": ("status_lamp", {"status": "waiting"}),
    "pink_terracotta": ("status_lamp", {"status": "error"}),
    "gray_terracotta": ("status_lamp", {"status": "done"}),
    "light_gray_terracotta": ("glow_panel", {}),
    "black_stained_glass": ("glow_strip", {"facing": "up", "axis": "x"}),
    "brown_stained_glass": ("console_terminal", {"facing": "north"}),
    "green_stained_glass": ("decision_podium", {"facing": "north", "open": "false"}),
    "red_stained_glass": ("decision_podium", {"facing": "north", "open": "true"}),
    "black_terracotta": ("merge_station", {"facing": "north", "active": "true"}),
    "blue_terracotta": ("memory_archive", {"facing": "north"}),
    "brown_terracotta": ("walnut_trim", {}),
    "white_terracotta": ("memory_catalog", {"facing": "north"}),
    "white_concrete": ("plaster_panel", {}),
    "brown_concrete": ("walnut_panel", {}),
    "lime_concrete": ("plaster_frame", {}),
    "yellow_concrete": ("oak_parquet", {}),
    "light_blue_concrete": ("terracotta_tile", {}),
    "blue_stained_glass": ("task_board", {"facing": "north", "up": "false", "down": "false", "left": "false", "right": "false"}),
}
GUI_OVERRIDES = {"widget/button": "kit/button", "widget/button_highlighted": "kit/button_hover",
                 "widget/button_disabled": "kit/button_disabled"}
CAST = [("marlow", "wide"), ("juniper", "slim"), ("kit", "wide"), ("wren", "slim"), ("rowan", "wide"), ("tove", "slim")]


def build_pack(dst: Path):
    if dst.exists():
        shutil.rmtree(dst)
    (dst / "assets").mkdir(parents=True)
    shutil.copytree(OUT / NS, dst / "assets" / NS)
    (dst / "pack.mcmeta").write_text(json.dumps({"pack": {
        "description": "AgentCraft art check (assets-src/out on vanilla stand-in blocks)",
        "min_format": 97, "max_format": 97}}, indent=1), encoding="utf-8")
    bsd = dst / "assets" / "minecraft" / "blockstates"
    bsd.mkdir(parents=True)
    for vanilla, (block, props) in STANDINS.items():
        parts = [{"apply": a} for a in resolve(block, props)]
        (bsd / f"{vanilla}.json").write_text(json.dumps({"multipart": parts}, indent=1), encoding="utf-8")
    sp = dst / "assets" / "minecraft" / "textures" / "gui" / "sprites"
    for van, ours in GUI_OVERRIDES.items():
        src = OUT / NS / "textures" / "gui" / "sprites" / f"{ours}.png"
        (sp / van).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, sp / f"{van}.png")
        meta = src.with_name(src.name + ".mcmeta")
        if meta.exists():
            shutil.copyfile(meta, sp / f"{van}.png.mcmeta")
    print("pack ->", dst)


def scene():
    setup = [
        "/time set 6000",
        "/fill -16 64 -8 12 64 8 minecraft:yellow_concrete",          # oak parquet floor
        "/fill -16 65 -8 12 72 8 minecraft:air",
        "/kill @e[type=minecraft:mannequin]",
        # studio wall (z=5): walnut wainscot, walnut trim rail, plaster above, framed plaster course
        "/fill -6 65 5 8 65 5 minecraft:brown_concrete",
        "/fill -6 66 5 8 66 5 minecraft:brown_terracotta",
        "/fill -6 67 5 8 69 5 minecraft:white_concrete",
        "/fill -6 70 5 8 70 5 minecraft:lime_concrete",
        "/fill -6 64 3 8 64 4 minecraft:light_blue_concrete",       # terracotta tile strip
        # 3x2 lit screen (x=1..3), 2x2 unlit screen (x=-3..-2), on the wall face z=4
        "/setblock 3 68 4 minecraft:white_stained_glass", "/setblock 2 68 4 minecraft:orange_stained_glass",
        "/setblock 1 68 4 minecraft:magenta_stained_glass", "/setblock 3 67 4 minecraft:light_blue_stained_glass",
        "/setblock 2 67 4 minecraft:yellow_stained_glass", "/setblock 1 67 4 minecraft:lime_stained_glass",
        "/setblock -2 68 4 minecraft:pink_stained_glass", "/setblock -3 68 4 minecraft:gray_stained_glass",
        "/setblock -2 67 4 minecraft:light_gray_stained_glass", "/setblock -3 67 4 minecraft:cyan_stained_glass",
        "/setblock -5 67 4 minecraft:blue_stained_glass",              # task board 1x1
        # status lamps on the wainscot (z=4), desk with monitor + console, furniture
        "/setblock 5 65 4 minecraft:orange_terracotta", "/setblock 6 65 4 minecraft:magenta_terracotta",
        "/setblock 7 65 4 minecraft:light_blue_terracotta", "/setblock 5 66 4 minecraft:yellow_terracotta",
        "/setblock 6 66 4 minecraft:lime_terracotta", "/setblock 7 66 4 minecraft:pink_terracotta",
        "/setblock 8 65 4 minecraft:gray_terracotta",
        "/setblock 0 65 3 minecraft:brown_stained_glass",                  # console terminal
        "/setblock 2 65 3 minecraft:stripped_dark_oak_log", "/setblock 2 66 3 minecraft:purple_stained_glass",
        "/setblock -1 65 1 minecraft:red_stained_glass", "/setblock -3 65 1 minecraft:green_stained_glass",
        "/setblock 4 65 1 minecraft:black_terracotta",
        "/setblock 7 65 2 minecraft:blue_terracotta", "/setblock 7 66 2 minecraft:white_terracotta",
        "/setblock 6 65 0 minecraft:black_stained_glass", "/setblock 5 69 1 minecraft:light_gray_terracotta",
        # vanilla neighbours for comparison
        "/setblock -6 65 4 minecraft:calcite", "/setblock -6 66 4 minecraft:stripped_oak_log",
        "/setblock 8 66 4 minecraft:cut_copper", "/setblock 8 67 4 minecraft:dark_oak_planks",
        "/setblock 8 68 4 minecraft:bookshelf",
    ]
    for i, (cid, model) in enumerate(CAST):
        x = -13.5 + i * 2
        setup.append(f"/summon minecraft:mannequin {x} 65 -3.5 {{profile:{{texture:\"agentcraft:entity/agent/{cid}\","
                     f"model:\"{model}\"}},Rotation:[180f,0f],hide_description:1b,immovable:1b,NoGravity:1b}}")
    shots = [
        {"name": "ingame_cast_front", "camera": {"x": -8.5, "y": 66.5, "z": -9.2, "lookAt": {"x": -8.5, "y": 66.0, "z": -3.5}, "fov": 70}},
        {"name": "ingame_cast_back", "camera": {"x": -8.5, "y": 66.6, "z": 2.2, "lookAt": {"x": -8.5, "y": 66.0, "z": -3.5}, "fov": 70}},
        {"name": "ingame_cast_34", "camera": {"x": -16.0, "y": 67.4, "z": -7.5, "lookAt": {"x": -9.5, "y": 66.2, "z": -3.5}, "fov": 60}},
        {"name": "ingame_heads_close", "camera": {"x": -12.5, "y": 67.3, "z": -5.4, "lookAt": {"x": -12.5, "y": 66.7, "z": -3.5}, "fov": 60}},
        {"name": "ingame_heads_close2", "camera": {"x": -5.5, "y": 67.3, "z": -5.4, "lookAt": {"x": -5.5, "y": 66.7, "z": -3.5}, "fov": 60}},
        {"name": "ingame_studio_day", "camera": {"x": 1.0, "y": 68.2, "z": -4.5, "lookAt": {"x": 1.5, "y": 66.8, "z": 4.0}, "fov": 70}},
        {"name": "ingame_studio_34", "camera": {"x": -5.0, "y": 70.0, "z": -3.0, "lookAt": {"x": 2.5, "y": 66.5, "z": 3.0}, "fov": 70}},
        {"name": "ingame_monitor_close", "camera": {"x": 2.0, "y": 67.9, "z": 1.6, "lookAt": {"x": 2.0, "y": 67.9, "z": 4.6}, "fov": 70}},
        {"name": "ingame_lamps_close", "camera": {"x": 6.5, "y": 66.4, "z": 1.8, "lookAt": {"x": 6.5, "y": 65.9, "z": 4.5}, "fov": 70}},
        {"name": "ingame_studio_far", "camera": {"x": 1.0, "y": 70.0, "z": -24.0, "lookAt": {"x": 1.0, "y": 67.0, "z": 4.0}, "fov": 70}},
        {"name": "ingame_studio_night", "time": 18000, "camera": {"x": 1.0, "y": 68.2, "z": -4.5, "lookAt": {"x": 1.5, "y": 66.8, "z": 4.0}, "fov": 70}},
        {"name": "ingame_studio_night_far", "time": 18000, "camera": {"x": 1.0, "y": 70.0, "z": -40.0, "lookAt": {"x": 1.0, "y": 67.0, "z": 4.0}, "fov": 70}},
        {"name": "ingame_cast_night", "time": 18000, "camera": {"x": -8.5, "y": 66.5, "z": -9.2, "lookAt": {"x": -8.5, "y": 66.0, "z": -3.5}, "fov": 70}},
        {"name": "ingame_gui_pause", "time": 6000, "screen": "pause", "camera": {"x": 1.0, "y": 68.2, "z": -4.5, "lookAt": {"x": 1.5, "y": 66.8, "z": 4.0}, "fov": 70}},
    ]
    return {"description": "Art track in-game check (assets-src/ingame_check.py)",
            "defaults": {"time": 6000, "weather": "clear", "hideHud": True, "mode": "spectator"},
            "setup": setup, "shots": shots}


def copy_mod(ref="HEAD"):
    """mod/ as committed at `ref` (git archive, read-only): other tracks may be mid-edit in the
    working tree, and the art check only needs a client that builds and has the DevBridge."""
    import io
    import tarfile
    if MODCOPY.exists():
        shutil.rmtree(MODCOPY)
    WORK.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["git", "-C", str(REPO), "archive", "--format=tar", ref, "mod"], capture_output=True)
    if r.returncode == 0 and r.stdout:
        with tarfile.open(fileobj=io.BytesIO(r.stdout)) as tf:
            tf.extractall(WORK, filter="data")
        print(f"mod/ copied from git {ref}")
    else:
        print("git archive failed, copying the working tree:", r.stderr.decode(errors="replace")[:200])
        ignore = shutil.ignore_patterns("build", "run", ".gradle", "out", "*.log")
        shutil.copytree(REPO / "mod", MODCOPY, ignore=ignore)
    run = MODCOPY / "run"
    (run / "resourcepacks").mkdir(parents=True)
    opts = (REPO / "mod" / "run-template" / "options.txt").read_text(encoding="utf-8").splitlines()
    opts = [o for o in opts if not o.startswith(("resourcePacks:", "incompatibleResourcePacks:"))]
    opts.append(f'resourcePacks:["vanilla","file/{PACK_NAME}"]')
    (run / "options.txt").write_text("\n".join(opts) + "\n", encoding="utf-8")
    return run


def node(*args, timeout=900):
    return subprocess.run(["node", *args], cwd=REPO, capture_output=True, text=True, timeout=timeout)


def scan_log(path: Path):
    bad = []
    keys = ("agentcraft", PACK_NAME, "Unable to load model", "Missing texture", "missing textures",
            "Exception loading blockstate", "Failed to load", "Unable to resolve", "Invalid", "nine_slice",
            "Couldn't load", "Unknown", "mannequin")
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if ("WARN" in line or "ERROR" in line) and any(k in line for k in keys):
            bad.append(line.strip()[:400])
    return bad


def other_clients():
    """Command lines of running Minecraft (Fabric Knot) clients - read-only query."""
    if os.name != "nt":
        return []
    r = subprocess.run(["powershell", "-NoProfile", "-Command",
                        "Get-CimInstance Win32_Process -Filter \"Name='java.exe'\" | "
                        "ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"],
                       capture_output=True, text=True, timeout=60)
    return [ln[:200] for ln in r.stdout.splitlines() if "KnotClient" in ln or "net.minecraft.client.main" in ln]


def port_free(port):
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack-only", action="store_true")
    ap.add_argument("--keep-open", action="store_true", help="do not quit the game after the shots")
    ap.add_argument("--allow-concurrent", action="store_true", help="start even if another client runs")
    a = ap.parse_args()
    if not OUT.exists():
        raise SystemExit("run assets-src/build.py first")
    run = copy_mod() if not a.pack_only else (WORK / "pack-only")
    build_pack(run / "resourcepacks" / PACK_NAME)
    sc = WORK / "ingame_scene.json"
    sc.write_text(json.dumps(scene(), indent=1), encoding="utf-8")
    if a.pack_only:
        return 0
    busy = other_clients()
    if busy and not a.allow_concurrent:
        print("another Minecraft client is running; not starting a second one (use --allow-concurrent):")
        for b in busy:
            print("  ", b)
        return 2
    if not port_free(PORT):
        print(f"port {PORT} is busy; set AGENTCRAFT_ARTCHECK_PORT")
        return 2
    SHOTS.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, GRADLE_USER_HOME=str(REPO / ".gradle-home"), AGENTCRAFT_DEV_PORT=str(PORT),
               AGENTCRAFT_SHOTS_DIR=str(SHOTS), AGENTCRAFT_MUTE="1", AGENTCRAFT_FOCUS="0", AGENTCRAFT_AUTOWORLD="1")
    log_path = LOGS / "ingame_client.log"
    gradlew = MODCOPY / ("gradlew.bat" if os.name == "nt" else "gradlew")
    t0 = time.time()
    with open(log_path, "w", encoding="utf-8") as log:
        proc = subprocess.Popen([str(gradlew), "runClient", "--no-daemon", "--console=plain"], cwd=MODCOPY, env=env,
                                stdout=log, stderr=subprocess.STDOUT)
    (WORK / "client.pid").write_text(str(proc.pid))
    print(f"runClient started (pid {proc.pid}), log {log_path}")
    report = {"pid": proc.pid, "port": PORT}
    try:
        r = node("tools/shoot.mjs", str(sc), "--port", str(PORT), "--manifest", str(SHOTS / "manifest.json"))
        report["shoot_exit"] = r.returncode
        report["shoot_stderr_tail"] = r.stderr[-3000:]
        try:
            report["shoot"] = json.loads(r.stdout)
        except ValueError:
            report["shoot_stdout_tail"] = r.stdout[-3000:]
        st = node("tools/devcli.mjs", "state", "--port", str(PORT), timeout=60)
        report["state"] = st.stdout[-4000:]
    finally:
        if not a.keep_open:
            q = node("tools/devcli.mjs", "quit", "--port", str(PORT), timeout=120)
            report["quit"] = (q.returncode, q.stdout[-500:])
            try:
                proc.wait(timeout=180)
            except subprocess.TimeoutExpired:
                # only ever the process tree this script started
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
                report["killed"] = True
            report["exit_code"] = proc.returncode
    report["seconds"] = round(time.time() - t0, 1)
    report["log_problems"] = scan_log(log_path)
    (SHOTS / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k not in ("state", "shoot_stderr_tail")}, indent=1)[:6000])
    return 0 if report.get("shoot_exit") == 0 and not report["log_problems"] else 1


if __name__ == "__main__":
    sys.exit(main())

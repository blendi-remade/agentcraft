# AgentCraft mod: developer notes

Fabric mod `agentcraft` (package `dev.agentcraft`). Common entrypoint `dev.agentcraft.AgentCraft`,
client entrypoint `dev.agentcraft.client.AgentCraftClient`. Loom's split source sets are used:
`src/main` (both sides) and `src/client` (client only).

In ACHQ this mod is the reference implementation and test target for generated offices. The upstream
Foreman (agent orchestrator), art pipeline and QA tooling are not in this repo; the mod's Foreman
link simply stays disconnected.

## Versions, and why

| Thing | Version |
|---|---|
| Minecraft | **26.3** |
| Fabric Loader | 0.19.5 |
| Fabric API | 0.161.0+26.3 |
| Loom | 1.18.2 (`net.fabricmc.fabric-loom`, the non-remapping plugin) |
| Gradle | 9.7.1 (wrapper) |
| Java | 25 (runtime and `--release 25`) |
| DevBridge WebSocket | org.java-websocket:Java-WebSocket 1.6.0 (nested with jar-in-jar) |

From 26.1 on, Minecraft is **unobfuscated**: no mapping layer, and the decompiled sources use
Mojang's real names, so every API can be checked by grepping the real sources (see "Finding
Minecraft APIs"). 26.x requires Java 25.

Many APIs changed after 1.21. Do **not** code from 1.21-era memory. Changes that matter here:
- **Windowing and input use SDL3, not GLFW.** Key codes are SDL scancodes (`InputConstants.KEY_ESCAPE == 41`).
- Rendering is split into extract and render passes (`GameRenderer.extract/render`, `*RenderState`).
  Screens are drawn through `GuiGraphicsExtractor`.
- Screens: `mc.gui.setScreen(..)` and `mc.gui.screen()`. The HUD is `mc.gui.hud`.
- Game rules are snake_case registry entries (`GameRules.ADVANCE_TIME`, ...).
- `Identifier` replaces `ResourceLocation`. Permissions use `PermissionSet`.
- Resource pack format is 97.1, data pack format is 121.

## Build and run

Keep Gradle's cache out of your home directory by pointing `GRADLE_USER_HOME` at a folder you choose:

```bash
cd mod
GRADLE_USER_HOME=<dir>/.gradle-home ./gradlew build        # jar -> mod/build/libs/agentcraft-0.1.0.jar
GRADLE_USER_HOME=<dir>/.gradle-home ./gradlew runClient    # dev client
GRADLE_USER_HOME=<dir>/.gradle-home ./gradlew --stop       # stop OUR daemons only
```
(PowerShell: `$env:GRADLE_USER_HOME='<dir>\.gradle-home'; .\gradlew.bat runClient`.)

`runClient` starts with **no clicks**:
1. `prepareRunDir` copies `run-template/options.txt` to `mod/run/options.txt` if that file does not
   exist yet (volume 0, `pauseOnLostFocus:false`, GUI scale 3, render distance 16, no tutorial).
   Delete `mod/run/options.txt` to reset it.
2. Program args: `--username <you> --width 1920 --height 1080`, where `<you>` is `AGENTCRAFT_PLAYER`
   or else your OS user name (letters, digits and `_`, at most 16 characters).
3. **AutoWorld** (client) runs the first time the title screen appears. It loads the world folder
   `AgentCraft HQ` if it exists, and otherwise creates it: creative, peaceful, commands allowed, no
   structures, superflat plains meadow, so **the grass top is y=64 and you stand at y=65**. World
   spawn is 0 65 0.
4. **HqWorld** (server side, HQ world only) re-applies the game rules on every start (no time or
   weather cycle, no mob spawning, keep inventory, `max_block_modifications` 1,000,000) and writes a
   marker file `agentcraft-world.json` in the world folder. Players who join in spectator or survival
   are put back into creative.

Delete `mod/run/saves/AgentCraft HQ` to start over with a fresh world.

### Environment switches (env var, or `-Dagentcraft.xxx=` system property)

| Var | Default | Effect |
|---|---|---|
| `AGENTCRAFT_DEV` | dev run: 1, jar: 0 | `0` disables the DevBridge, `1` enables it |
| `AGENTCRAFT_DEV_PORT` | 7879 | DevBridge port (always bound to 127.0.0.1) |
| `AGENTCRAFT_MUTE` | dev run: 1, jar: 0 | `1` forces master and music volume to 0 at startup |
| `AGENTCRAFT_FOCUS` | dev run: 0, jar: 1 | `0`: the window is shown without activating it |
| `AGENTCRAFT_AUTOWORLD` | dev run: 1, jar: 0 | `1`: create/load the "AgentCraft HQ" world on startup |
| `AGENTCRAFT_FOREMAN` | 1 | `0` disables the Foreman link (the HUD says so) |
| `AGENTCRAFT_HQ_AUTOBUILD` | 1 | `0` stops a fresh HQ world from building the studio on first start |
| `AGENTCRAFT_HQ_ANYWORLD` | 0 | `1` lets `/agentcraft hq` build outside the "AgentCraft HQ" world |

"Dev run" is `gradlew runClient`; "jar" is a built jar installed in a normal launcher.

## DevBridge

A WebSocket on `127.0.0.1:${AGENTCRAFT_DEV_PORT:-7879}` served by the client in dev runs. It can move
the camera, take screenshots, run commands and report state (`dev.camera`, `dev.screenshot`,
`dev.command`, `dev.state`, `dev.anchors`, `dev.hq.check`, `dev.quit`, ...). The upstream Node tools
that drove it are not in this repo; the message handlers in `client/dev/DevBridge.java` and
`DevCommands.java` are the reference. Request fields `id`, `type` and `timeoutMs` are reserved.

## Anchors and the test room

`layout.Anchors` holds the published layout (an immutable snapshot, readable from any thread) and
saves it as `agentcraft-anchors.json` in the world folder; it is loaded again whenever the HQ world
starts. `/agentcraft hq [builder]` runs an `hq.HqBuilder`, publishes its anchors and moves the world
spawn to `spawn`. Because it rewrites terrain and moves the spawn, it only builds in the "AgentCraft HQ"
world and never in a Hardcore world. `/agentcraft anchors` lists the current anchors.

## Blocks

All 16 AgentCraft blocks are registered (`block.ModBlocks`) with block items and the "AgentCraft
Studio" creative tab (`block.ModItems`). Facing blocks face the placer, and connectable panels
compute up/down/left/right from same-facing neighbours. Block entities (with a saved and synced
binding string) exist on monitor, task_board, decision_podium, merge_station, status_lamp,
console_terminal and memory_archive.

## Finding Minecraft APIs

```bash
GRADLE_USER_HOME=<dir>/.gradle-home ./gradlew mcSources   # genSources + unpack into mod/build/mcsrc
grep -rn "class LevelRenderer" mod/build/mcsrc/net/minecraft
```
`gradlew clean` deletes `mod/build/mcsrc` with the rest of `build/`; run `mcSources` again after a
clean (about a minute). Fabric API module sources are in the official maven, for example
`https://maven.fabricmc.net/net/fabricmc/fabric-api/<module>/<version>/<module>-<version>-sources.jar`.

## Gotchas

- Removing a registered entry (block, entity type) from an existing world triggers Fabric's "Missing
  content detected!" screen. `AutoWorld` answers it for the HQ world only.
- Resource paths must be lower case; the game refuses other characters in model file names.
- JSpecify `@Nullable` on a qualified nested type goes after the dot: `Anchors.@Nullable Bounds`.
- Git Bash rewrites a leading slash in an argument into a Windows path (the command `/agentcraft hq`
  arrived as `C:/Program Files/Git/agentcraft hq`). Use PowerShell, or set `MSYS_NO_PATHCONV=1`.
- Don't set `setReuseAddr(true)` on the DevBridge server. On Windows that would allow two games to
  bind the same port.
- `mod/run/` is gitignored.
- Harmless log noise in dev: `Could not authorize you against Realms server` and `Requested post
  effect does not exist: minecraft:end_of_frame`.

# AgentCraft mod: developer notes

Fabric mod `agentcraft` (package `dev.agentcraft`). Common entrypoint `dev.agentcraft.AgentCraft`,
client entrypoint `dev.agentcraft.client.AgentCraftClient`. Loom's split source sets are used:
`src/main` (both sides) and `src/client` (client only).

## Versions, and why

| Thing | Version |
|---|---|
| Minecraft | **26.3** (stable, released 2026-09-15) |
| Fabric Loader | 0.19.5 |
| Fabric API | 0.161.0+26.3 |
| Loom | 1.18.2 (`net.fabricmc.fabric-loom`, the non-remapping plugin), pinned to a release instead of the template's `1.18-SNAPSHOT` |
| Gradle | 9.7.1 (wrapper from the official template) |
| Java | 25 (runtime and `--release 25`) |
| DevBridge WebSocket | org.java-websocket:Java-WebSocket 1.6.0 (nested with jar-in-jar; slf4j comes from Minecraft) |

The spec said 1.21.x. **26.3 was chosen instead** for these reasons:
- It is the newest stable release, with an actively maintained Fabric API, and it is the default branch
  of the official `FabricMC/fabric-example-mod` template.
- From 26.1 on, Minecraft is **unobfuscated**. There is no mapping layer and no remapping (so builds
  are faster), and the decompiled sources use Mojang's real names. For agents this is the biggest win:
  every API can be checked by grepping the real sources (see "Finding Minecraft APIs").
- 26.x requires Java 25, which is the JDK installed here. 1.21.11 would have targeted Java 21.

The cost is that many APIs changed after 1.21. Do **not** code from 1.21-era memory. Check the
26.3 sources. Changes that matter to this project:
- **Windowing and input use SDL3, not GLFW** (`com.mojang.blaze3d.platform.Window`, `SDLHints`).
  Key codes are SDL scancodes (`InputConstants.KEY_ESCAPE == 41`).
- Rendering is split into extract and render passes (`GameRenderer.extract/render`, `*RenderState`).
  Screens are drawn through `GuiGraphicsExtractor`. Backends live under `com.mojang.renderpearl`.
  OpenGL is the default; Vulkan is optional (options key `preferredGraphicsBackend`).
- Screens: `mc.gui.setScreen(..)` and `mc.gui.screen()` (no longer on `Minecraft`). The HUD is `mc.gui.hud`
  (`isHidden()` and `toggle()` replace `options.hideGui`).
- Game rules are snake_case registry entries (`GameRules.ADVANCE_TIME`, `KEEP_INVENTORY`, ...).
- Day time comes from world clocks: `level.getDefaultClockTime()`. `/time set` still works.
- `Identifier` replaces `ResourceLocation`. Permissions use `PermissionSet` and `LevelBasedPermissionSet.OWNER`.
- **Resource pack format is 97.1, data pack format is 121** (from the jar's `version.json`). The art
  track should target these.

## Build and run

Always isolate Gradle:

```bash
cd mod
GRADLE_USER_HOME=C:/Projects/agentcraft/.gradle-home ./gradlew build        # jar -> mod/build/libs/agentcraft-0.1.0.jar
GRADLE_USER_HOME=C:/Projects/agentcraft/.gradle-home ./gradlew runClient    # dev client
GRADLE_USER_HOME=C:/Projects/agentcraft/.gradle-home ./gradlew --stop       # stop OUR daemons only
```
(PowerShell: `$env:GRADLE_USER_HOME='C:\Projects\agentcraft\.gradle-home'; .\gradlew.bat runClient`.)

`runClient` starts with **no clicks**:
1. `prepareRunDir` copies `run-template/options.txt` to `mod/run/options.txt`, but only if that file
   does not exist yet. The template sets: master and music volume 0, `pauseOnLostFocus:false`,
   `guiScale:3` (1080p), render distance 16, chunk fade-in off (so screenshots are never half-faded),
   no tutorial, accessibility onboarding or narrator, no Realms notifications, and the
   inactivity FPS limit set to "minimized" only. Delete `mod/run/options.txt` to reset it.
2. Program args: `--username <you> --width 1920 --height 1080`, where `<you>` is `AGENTCRAFT_PLAYER`
   or else your OS user name (letters, digits and `_`, at most 16 characters).
3. **AutoWorld** (client) runs the first time the title screen appears. It loads the world folder
   `AgentCraft HQ` if it exists, and otherwise creates it: creative, peaceful, commands allowed, no
   structures, no bonus chest, superflat plains meadow (bedrock / 124 stone / 3 dirt / grass), so
   **the grass top is y=64 and you stand at y=65**. World spawn is 0 65 0.
4. **HqWorld** (server side, HQ world only) re-applies the game rules on every start: no time or
   weather cycle, keep inventory, no fire spread, no mob spawning of any kind, no mob griefing, no vine
   spread, no snow build-up, respawn radius 0, no locator bar, quiet advancement and command output,
   and max_block_modifications 1,000,000 so large /fill commands work for the HQ builder. On first
   creation it also sets time 12000 (golden hour), clear weather and the world spawn. It writes a
   marker file `agentcraft-world.json` in the world folder. Players who join in spectator or survival
   are put back into creative.

Delete `mod/run/saves/AgentCraft HQ` to start over with a fresh world.

### Environment switches (env var, or `-Dagentcraft.xxx=` system property)

| Var | Default | Effect |
|---|---|---|
| `AGENTCRAFT_DEV_PORT` | 7879 | DevBridge port (always bound to 127.0.0.1) |
| `AGENTCRAFT_DEV` | 1 | `0` disables the DevBridge |
| `AGENTCRAFT_MUTE` | 1 | Forces master and music volume to 0 at startup. **Set `0` for real use** (for example in launch.ps1) to keep your own volume |
| `AGENTCRAFT_FOCUS` | 0 | `0`: the window is shown **without activating it**, so it never steals focus. `1`: normal "come to front" |
| `AGENTCRAFT_AUTOWORLD` | 1 | `0`: stay on the title screen |
| `AGENTCRAFT_SHOTS_DIR` | `<repo>/artifacts/shots` | Where `dev.screenshot` writes |
| `AGENTCRAFT_DEV_ALLOW_ORIGIN` | 0 | `1` lets browser pages (which send an Origin header) connect. They are refused by default |
| `AGENTCRAFT_DEV_TEST` | 0 | `1` registers test-only commands (`dev.test.stall`, which blocks the render thread to simulate a hung game; `dev.test.foremanMessage`). Never set it for real use |
| `AGENTCRAFT_PORT` | 7878 | Foreman WebSocket port the mod connects to (always 127.0.0.1) |
| `AGENTCRAFT_FOREMAN` | 1 | `0` disables the Foreman link (the HUD says so) |

The defaults (muted, no focus) suit unattended agent runs. `tools/launch.ps1` should set
`AGENTCRAFT_MUTE=0 AGENTCRAFT_FOCUS=1` for real use (when you launch the game yourself; it does
without `-Dev`). The name the agents call you comes from the Foreman (`--user-name`, see
foreman/README.md) and reaches the mod in `foreman.status`.

### Focus behaviour (what was verified)
`RenderSystemMixin` sets the SDL hints `SDL_WINDOW_ACTIVATE_WHEN_SHOWN=0`,
`SDL_WINDOW_ACTIVATE_WHEN_RAISED=0` and `SDL_FORCE_RAISEWINDOW=0` before SDL starts. SDL3 then shows
the window with `SWP_NOACTIVATE`. Verified on Windows 11: after launch, `GetForegroundWindow()` was
still the previously active app. `dev.state` reports `window.osForeground:false`, read through a
read-only user32 call using Java FFM.

Caveat: **SDL's own flag (`window.focused`) still says `true`.** The window can still appear on top
of other windows; it just isn't activated. Window *placement* is untouched.

## DevBridge (dev control WebSocket)

A WebSocket server **inside the client**, listening on `ws://127.0.0.1:${AGENTCRAFT_DEV_PORT:-7879}`. It
starts at `CLIENT_STARTED`, before the world loads, so `dev.ping` works during loading. It stops at
`CLIENT_STOPPING` and uses daemon threads. If the port is busy it logs an error and the game keeps running.

**Protocol.** Each frame carries one JSON object (text frames; binary frames holding UTF-8 JSON are
treated the same, other binary frames get an `ok:false` reply).
- Request: `{"id":"7","type":"dev.camera", ...fields}`. `id`, `type` and `timeoutMs` are reserved
  names, so never use them as payload field names.
  - `id` (optional) is a string or a number and is echoed back **exactly as sent** (`7` stays a number).
    Any other id (object, array, bool) gets an `ok:false` reply that still carries the id.
  - `type` must be a JSON string (`["dev.state"]` or `5` are refused).
  - `timeoutMs` (optional, integer 1..3600000) overrides the command's server-side timeout.
- Reply: `{"id":"7","type":"dev.camera","ok":true, ...result}` or `{"id":"7","type":"dev.camera","ok":false,"error":"..."}`.
  Replies always include null-valued fields (for example `dev.state` `screen: null`, `foreman: null`).
- **Fields are strictly typed** and errors name the field: numbers must be JSON numbers and finite (the
  strings `"NaN"`/`"12"`, bare `NaN`/`Infinity` and overflowing `1e400` are refused), integers must be whole,
  booleans must be `true`/`false` (the string `"false"` is refused), and every number has a range. Example:
  `field 'ticks' must be an integer (got string "noon")`, `field 'lookAt.x' must be a finite number (got string "NaN")`.
- A timeout while the render thread is stuck carries `stalled:true` and says so in `error`.
- On connect the server sends `{"type":"dev.hello","protocol":1,"minecraft":"26.3","inWorld":bool}`.
- Requests may be in flight at the same time; match replies by `id`. All game work is done on the
  render thread (`mc.execute` or the end-of-frame scheduler) or on the integrated server thread
  (`server.submit`), and the reply is sent asynchronously. Every handler error becomes an
  `ok:false` reply; nothing is thrown into the game. Unexpected exceptions are reported as
  `internal error: <exception>` and logged with a stack.
- Connections that send an `Origin` header (browsers) are refused with HTTP 404.

| Command | Fields | Result / notes |
|---|---|---|
| `dev.ping` | (none) | `{pong, frame, msSinceLastFrame, stalled, quitting}`. Answered on the socket thread, so it answers while the game loads **and while it is hung**. `stalled:true` = the render thread has not finished a frame for 5 s (QA: relaunch) |
| `dev.help` | (none) | All commands with help text, plus registered screens |
| `dev.state` | (none) | `inWorld`, **`ready`** (in a world with no loading screen or overlay: safe to shoot), `paused` (a pausing screen is open, so the integrated server is stopped), `screen{class,title}` or null, `fps`, `frame`, `window{width,height,framebufferWidth/Height,renderWidth/Height,guiScale,focused,osForeground,iconified}`, `mouse{x,y,guiX,guiY,grabbed}` (logical window and scaled GUI pointer coordinates), `hudHidden`, `fov` (what the last frame was rendered with), `fovOption` (the player's setting), `fovPin` (dev camera pin, null = none), `cameraType`, `audio{master,music}`, `player{name,x,y,z,eyeY,yaw,pitch,flying,gameMode}`, `camera{x,y,z,yaw,pitch,fov}`, `world{name,dimension,time,raining,thundering}`, `chunks{renderedAll,lightQueue,loadedAll,renderDistance}` (player/camera/world/chunks are null outside a world), `foreman{link, connected, url, attempt, lastError, phaseForMs, everSynced, snapshots, messages, lastMessageAgoMs, stale, backend, auth, message, version, counts{agents, activeAgents, tasks, openTasks, decisions, openDecisions, repos, memory, goals, feed}, goal?, oldestOpenDecision}`, `agents{count, moving, pathFailures, plates, plateOverlaps, plateLayoutUs}` (plates = nameplates laid out last frame, plateOverlaps = pairs of drawn plates overlapping on screen last frame, 0 when settled; plateLayoutUs = mean cost of the declutter pass) |
| `dev.camera` | `anchor?` (fills x/y/z/yaw/pitch from the published layout, see `dev.anchors`; `cam_*` anchors are eye positions, other anchors feet positions; explicit fields win), `x,y,z` + (`yaw,pitch` **or** `lookAt:{x,y,z}`, lookAt wins), `fov?` (30-110, may be fractional; **default: the player's FOV option**), `mode?` = `spectator` (default) / `creative` (flying) / `keep`, `feet?` (default false: x,y,z is the **eye** position), `hideHud?`, `closePause?` (default true: closes a vanilla pause menu first) | Validates first: all numbers finite; `pitch` in [-90, 90]; `yaw` any finite value (wrapped to [-180, 180)); `y` in [-20000000, 19999999] (vanilla `/tp`'s limit); x/z inside the **world border** (±29999984); lookAt not equal to the eye. Then forces first person, stops spectating other entities, teleports on the server thread, waits until the client has the exact position, pins position and rotation with no interpolation, and **only replies ok once a rendered frame used exactly the requested eye position (±0.01), rotation (±0.05°) and FOV**; otherwise `ok:false` with wanted vs got (`mode:keep` skips that check, since walking players fall). Returns the actual `camera{x,y,z,yaw,pitch,fov}`. Yaw: 0 = +Z (south), 90 = -X (west), -90 = +X (east). Pitch: positive looks down. **FOV pin:** each call renders with exactly its `fov` (or the option), ignoring vanilla's dynamic FOV (flying widens it by 1.1x, so before this pin a "70" shot really rendered at 77). Nothing carries over between calls and `options.txt` is never touched |
| `dev.release` | `mode?` = `creative` (default) / `keep` | Hands the view back to the player: clears the FOV pin (vanilla FOV again), shows the HUD, spectator -> creative (flying, so you don't fall) |
| `dev.screenshot` | `name` (letters, digits, `_ - . /`; `.png` added), `hideHud?` (default true), `frames?` (3, 1-600), `waitChunks?` (true), `chunkRadius?` (whole render distance, 0-64), `chunkTimeoutMs?` (30000, 0-600000) | Hides the HUD, waits until all chunks within the render distance are loaded and meshed and the light queue is empty for 5 consecutive frames, waits N more frames, then copies the **main render target** (the framebuffer, so it doesn't depend on window focus or overlap). Writes the PNG and restores the HUD. Returns `{path, width, height, ms, chunksTimedOut, paused, stats{meanLuma,stdLuma,darkFraction}}`. Use the stats to catch black frames. Open screens are included in the capture. `width`/`height` are **not supported** (the shot is the window framebuffer size, 1920x1080). The default request timeout grows with `chunkTimeoutMs` and `frames` |
| `dev.time` | `ticks` (integer 0..2147483647) | `/time set`. 6000 noon, 12000 golden hour (the HQ default), 18000 night, 23300 sunrise |
| `dev.weather` | `weather: clear/rain/thunder` or `clear: bool` | Rain fades in over several seconds (vanilla behaviour) |
| `dev.command` | `cmd` (non-empty string, leading `/` optional) | Runs as the player with owner permissions on the integrated server. Returns `{cmd, messages[], success, result}` (`result` null when the command did not parse). Feedback is captured, not shown in chat. An idempotent `/fill` reports `success:false` with "No blocks were filled" |
| `dev.screen` | `open: name` or `null` (absent = null) | Built in: `title`, `pause`, `chat`, `inventory`, `options`, plus any registered screens. `null` closes the screen (on the title screen it stays on title). Returns the resulting `screen` class or null |
| `dev.key` | `key` (`escape`, `key.keyboard.f3`, ...) + `modifiers?` (0-65535), or `mapping` (`key.chat`) | Sent to the open screen's `keyPressed`, otherwise as a key-mapping click |
| `dev.type` | `text` (up to 100000 chars) | `charTyped` into the open screen's focused widget |
| `dev.hud` | `hidden: bool` | Like F1 |
| `dev.waitChunks` | `timeoutMs?` (30000; also the request timeout), `radius?` (0-64) | Waits for chunks to load and build (same condition as screenshots) |
| `dev.wait` | `frames?` (0-36000), `ms?` (0-600000) | Waits for rendered frames and/or wall time; the default request timeout grows with both |
| `dev.quit` | `forceAfterMs?` (15000, 1000-600000) | Replies `{quitting, alreadyQuitting, renderThreadStalled, forceAfterMs}`, then calls `mc.stop()` 250 ms later: the world saves and the JVM exits (about 1-2 s). **Watchdog:** if the render thread is hung and has not run the stop after `forceAfterMs`, it logs the render thread's stack, stops the integrated server (which saves the world), then halts the JVM with **exit code 3** (`runClient` then ends with BUILD FAILED). If a normal shutdown is still running after 90 s it does the same with exit code 4 |
| `dev.test.stall` | `ms` (1-600000) | **Test only** (`AGENTCRAFT_DEV_TEST=1`): blocks the render thread to simulate a hang |
| `dev.foreman` | `reconnect?` (false) | The Foreman link + model summary (same as `dev.state.foreman`); `reconnect:true` drops the connection and connects again now |
| `dev.foreman.send` | `message:{type, ...}` | Sends a client message (docs/protocol.md "Mod -> Foreman") through the mod's own link and replies `{ack:{re, ok, error?, result?}}`. Example: `{message:{type:"goal.submit", text:"Add #tags"}}`, `{message:{type:"decision.answer", decisionId:"d3", option:"Merge"}}` |
| `dev.foreman.inject` | exactly one of `message:{type,...}`, `patch:{agent\|task: id, set:{wire fields}}`, `say:{agent, text, to?}` | Applies to the mod's Foreman model **as if the Foreman had sent it** (always available; bypasses the hold queue). `patch` copies the current agent/task, replaces the given wire fields (`{"station":"desk","state":"editing"}`, `{"status":"doing","assignee":"marlow"}`, `null` clears) and applies it as an `agent.upsert`/`task.upsert`; `say` is an `agent.say` stamped now. Replies `{applied, message}`. Video choreography; the next snapshot (reconnect) undoes it |
| `dev.foreman.hold` | `on` (bool), `release?` = `reconnect` (default) / `replay` / `drop` | `on:true`: live Foreman messages are queued instead of applied, so a shot shows only what it injects. `on:false` releases them: `reconnect` drops the queue and reconnects (fresh snapshot), `replay` applies the queue, `drop` discards it. `dev.state.foreman.held/heldQueued` show it |
| `dev.play` | `duration` (s), `camera`, `timeline?`, `name?`, `showHud?` (false), `holdEndMs?` (300), `foreman?:{hold?, release?}`, `log?` (true) | **Real-time shot playback** for a screen recorder (OBS). See "Shot playback" below. Replies when the shot is done: `{frames, resolution, perf{fps, frameMsMedian/P99/Max, framesOver20ms, pathStepMsMin/Max}, cameraVsPath{maxPosError, maxRotError, maxFovError}, events[{t, at, event, ok, error?}], warnings, frameLog}` |
| `dev.play.pose` | `camera`, `t?` (0), `duration?` | Where a camera path is at time t: `{pose{x,y,z,yaw,pitch,fov}, start, end}` (eye position). `record.mjs` puts the camera there with `dev.camera` before playing; also handy to preview a path with stills |
| `dev.play.status` / `dev.play.stop` | | Progress of the playing shot / stop it (its `dev.play` replies `ok:false`) |
| `dev.window` | `width`, `height` | Resizes the game window (windowed mode, `Window.setWindowed`), e.g. 2560x1440 to fill the monitor for a capture; replies once a frame was rendered at the new size `{width, height, framebufferWidth/Height, renderWidth/Height}` |
| `dev.agents` | `settle?` (false) | Every agent NPC: `id, entityId, x,y,z, yaw, station, anchor, target{x,y,z,yaw}, walking, path[[x,y,z]...], state, activity, stale, model, skin`, and `plate{mode full\|compact, lift, target, rank, nudge, scale, depth, weight, focused, capped, rect[x0,y0,x1,y1] in screen px}` when its nameplate was laid out last frame; top level also has `plates, plateOverlaps`; `dev.state.agents` also has `plateOverlapPairs` ("rowan/wren": which plates overlapped last frame) and `exclaims`. `settle:true` snaps walking agents to their targets and the nameplates to their final layout on the next frame (no one mid-walk, no plate mid-slide in a shot) |
| `dev.anchors` | `prefix?` | The published layout: `{layout, revision, bounds, anchors:{name:{x,y,z,yaw,pitch}}, count}` |
| `dev.agents.look` | `agent?` | Agent life per agent: `{id, family, awaitingUser, awaitingDecision, needsYou, paused, posture, seated, sit, seat{x,z,top,drop,deskTop}?, bodyYaw, headYaw, headPitch, bubble, particles}`; top level `exclaims` (agents showing the "!"), `card{agent, input}` while an agent card is open (`input` = its message line, null when closed), `textInputActive` (SDL text input on: typed characters are delivered) |
| `dev.agents.card` | `agent` | Opens the agent card for that agent (like right-clicking it) |
| `dev.agents.fx` | `agent`, `fx` = `confetti`/`puff`/`sparkle`/`say`, `text?`, `to?` | Plays an agent effect now (QA preview; `say` shows a local speech bubble, nothing is sent) |
| `dev.agents.keys` | `keys` (comma-separated: key names `space return escape back tab left right`, or text typed letter by letter, a-z 0-9 space) | **Test only** (`AGENTCRAFT_DEV_TEST=1`): presses keys as SDL reports a keyboard (SDL events queued for the game window, one key every 3 frames, through Minecraft's SDL event loop; printable keys produce text events only while SDL text input is on). Returns `{pressed, textEvents, screen, input?, textInputActive}`. `tools/agents-typing.mjs` uses it to check the agent card's message line |
| `dev.test.foremanMessage` | `message:{type, ...}` | **Test only** (`AGENTCRAFT_DEV_TEST=1`): applies a Foreman message to the state model as if received (e.g. `foreman.status` with `auth:"failed"` to see the auth banner) |
| `dev.displays` | `look?` = `paper` / `dark` / `split`, `reset?` | Monitor look (default dark; split alternates per monitor for comparisons), every laid-out monitor screen `{pos, agent, mode, style, size, ppb, rows, ageMs}`, and `stats` = display CPU cost per frame since the last reset (`monitor`/`board`: `usPerFrame`, `callsPerFrame`, `rebuilds`) |
| `dev.taskwall` | `open?` (task id), `press?` (button id), `aim?` (task id), `board?` ("x y z" origin for `aim`), `lightFloor?` (0-15), `ppb?` (0-256, 0 = auto), `relayout?` | Task Wall boards and their cards (column counts, widths and cards per row, hidden ids, card positions, size full/brief/compact, title lines, state dot, glowing, `layoutUs` of the last re-plan). `lightFloor`/`ppb` override the block-light floor and the pixel density for A/B shots, `relayout` forces a re-plan. `open` opens that task's screen, `press` presses a button in the open task screen (`prev next retry prioritize reassign cancel to:<agent>`), `aim` returns the world point of a card and an eye 2.5 blocks in front (then `dev.camera` + `dev.key {mapping:"key.use"}` clicks it the real way; use `mode:"creative"`, spectators cannot click) |

Registered screens (`dev.screen {open}`): `creative_agentcraft` (creative inventory on the AgentCraft tab), `agent` (agent card: last clicked agent, else whoever needs you), `task` (task detail: the last task opened, else the first doing one). Phase 3 features add theirs (see mod/FEATURES.md).

### Extending it from other mod code (client side)

```java
DevBridge.register("dev.foreman", 10_000, "{} -> foreman link status", (req, mc) -> {
    Fields f = Fields.of(req);                       // strict typed fields, errors name the field
    int limit = f.optInt("limit", 20, 1, 500);
    return DevBridge.onClient(mc, () -> { JsonObject o = new JsonObject(); /* ... */ return o; });
});
DevBridge.register("dev.slow", req -> Fields.of(req).optLong("ms", 0, 0, 60_000) + 10_000, "...", handler); // request-dependent timeout
DevBridge.registerScreen("console", mc -> new ConsoleScreen());   // dev.screen {open:"console"}
DevBridge.addStateContributor((mc, state) -> state.add("foreman", foremanStatusJson()));
FrameScheduler.afterFrames(2).thenRun(...);                        // end-of-frame callbacks (render thread)
FrameScheduler.when(() -> condition, minFrames, stableFrames, timeoutMs, "what");
FrameScheduler.msSinceLastFrame(); FrameScheduler.stalled();      // render-thread liveness, any thread
DevBridge.invoke("dev.screen", req);                               // run a registered command from mod code (dev.play timelines)
```
Register in `onInitializeClient`. Built-ins are registered when the bridge starts, so a later
`register` with the same name replaces a built-in. Throw `DevBridge.DevException` for user errors
(sent back verbatim); any other exception becomes `internal error: ...` and is logged.
`Fields` (`num`, `num(min,max)`, `optNum`, `integer`, `optInt`, `optLong`, `bool`, `optBool`, `str`,
`nonBlank`, `optStr`, `obj`, `optObj`) refuses NaN/Infinity, wrong JSON types and out-of-range values.

### Shot playback (`dev.play`, `tools/record.mjs`)

Plays a choreographed camera shot **in real time** so a screen recorder (OBS, 60 fps window
capture) films it. Code: `client.dev.play` (`ShotPlayer`, `CameraPath`, `Timeline`, `PlayCommands`);
hooks in `MinecraftMixin`; shot files and their format: `tools/shots/README.md`.

Per loop iteration, on the render thread:
1. `Minecraft.runTick` HEAD (before the client ticks): the first call starts the clock; every
   timeline event with `t <= elapsed` runs, so its effect is in this frame.
2. `Minecraft.renderFrame` HEAD (after the ticks): the path is sampled and the player is snapped
   there with `snapTo` (position **and previous position**, rotation **and previous rotation**), the
   camera's own smoothed eye height (`CameraAccessor`, lerped with the partial tick) is subtracted,
   and the FOV is pinned (`DevCamera`). `Camera.alignWithEntity` then lands exactly on the path:
   no tick interpolation, no jitter (measured: rendered camera vs path max error 0 blocks / 8e-6 deg).
3. `renderFrame` TAIL: frame timing and the rendered camera are logged; after the end pose was held
   for `holdEndMs` the shot ends, the HUD comes back and a Foreman hold is released.

**Which time a frame shows.** Frame *starts* jitter by about +-2 ms against vsync (ticks, packets,
GC); frame *ends* (right after present) are as regular as the display. Sampling the path at the
frame start gave uneven camera steps (14.8-18.6 ms of path time per 16.7 ms frame). The path is
now sampled at the predicted present time: previous frame end + the smoothed frame interval,
clamped to within one interval of the wall clock (a hitch still advances the camera by the real
time that passed). Path steps now follow the frame intervals (16.59-16.78 ms in a clean take).
t = 0 is the predicted present time of the shot's first frame.

**Camera paths** (`camera` field, also `dev.play.pose`):
- `keys`: keyframes `{t, x,y,z, yaw,pitch | lookAt:{x,y,z}, fov?, ease?}` or `{t, anchor}` (eye
  position; `cam_*` anchors are eyes, other anchors feet + 1.62). A time-based (non-uniform)
  Catmull-Rom spline (cubic Hermite, tangents `(v[i+1]-v[i-1])/(t[i+1]-t[i-1])`); `easeEnds`
  (default true) gives zero velocity at the first and last key. Yaw takes the shortest arc between
  keys. When every key has a `lookAt` (or the path has one) the look *target* is splined instead
  of yaw/pitch, so a subject stays centred. `ease` on a key (`inOut|in|out|linear`) remaps time
  inside the segment that starts there (e.g. a hold).
- `orbit`: `{center:{x,z}, radius, y, from, to, lookAt?, fov?, ease?:"inOut"}`: an exact arc at
  constant height; angles in degrees, 0 = south of the centre, growing like yaw (90 = west).

**Timeline** (`timeline` field): `{t, inject:{type,...}}`, `{t, patch:{agent|task, set}}`,
`{t, say:{agent, text, to?}}` (same as `dev.foreman.inject`), or `{t, cmd:"dev.xxx", ...fields}`
for any DevBridge command (`dev.screen`, `dev.key`, `dev.agents {settle}`, `dev.screenshot`...;
`dev.command` takes the server command in `command`). `{t, cmd:"dev.type", text, msPerChar?:75,
jitter?:0.3, seed?}` types one character at a time with a natural, seeded rhythm (longer pauses
after spaces/punctuation). An event that fails at once stops the shot (`ok:false`); slower
failures are reported in `events`. With a timeline, live Foreman messages are held during the shot
(`foreman.hold`, default on) and released by reconnecting (fresh snapshot, so the injected changes
are undone after the shot).

**Not deterministic** (real time): the client ticks (agent walks, sitting, bubbles), the integrated
server and the GPU run on their own clocks, so two takes differ by up to a tick (50 ms) in when an
agent arrives; server commands (`dev.command`) apply whenever the server thread gets to them;
particles are random. The camera itself is exact every frame. Shots therefore start agents walking
early enough (desk_story: the walk starts at 0.6 s, the camera arrives at 3.6 s) and never cut
on an agent's exact arrival.

Measured (RTX 4090, vsync on, window 2560x1440 via `dev.window`): all three example shots at 60 fps,
frame time median 16.68 ms, p99 <= 16.8 ms, 0 frames over 20 ms in the final takes (one earlier
orbit take had one 33.5 ms hitch followed by two 8.3 ms frames: the camera followed real time).

## Phase 2: the mod as a live view of the Foreman

Feature map and APIs for Phase 3: **mod/FEATURES.md**. This section records how it works and why.

```
common (src/main)                          client (src/client)
  AgentCraft          registries + init      AgentCraftClient -> ClientFeatures (one init() per feature)
  block/              16 blocks, BEs, items  foreman/   link (java.net.http WS), Protocol records, ForemanState, Foreman facade
  entity/             agent entity type      agents/    AgentManager, AgentMotion, GridPathfinder, AgentRenderer, Nameplate, hooks
  layout/             Anchors + names        hud/       ConnectionBanner        ui/  UiStyle, Kit, Panels, WorldUi, TextUtil
  hq/                 /agentcraft hq builder world/     StationRenderer base, ServerTasks, StationInteractions, dev helpers
  command/            /agentcraft root       monitor/ taskwall/ decisions/ console/ diff/ library/ permissions/ hq/  (Phase 3)
```

### Foreman link
`client.foreman.ForemanLink`: `java.net.http` WebSocket to `ws://127.0.0.1:${AGENTCRAFT_PORT:-7878}`
(no Origin header; the Foreman refuses any). On open it sends `hello`; the `snapshot` reply makes the
link `synced`. Frames are reassembled and parsed on the link's own daemon threads and applied to
`ForemanState` on the client thread with `Minecraft.execute`, in order, so the render and server
threads never block on the network. Requests (`Foreman.send` / `submitGoal` / `answer` / ...)
get an id, are chained (java.net.http allows one outstanding send) and complete with the matching
`ack` (20 s timeout; failed immediately when not synced or when the connection drops). `diff`
replies are matched by `requestId`. Reconnect forever with backoff 0.25, 0.5, 1, 2, 3, 5 s; a watchdog
pings every 15 s and drops a connection that is silent for 45 s or that sends no snapshot within 15 s.
A killed Foreman is noticed at once (connection reset) and its restart is picked up within the
backoff (about 3 s in the Phase 2 test). The model keeps the last known state while disconnected
(`isStale()`): agents stay in place with a dimmed "Foreman offline" plate and the HUD says
"Reconnecting to the Foreman".

### Agents: client-side entities (architecture A), decided by measurement
Two options were prototyped in the Phase 2 test room on the same six anchor-to-anchor routes
(a temporary `dev.proto.ab` command, removed after the measurement; raw data in
`artifacts/logs/proto-ab-final.json`):

- **A**: client-only entities in the client level, moved by `AgentMotion` along a `GridPathfinder`
  route (A* over the client's blocks, string-pulled). No physics, no server AI.
- **B**: a server-side `PathfinderMob` walking with vanilla `GroundPathNavigation` (`moveTo`, re-path
  every 10 ticks like vanilla move-to goals), synced to the client by vanilla entity tracking.

| route | A arrive (ticks) | A final error | A speed CV | B result | B final error | B speed CV | B stalled ticks |
|---|---|---|---|---|---|---|---|
| desk_marlow -> library | 42 | 0 | 0.038 | stopped short | 1.183 | 0.302 | 369 |
| desk_kit -> testbench | 108 | 0 | 0.061 | stopped short | 1.227 | 0.212 | 369 |
| lounge -> mergestation | 122 | 0 | 0.021 | stopped short | 1.566 | 0.192 | 369 |
| user -> desk_tove | 102 | 0 | 0 | timed out | 1.177 | 0.308 | 385 |
| library_2 -> terminal | 147 | 0 | 0.014 | stopped short | 1.199 | 0.168 | 369 |
| testbench_2 -> lounge_2 | 75 | 0 | 0.016 | stopped short | 1.531 | 0.226 | 369 |

(Final error = horizontal distance to the anchor in blocks. Speed CV = std/mean of the per-tick
speed while moving. A also ends on the anchor's exact yaw; its route planning took 0.1-2.3 ms.)

B never reached a spot. Vanilla navigation considers itself done about a block early (its goal is a
block, not a point), its first `moveTo` right after spawning fails (the mob is not on the ground
yet), and it stop-starts, with 3-15x the speed jitter of A. Exact desk and podium spots with the
right facing would need a custom move control on top anyway. B also needs the Foreman state on the
server (client-to-server sync), puts Foreman agents into the world save (stale NPCs after a crash),
lets players push them, and the vanilla `AvatarRenderer` (both skin layers, slim arms) requires an
`Avatar`, which a `PathfinderMob` is not. A is exact and deterministic (same state, same picture,
which screenshot QA needs), cheap, needs no networking, and keeps "the game is only a view".
**Chosen: A.**

How A works: `AgentManager` (END_CLIENT_TICK) keeps one `ClientAgentEntity` (extends `Avatar`,
negative entity id, `noSave`/`noSummon` type; a server-side instance discards itself) per Foreman
agent in `mc.level`. Targets come from `StationAssigner` (desk -> `desk_<id>`, shared stations ->
sticky slots, off shift -> lounge). New agents appear on their spot. Station changes walk at
2.9 blocks/s (the vanilla walk cycle is driven by the real distance moved), turning at most
24 deg/tick and turning in place before walking backwards. No route (or more than 96 blocks)
teleports. Rendering: `EntityRenderDispatcherMixin` routes agents to `AgentRenderer` (an
`AvatarRenderer`, slim or wide by skin), because vanilla sends every `AvatarRenderState` to the
player renderer at submit time. Clicks on agents are consumed client-side (never sent to the server,
which does not know them).

### Nameplates: declutter and occlusion (fix round)
The verifier found plates unreadable whenever agents shared a station (the lounge at every session
start): a full plate is up to 126 GUI px (3.15 blocks) wide, lounge slots are 1.4 blocks apart, all
plate backgrounds were translucent and drawn after all (opaque) text, so side-by-side plates
interleaved their text and a nearer plate let farther text ghost through. Fixed at both levels:

- **Occlusion** (`client.ui.WorldUi`): plates are opaque on `Layer.SOLID` (see gotchas) and get a
  depth nudge by rank, so whenever two plates do overlap, one hides the other completely. Checked
  with Improved Transparency (OIT) on as well (`artifacts/shots/fix2_oit_*.png`).
- **Declutter** (`client.agents.PlateLayout`, once per frame at END_EXTRACTION): projects every
  visible plate to a screen rect, collapses low-value plates (idle/done/off shift/offline, weight
  <= 2) to a name-only pill when the full plate would overlap another, then places plates in priority
  order (crosshair/focused, waiting, error, working/thinking, then the low-value tier; nearest first
  within a tier, sticky) at the lowest lift that clears the plates placed before. Lifts slide (fast
  up, calm down, feed-forward for drifting targets), jump on camera cuts and when a slide would carry
  a plate across another one, and a lifted plate draws a hairline in the agent's colour down to its
  head. The plate under the crosshair always shows in full (hover a compact plate to read it).
  Plates behind walls take no space (line-of-sight test per tick; a camera inside a wall block is
  handled), plates nearer than 1.3 blocks are hidden, a crowd taller than 8 plates hides its
  low-value plates.
- **Mid-distance legibility**: plates keep their world size up to 12 blocks, then grow with
  distance up to 1.6x (constant screen size), so desk plates read from `cam_room`.

Measured (fix round, `artifacts/logs/phase2_fix_live.json`): 0 overlapping plates in every settled
view (lounge front/back/side/focused/stale, showcase, room, reconnect); live sim at speed 4 (up to
six agents walking at once): some plate pair overlapped in 13 of 319 samples (4 %, 200 ms apart),
no run longer than ~0.25 s (mid re-arrangement), always drawn cleanly in rank order. Layout pass:
1-16 microseconds per frame. Fps with vsync off: ~1440 with six agents and plates in view vs ~1850
looking away (the verifier measured 1400-1500 before this change).

### Anchors and the test room
`layout.Anchors` holds the published layout (an immutable snapshot, readable from any thread) and
saves it as `agentcraft-anchors.json` in the world folder; it is loaded again whenever the HQ world
starts. `/agentcraft hq [builder]` runs an `hq.HqBuilder`, publishes its anchors and moves the world
spawn to `spawn`. The Phase 2 builder `test` (`hq.TestRoomBuilder`) is a temporary 25x25 walled
room: a desk island with six monitors (north), library shelves and the task wall (west), terminals
and merge stations (east), a meeting table and the goal atrium (centre), the podium with user spots,
a per-agent status lamp test bench and the lounge (south, everyone facing north so `cam_agents` sees
their faces), plus a sample row of all 16 blocks between vanilla reference blocks north of the room
(`cam_blockrow`). `/agentcraft anchors` and `dev.anchors` list the anchors; `dev.camera {anchor}`
uses them.

### Blocks
All 16 blocks of the assets-src block contract are registered (`block.ModBlocks`) with block items
and the "AgentCraft Studio" creative tab (`block.ModItems`, translation key `itemGroup.agentcraft`).
Facing blocks face the placer (vanilla lectern rule), luminance follows the contract, thin or
shaped blocks are non-occluding with real shapes, and connectable panels compute up/down/left/right
from same-facing neighbours. Block entities (with a saved and synced binding string) exist on
monitor, task_board, decision_podium, merge_station, status_lamp, console_terminal and
memory_archive. Their BERs are empty Phase 3 hooks, except the monitor's placeholder (the agent's
name on the screen).

### Phase 2 gotchas
- **Render layers need no registration in 26.x**: every baked quad picks solid, cutout or
  translucent from its sprite's transparency (`ChunkSectionLayer.byTransparency`). There is no
  BlockRenderLayerMap any more.
- Resource paths must be lower case. An art build briefly shipped `monitor_corner_bl_L.json`, which the
  game refuses ("Non [a-z0-9/._-] character"), so monitors and task boards rendered purple/black. Fixed
  in assets-src (`_outer`); re-run `sync.py`, which removes files it put there before.
- Removing a registered entry (block, entity type) from an existing world triggers Fabric's "Missing
  content detected!" screen, which blocked unattended runs. `AutoWorld` now answers it for the HQ
  world only (Fabric makes a backup, then the world loads) and logs a warning.
- The entity dispatcher picks renderers per type, but at submit time it sends every
  `AvatarRenderState` to the player renderer: custom avatars need the mixin, or they lose their own
  nameplate and layers.
- World-space UI: a nine-slice plate and the sprites on top of it z-fight at the same depth, so
  overlays/text use the polygon-offset variant (`WorldUi.Layer.OVERLAY`, `WorldUi.submitText`).
- **Fully opaque world text is drawn in the solid pass**, before every translucent quad
  (`SubmitNodeCollection.canRenderAsSolid`: text alpha 255, no background). Submit order does not
  change that. A translucent plate (`RenderTypes.text(GUI atlas)`, the kit nameplate has alpha 220)
  is therefore drawn over every opaque text that's already in the depth buffer: a nearer plate lets
  the farther plate's text ghost through. With "Improved Transparency" all translucent quads go
  through OIT and ordering is lost entirely. Fix used for billboards: `WorldUi.Layer.SOLID`, a custom
  pipeline (world text shader, no blending, colour-only writes, cutout below 0.1 alpha) that draws
  plates opaque in the solid pass, so depth alone decides what is in front.
- Two billboards at the same camera distance are coplanar, and the polygon offset of text then lets
  plate A's text win over plate B even where B should cover it (text from two plates interleaves).
  `WorldUi.billboard(..., scale, nudge, ox, oy, oz)` pulls a billboard a fraction of its distance
  towards the camera and shrinks it by the same factor (a homothety about the eye: identical on
  screen, nearer in depth). `PlateLayout` gives every plate a rank nudge of 0.15 % per rank.
- `LevelExtractionEvents.END_EXTRACTION` (Fabric) runs after every entity render state was extracted
  and before anything is submitted: the place for a pass that needs all of them at once (the
  nameplate declutter). `CameraRenderState` already has `projectionMatrix` and `viewRotationMatrix`
  then (camera space looks down -Z).
- JSpecify `@Nullable` on a qualified nested type goes after the dot: `Anchors.@Nullable Bounds`.
- Git Bash rewrites a leading slash in an argument into a Windows path (the command `/agentcraft hq`
  arrived as `C:/Program Files/Git/agentcraft hq`). Use `devcli cmd "agentcraft hq"`; the slash is optional.
- A Foreman profile can only run once at a time. Parallel specialists must use their own `--profile`
  (and port).

## Tools (repo `tools/`, Node 22, local `ws` dependency: run `npm install` in tools/ once)

```bash
node tools/devcli.mjs wait                         # wait for the bridge + a ready world (300 s)
node tools/devcli.mjs state
node tools/devcli.mjs camera -4 72 -8 -37.4 13.1 70        # x y z yaw pitch [fov]
node tools/devcli.mjs camera 20 66.5 20 80 --look 9,67,9   # aim at a point
node tools/devcli.mjs shot my_shot [--hud] [--frames 5] [--no-wait-chunks]
node tools/devcli.mjs cmd "/fill 0 65 0 4 69 4 minecraft:oak_planks"
node tools/devcli.mjs time 12000 | weather clear | hud off | screen pause | key escape | type "hi"
node tools/devcli.mjs raw '{"type":"dev.waitChunks","timeoutMs":60000}'
node tools/devcli.mjs quit                         # saves; waits for the bridge to close
node tools/shoot.mjs tools/scenes/phase1.json [--only a,b] [--manifest out.json] [--verbose]
node tools/record.mjs tools/shots/hq_orbit.json [more.json] [--hold 3000] [--stills 1,3] [--window 2560x1440]   # play shots for OBS (tools/shots/README.md)
```
`devcli` prints the JSON reply and exits 1 on `ok:false`. `--port` overrides the port. `--timeout`
sets the connect timeout in seconds. `devcli release` hands the view back after dev camera use.
`tools/lib/devclient.mjs` exports `DevClient` (`connect`, `request`, `call`, `waitInWorld`,
`waitClosed`, `health`, `assertNotHung`) for other scripts. `health()` uses dev.ping and works on a
hung game; `waitInWorld` (so `devcli wait` and `shoot.mjs`) fails fast with "game is hung" once the
render thread has been stuck for 30 s, and `shoot.mjs` stops at the first failed shot if the game
looks hung (`hung` in its JSON summary) instead of timing out on every remaining shot. Relaunch by
`devcli quit` (force-exits a hung game after 15 s) and `gradlew runClient`.

Scene format for shoot.mjs (see `tools/scenes/phase1.json`): `{defaults, setup:[cmds], shots:[{name,
camera:{x,y,z,yaw,pitch | lookAt, fov}, time?, weather?, commands?, screen?, keepScreen?, hideHud?,
frames?, delayMs?, waitChunks?}]}`, or a bare array of shots. Shots are written to `artifacts/shots/<name>.png`.
A shot without `fov` renders at the player's FOV option (70), exactly; scenes no longer inherit the
previous shot's FOV.

## Finding Minecraft APIs

```bash
GRADLE_USER_HOME=C:/Projects/agentcraft/.gradle-home ./gradlew mcSources   # genSources + unpack into mod/build/mcsrc
grep -rn "class LevelRenderer" mod/build/mcsrc/net/minecraft
```
`gradlew clean` deletes `mod/build/mcsrc` with the rest of `build/`; run `mcSources` again after a
clean (about a minute).
Fabric API module sources are in the official maven, for example
`https://maven.fabricmc.net/net/fabricmc/fabric-api/<module>/<version>/<module>-<version>-sources.jar`.
The module versions are listed under `.gradle-home/caches/modules-2/files-2.1/net.fabricmc.fabric-api/`.
`fabric-client-gametest-api-v1` is a good reference for world creation, screenshots and chunk waiting in 26.3.

## Timings (this machine, RTX 4090)

| Step | Time |
|---|---|
| Cold `gradlew build`: fresh copy of `mod/` (no `build/`, `.gradle/`), **empty `.gradle-home`** (the real one moved aside, then restored), `--no-daemon`; downloads Gradle 9.7.1, Loom, MC and Fabric API, about 580 MB (`artifacts/logs/fix-coldbuild.log`) | 61 s |
| `genSources` (first time) | 72 s |
| Incremental `gradlew build` (warm daemon) | 2-4 s |
| `runClient` to ready world, first ever run (Gradle configure + world creation) | 48 s |
| `runClient` to ready world, warm daemon, existing world | 14-19 s |
| `runClient` to ready world, warm daemon, fresh run dir and new world | 17 s |
| `dev.quit` to JVM exit | 1-2 s |
| `dev.quit` on a hung render thread (`forceAfterMs` 5000) to JVM exit, world saved | 5.9 s |
| Screenshot (chunks already loaded) | about 0.4-0.8 s |
| Screenshot after a 6000-block teleport (waits for 16-chunk radius) | about 5 s |
| Soak: 90 camera moves and shots (18 of them far teleports) in 3 min | 0 failures, 59-60 fps (vsync) |
| Soak after the fix round: 42 verified camera moves + shots (6 far teleports, mixed modes/FOVs) | 68 s, 0 failures, 59-60 fps |

## Known issues

- **One JVM crash in about 8 sessions** (Temurin 25.0.1): `EXCEPTION_ACCESS_VIOLATION` in the *C2 JIT compiler
  thread* while compiling `LevelExtractor::extract`, about 34 s after launch (`artifacts/logs/hs_err_pid104408.log`).
  No third-party DLLs were loaded and no mod code was on the stack. Repeating the exact same sequence
  and a 3-minute soak did not reproduce it. If it recurs, tools should treat "bridge gone" as "relaunch"
  (the world autosaves). Possible mitigations, both untested: a newer JDK 25 update, or
  `-XX:CompileCommand=exclude,net/minecraft/client/renderer/extract/LevelExtractor.extract`, which costs
  per-frame speed. A shot that is in progress when the JVM dies leaves a 0-byte PNG.
- **An unexplained pause menu** appeared once during an unattended run (`focused` flipped to false at the
  same moment, with `pauseOnLostFocus=false`). In 26.3 only a real Escape key event or focus-pause opens
  it. A pause menu stops the integrated server, so chunks stop loading. Mitigations now in place:
  `dev.state.paused`; `dev.camera` closes a vanilla pause menu (`closedPauseScreen:true`; disable with
  `closePause:false`); chunk waits fail with a clear "game is paused" error; and every pause-screen
  open is logged with a short stack ("Pause screen opening ...") so the source can be found next time.
- `width`/`height` for `dev.screenshot` are not implemented. Shots are always the window framebuffer size (1920x1080).
- Rain fades in over a few seconds after `dev.weather rain`.
- A forced `dev.quit` (exit code 3/4) skips the client's own shutdown (options, resource cleanup); the
  world itself is saved by the integrated server first. The exit-code-4 path (a normal shutdown that
  hangs) has not been observed or tested; the exit-code-3 path was tested with `dev.test.stall`.
- `dev.key` sends keycode 0 alongside the scancode, so shortcuts that depend on the keycode (such as
  Ctrl+C in text fields) may not work through it.

## Gotchas hit

- `type`, `id` and `timeoutMs` are reserved request fields. `dev.weather` first used `type` for the
  weather kind, which the message type silently overwrote. It is now `weather`.
- **A NaN camera hangs vanilla forever.** `Frustum.offsetToFullyIncludeCameraCube` loops until the
  camera cube is inside the frustum; with a NaN view vector that never happens, so the render thread
  spins and the game is dead (dev.quit could not even run). Gson's `getAsFloat()` happily parses the
  string `"NaN"`, and `pitch < -90 || pitch > 90` is false for NaN. All request fields now go through
  `Fields`, which refuses non-finite numbers. Huge-but-finite values are dangerous in the same loop
  (doubles lose the precision to move the camera), so y is limited like vanilla `/tp` and x/z to the
  world border.
- Gson's lenient getters are traps for a protocol: `getAsString()` on `["dev.state"]` returns
  `"dev.state"`, `getAsBoolean()` on `"yes"` returns false, `getAsLong()` on `1.5` truncates. Use `Fields`.
- Vanilla multiplies the FOV option by a dynamic modifier (1.1 while flying, which spectators always
  are). Shots requested at `fov:70` used to render at 77; `tools/scenes/phase1.json` was updated to 77/88
  to keep its framing, and the dev camera now pins the exact FOV (`CameraMixin` on `Camera.calculateFov`).
- Right after joining, `inWorld` is true while `LevelLoadingScreen` is still showing. Wait for `ready`.
- Waiting only for chunks near the camera left a square horizon after long teleports. Screenshots now
  wait for the whole render distance (circular, radius rd-1, matching the server's chunk tracking).
- `hasRenderedAllSections()` is true right after a teleport, before new sections are queued. The
  waiter therefore requires the condition to hold for 5 consecutive frames, after at least 6 frames.
- Chunk fade-in (new in 26.x, default 0.75 s) would make freshly loaded chunks look translucent in
  shots. It is set to 0 in the options template.
- Static `start()` and `stop()` names clash with `WebSocketServer`'s own methods, hence `startBridge` and `stopBridge`.
- Log noise that is harmless in dev: `Could not authorize you against Realms server` (offline dev
  account) and `Requested post effect does not exist: minecraft:end_of_frame`. The second is printed
  by vanilla 26.3 in dev, not by this mod.
- Don't set `setReuseAddr(true)` on the WebSocket server. On Windows that would allow two games to
  bind the same port.
- `mod/run/` is gitignored, and the server run dir is `mod/run/server`, so it is ignored too.
- **Git Bash rewrites arguments that start with a slash.** Run from Git Bash (MSYS),
  `node tools/devcli.mjs type "/status"` types `C:/Program Files/Git/status`, and the console sends
  that as a plain message to Marlow in the current console (older builds submitted a goal). Set `MSYS_NO_PATHCONV=1` for console commands, or drive the DevBridge from
  PowerShell. This happened in the claude e2e run. The lead asked what the goal meant instead of
  starting work on it.

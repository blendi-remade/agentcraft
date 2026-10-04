# AgentCraft contribution notes

This contribution adds standalone Codex support, mixed Codex/Claude teams and dedicated-server
multiplayer, then fixes the setup, interaction and recovery problems found while using them in
Minecraft. The existing task graph, worktrees, CI, review and owner-approved merge workflow run
through one shared scheduler.

## What changed

- **CLI discovery and team setup.** The owner can detect installed, authenticated Codex and Claude
  CLIs and their model catalogs in Minecraft. Choose one provider for every role or mix lead,
  worker and reviewer providers. Each role has model and supported reasoning controls.
- **Per-agent choices.** Agent cards expose provider/model/reasoning selection, explicit Apply,
  role defaults and Team setup. Team changes preserve individual overrides unless explicitly
  reset. Running turns keep their selections; later turns use saved choices.
- **Provider isolation and recovery.** Sessions are separated by provider. Interrupted jobs retain
  their provider and job kind. A valid setup change can recover execution after the startup
  provider was unavailable. Provider failures hold their own jobs while healthy providers continue.
  Team status describes the saved roles. Claude subscription login retains its explicit host opt-in,
  and existing API users can still use the SDK bundled executable.
- **Dedicated multiplayer.** The host runs Foreman beside the server. A modded coding owner uses
  the studio while ordinary Java guests can join without installing AgentCraft. Polymer projects
  studio content into vanilla equivalents. Coding, repository, permission and merge actions are
  restricted to the configured owner; being a Minecraft operator does not grant coding access.
- **Multiplayer transport.** Large snapshots transfer in bounded parts and apply atomically.
  Relay consumption provides backpressure. Guest views exclude private coding information.
- **Console behavior.** Plain text talks to Marlow; `/goal` explicitly starts work and selects a
  repository when needed. Mentions retain their routing. Chat after completed, failed or cancelled
  work uses a conversation session. Slash completion keeps the selected row visible.
- **Interaction fixes.** Agent, task, library and diff controls use Minecraft 26.3's SDL left-button
  identifier. Model controls expose shortcuts as well as mouse hit targets. Setup pickers preserve
  keyboard focus across refreshes. Failed model previews clear the old catalog before retry.
- **Rendering and placement.** The top-center HUD has notch clearance. The Iris-compatible render
  path avoids the observed stretched geometry. HQ placement is dimension-aware and uses translated
  bounds, with guards around player changes and foliage during rebuilds.
- **Bounded logs and honest CI.** Streamed response fragments become readable entries with bounded
  retained text. Failed requests dispose their waiters. No test command remains an unknown CI result,
  rather than being reported as a pass. Lifecycle regressions cover cancellation and process failure.

See [team setup](qa/team-setup.md), [console commands](console.md), the
[protocol](protocol.md), and the [annotated feature gallery](contribution-gallery.html).

## Validation

The local source checkpoint on 2026-10-04 passed 632 Foreman tests, TypeScript typechecking and
protocol-document consistency, plus the Java build and 50 JVM tests. Tool tests passed 18/18 and
the Python packaging regression passed. Later source changes require their own checks.

```sh
npm --prefix foreman run check
npm --prefix tools test
sh mod/gradlew -p mod --no-daemon build
python3 -m unittest tools/test_package_multiplayer.py
```

A disposable real-CLI fixture ran a Codex worker that edited and committed a file, passed its
project tests, and received a Claude review leading to an open owner merge decision. The base
branch stayed unchanged until explicit approval; Foreman then merged only the intended file and
its tests passed on the base branch. In-game setup selections survived readback and a Foreman restart.
Native keyboard checks also verified both provider catalogs, slash-menu scrolling and a plain
chat reply with zero goals and tasks. These are functional checks, not an FPS benchmark.

## Evidence limits and release status

The gallery contains real framebuffer captures with separate HTML annotation markers. Browser-rendered
JPEG exports in `docs/img/contribution/annotated/` include those markers and their legends for PR
embedding; the original PNG captures remain unchanged. Screenshots
show rendered state; the accompanying test/readback notes establish behavior. Mouse-handler and
widget regressions pass, but native automation could not move Minecraft's SDL pointer reliably.
They must not be described as physical mouse-click verification. See [the mouse regression
notes](qa/agent-card-mouse.md).

Windows launcher behavior has fixture coverage, not a physical Windows qualification.

The qualified mod and runtime were installed in the original multiplayer world after a graceful
save and verified backup. Both players' saved data, advancements and stats matched their pre-update
files; saved agent model choices and shader files were preserved. The coding owner rejoined at
the same position and the shader view rendered cleanly. A second authenticated human guest was
not present for this final deployment; vanilla compatibility was checked separately on loopback.
The publishing branch uses a clean source export and excludes local runtime history.


The disposable real-CLI review was subsequently approved through Foreman: only `greeting.mjs`
merged into the fixture base branch, its tests passed, and the task became done. A separate
isolated process-interruption check verified that the failed agent card still opened Model (O)
and Message (M). Sending a new message received `RECOVERED` with authentication healthy and no
goals or tasks created. A transient model-discovery failure is now reported as a CLI failure,
without incorrectly directing the owner to sign in again.

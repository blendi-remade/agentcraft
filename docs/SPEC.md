# AgentCraft — Spec

Minecraft as a spatial UI for real, multi-agent Claude work. The user should be able to use this
**for their actual daily work**: practicality is a hard requirement, equal to the visual bar.

## North star

The user launches one command, walks into their HQ, types a goal ("add OAuth to life-tracker"),
and watches a team of Claude agents split it into tasks, work in real git worktrees of a real
repo, talk to each other, show progress physically, and come to the user for decisions. The user
can review diffs, approve merges, and steer agents without ever leaving the game — and nothing
of value is lost if the game closes, because the game is only a view.

## Architecture

```
Minecraft 26.3 (Fabric mod "agentcraft", Java 25)          Foreman (Node 22 + TypeScript)
 ├─ integrated server side: entities, blocks, HQ builder <-WS-> ├─ AgentManager (Claude Agent SDK sessions)
 ├─ client side: screens, renderers, HUD, keybinds           │   backends: "claude" (real) | "sim" (scripted)
 └─ DevBridge: camera / screenshot / scene control           ├─ TaskGraph (persisted JSON)
                                                             ├─ MessageBus (agent<->agent, agent<->user)
                                                             ├─ Memory (markdown files, shared + per-agent)
                                                             ├─ DecisionQueue (questions + permission prompts)
                                                             ├─ RepoManager (git worktrees, diffs, merges)
                                                             └─ Notifier (desktop notification when user needed)
```

- **The Foreman is the source of truth.** It runs as a standalone process: agents keep working
  while Minecraft is closed. All state persists in `~/.agentcraft/` (or `AGENTCRAFT_HOME`) and survives restarts.
  On reconnect the mod receives a full `snapshot` and rebuilds the view.
- **The mod is a view + input device.** It renders the state and sends user intents. No business logic.
- Transport: WebSocket, Foreman listens on `ws://127.0.0.1:${AGENTCRAFT_PORT:-7878}`. The mod
  (integrated-server side) connects as client, auto-reconnects with backoff. JSON messages, one per frame.
- Single launch: `tools/launch.ps1` starts the Foreman (if not running) then `gradlew runClient`
  with quick-play into the HQ world.

## Protocol (v1) — source of truth is `foreman/src/protocol.ts`, mirrored in `mod/.../protocol/`

**Field-level reference with JSON examples: `docs/protocol.md`** (generated from the zod schemas;
`npm run check:protocol-doc` in `foreman/` fails if it is stale). The list below is the overview.
Additions made while building the Foreman (2026-10-01): `foreman.status` {status: backend/auth/
authMode/message for the banner} (also in `snapshot.foreman`); `ack` {re, ok, error?, result?} for any client
message with an `id`, and `error` {message, re?}; `snapshot.goals[]` and `snapshot.logs[]` (log tail
per agent); Agent `title`, `accent`, `worktree`, `paused`, `active` (off-shift agents); Task
`description`, `goalId`, `priority`, `branch`, `worktree`, `ci`, `blockedReason`, `summary`,
timestamps, and status `cancelled` (hidden on the wall); Decision `answer`, `taskId`, `repoId`,
`worktree`, `tool`, and status `cancelled`; structured Worktree objects in `repo.worktrees[]`;
diff lines `{kind: add|del|ctx, text, oldNo?, newNo?}`. Merge option labels are exactly
`Merge` / `Request changes` / `Reject`; permission labels `Allow once` / `Always allow for this
agent` / `Deny`. `agent.action` semantics (2026-10-01 fix round): `pause` keeps the task, `stop` =
off shift (`active=false`) until `resume`/`spawn`, its tasks go back to the board; `spawn` takes an
optional task id (`arg`) to assign. Second fix round: a goal whose tasks were all cancelled/rejected
becomes `cancelled` (not stuck at 0%); a task that changed no files closes as `done` without a merge
decision; approved merge commits use the user's git identity (signed if their git config signs).

Every message: `{ "v":1, "type": string, "id"?: string, ...payload }`.

Foreman → Mod
- `snapshot` { agents[], tasks[], decisions[], repos[], memory[], goal?, feed[] } — full state on connect
- `agent.upsert` { agent: {id, name, role, color, skin, state, activity, station, taskId?, repoId?} }
  - `state` ∈ idle | thinking | reading | editing | running | testing | waiting_user | blocked | done | error
  - `station` ∈ desk | library | terminal | testbench | mergestation | meeting | lounge | user
- `agent.log` { agentId, entries: [{ts, kind: text|tool|result|error|diff, text}] } — streamed
- `agent.say` { agentId, text, to?: agentId|"user" } — speech bubble + feed
- `task.upsert` { task: {id, title, status: todo|doing|review|done|blocked, assignee?, deps[], repoId?} }
- `decision.upsert` { decision: {id, agentId, kind: question|permission|merge, question, options[], context?, status: open|answered} }
- `repo.upsert` { repo: {id, name, path, branch, worktrees[], ci: unknown|running|pass|fail} }
- `memory.upsert` { entry: {id, scope: shared|agentId, title, body, updated} }
- `goal.upsert` { goal: {id, text, progress 0..1, status} }
- `feed.add` { item: {ts, agentId?, kind, text} }
- `diff` { requestId, repoId, worktree, files: [{path, status, hunks}] } — response to `diff.request`
- `notify` { level: info|warn|need_user, text }

Mod → Foreman
- `hello` { modVersion, protocol: 1 }
- `goal.submit` { text, repoId? }
- `user.message` { to: agentId|"all", text }
- `decision.answer` { decisionId, option?, text? }
- `task.action` { taskId, action: reassign|cancel|retry|prioritize, arg? }
- `agent.action` { agentId, action: pause|resume|stop|spawn, arg? }
- `diff.request` { requestId, repoId, worktree }
- `repo.add` { path }

Dev control (used by tools + QA, NOT by gameplay): separate WS `ws://127.0.0.1:${AGENTCRAFT_DEV_PORT:-7879}`
served **by the mod client**:
- `dev.camera` {x,y,z, yaw,pitch | lookAt:{x,y,z}, fov?, mode?} · `dev.screenshot` {name, hideHud?} → `{ok, path, width, height, stats}` (window framebuffer size; width/height not supported)
- `dev.time` {ticks} · `dev.weather` {weather: clear|rain|thunder} · `dev.screen` {open: name|null} · `dev.command` {cmd}
- `dev.key` {key|mapping} · `dev.type` {text} · `dev.waitChunks` · `dev.quit` · `dev.state` → {ready, paused, player, camera, screen, fps, window, fov, foreman}
- `dev.ping` → {stalled, msSinceLastFrame} (answers even when the game is hung) · `dev.release` (hand the view back: FOV pin off, HUD on, creative)
- `dev.camera` replies ok only once a rendered frame matches the request; each call pins the exact FOV (default: the player's option), nothing carries over. `dev.quit` force-exits a hung game (world saved, exit code 3).
- Full reference: mod/DEV.md. Request fields `id`, `type`, `timeoutMs` are reserved. Fields are strictly typed (finite numbers, ranges); errors name the field.
- `tools/shoot.mjs <scene.json>` drives a list of shots and writes PNGs to `artifacts/shots/`.

## Practicality requirements (non-negotiable)

1. **Real repos**: `repo.add` any local git repo. Each worker agent gets its own git worktree on
   branch `agentcraft/<agent>/<task>`. **Never push, never touch the user's checked-out branch,
   never merge without an explicit user `merge` decision.**
2. **Command console** (keybind `` ` `` or `Enter` on a terminal block): one input line with
   prefixes — plain text = new goal; `@name msg` = message agent; `/answer`, `/repo add <path>`,
   `/pause @name`. Autocomplete for agent names. This is the fast path; walking is optional.
3. **Readable text**: logs/diffs/plans rendered crisp (vanilla font, proper scaling), scrollable,
   syntax-tinted diffs (+ green / - red), selectable agent, search not required v1.
4. **Durability**: Foreman state survives restarts; Agent SDK sessions resumed by session id.
5. **Out-of-game notifications**: desktop notification (and console bell) when a decision is waiting.
6. **Permissions**: risky tool calls (anything outside the worktree, network, deleting) become
   `permission` decisions in-world. Safe edits/reads inside the worktree auto-allowed.
7. **Graceful auth failure**: if the Claude backend can't authenticate, the Foreman says so loudly
   (in-world banner + console) and the `sim` backend can still be used for demos. Auth check uses
   `ANTHROPIC_API_KEY` or a cloud provider switch (Agent SDK), or with `--use-claude-login` the
   logged-in `claude` CLI credentials; the status names the mode (`authMode`).
8. **Performance**: 60+ fps in HQ on an RTX 4090; text renderers batch; no per-frame allocations in hot paths.
9. **One-command launch** and a `README.md` a stranger could follow.

## Agent model

- **Lead** ("Foreman" persona in-world, but a normal agent): receives the goal, explores the repo,
  writes a plan into shared memory, creates tasks with deps, assigns workers, reviews results,
  asks the user when a decision is genuinely theirs.
- **Workers** (2–4 by default, configurable): each takes a task, works in its worktree, posts
  progress, messages others via tool `send_message`, writes memory via `write_memory`, marks task
  done → review. Custom MCP tools exposed to agents: `send_message`, `ask_user`, `write_memory`,
  `read_memory`, `update_task`, `create_task` (lead only), `report_status`.
- Agent activity → `state`/`station` mapping is derived automatically from tool use
  (Read/Grep → library; Edit/Write → desk; Bash test → testbench; ask_user → walks to user).

## World & visuals (see docs/visual-bar.md)

HQ built deterministically by `/agentcraft hq` in a void/superflat world: a cohesive, beautiful
building with: central **Goal Atrium** (holographic goal + progress ring), **Task Wall**
(kanban), **Agent Desks** each with a **Monitor** (multi-block screen showing that agent's live
log), **Library** (memory archive — lecterns/books open memory), **Test Bench** (CI lamps),
**Merge Station** (review diffs, approve), **Decision Podium** (bell + beacon when decisions open),
**Repo Wings** (one room per connected repo). Agents are custom humanoid entities with distinct
skins, nameplates showing name + state, speech bubbles, pathfinding between stations, idle anims.

## Repo layout

```
mod/          Fabric mod (Gradle 9.7, Java 25, Loom 1.18; MC 26.3, see mod/DEV.md for why)
foreman/      Node/TS orchestrator (npm, vitest)
assets-src/   procedural texture/model/skin generators (Python+PIL / Node), Blender scripts
tools/        launch.ps1, shoot.mjs, scenes/*.json, smoke tests
sandbox/      throwaway git repos for end-to-end tests (never the user's real repos in tests)
artifacts/    screenshots, logs (gitignored)
docs/         SPEC.md, visual-bar.md, protocol.md, QA.md, img/
```

## Definition of done for v1

- `tools/launch.ps1` → game opens into the HQ, Foreman connected, banner shows backend status.
- Submitting a goal (console) on a sandbox repo with the `claude` backend: lead plans, ≥2 workers
  work in worktrees, at least one `ask_user` decision appears and is answered in-world, tasks move
  across the Task Wall, monitors stream logs, merge decision lets the user review the diff in-game.
- Same flow fully works with `sim` backend (deterministic, used for screenshot QA).
- Screenshot QA suite (`tools/scenes/*.json`) passes the visual bar review.
- Restart the game mid-run → state restored. Kill the Foreman → mod shows "disconnected" gracefully, reconnects.

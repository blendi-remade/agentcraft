# AgentCraft Foreman

The Foreman is the brain of AgentCraft: a Node 22 + TypeScript service that runs a team of Claude
agents (one lead, up to five workers) on a real git repo and streams everything to the Minecraft
mod over a WebSocket. The game is only a view. The Foreman owns all state, keeps working while
Minecraft is closed, and survives restarts.

```
                     ws://127.0.0.1:7878  (protocol v1, docs/protocol.md)
 Minecraft mod  <------------------------------------------------>  Foreman
 (or npm run tui)     hello -> snapshot, then upserts                  |
                      goal.submit / decision.answer / ...              |
                                                                       v
   Foreman (src/foreman.ts) -- owns state, applies user intents, exposes primitives to backends
     |- TaskGraph     src/taskgraph.ts   tasks, deps, statuses, assignment, goal progress
     |- MessageBus    src/bus.ts         agent<->agent, agent<->user, activity feed
     |- Memory        src/memory.ts      markdown notes, shared + per agent
     |- DecisionQueue src/decisions.ts   question | permission | merge; answer wakes the agent
     |- RepoManager   src/repos.ts       repos, per-task worktrees, structured diffs, guarded merges
     |- Notifier      src/notifier.ts    desktop notification + console bell when you are needed
     |- Store         src/store.ts       atomic JSON state + JSONL logs under AGENTCRAFT_HOME
     `- Backend       claude: src/agents/claude/  (Claude Agent SDK sessions)
                      sim:    src/agents/sim/     (deterministic scripted team, real git)
```

## Run it

```sh
cd foreman
npm install

# real agents: needs ANTHROPIC_API_KEY (or CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY)
npm run start -- --backend claude --repo C:\path\to\your\repo
# personal use only: your local `claude` CLI login instead of an API key
npm run start -- --backend claude --repo C:\path\to\your\repo --use-claude-login
# Codex agents on your Codex login (`codex login`), or a mixed team
npm run start -- --backend codex --repo C:\path\to\your\repo
npm run start -- --backend claude --worker-engine codex --repo C:\path\to\your\repo

# simulated team on a fresh sandbox repo (no API calls) - for demos and screenshot QA
npm run start -- --backend sim --reset --speed 2

# static "showcase" states for screenshots (fast-forward through the real script, then hold)
npm run start -- --backend sim --profile showcase --reset --showcase            # busy mid-run
npm run start -- --backend sim --profile showcase-late --reset --showcase late  # blocked/error/done

# terminal client that connects exactly like the mod
npm run tui
```

In the TUI (and in the mod's console) type:

| input | does |
| --- | --- |
| `Add OAuth to life-tracker` | new goal for the lead |
| `@kit please also cover emoji tags` | message an agent (`@all` for everyone) |
| `/answer` / `/answer d3 2 more tests please` | answer the oldest / a specific decision (1-based option, optional text) |
| `/diff kit-t2` or `/diff d3` | show a worktree's diff (or a merge decision's) |
| `/repo add C:\path\to\repo` | connect a repo |
| `/pause @kit`, `/resume @kit`, `/stop @kit`, `/spawn @tove` | steer agents (see Steering) |
| `/task t3 cancel\|retry\|prioritize [n]\|reassign @wren` | steer tasks |
| `/status`, `/tasks`, `/agents`, `/decisions`, `/memory [id]`, `/feed` | views |

`npm run tui -- --script scripts/sim-demo.script --transcript out.txt` replays a whole session
unattended (`/wait d3`, `/wait goal done`, `/wait 2` are available in scripts);
`--commands <file>` tails a file for commands; `--auto-answer merge,permission` answers for you.

Stop the Foreman with Ctrl+C (or `q` + Enter). State is saved continuously; a hard kill loses at
most ~100 ms of state, and interrupted agent turns resume on the next start.

## Options

`npm run start -- --help` prints everything. The important ones:

| flag / env | default | |
| --- | --- | --- |
| `--backend sim\|claude\|codex` / `AGENTCRAFT_BACKEND` | `claude` | codex: an all-Codex team |
| `--lead-engine` / `--worker-engine` `claude\|codex` | the backend's | mixed teams, e.g. a Claude lead with Codex workers |
| `--engines kit=codex,...` / `AGENTCRAFT_ENGINES` | | engine per agent |
| `--codex-model`, `--codex-lead-model`, `--codex-worker-model`, `--codex-effort` | your Codex config | Codex models and reasoning effort |
| `--codex-path` / `AGENTCRAFT_CODEX_PATH` | `codex` on PATH, else the Codex app's | the Codex CLI |
| `--port` / `AGENTCRAFT_PORT` | `7878` | WebSocket port (127.0.0.1 only) |
| `--home` / `AGENTCRAFT_HOME` | `~/.agentcraft` | state root |
| `--use-claude-login` / `AGENTCRAFT_USE_CLAUDE_LOGIN=1` / config `claude.useClaudeLogin` | off | personal use only: your `claude` CLI login instead of an API key. Any `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` or `CLAUDE_CODE_USE_*` switch in the shell is withheld from the agents; `foreman.status.authMode` reads `claude login` |
| `--user-name` / `AGENTCRAFT_USER_NAME` / config `userName` | OS user name | how the agents address you; sent to the mod in `foreman.status` |
| `--profile` | backend name | state lives in `<home>/<profile>` |
| `--repo <path>[,<path>]` | | register repos at start (sim: a fresh `sandbox/sim-demo`) |
| `--goal "<text>"` | | submit a goal right away |
| `--reset` | | wipe this profile first |
| `--notify` / `--no-notify` / `AGENTCRAFT_NOTIFY` | on for claude, off for sim | Windows, macOS or Linux (`notify-send`) notifications |
| `--toast-silent` | | toast without sound |
| `--model`, `--lead-model`, `--worker-model` | lead `opus`, workers `sonnet` | any model id/alias the CLI accepts |
| `--effort low..max` | `medium` | |
| `--workers 3` or `--workers kit,wren` | `juniper,kit,wren` | team (others stay "off shift") |
| `--max-concurrent` | `3` | workers running at once |
| `--max-turns`, `--max-budget <usd>` | 40 lead / 80 worker, none | per turn caps |
| `--ci "<cmd>"` | detected (`npm test`, `cargo test`, ...) | run after each task |
| `--lead-read-commands "<cmd>,..."` | none | read commands the lead runs without asking, by prefix: `"bd show,gh issue view"` lets it read your issue tracker |
| `--no-lead-review` | | merge decisions go to you without a lead review turn |
| `--repo-poll-ms` | `10000` | how often checkouts are checked for head/dirty changes |
| `--merge-style merge\|squash` / `AGENTCRAFT_MERGE_STYLE` | `merge` | approved merges: a merge commit that keeps the agents' commits, or one squashed commit (see Safety guarantees) |
| `--no-sign-merges` / `AGENTCRAFT_SIGN_MERGES=0` | signed if your git config signs (claude) | never sign approved merge commits; the sim never signs |
| sim: `--speed`, `--seed`, `--autostart`, `--showcase [late]`, `--auto-answer`, `--no-ambient` | | |

`<home>/config.json` can hold the same settings (`{"backend":"claude","claude":{"workers":["kit","wren"]}}`).
While running, `<home>/<profile>/foreman.json` records `{pid, port, host, backend, profile, version, startedAt}`
so launch scripts can find it; `<home>/foreman.json` holds the same for the first live Foreman (when
it exits, another live profile takes its place). A second Foreman on a profile that is already
running is refused (two would both write its `state.json`).

## Engines: Claude and Codex

The team (`src/agents/team.ts`: task graph, worktrees, scheduling, CI, reviews, merges, steering,
restarts) runs each agent turn through an engine, chosen per agent:

- **Claude** (`src/agents/claude/engine.ts`): one Claude Agent SDK `query()` per turn; the team tools
  are an in-process MCP server; every tool call goes through `canUseTool` and the policy.
- **Codex** (`src/agents/codex/`): one `codex app-server` process per turn, JSON-RPC over stdio. The
  agent's thread is durable, so its next turn resumes it. Commands run with `approvalPolicy:
  "untrusted"`, so Codex asks before each one, and the ask goes through the same policy and in-game
  permission prompts (commands are unwrapped from Codex's `powershell -Command` / `bash -lc` wrapper
  first). Workers are sandboxed to their worktree, its git dir and the temp dir; the lead is
  read-only. The team tools are app-server dynamic tools. None of your own Codex setup reaches an
  agent thread: your MCP servers, plugins, apps, web search, image generation and notify hooks are
  switched off for it (your Codex app is untouched). Codex's own sub-agent tools cannot be switched
  off; agents are told not to use them, and every approval from a thread AgentCraft did not start is
  declined. The git safety environment is passed explicitly (`shell_environment_policy.set`), since
  Codex drops variables named like secrets (`GIT_CONFIG_KEY_0`).

  On Windows, the app-server uses `<home>/<profile>/codex-localappdata` as its own local app-data
  directory. This avoids a Codex sandbox setup bug that tries to repair permissions on locked
  desktop runtime executables. Agent shell commands retain the original `LOCALAPPDATA`; the
  sandbox, approval policy, login and saved Codex threads are unchanged.

  A worker's sandbox can write exactly what committing and merging on its own branch needs: the
  shared `objects/`, its own branches' refs and reflogs (`refs/heads/agentcraft/<agent>/`), and its
  worktree's own git dir (Codex protects the `.git` pointer's target unless it is granted exactly),
  validated against the registered repository before every turn. Never the shared `.git` as a
  whole: its `config` and `hooks` would let a worker run code in your own git, outside any sandbox,
  and its refs would let it move your branches. On Windows,
  worktrees run with the older grant may retain Codex deny ACLs; recreating the worktree after
  saving its changes clears those stale permissions. Do not reset permissions on the whole repo.
  Windows agents are also told to use `npm.cmd` / `npx.cmd`: their PowerShell launchers can fail
  on sandbox-inaccessible global installs or script execution policy, while the CMD launchers work.

The rest of this section describes the team with either engine ("Read/Grep/Glob" is how a Codex
agent reads with its shell).

## How the claude backend works

1. **Plan** (lead, read-only in your checkout): explores with Read/Grep/Glob, writes `Plan: ...` to
   shared memory, creates tasks with deps and assignees via `create_task`, may `ask_user`.
2. **Work** (worker, in its own worktree `<profile>/worktrees/<repo>/<agent>-<task>` on branch
   `agentcraft/<agent>/<task>-<slug>`): edits, runs tests, coordinates with `send_message`, finishes
   with `update_task(status "review")`. A worker that ends without it is nudged once.
3. **CI**: the repo's test command runs in the worktree; a failure goes back to the worker once.
4. **Review** (lead): gets the diff + CI result (and the task's history: who worked on it, what you
   already answered), then `request_merge` or asks for changes.
5. **Merge decision** (you): Merge / Request changes / Reject. Only an answered **Merge** merges.
   If the base moved on and the merge would conflict, the worker merges the base into its branch,
   resolves it, and the task comes back for review. That is what lets the lead plan tasks that
   touch the same files (a new CLI case, a help line) to run in parallel instead of in a chain.

A task that changed no files (a report, an investigation) has nothing to merge: `request_merge`
closes it as done (worktree abandoned, branch kept) instead of asking you to approve an empty
merge, and **Merge** on such a branch does the same. A goal whose tasks were all cancelled or
rejected becomes `cancelled` (it is active again if the lead adds a task to it).

Agent tools (in-process MCP server `agentcraft`): `send_message`, `ask_user` (blocks until you
answer), `write_memory`, `read_memory`, `update_task`, `report_status`, `list_tasks`, and for the
lead `create_task`, `request_merge`. Unread messages ride along on every tool result and on the
prompt of the agent's next turn. A message from you that arrives after an agent's last tool call
(e.g. while it writes its final summary) starts a follow-up turn as soon as that turn ends; one
sent to an off-shift agent is delivered when you `/resume` it.

The CLI process of every agent turn is spawned by the Foreman (the SDK's
`spawnClaudeCodeProcess`), so the Foreman knows its pid: an aborted turn (stop, pause, cancel,
timeout, Foreman shutdown) is closed, and its CLI and every process it started are killed if they
are still there a few seconds later (a process tree snapshot taken at abort time, plus a second
look after the CLI exited, also finds orphans the CLI left behind; a pid is only killed if its
creation time still matches, and never if the CLI's pid was reused). The next turn of that agent
(e.g. after `/pause` + `/resume`) waits for this clean-up, so two CLIs never share a session.

SDK stream -> world: Read/Grep/Glob -> `reading@library`, Edit/Write -> `editing@desk`, test
commands -> `testing@testbench`, other Bash -> `running@terminal`, `ask_user` -> `waiting_user@user`.

Sessions are persisted per (agent, task) and per (lead, goal). On restart, interrupted turns resume
with their session id **and their job kind** (a resumed plan still activates the goal; a resumed
review still ends in a merge decision); a question that was open across the restart resumes the
session with your answer. Start-up then reconciles every open state: a goal still planning with
nobody planning it is planned again (or activated if it has tasks), a task left `doing` with no
turn behind it goes back on the board (its session resumes), a task in `review` without a merge
decision gets CI + review again. SDK sessions are isolated from your own Claude Code settings
(`settingSources: []`).

A failed turn (API error, max turns, timeout) shows the agent as `error` and blocks its task with
the reason; `/task t3 retry` puts it back on the board.

### Steering

| | |
| --- | --- |
| `/pause @kit` | aborts Kit's turn, keeps the task; any open question of Kit's is withdrawn. `/resume @kit` continues the same session. |
| `/stop @kit` | Kit goes off shift (lounge, `active: false`): turn aborted, open questions and permission prompts withdrawn, `doing` tasks back on the board unassigned. Never scheduled again until `/resume @kit` or `/spawn @kit`; survives Foreman restarts. |
| `/spawn @wren [t3]` | brings an off-shift agent onto the team; with a task id, that task is assigned to it. |
| hand-off | when a task changes hands (stop, `/task t3 reassign @wren`) it is held off the board until the old turn is really over (CLI exited, its processes gone), then the old worktree's work is committed on its branch and the next worker's worktree starts **from that branch**, so nothing is lost. The next worker's prompt says it takes over (and from whom) and lists the questions you already answered on that task, so it does not ask again. This also works if the old directory is still busy: removing it is retried in the background and never blocks the hand-off. |
| stop is immediate | the aborted turn's CLI process is force-closed; anything a lingering session still tries (tool calls, permission requests, messages) is refused. |
| self-healing scheduler | if starting a task fails (a git error, a busy directory), the task stays on the board and the scheduler retries with backoff (2 s .. 60 s) instead of waiting for the next event. |

### Permissions (src/policy.ts)

| | |
| --- | --- |
| allowed | reads/edits inside the agent's worktree; safe dev commands (`npm test`, `node src/x.ts`, `git status/diff/add/commit/merge`, `ls`, `grep`, ...); `npx <tool>` for dev tools the worktree has installed (`node_modules/.bin`); scratch files in the OS temp dir |
| asks you (permission decision) | anything outside the worktree (absolute paths, `..`, `~`, `$HOME`, `%USERPROFILE%`, brace expansion like `{~,x}`, `cd` out of the worktree, redirections like `>C:/x`, paths from `$VARS` or `$(...)`, links that lead out, Glob patterns like `../../x/*`), network (`curl`, `npm install`/`view`/`outdated`, `npx` of a tool that is not installed, WebFetch, `git fetch`), dev servers (`vite`, `webpack serve`), git commands that change the repo shared with your checkout (`git config` writes, `git branch -f/-D/<new>`, `git tag`, `git stash`, `git update-ref`, `git checkout <branch>`, `git rebase <upstream> <other-branch>`, `--update-refs`, `--ignore-other-worktrees`, `git submodule update`, `filter-branch`), git pointed at another repository (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, ... in any form: prefix, `export`, `env`, `read`, `for`; `--git-dir`; git run after `cd`/`-C` out of the worktree), writing, moving or deleting a `.git` entry inside the worktree (its link to the repository), destructive commands (`rm -r`, `find -delete`, `git reset --hard`, `git clean`, `xargs rm`), env vars that make commands run code (`GIT_PAGER=...`, `NODE_OPTIONS=...`, `git -c core.pager=...`), inline code that writes/spawns/uses the network (`node -e`, `python -c`), process/system commands (`taskkill`, `reg`, `sudo`), GUIs and the browser (`git citool`, `git gui`, `git <sub> --help` on Windows), unknown binaries |
| always denied | `git push` however it is spelled, wrapped or hidden, when the policy can see it: `env`/`xargs`/`timeout`/`sudo`/`bash -c`/`cmd /c`/`eval`, inside `$(...)`, backticks or `<(...)`, `find -exec`, commands git runs for us (`rebase -x`, `bisect run`, `submodule foreach`, `filter-branch --tree-filter`, `difftool -x`), `echo "git push" \| bash`, here-docs/strings fed to a shell, `node -e "...execSync('git push')"`, a git subcommand from a variable or substitution (`git $x`), `git -c alias.p=push`, `git lfs push`, `git subtree push`; signing with your key (`git commit -S`, `git tag -s`, `-c commit.gpgsign=true`); changing or clearing the git safety variables (`env -i`, `GIT_CEILING_DIRECTORIES`); file edits by the lead; subagents. Where the policy cannot see a push (a test script, a node script), git itself refuses it (below). |

The Bash classifier is a small shell parser (quotes, redirections, heredocs and here-strings,
brace expansion, a virtual `cd`, wrapper commands, nested shells, `eval`). Every command
substitution (`$(...)`, backticks, `<(...)`, also inside double quotes, unquoted heredocs and
`$((...))`) is classified as a command of its own, and its output counts as unknown wherever a
path matters (except `$(pwd)`, `$(git rev-parse --show-toplevel)` and lists of worktree paths like
`$(git ls-files)`). `find` is checked per start point and per `-exec` command; `xargs` may read
from a list of worktree paths (`find`, `git ls-files`, `grep -l`), anything else it runs asks.
Commands that git runs for us (`git rebase -x/--exec`, `git bisect run`, `git submodule foreach`,
`git filter-branch --*-filter`, `git difftool -x`, `-c alias.x='!cmd'`) are classified exactly like
the same command typed directly. Anything it cannot verify asks. The lead works in your own
checkout, so it may only run read-only commands without asking (a redirection like `git log > x`
or `git diff --output=x` is a write). Programs the policy does not know, like an issue tracker's
CLI, ask every time unless listed in `--lead-read-commands`. The list is matched by bare program
name and applies to the lead only: a worker could put its own `bd` in front of the real one. Entries must be a bare program name plus plain words; writers, interpreters and network tools (`rm`, `git`, `bash`, `node`, `curl`, ...) are refused at startup.

"Always allow for this agent" stores every rule key the call needed, and each key is scoped so it
never covers more than the prompt said (the prompt shows the scope: `"Always allow for this
agent" covers: ...`):

| key | covers |
| --- | --- |
| `Bash:rm -r`, `Bash:find -delete`, `Bash:npm install`, `Bash:git reset --hard`, `Bash:git rebase`, ... | that action inside the worktree; paths outside, and commands git would run for it (`rebase -x`), still ask with their own keys |
| `Bash:git checkout:<target>` | switching the worktree to exactly that branch/commit |
| `Bash:outside:<cmd>:r\|w\|x:<dir>` | `<cmd>` reading / writing / running files directly in `<dir>` |
| `Bash:outside:<cmd>:rtree\|wtree:<path>` | a recursive read / change of exactly `<path>` (`rm -r`, `grep -r`, `find`, `mv` of a directory) |
| `Bash:net:curl:<hosts>`, `Bash:net:gh:pr view` | that tool to those hosts / that subcommand |
| `Bash:exact:<hash>` | only that exact command: anything whose arguments cannot be checked (xargs writes, `$VARS`, substitutions, unknown programs, process/system commands, inline code, shell scripts on stdin) |
| `Read:<dir>`, `Grep:tree:<path>`, `Write:<dir>`, `Write:.git:<file>`, `WebFetch:<host>` | the non-Bash tools |

`git push` is never allowed, whatever is stored. Keys from older versions of the Foreman
(`Bash:subst`, `Bash:find -exec`, `Bash:xargs rm`, `lead:<prefix>`, `Bash:git fetch`,
`Bash:git submodule`, `Bash:git lfs`, `Bash:git checkout`, `Write:.git`, ...) no longer match anything.

### Push, signing and other repositories are blocked at the git level too (src/gitsafety.ts)

The policy can only judge what it can see; a push could hide in a test script or a node script.
So every process an agent can influence (the agent's Claude CLI process, every command it runs,
and the Foreman's CI runs) gets:

- `GIT_ALLOW_PROTOCOL=agentcraft-none` plus env-scoped git config `protocol.allow=never` and an
  empty `url.<dead>.pushInsteadOf`: git refuses every transport, so push, send-pack, fetch and
  clone all fail, even with an explicit `pushurl`.
- `commit.gpgsign=false`, `tag.gpgsign=false` and a missing `gpg.program`/`gpg.ssh.program`:
  agents' commits are never signed with your key, and an explicit `-S` fails instead of signing.
- `GIT_CEILING_DIRECTORIES=<parent of the agent's cwd>`: git never walks up out of the worktree,
  so a worktree whose `.git` link was deleted stops working instead of reaching an enclosing
  repository. Inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/... are removed.
- The agent's own git identity (`AgentCraft Kit <kit@agentcraft.local>`), never yours.

Env-scoped config outranks the repo's `.git/config` and your global config. Local git (status,
commit, branch, merge) is unaffected, and the Foreman's own git calls do not use this environment.
This is not a sandbox: code an agent runs could drop the variables on purpose (a script that
spawns git with an empty environment); the policy refuses every command it can see doing that
(`unset GIT_...`, `env -i`, `GIT_ALLOW_PROTOCOL=...`).

## Safety guarantees (src/repos.ts)

- Never pushes; there is no code path that runs `git push` (and agents' git cannot push, above).
- Your checked-out branch's working tree is touched only by an approved merge. The merge commit is
  built off-tree (`merge-tree` + `commit-tree`) and applied with `merge --ff-only`.
- The Foreman's own git writes in a worktree (committing leftover work at merge, abandon and
  hand-off) first check that the worktree's `.git` link still leads to this repository's own entry
  for that directory. If an agent rewrote or deleted it, nothing is committed, the diff is not
  shown, and an abandoned worktree is left in place for you to look at. They only ever move the
  agent's own `agentcraft/...` branch: if the agent checked out another branch, its work is
  committed as a snapshot onto its own branch and the other branch is not touched.
- The approved merge commit is yours: it uses your git identity (`user.name`/`user.email` as your
  git sees it in that repo) and is signed when your git config has `commit.gpgsign=true` (with your
  `gpg.format`/`user.signingkey`; `commit-tree` does not do that by itself). If signing fails, the
  merge is refused with the reason and the decision re-opens; nothing changes. `--no-sign-merges`
  turns signing off; the sim never signs. The agents' own commits on their branches (theirs
  and the Foreman's) use `AgentCraft <Name> <name@agentcraft.local>` and are never signed.
  With `--merge-style squash`, main gets one commit with the task's changes (your identity,
  signed as above, `Co-authored-by` the agents) instead of a merge commit plus the agents'
  commits - useful for repos that require signed commits or verified emails. Branches are kept.
- `/repo add <path>` must name a repository root; a folder inside another repository is refused
  (instead of silently registering the enclosing repo as the merge target).
- Merges are refused (and the decision re-opens with the reason) if the checkout that has the base
  branch checked out has uncommitted tracked changes. A merge that would conflict is not made either:
  with the claude backend the task goes back to its worker (`git merge <base>` in its worktree,
  resolve, test, commit), then through CI and review to a fresh merge decision; other backends
  re-open the decision with the conflicting files.
- If you have another branch checked out, a merge only moves the base branch ref.
- Agent branches are kept after merge/reject; merged worktree diffs stay viewable.
- `repo.dirty` follows your checkout: it is re-broadcast after a refused merge and polled every
  10 s (`--repo-poll-ms`), so the mod can show why a merge was refused.
- CI runs with the git safety env and a timeout that kills the whole process tree.
- The WebSocket only takes local, non-browser clients: any `Origin` header (every browser sends
  one; sandboxed iframes, `data:` and `file:` pages send `Origin: null`) and any Host header other
  than `127.0.0.1`/`localhost`/`[::1]` (DNS rebinding) are refused with HTTP 401. The mod and the
  CLI tools send no Origin. `--allow-browser-origins` turns this off for development.

## State layout

```
<AGENTCRAFT_HOME>/<profile>/
  state.json             agents, tasks, decisions, repos, goals, feed, messages, sessions (atomic writes)
  foreman.json           pid/port of the Foreman running this profile
  logs/<agent>.jsonl     agent logs (snapshots carry the last 60 lines per agent); rotated at 8 MB
                         into <agent>.1.jsonl (one old file kept); start-up reads only their ends
  memory/shared/*.md     shared notes (hand-editable)
  memory/agents/<id>/*.md
  worktrees/<repo>/<agent>-<task>/
```

## Protocol

`src/protocol.ts` (zod) is the source of truth; `docs/protocol.md` is generated from it with field
tables and a JSON example per message (`npm run gen:protocol-doc`; `npm run check:protocol-doc`
fails if it is stale). Highlights beyond the spec draft: `foreman.status` (backend/auth banner, with
`authMode`: `claude login`, `API key`, a cloud provider name or the Codex equivalents),
`ack`/`error` replies for messages with an `id`, `snapshot.logs`/`snapshot.goals`,
`Agent.active/paused/worktree/title`, task status `cancelled`, decision status `cancelled`.

## The sim backend

A deterministic 22-beat script (`src/agents/sim/scenario.ts`) on the pocket-notes demo repo: the
lead plans 9 tasks, five workers read, edit, test and message each other, CI fails and gets fixed,
a permission prompt, a product question, a blocked task (npm publish needs you) with a blocked
agent, an agent error that recovers (API overload), a cancelled stretch task, five merge decisions,
and a last question that decides how the goal ends (close the publish task -> goal done at 100%,
or keep it -> the goal stays open). Every agent state and station appears. Every edit, test run
and merge is real (real worktrees, real `npm test`, real merge commits), so the diffs you review
are genuine. Your answers change the outcome (Deny vs Allow, which `notes tags` behaviour gets
built, Request changes makes the worker revise). Progress is persisted per beat; a restarted
Foreman resumes the script. `/stop @agent` takes an agent off shift; the script waits for it until
`/resume`.

Static states for screenshot QA:

| | agents |
| --- | --- |
| `--showcase` | Marlow waiting_user@user, Juniper editing@desk, Kit testing@testbench, Wren idle@lounge, Rowan reading@library, Tove thinking@desk; open merge + question decisions |
| `--showcase late` | Marlow thinking@meeting, Juniper running@terminal, Kit done@lounge, Wren blocked@desk (t7), Rowan error@library, Tove editing@desk |

The repo id is the demo dir name: `sim-demo-showcase` / `sim-demo-showcase-late` for those profiles.

## Tests

```sh
npm test            # vitest: protocol, task graph, persistence, decisions, repos/merges, policy,
                    #         git push block, WS + full sim run, showcase states, claude
                    #         orchestration, restart recovery and steering (fake SDK)
npx tsc --noEmit
npm run check       # all of the above + protocol doc freshness
```

## Troubleshooting

- **`port 7878 is already in use`**: another Foreman is running (`~/.agentcraft/foreman.json` and `~/.agentcraft/<profile>/foreman.json` have its pid) - or use `--port`.
- **`profile "claude" is in use by the Foreman pid N`**: that profile already has a running Foreman; stop it or use `--profile`.
- **`... is not a repository root`**: `/repo add` the repository's top folder (the message names it).
- **Banner says auth failed**: the parentheses show the auth mode that was tried (`API key`, a cloud provider or `claude login`). Set `ANTHROPIC_API_KEY` (or a cloud provider switch) and restart the Foreman. With `--use-claude-login`: run `claude` and `/login`. The sim backend works without auth. Why the claude.ai login is opt-in: Anthropic does not allow third-party tools to offer it ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)); see `src/agents/claude/auth.ts`.
- **Merge refused: uncommitted changes**: commit or stash in your checkout, then choose Merge again (the decision re-opened).
- **Reset the demo repo**: `node sandbox/create-demo.mjs --force`.

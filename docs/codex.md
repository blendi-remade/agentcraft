# Codex backend (experimental)

The `codex` backend runs the existing AgentCraft lead/worker workflow through the
[official Codex app-server](https://developers.openai.com/codex/app-server/).
Claude remains the default; the simulation backend still needs no model access.

This integration uses the experimental dynamic-tool API. It targets **Codex CLI
0.159.2 exactly**; other protocol versions are refused until verified. The CLI is a separate
prerequisite, not downloaded or updated by AgentCraft. Protocol changes may require
updating this adapter. Authentication, model availability and usage limits belong
to your Codex account.

## Setup

1. Install Codex using the [official installation instructions](https://developers.openai.com/codex/cli/).
2. Run `codex login` yourself, then verify `codex --version` and `codex login status`.
3. Start AgentCraft with a disposable repository first:

```sh
# Foreman only, on any supported Node 22+ host
cd foreman
npm ci
npm run start -- --backend codex --repo /absolute/path/to/repo --workers kit --max-concurrent 1
```

```sh
# macOS launcher, from the AgentCraft root
node tools/mac.mjs launch --backend codex --repo /absolute/path/to/repo
node tools/mac.mjs stop --profile codex
```

```powershell
# Windows launcher, from the AgentCraft root
tools\launch.ps1 -Backend codex -Repo C:\path\to\repo
```

If `codex` is not on the Foreman's `PATH`, use `--codex-path /absolute/path/to/codex`
or `AGENTCRAFT_CODEX_PATH`. This setting is an executable path, not a command with
arguments. `--use-claude-login` is not used for Codex.

The backend uses your existing Codex authentication. It does not implement credential storage or copy credentials. A missing CLI or failed authentication appears in the Foreman status
banner. Login and model usage are never exercised by the automated tests.

## Configuration

The default profile is `codex`, keeping it separate from `claude` and `sim`.
Backend session identifiers are namespaced so a Claude session is never passed to
Codex when a custom profile is reused. Prefer a separate profile for each backend.

The model is left to Codex unless you supply `--model`, `--lead-model` or
`--worker-model`. AgentCraft does not guess which models your account can access.
Supported reasoning effort values are `low`, `medium`, `high` and `xhigh`.

The existing worker, concurrency, CI, review, resume and merge options apply.
For Codex, `--max-turns`, `--max-turns-lead` and `--max-turns-worker` cap completed
work steps (tool activity and non-final agent messages), not provider API turns.
Reaching the cap interrupts the run. These limits are not dollar-cost guarantees.
Malformed or nonpositive limits are rejected.

You can also configure the backend in `~/.agentcraft/config.json`:

```json
{
  "backend": "codex",
  "codex": {
    "workers": ["kit"],
    "maxConcurrent": 1,
    "effort": "medium",
    "leadEffort": "medium",
    "leadReview": true,
    "resumeOnStart": true
  }
}
```

Codex does not report a reliable dollar cost to this adapter, so AgentCraft does
not fabricate an estimated spend. `--max-budget` is rejected for Codex rather than
silently ignoring a budget cap. Check usage and limits in your Codex account.

## What is shared with Claude

- The task graph, per-task worktrees, CI retry, lead review and user-approved merge
- Team messages, task tools, shared memory and questions at the decision podium
- Stop, pause, resume, cancellation, restart recovery and hand-off orchestration
- The existing git safety environment and agent commit identities

Automatic merge-conflict recovery is not supported by this sandbox-only adapter:
`git merge` and commits require shared `.git` metadata outside the worker's writable
area. A conflicting approved merge leaves the decision open instead of starting a
Codex retry. Resolve and commit the conflict locally in that task's worktree, then
choose **Merge** again. The base checkout remains unchanged until a merge succeeds.
Ordinary uncommitted worker edits are still committed by the Foreman during the
existing user-approved merge flow.

The adapter does not use Claude's SDK as a Codex wire protocol. Codex events and
requests are translated at a dedicated app-server boundary.

## Sandbox and permission differences

This initial adapter is **sandbox-only**. The lead runs read-only; workers can write
in their own worktree. Network access is disabled. Codex's native sandbox enforces
these boundaries; the backend never enables a full-access mode or grants a sandbox
escape. Native escalation requests are denied. A dependency download, external
network call or write outside the permitted workspace may therefore fail, even if
you would approve it for Claude. Prepare dependencies yourself before starting.

Codex's built-in commands and edits do not expose the same every-tool permission
callback as Claude. They are governed by Codex's sandbox, not the complete Claude
command-classifier policy. Codex's native sandbox can read files outside the repository;
it is not a confidentiality boundary around your project. Use this experimental
backend only with repositories and local files you trust the coding agent to read. AgentCraft's shared task and coordination tools retain
their existing validation. The Foreman still owns worktrees, CI and merge decisions.

Inherited MCP servers and unrelated Codex capabilities are disabled for AgentCraft
turns. Custom shell-environment overrides that would compromise the controlled
environment are refused before a Codex turn starts. These restrictions are per-process
or per-thread; AgentCraft does not rewrite your Codex configuration. Git's no-network
and unsigned-agent identity settings are included in the agent shell environment.

Windows users may need to point `--codex-path` at the native `codex.exe` rather than
an npm `.cmd` shim. The adapter does not execute configurable paths through a shell.

## Verification before using a real repository

The automated suite uses fake app-server traffic and real temporary git repositories;
it does not establish live-model behavior or Minecraft visual behavior. A maintainer
should perform this manual smoke test with their own authenticated CLI:

1. Launch with one worker on a disposable repository and submit a small goal.
2. Confirm the lead creates tasks and the worker's tool activity reaches its monitor.
3. Ask the worker a question and check its reply and any decision-podium questions.
4. Pause/resume, then stop/resume a busy worker; ensure an old process does not keep
   changing files after the next turn starts.
5. Restart Foreman mid-task and verify the correct Codex thread resumes.
6. Review the resulting diff and CI result. Reject once, request a change, and then
   explicitly approve the merge. Verify the base checkout changes only at that step.
7. Confirm an attempted network call or write outside the worktree is blocked,
   and that no full-access or sandbox-escape option is offered.

No live Codex inference or game run is required by `npm run check`.

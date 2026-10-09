# AgentCraft protocol v1

> GENERATED from `foreman/src/protocol.ts` and `foreman/src/protocol-examples.ts` by `npm run gen:protocol-doc` (in `foreman/`). Do not edit by hand. The Java mod mirrors these shapes.

## Transport

- The Foreman listens on `ws://127.0.0.1:${AGENTCRAFT_PORT:-7878}`. Clients (the mod, CLI tools) connect, send `hello`, and receive a full `snapshot` followed by incremental messages. Multiple clients may be connected; every client receives every broadcast.
- One JSON object per WebSocket **text** frame. Envelope: `{ "v": 1, "type": "<type>", "id"?: "<correlation id>", ...payload }`.
- Client messages that carry an `id` are answered with `ack { re: id, ok, error?, result? }`. Invalid messages get `error` (and a failed `ack` if they had an id).
- Timestamps are integer epoch milliseconds. Colors are `"#RRGGBB"`. Optional fields are omitted, never `null`. Receivers must ignore unknown fields.
- Upserts replace the whole entity by id. `agent.log` and `feed.add` append.
- Connections that carry any `Origin` header (browsers; also `Origin: null` from sandboxed iframes, `data:` and `file:` pages) or a Host header other than `127.0.0.1` / `localhost` / `[::1]` are rejected with HTTP 401, so a web page cannot drive your agents. Clients (the mod, CLI tools) must not send an Origin header. Heartbeat: the Foreman pings every 15 s.
- The mod should reconnect with backoff and re-send `hello`; the snapshot rebuilds the whole view.

## Enums

- <a id="agentstate"></a>**AgentState**: `idle`, `thinking`, `reading`, `editing`, `running`, `testing`, `waiting_user`, `blocked`, `done`, `error` - What the agent is doing right now; drives nameplate dot color, particles and animation.
- <a id="station"></a>**Station**: `desk`, `library`, `terminal`, `testbench`, `mergestation`, `meeting`, `lounge`, `user` - Where in the HQ the agent should walk to. `user` = next to the player / Decision Podium.
- <a id="agentrole"></a>**AgentRole**: `lead`, `worker`
- <a id="taskstatus"></a>**TaskStatus**: `todo`, `doing`, `review`, `done`, `blocked`, `cancelled` - Task Wall column. `cancelled` tasks are kept for history but should not be shown on the wall.
- <a id="cistatus"></a>**CiStatus**: `unknown`, `running`, `pass`, `fail`
- <a id="logkind"></a>**LogKind**: `text`, `tool`, `result`, `error`, `diff`
- <a id="decisionkind"></a>**DecisionKind**: `question`, `permission`, `merge`
- <a id="decisionstatus"></a>**DecisionStatus**: `open`, `answered`, `cancelled` - `cancelled` = became moot (agent stopped, task cancelled); render like answered.
- <a id="goalstatus"></a>**GoalStatus**: `planning`, `active`, `done`, `failed`, `cancelled`
- <a id="feedkind"></a>**FeedKind**: `goal`, `plan`, `task`, `message`, `decision`, `merge`, `ci`, `memory`, `system`, `error`, `user`
- <a id="notifylevel"></a>**NotifyLevel**: `info`, `warn`, `need_user`
- <a id="worktreestatus"></a>**WorktreeStatus**: `active`, `merged`, `abandoned`
- <a id="backendname"></a>**BackendName**: `sim`, `claude`, `codex`, `openai`
- <a id="authstatus"></a>**AuthStatus**: `ok`, `failed`, `unknown`, `checking` - `failed` must be shown loudly (in-world banner): the selected backend cannot run.

Exact option labels: merge decisions use `Merge`, `Request changes`, `Reject`; permission decisions use `Allow once`, `Always allow for this team`, `Deny`. Question decisions use agent-supplied options (may be empty: free text).

## Entities

### <a id="agent"></a>Agent

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | yes | stable lowercase id, e.g. "kit" |
| `name` | string | yes | display name, e.g. "Kit" |
| `role` | [AgentRole](#agentrole) | yes |  |
| `title` | string | no | short descriptive role from cast.json, e.g. "Backend tinkerer" |
| `color` | string (#RRGGBB) | yes | agent color (scarf/badge/nameplate) |
| `accent` | string (#RRGGBB) | no | "#RRGGBB" |
| `skin` | string | yes | skin id -> assets/agentcraft/textures/entity/agent/<skin>.png |
| `state` | [AgentState](#agentstate) | yes | What the agent is doing right now; drives nameplate dot color, particles and animation. |
| `activity` | string | yes | one short line for the nameplate, e.g. "editing src/cli.ts" (<= 48 chars) |
| `station` | [Station](#station) | yes | Where in the HQ the agent should walk to. `user` = next to the player / Decision Podium. |
| `taskId` | string | no |  |
| `repoId` | string | no |  |
| `worktree` | string | no | id of the worktree the agent is working in (see Repo.worktrees) |
| `paused` | boolean | yes |  |
| `active` | boolean | yes | false = off shift (not on the current team, or stopped by the user); render idle in the lounge |
| `engine` | `claude` \| `codex` \| `openai` | no | which engine runs this agent (absent: the sim) |
| `model` | string | no | the model it runs, for display, e.g. "Opus 5.5" or "GPT-6 Astra" (the real model once a turn reported it) |

### <a id="logentry"></a>LogEntry

| field | type | required | notes |
| --- | --- | --- | --- |
| `ts` | integer | yes | epoch milliseconds |
| `kind` | [LogKind](#logkind) | yes |  |
| `text` | string | yes | may contain newlines; `diff` entries use unified +/- line prefixes |

### <a id="task"></a>Task

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | yes | e.g. "t3" |
| `title` | string | yes |  |
| `description` | string | no |  |
| `status` | [TaskStatus](#taskstatus) | yes | Task Wall column. `cancelled` tasks are kept for history but should not be shown on the wall. |
| `assignee` | string | no | agent id |
| `deps` | string[] | yes | task ids that must be done before this one can start |
| `repoId` | string | no |  |
| `goalId` | string | no |  |
| `priority` | integer | yes | higher = sooner; default 0 |
| `branch` | string | no | git branch, e.g. "agentcraft/kit/t2-tag-parser" |
| `startBranch` | string | no | the worker's branch starts from this branch instead of the base, e.g. a fetched pull request "agentcraft/pr-12" |
| `worktree` | string | no |  |
| `ci` | [CiStatus](#cistatus) | yes |  |
| `blockedReason` | string | no |  |
| `summary` | string | no | worker/lead summary of the result |
| `createdBy` | string | yes | agent id or "user" |
| `createdAt` | integer | yes | epoch milliseconds |
| `updatedAt` | integer | yes | epoch milliseconds |

### <a id="decision"></a>Decision

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | yes | e.g. "d4" |
| `agentId` | string | yes | agent waiting on this decision |
| `kind` | [DecisionKind](#decisionkind) | yes |  |
| `question` | string | yes |  |
| `options` | string[] | yes | button labels; first is the default/recommended choice |
| `context` | string | no | extra detail, multi-line plain text. permission: why it asks, the cwd, and a line `"Always allow for this team" covers: ...` (the scope of that choice). merge: summary + diff stat; after a refused merge the decision is open again and this ends with `Merge refused: <reason>` |
| `status` | [DecisionStatus](#decisionstatus) | yes | `cancelled` = became moot (agent stopped, task cancelled); render like answered. |
| `answer` | [DecisionAnswer](#decisionanswer) | no |  |
| `taskId` | string | no |  |
| `repoId` | string | no | merge decisions: repo to request the diff from |
| `worktree` | string | no | merge decisions: worktree to request the diff for |
| `tool` | string | no | permission decisions: tool name, e.g. "Bash" |
| `createdAt` | integer | yes | epoch milliseconds |

### <a id="decisionanswer"></a>DecisionAnswer

| field | type | required | notes |
| --- | --- | --- | --- |
| `option` | string | no | the chosen option label (one of Decision.options) |
| `text` | string | no | free-text answer / feedback |
| `ts` | integer | yes | epoch milliseconds |

### <a id="repo"></a>Repo

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | yes | e.g. "demo-app" |
| `name` | string | yes |  |
| `path` | string | yes | absolute path of the user checkout |
| `branch` | string | yes | base branch agents branch from and merge into |
| `head` | string | no | short sha of base branch |
| `dirty` | boolean | yes | user checkout has uncommitted tracked changes (merges are refused while dirty) |
| `worktrees` | [Worktree](#worktree)[] | yes |  |
| `ci` | `unknown` \| `running` \| `pass` \| `fail` | yes | latest CI/test result across this repo |

### <a id="worktree"></a>Worktree

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | yes | e.g. "kit-t2" — use as `worktree` in diff.request |
| `agentId` | string | yes |  |
| `taskId` | string | no |  |
| `branch` | string | yes |  |
| `base` | string | yes | branch it was created from / will merge into |
| `path` | string | yes |  |
| `status` | [WorktreeStatus](#worktreestatus) | yes |  |
| `ahead` | integer | yes | commits on branch not on base |
| `files` | integer | yes | files changed vs base (incl. uncommitted) |
| `additions` | integer | yes |  |
| `deletions` | integer | yes |  |

### <a id="memoryentry"></a>MemoryEntry

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | yes | "shared/<slug>" or "<agentId>/<slug>" |
| `scope` | string | yes | "shared" or an agent id |
| `title` | string | yes |  |
| `body` | string | yes | markdown |
| `updated` | integer | yes | epoch milliseconds |
| `author` | string | no | agent id or "user" that last wrote it |

### <a id="goal"></a>Goal

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | yes | e.g. "g1" |
| `text` | string | yes |  |
| `progress` | number | yes |  |
| `status` | `planning` \| `active` \| `done` \| `failed` \| `cancelled` | yes | planning (lead is planning) -> active -> done (every non-cancelled task merged/done); cancelled: every task was cancelled or rejected (back to active if the lead adds a task); failed: planning failed |
| `repoId` | string | no |  |
| `createdAt` | integer | yes | epoch milliseconds |
| `updatedAt` | integer | yes | epoch milliseconds |

### <a id="feeditem"></a>FeedItem

| field | type | required | notes |
| --- | --- | --- | --- |
| `ts` | integer | yes | epoch milliseconds |
| `kind` | [FeedKind](#feedkind) | yes |  |
| `text` | string | yes |  |
| `agentId` | string | no | who it is about / from |
| `to` | string | no | message recipient: agent id, "user" or "all" |

### <a id="foremanstatus"></a>ForemanStatus

| field | type | required | notes |
| --- | --- | --- | --- |
| `version` | string | yes |  |
| `backend` | [BackendName](#backendname) | yes |  |
| `auth` | [AuthStatus](#authstatus) | yes | `failed` must be shown loudly (in-world banner): the selected backend cannot run. |
| `message` | string | no | human-readable backend/auth status for the banner |
| `account` | string | no | e.g. organization / plan when auth ok |
| `speed` | number | no | sim: speed multiplier |
| `showcase` | boolean | no | sim: holding a static showcase state (`--showcase` or `--showcase late`) |
| `costUsd` | number | no | when reported by the provider: estimated spend of this profile (sum over all sessions, survives restarts) |
| `userName` | string | no | the person the team works for, as the agents address them (UI: "<name> answered") |

### <a id="agentlogs"></a>AgentLogs

| field | type | required | notes |
| --- | --- | --- | --- |
| `agentId` | string | yes |  |
| `entries` | [LogEntry](#logentry)[] | yes |  |

### <a id="difffile"></a>DiffFile

| field | type | required | notes |
| --- | --- | --- | --- |
| `path` | string | yes |  |
| `oldPath` | string | no | renames only |
| `status` | `added` \| `modified` \| `deleted` \| `renamed` | yes |  |
| `binary` | boolean | yes |  |
| `additions` | integer | yes |  |
| `deletions` | integer | yes |  |
| `hunks` | [DiffHunk](#diffhunk)[] | yes |  |

### <a id="diffhunk"></a>DiffHunk

| field | type | required | notes |
| --- | --- | --- | --- |
| `header` | string | yes | e.g. "@@ -12,6 +12,9 @@ export function run" |
| `oldStart` | integer | yes |  |
| `oldLines` | integer | yes |  |
| `newStart` | integer | yes |  |
| `newLines` | integer | yes |  |
| `lines` | [DiffLine](#diffline)[] | yes |  |

### <a id="diffline"></a>DiffLine

| field | type | required | notes |
| --- | --- | --- | --- |
| `kind` | `add` \| `del` \| `ctx` | yes |  |
| `text` | string | yes | line content without the +/-/space prefix |
| `oldNo` | integer | no | line number in base (del, ctx) |
| `newNo` | integer | no | line number in branch (add, ctx) |

## Foreman -> Mod

### `snapshot`

Full state. Sent in reply to every `hello`; the mod rebuilds its view from it.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `foreman` | [ForemanStatus](#foremanstatus) | yes |  |
| `agents` | [Agent](#agent)[] | yes |  |
| `tasks` | [Task](#task)[] | yes |  |
| `decisions` | [Decision](#decision)[] | yes | open decisions plus the most recent answered ones |
| `repos` | [Repo](#repo)[] | yes |  |
| `memory` | [MemoryEntry](#memoryentry)[] | yes |  |
| `goal` | [Goal](#goal) | no | current (latest) goal |
| `goals` | [Goal](#goal)[] | yes | all goals, oldest first |
| `feed` | [FeedItem](#feeditem)[] | yes | most recent feed items, oldest first (<= 200) |
| `logs` | [AgentLogs](#agentlogs)[] | yes | recent log tail per agent (<= 60 entries each) |

```json
{
  "v": 1,
  "type": "snapshot",
  "foreman": {
    "version": "0.1.0",
    "backend": "claude",
    "auth": "ok",
    "account": "fal · Claude Enterprise",
    "message": "Claude (lead opus, workers sonnet)",
    "costUsd": 0.42
  },
  "agents": [
    {
      "id": "kit",
      "name": "Kit",
      "role": "worker",
      "title": "Builder & tester",
      "color": "#2E78C6",
      "accent": "#F4EFE6",
      "skin": "kit",
      "state": "editing",
      "activity": "editing src/tags.ts",
      "station": "desk",
      "taskId": "t2",
      "repoId": "demo-app",
      "worktree": "kit-t2",
      "paused": false,
      "active": true
    }
  ],
  "tasks": [
    {
      "id": "t2",
      "title": "Tag parser module (src/tags.ts)",
      "description": "parseTags/hasTag/normalizeTag with unit tests.",
      "status": "doing",
      "assignee": "kit",
      "deps": [
        "t1"
      ],
      "repoId": "demo-app",
      "goalId": "g1",
      "priority": 2,
      "branch": "agentcraft/kit/t2-tag-parser-module",
      "worktree": "kit-t2",
      "ci": "fail",
      "createdBy": "marlow",
      "createdAt": 1790850000000,
      "updatedAt": 1790850060000
    }
  ],
  "decisions": [
    {
      "id": "d2",
      "agentId": "marlow",
      "kind": "merge",
      "question": "Merge t2 \"Tag parser module (src/tags.ts)\" (agentcraft/kit/t2-tag-parser-module) into main?",
      "options": [
        "Merge",
        "Request changes",
        "Reject"
      ],
      "context": "2 files, +45 -0 | tests: pass",
      "status": "open",
      "taskId": "t2",
      "repoId": "demo-app",
      "worktree": "kit-t2",
      "createdAt": 1790850120000
    }
  ],
  "repos": [
    {
      "id": "demo-app",
      "name": "demo-app",
      "path": "C:\\Projects\\agentcraft\\sandbox\\demo-app",
      "branch": "main",
      "head": "a6cbf49",
      "dirty": false,
      "ci": "pass",
      "worktrees": [
        {
          "id": "kit-t2",
          "agentId": "kit",
          "taskId": "t2",
          "branch": "agentcraft/kit/t2-tag-parser-module",
          "base": "main",
          "path": "C:\\Users\\you\\.agentcraft\\claude\\worktrees\\demo-app\\kit-t2",
          "status": "active",
          "ahead": 1,
          "files": 2,
          "additions": 45,
          "deletions": 0
        }
      ]
    }
  ],
  "memory": [
    {
      "id": "shared/plan",
      "scope": "shared",
      "title": "Plan: #tags for pocket-notes",
      "body": "# Plan\n\n- t2 Tag parser module - Kit\n- t3 `list --tag` - Juniper",
      "updated": 1790850030000,
      "author": "marlow"
    }
  ],
  "goal": {
    "id": "g1",
    "text": "Add #tags to pocket-notes",
    "progress": 0.39,
    "status": "active",
    "repoId": "demo-app",
    "createdAt": 1790850000000,
    "updatedAt": 1790850120000
  },
  "goals": [
    {
      "id": "g1",
      "text": "Add #tags to pocket-notes",
      "progress": 0.39,
      "status": "active",
      "repoId": "demo-app",
      "createdAt": 1790850000000,
      "updatedAt": 1790850120000
    }
  ],
  "feed": [
    {
      "ts": 1790850005000,
      "kind": "plan",
      "text": "Marlow planned the goal into 9 tasks",
      "agentId": "marlow"
    }
  ],
  "logs": [
    {
      "agentId": "kit",
      "entries": [
        {
          "ts": 1790850090000,
          "kind": "tool",
          "text": "Edit src/tags.ts"
        }
      ]
    }
  ]
}
```

### `agent.upsert`

An agent was created or changed (state, station, activity, task...). Replace by `agent.id`.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `agent` | [Agent](#agent) | yes |  |

```json
{
  "v": 1,
  "type": "agent.upsert",
  "agent": {
    "id": "kit",
    "name": "Kit",
    "role": "worker",
    "title": "Builder & tester",
    "color": "#2E78C6",
    "accent": "#F4EFE6",
    "skin": "kit",
    "state": "editing",
    "activity": "editing src/tags.ts",
    "station": "desk",
    "taskId": "t2",
    "repoId": "demo-app",
    "worktree": "kit-t2",
    "paused": false,
    "active": true
  }
}
```

### `agent.log`

New log lines for an agent monitor (append; keep a bounded tail).

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `agentId` | string | yes |  |
| `entries` | [LogEntry](#logentry)[] | yes |  |

```json
{
  "v": 1,
  "type": "agent.log",
  "agentId": "kit",
  "entries": [
    {
      "ts": 1790850091000,
      "kind": "tool",
      "text": "$ npm test"
    },
    {
      "ts": 1790850092000,
      "kind": "error",
      "text": "tests FAILED (0.4s) - tests 15, pass 12, fail 3\nFAIL parseTags keeps hyphenated tags"
    },
    {
      "ts": 1790850093000,
      "kind": "diff",
      "text": "src/tags.ts\n- const TAG_RE = /#(\\w+)/g;\n+ const TAG_RE = /(?:^|\\s)#(\\w[\\w-]*)/g;"
    }
  ]
}
```

### `agent.say`

Speech bubble above the agent; also mirrored to the feed.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `agentId` | string | yes |  |
| `text` | string | yes |  |
| `to` | string | no | agent id, "user" or "all"; omitted = said to the room |
| `ts` | integer | yes | epoch milliseconds |

```json
{
  "v": 1,
  "type": "agent.say",
  "agentId": "kit",
  "to": "juniper",
  "text": "parseTags() is in src/tags.ts - you are unblocked once it merges.",
  "ts": 1790850095000
}
```

### `task.upsert`

Task created or changed. Replace by `task.id`.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `task` | [Task](#task) | yes |  |

```json
{
  "v": 1,
  "type": "task.upsert",
  "task": {
    "id": "t2",
    "title": "Tag parser module (src/tags.ts)",
    "description": "parseTags/hasTag/normalizeTag with unit tests.",
    "status": "doing",
    "assignee": "kit",
    "deps": [
      "t1"
    ],
    "repoId": "demo-app",
    "goalId": "g1",
    "priority": 2,
    "branch": "agentcraft/kit/t2-tag-parser-module",
    "worktree": "kit-t2",
    "ci": "fail",
    "createdBy": "marlow",
    "createdAt": 1790850000000,
    "updatedAt": 1790850060000
  }
}
```

### `decision.upsert`

Decision opened, answered or cancelled. Replace by `decision.id`.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `decision` | [Decision](#decision) | yes |  |

```json
{
  "v": 1,
  "type": "decision.upsert",
  "decision": {
    "id": "d2",
    "agentId": "marlow",
    "kind": "merge",
    "question": "Merge t2 \"Tag parser module (src/tags.ts)\" (agentcraft/kit/t2-tag-parser-module) into main?",
    "options": [
      "Merge",
      "Request changes",
      "Reject"
    ],
    "context": "2 files, +45 -0 | tests: pass",
    "status": "open",
    "taskId": "t2",
    "repoId": "demo-app",
    "worktree": "kit-t2",
    "createdAt": 1790850120000
  }
}
```

### `repo.upsert`

Repo added or changed (worktrees, CI, head, dirty). Replace by `repo.id`.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `repo` | [Repo](#repo) | yes |  |

```json
{
  "v": 1,
  "type": "repo.upsert",
  "repo": {
    "id": "demo-app",
    "name": "demo-app",
    "path": "C:\\Projects\\agentcraft\\sandbox\\demo-app",
    "branch": "main",
    "head": "a6cbf49",
    "dirty": false,
    "ci": "pass",
    "worktrees": [
      {
        "id": "kit-t2",
        "agentId": "kit",
        "taskId": "t2",
        "branch": "agentcraft/kit/t2-tag-parser-module",
        "base": "main",
        "path": "C:\\Users\\you\\.agentcraft\\claude\\worktrees\\demo-app\\kit-t2",
        "status": "active",
        "ahead": 1,
        "files": 2,
        "additions": 45,
        "deletions": 0
      }
    ]
  }
}
```

### `memory.upsert`

Memory entry written. Replace by `entry.id`.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `entry` | [MemoryEntry](#memoryentry) | yes |  |

```json
{
  "v": 1,
  "type": "memory.upsert",
  "entry": {
    "id": "shared/plan",
    "scope": "shared",
    "title": "Plan: #tags for pocket-notes",
    "body": "# Plan\n\n- t2 Tag parser module - Kit\n- t3 `list --tag` - Juniper",
    "updated": 1790850030000,
    "author": "marlow"
  }
}
```

### `goal.upsert`

Goal created or progress/status changed. Replace by `goal.id`; latest goal is current.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `goal` | [Goal](#goal) | yes |  |

```json
{
  "v": 1,
  "type": "goal.upsert",
  "goal": {
    "id": "g1",
    "text": "Add #tags to pocket-notes",
    "progress": 0.56,
    "status": "active",
    "repoId": "demo-app",
    "createdAt": 1790850000000,
    "updatedAt": 1790850200000
  }
}
```

### `feed.add`

Append to the activity feed.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `item` | [FeedItem](#feeditem) | yes |  |

```json
{
  "v": 1,
  "type": "feed.add",
  "item": {
    "ts": 1790850210000,
    "kind": "merge",
    "text": "Merged agentcraft/kit/t2-tag-parser-module into main (7cf1999, 2 files)",
    "agentId": "marlow"
  }
}
```

### `diff`

Reply to `diff.request` (sent only to the requesting client). Structured unified diff of worktree vs base, including uncommitted changes.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `requestId` | string | yes |  |
| `repoId` | string | yes |  |
| `worktree` | string | yes |  |
| `base` | string | no |  |
| `branch` | string | no |  |
| `files` | [DiffFile](#difffile)[] | yes |  |
| `stats` | { files: integer, additions: integer, deletions: integer } | yes |  |
| `truncated` | boolean | yes | true if very large files/hunks were cut |
| `error` | string | no |  |

```json
{
  "v": 1,
  "type": "diff",
  "requestId": "r7",
  "repoId": "demo-app",
  "worktree": "kit-t2",
  "base": "main",
  "branch": "agentcraft/kit/t2-tag-parser-module",
  "files": [
    {
      "path": "src/tags.ts",
      "status": "added",
      "binary": false,
      "additions": 2,
      "deletions": 0,
      "hunks": [
        {
          "header": "@@ -0,0 +1,2 @@",
          "oldStart": 0,
          "oldLines": 0,
          "newStart": 1,
          "newLines": 2,
          "lines": [
            {
              "kind": "add",
              "text": "// Tag parsing for notes",
              "newNo": 1
            },
            {
              "kind": "add",
              "text": "export const TAG_RE = /(?:^|\\s)#(\\w[\\w-]*)/g;",
              "newNo": 2
            }
          ]
        }
      ]
    },
    {
      "path": "src/notes.ts",
      "status": "modified",
      "binary": false,
      "additions": 1,
      "deletions": 1,
      "hunks": [
        {
          "header": "@@ -9,3 +9,3 @@ export interface Note {",
          "oldStart": 9,
          "oldLines": 3,
          "newStart": 9,
          "newLines": 3,
          "lines": [
            {
              "kind": "ctx",
              "text": "export interface ListOptions {",
              "oldNo": 9,
              "newNo": 9
            },
            {
              "kind": "del",
              "text": "  all?: boolean;",
              "oldNo": 10
            },
            {
              "kind": "add",
              "text": "  all?: boolean; tag?: string;",
              "newNo": 10
            },
            {
              "kind": "ctx",
              "text": "}",
              "oldNo": 11,
              "newNo": 11
            }
          ]
        }
      ]
    }
  ],
  "stats": {
    "files": 2,
    "additions": 3,
    "deletions": 1
  },
  "truncated": false
}
```

### `notify`

Toast/banner for the player. `need_user` = a decision is waiting (play a bell).

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `level` | [NotifyLevel](#notifylevel) | yes |  |
| `text` | string | yes |  |
| `decisionId` | string | no |  |
| `ts` | integer | yes | epoch milliseconds |

```json
{
  "v": 1,
  "type": "notify",
  "level": "need_user",
  "text": "Marlow: Merge t2 \"Tag parser module\" into main?",
  "decisionId": "d2",
  "ts": 1790850120000
}
```

### `foreman.status`

Backend/auth status changed (banner).

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `status` | [ForemanStatus](#foremanstatus) | yes |  |

```json
{
  "v": 1,
  "type": "foreman.status",
  "status": {
    "version": "0.1.0",
    "backend": "claude",
    "auth": "failed",
    "message": "Claude login check failed: not logged in. Run `claude` and /login, then restart the Foreman."
  }
}
```

### `ack`

Reply to any client message that carried an `id`.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `re` | string | yes | the `id` of the client message being acknowledged |
| `ok` | boolean | yes |  |
| `error` | string | no |  |
| `result` | map<string, any> | no | e.g. {goalId} for goal.submit, {repoId} for repo.add |

```json
{
  "v": 1,
  "type": "ack",
  "re": "c12",
  "ok": true,
  "result": {
    "goalId": "g2"
  }
}
```

### `error`

A client message was invalid or failed (also sent as ack.ok=false when it had an id).

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `message` | string | yes |  |
| `re` | string | no |  |

```json
{
  "v": 1,
  "type": "error",
  "message": "no agent named \"kitt\"",
  "re": "c13"
}
```

## Mod -> Foreman

### `hello`

First message after connecting. The Foreman replies with `snapshot`, then streams upserts.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `modVersion` | string | yes |  |
| `protocol` | 1 | yes |  |
| `client` | string | no | "mod" \| "cli" \| ... (informational) |

```json
{
  "v": 1,
  "type": "hello",
  "modVersion": "0.1.0",
  "protocol": 1,
  "client": "mod"
}
```

### `goal.submit`

New goal for the lead (console: plain text).

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `text` | string | yes |  |
| `repoId` | string | no | defaults to the only/most recently added repo |

```json
{
  "v": 1,
  "type": "goal.submit",
  "id": "c12",
  "text": "Add a --version flag to the CLI",
  "repoId": "demo-app"
}
```

### `user.message`

Message an agent (console: `@name text`) or everyone.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `to` | string | yes | agent id or "all". With "all", a leading "@name" in text routes to that agent. |
| `text` | string | yes |  |

```json
{
  "v": 1,
  "type": "user.message",
  "id": "c13",
  "to": "all",
  "text": "@kit please also cover #tags with emoji"
}
```

### `decision.answer`

Answer an open decision. Merge decisions: option "Merge" merges, "Request changes" sends `text` back to the worker, "Reject" abandons the branch.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `decisionId` | string | yes |  |
| `option` | string \| integer | no | option label (preferred) or 0-based index into Decision.options |
| `text` | string | no | free text (questions) or feedback (merge "Request changes") |

```json
{
  "v": 1,
  "type": "decision.answer",
  "id": "c14",
  "decisionId": "d2",
  "option": "Request changes",
  "text": "Export TAG_RE so format.ts can reuse it."
}
```

### `task.action`

Steer a task from the Task Wall.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `taskId` | string | yes |  |
| `action` | `reassign` \| `cancel` \| `retry` \| `prioritize` | yes |  |
| `arg` | string | no | reassign: agent id; prioritize: integer priority (default: bump to top) |

```json
{
  "v": 1,
  "type": "task.action",
  "id": "c15",
  "taskId": "t5",
  "action": "reassign",
  "arg": "wren"
}
```

### `agent.action`

Pause/resume/stop an agent, or spawn (activate) an off-shift worker.

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `agentId` | string | yes |  |
| `action` | `pause` \| `resume` \| `stop` \| `spawn` | yes | pause: abort the current turn, keep the task (open questions are withdrawn); resume continues it. stop: off shift (active=false) until resume/spawn: turn aborted, open questions/permission prompts withdrawn, its doing tasks go back to the board and the next worker continues from the same branch. spawn: bring an off-shift agent onto the team. |
| `arg` | string | no | spawn: optional task id to assign to the agent |

```json
{
  "v": 1,
  "type": "agent.action",
  "id": "c16",
  "agentId": "juniper",
  "action": "pause"
}
```

### `diff.request`

Ask for the structured diff of a worktree. Answered with `diff` (same requestId).

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `requestId` | string | yes |  |
| `repoId` | string | yes |  |
| `worktree` | string | yes | worktree id (e.g. "kit-t2"); an agent id resolves to that agent's current worktree |

```json
{
  "v": 1,
  "type": "diff.request",
  "id": "c17",
  "requestId": "r7",
  "repoId": "demo-app",
  "worktree": "kit-t2"
}
```

### `repo.add`

Register a local git repo (console: `/repo add <path>`).

| field | type | required | notes |
| --- | --- | --- | --- |
| `id` | string | no | client correlation id; the Foreman answers with `ack` {re: id} |
| `path` | string | yes |  |

```json
{
  "v": 1,
  "type": "repo.add",
  "id": "c18",
  "path": "C:\\Projects\\agentcraft\\sandbox\\demo-app"
}
```

## Console mapping (mod)

| console input | message |
| --- | --- |
| plain text | `goal.submit {text}` |
| `@name text` | `user.message {to:"all", text:"@name text"}` (the Foreman routes it) or `{to:"name", text}` |
| `/answer [dN] <n\|label> [text]` | `decision.answer {decisionId, option, text?}` |
| `/repo add <path>` | `repo.add {path}` |
| `/pause @name`, `/resume @name`, `/stop @name`, `/spawn @name [taskId]` | `agent.action` (spawn: `arg` = task id) |
| `/task <id> cancel\|retry\|prioritize [n]\|reassign <agent>` | `task.action` |


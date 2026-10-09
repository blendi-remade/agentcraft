# Usage display: spend (API key) and plan rate limits (claude login)

Status: implemented on branch `usage-display`. Scope: show the user what their
agents consume, in the game. API-key mode already has an estimate
(`foreman.status.costUsd`, summed per profile from each turn's SDK `total_cost_usd`,
rendered by `ConsoleActions.spendLabel` as `$2.46`). Subscription mode
(`--use-claude-login`, `authMode === 'claude login'`) has nothing, and there the thing that
matters is the claude.ai rate-limit windows: the 5-hour session, the 7-day weekly, per-model
weekly windows such as "Fable", each a utilization 0-100 plus a reset instant, and optional
extra-usage credits.

Source: `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`
in `@anthropic-ai/claude-agent-sdk` 0.3.286 (Claude Code 2.1.286). The SDK says the name
and shape will change. Verified on this machine against a Max login: the method exists at
runtime, a round trip takes 1.3 s, and the real payload is far wider than the typings
(a trimmed copy is the test fixture `foreman/test/fixtures/usage-sample.json`, section 5):
`rate_limits` carries a normalized `limits[]` array alongside the typed `five_hour` /
`seven_day` / `model_scoped` fields, a dozen null codename keys for unreleased limits (one
with `limit_dollars: 250`),
`extra_usage` with extra flags, a `spend` object, a per-surface `seven_day_breakdown`
(Claude Code 83 %, Chats 14 %, Cowork 3 %) and `weekly_scoped_shares`. The CLI fetches all
of it from the claude.ai usage endpoint, so it describes the whole account, not AgentCraft.
Everything below is built so the SDK method can vanish or change shape without a Foreman
crash or a wire-protocol change, and so unknown keys are dropped before they reach the wire.

## 1. Wire shape

Decision: one optional `usage` object on `ForemanStatus`; the existing top-level `costUsd`
stays where it is. Exact schema for `foreman/src/protocol.ts`:

```ts
export const UsageWindow = z.object({
  id: z.string().describe('stable key: "session", "weekly", "weekly:<slug>" (per-model or per-surface weekly window); see docs/design/usage-display.md'),
  label: z.string().describe('short display name chosen by the Foreman, e.g. "5h", "7d", "Fable"; free to change'),
  utilization: z.number().min(0).max(100).nullable().describe('percent of the window used; null when the account does not report it'),
  resetsAt: z.string().nullable().describe('ISO 8601 instant the window resets; null when unknown'),
  active: z.boolean().optional().describe('true when the server marks this window as the one currently binding'),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

export const UsageExtra = z.object({
  enabled: z.boolean(),
  usedCredits: z.number().nullable().describe('extra-usage credits spent this month, in major units of `currency` (e.g. dollars, not cents)'),
  monthlyLimit: z.number().nullable().describe('the monthly extra-usage cap, in the same major units; null when not reported'),
  utilization: z.number().min(0).max(100).nullable(),
  currency: z.string().optional().describe('ISO 4217, e.g. "USD"'),
});

export const Usage = z.object({
  mode: z.enum(['api', 'subscription']).describe('api: costUsd is a real spend estimate; subscription: windows carry the story, costUsd is notional'),
  plan: z.string().optional().describe('subscription: "pro", "max", "team", "enterprise" as the CLI reports it'),
  windows: z.array(UsageWindow).describe('display order; empty when nothing is known (api mode, or an error with no previous result)'),
  extra: UsageExtra.optional().describe('subscription: extra-usage credits, when enabled on the plan'),
  fetchedAt: Ts.describe('when these numbers were obtained (ms since epoch, like every other Ts)'),
  stale: z.boolean().optional().describe('true when the last poll failed and windows are the previous good values'),
  error: z.string().optional().describe('why the last poll failed or why there is nothing to show; human-readable, never credential material'),
});
export type Usage = z.infer<typeof Usage>;

// in ForemanStatus:
  usage: Usage.optional().describe('claude: spend / plan rate limits; absent for sim, Codex-only teams and Foremans that predate it'),
```

`Ts` is the protocol's existing ms-since-epoch timestamp, so `fetchedAt` matches every other
timestamp on the wire; `resetsAt` stays ISO 8601 because the SDK gives it that way and it is
only formatted, never compared with Foreman clocks.

Mapping from the SDK response (Foreman side, `foreman/src/agents/claude/usage.ts`):
- Primary source: `rate_limits.limits[]`. `kind: 'session'` -> id `session`, label `5h`;
  `kind: 'weekly_all'` -> id `weekly`, label `7d`; `kind: 'weekly_scoped'` -> id
  `weekly:<slug>`, label = `scope.model.display_name` (or `scope.surface` display name when
  the model is null; both null -> skipped). `<slug>` is the display name lower-cased, runs
  of characters other than `a-z0-9` replaced by `-`, leading and trailing `-` trimmed
  (`Fable` -> `weekly:fable`, `Opus (4.5)` -> `weekly:opus-4-5`); this rule is final
  (section 6). `percent` -> `utilization`, `resets_at` -> `resetsAt`, `is_active` ->
  `active`. Order as the server gives it. Unknown `kind` values are skipped (not an
  error): the codename limits show the server adds kinds freely. Each entry is parsed on
  its own: a malformed one (a string `percent`, an unknown kind with odd fields) is
  dropped alone and the others still map.
- Fallback when `limits` has no usable entry (absent, empty or all malformed; older CLI,
  or the array gets dropped): `five_hour` -> `session`, `seven_day` -> `weekly`, each
  `model_scoped[]` entry -> `weekly:<slug>`, then legacy `seven_day_opus` /
  `seven_day_sonnet` -> `weekly:opus` /
  `weekly:sonnet` only when `model_scoped` is empty, so a model never appears twice;
  `seven_day_oauth_apps` is dropped (no user-facing meaning in the game). Windows with
  both `utilization` and `resetsAt` null are dropped, and so is a typed window or a
  `model_scoped` entry that does not parse.
- Both paths produce the same ids, so the mod cannot tell which one ran.
- `extra_usage` maps only the five typed fields (`is_enabled`, `used_credits`,
  `monthly_limit`, `utilization`, `currency`). The two amounts go on the wire in major
  units (dollars): divided by `10^decimal_places` when the server sends an integer
  `decimal_places`, passed through unchanged when it is null or absent (as in the
  captured sample). An `extra_usage` that does not parse is dropped alone. `spend`,
  `seven_day_breakdown`, `weekly_scoped_shares`, the dollar fields on each window and the
  codename keys are dropped. The per-surface breakdown is the one worth a follow-up
  ("Claude Code 83 % of your week"); it is not part of this change.

Why `limits[]` first: it is the server's own normalized view, it already carries the
"active" flag and the model scope, and it is the only place a new scope (a surface, a
future model) appears without a new top-level key. Alternative: map the typed fields only.
Lost: the typings lag the payload (the sample has `limits`, `spend` and twenty keys the
typings do not), and per-model data would depend on `model_scoped` staying populated.
Alternative: `limits[]` only, no fallback. Lost: it is undocumented, so the fallback costs
twenty lines and buys resilience against it being renamed.

Why a list keyed by `id`/`label` rather than fixed fields (`fiveHour`, `sevenDayOpus`...):
every model launch adds a scoped window and the server adds kinds at will. Fixed fields
would need a protocol change, a doc regeneration and a mod release each time, and the mod
would show nothing for a window it does not know. A list lets the Foreman add a window and
the mod render it from `label` with no code change; the mod styles by `id` prefix
(`weekly:`) when it wants to.

Alternatives considered for the container:
- Flat fields on `ForemanStatus`. Lost: `setStatus()` is a merge patch, so a poll reporting
  fewer windows than the last one leaves stale fields behind unless every poll nulls every
  known field; one object is replaced atomically. Plus the per-model problem above.
- A separate `foreman.usage` message. Lost: a new snapshot field, mod handler, doc section
  and staleness path for data that is status by nature and already fans out to banner,
  console and wall via `foreman.status`. Chattiness is moot at one small object a minute.
- Folding `costUsd` into `usage`. Lost: the field is shipped and parsed by every mod
  build; moving it is exactly the compatibility break of section 6.

`costUsd` in subscription mode: keep publishing it (the SDK still reports `total_cost_usd`
for login turns and the per-profile sum is the only AgentCraft-specific number the user
has). The mod labels it `est.` and demotes it: in `/status` it reads "notional spend, not
billed on a subscription"; in the header it is dropped whenever a window is shown.
Alternatives: hide it (loses the only non-account-wide number), show it unchanged
(misleading: nothing is billed). The mod decides by `usage.mode`, which is why `mode`
exists; without `usage` (old Foreman) the mod keeps today's behaviour.

## 2. Polling

Decision: the poll is an engine capability, scheduled by the team.

`Engine` gets an optional method `usage?(): Promise<Usage>`. `ClaudeEngine` implements it;
`CodexEngine` and the sim do not. `Team` polls `enginesInUse().filter((e) => e.usage)`;
today that is at most one engine. Should a second usage-capable engine ever exist, labels
get the engine prefix the way `account` does.

`ClaudeEngine.usage()`:
- API mode (`!cfg.useClaudeLogin`): returns `{ mode: 'api', windows: [], fetchedAt }` with
  no process spawned. `rate_limits_available` is false for API keys, Bedrock and Vertex, so
  a poll would only confirm what the config says. The poller publishes that answer once
  and stops: no timer, no turn-end polls, no status churn.
- Subscription mode: open a throwaway `query()` exactly like `checkAuth()`
  (`settingSources: []`, `persistSession: false`, `env: withAuthMode(...)`, a 30 s timeout
  race, `q.close()` in `finally`), feature-detect the method, call it with
  `{ skipBehaviors: true }` (skips the scan of seven days of local transcripts), and map the
  response leniently: only the outer shape is required (an object whose `rate_limits` is an
  object or null); each `limits[]` entry, typed window, `model_scoped[]` entry and
  `extra_usage` has its own `.passthrough()` schema with every field optional, and is
  dropped alone when it does not fit.
- Feature detection: the first function found by name among
  `['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET', 'usage']` on the query
  object, reached via `unknown`, never via the SDK type, so a rename breaks neither the
  build nor the run. None -> `{ mode: 'subscription', windows: [], error: 'usage API not available in this SDK' }`,
  remembered by the engine so later polls return it without spawning a process.
  Found, but the answer is not an object or its `rate_limits` is neither an object nor
  null -> `error: 'usage API shape changed'` plus a debug
  log of the top-level key names (names only). `rate_limits_available === false` under
  login -> `error: 'usage not available for this login; run claude and /login again'`
  (the profile scope is missing from older login tokens). `rate_limits` absent or null
  otherwise -> `error: 'usage not reported for this login'`, so the mod can say why there
  is nothing.
- `usage()` never throws; every failure is a returned `error`. The `error` strings (the mod
  shows them after `usage: ` in `/status`):
  - `usage API not available in this SDK`
  - `usage API shape changed`
  - `usage not available for this login; run claude and /login again`
  - `usage not reported for this login`
  - `usage request failed: <reason>`: from `usage()`, when the request throws or times out
    (`usage request failed: timed out after 30s`)
  - `usage poll failed: <reason>`: from the poller, when `usage()` throws anyway (a safety
    net; it should not happen)

Scheduling (`UsagePoller` in `foreman/src/agents/usage.ts`, owned by `Team`):
- Triggers: once after `checkAuth()` succeeds; after every `afterTurn()`; a timer at 60 s
  while a turn of a usage-reporting engine runs (Claude; a Codex worker's turn in a mixed
  team does not count), 5 min otherwise. Alternatives: only after turns (an idle user
  watching the session window reset would see nothing move), only on a timer (the first
  number arrives a minute late). Both lost.
- Concurrency: one in-flight poll per engine. A trigger during a poll sets `dirty`; one more
  poll runs when the current one ends. Triggers never queue.
- Backoff: on `error` the next interval doubles from 60 s up to 30 min; a success resets it.
  Turn-end triggers are ignored while `nextAllowedAt` is in the future, so a failing
  endpoint is hit at most once per interval.
- Publishing: success -> `setStatus({ usage })`. Failure with a previous good result ->
  previous windows with `stale: true`, the new `error`, the old `fetchedAt`. Failure with
  nothing previous -> `windows: []` plus `error`. `fetchedAt` changes per poll so one
  `foreman.status` goes out per poll; fine at this rate.
- Opt-out: `--no-usage` (config.json `claude.usagePoll: false`). The poll spawns a CLI
  process every minute during work and the numbers are account-wide; a streamer or a
  shared machine may want neither. Alternative: no switch. Lost: cheap now, awkward to
  retrofit.

Cost of a poll: one `claude` child process, like the auth probe. Measured 1.3 s round trip
here, with a transient CLI process (order of 100 MB RSS) and one HTTPS request the CLI makes
itself. The implementation logs the duration at debug; if the median on the reference
machine exceeds 5 s, the busy cadence becomes 2 min before shipping. Alternatives:
- Reuse a running turn's `Query`. Lost: `runTurn` owns and closes it, the control call
  would interleave with the turn's stream, and an idle team has no query to borrow.
- Call the claude.ai usage endpoint directly with the OAuth token. Lost: a new network
  path, credential handling in the Foreman, an undocumented endpoint. Section 4 forbids it.
- One long-lived idle query for polling. Lost: a resident CLI process for a number refreshed
  once a minute, plus reconnect logic when it dies.

## 3. Rendering in the mod

Decision: console first (header line and `/status`), in-world second, and only cheaply.

Protocol (`Protocol.java` ~line 212): `ForemanStatus` gains `@Nullable Usage usage`, with
records `Usage(mode, plan, windows, extra, fetchedAt, stale, error)`,
`UsageWindow(id, label, utilization, resetsAt, active)` and `UsageExtra(...)`. Everything
`@Nullable` except `mode`; `windows` is read through an accessor that returns an empty list
when null, so a malformed payload never NPEs. Unknown fields stay ignored.

Console header (`ConsoleScreen` ~line 740): when `windows` is non-empty, replace the spend
segment with up to four windows, `5h 62% · 7d 34% · Fable 43%`, utilization rounded to an
integer, `?` for null, `(stale)` appended when stale. When windows are empty keep today's
`spendLabel`, prefixed `est. ` in subscription mode.

`/status` (`ConsoleActions.status` ~line 294): one line per window,
`5h session · 62% used · resets in 2h 57m`, the countdown computed from `resetsAt`
against the client clock at render time (no new messages), tone INFO below 80 %, WARN from
80 %, ERROR from 95 %, the `active` window marked with a leading `>`. One line for `extra`
when enabled: `extra usage · $3.20 of $20.00 this month` (`$3.20 used this month` without
a limit; amounts in major units, section 1). One line for the plan: `Claude Max plan ·
whole-account usage, not only AgentCraft`. `error` as a WARN line. `costUsd` reworded as in
section 1. `fetchedAt` older than 15 min shows `(as of <time>)`.

In-world: one extra text line in the feed monitor's header (`monitor/MonitorScreen` lays
it out, `monitor/MonitorRenderer` draws it; not on narrow panels), the same string as the
console header segment: one more row in a layout that is already rebuilt from text. The
layout rebuild is keyed on the rendered string, not the status object, or the per-poll
`fetchedAt` change would rebuild custom geometry every minute for nothing (`DisplayStats`
rebuild counts will show it).
Utilization bars on the task wall, a colour band on the banner or a dedicated meter block
are follow-ups: new geometry and a design pass, for numbers the console shows today.

Why console first: it is text, it lives where `/status` and spend already live, it is
checked by eye in one session, and it validates the schema before geometry is built on it.
Alternative: in-world first because the game is the product. Lost: a wall bar built before
the real window set has been watched for a week gets rebuilt once it is known.

## 4. Privacy and safety

- The numbers are account-wide (every Claude Code, chat and Cowork use, every machine).
  `/status` says so; the header does not pretend they are AgentCraft's.
- The Foreman logs utilization integers, window ids, `plan`, the poll duration and the
  `error` string, at debug. It never logs the raw response, the env handed to `query()`, or
  anything from `accountInfo()`. The mapper copies named fields into the wire object; the
  passthrough schema is for tolerance on input, not for forwarding, so a future key with
  sensitive content cannot reach the wire.
- No new network access: the CLI makes the request it already makes for `/usage`. The
  Foreman learns no endpoint URL and touches the OAuth token only through `withAuthMode`,
  as the auth probe already does.
- Every error path returns a value; `usage()` and the poller catch everything. A broken
  SDK leaves the game without a usage line and nothing else.

## 5. Tests required before merge

Foreman (vitest, fake `queryFn` as in `test/claude-auth.test.ts`):
- `claude-usage.test.ts`: fake query exposing the experimental method. Cases: the captured
  Max answer, trimmed, as a fixture (`test/fixtures/usage-sample.json`; it keeps `session`,
  `subscription_type`, `rate_limits_available` and, under `rate_limits`, `five_hour`,
  `seven_day`, the codename keys `iguana_necktie`, `tangelo` and `nimbus_quill`,
  `extra_usage`, `limits`, `spend`, `seven_day_breakdown`, `weekly_scoped_shares` and
  `model_scoped`) -> windows
  `session 62`, `weekly 34`, `weekly:fable 43 active=false`, plan `max`, extra disabled,
  codename keys, `spend` and the breakdowns never on the wire; one malformed limit -> the
  others still map; `rate_limits` null -> `usage not reported for this login`;
  `decimal_places: 2` -> amounts divided by 100; `limits` deleted from the fixture -> same ids from the fallback;
  legacy `seven_day_opus` only -> `weekly:opus`; `model_scoped` and legacy both present ->
  no duplicate; unknown `kind` skipped; `rate_limits_available: false` -> `error`, empty
  windows; method missing -> `error`, no throw, no second spawn; malformed (`rate_limits: 'nope'`) ->
  `error`, no throw; API mode -> `queryFn` never called, `mode: 'api'`; timeout ->
  `error` and `q.close()` called.
- Poller with fake timers: busy 60 s, idle 5 min, single in-flight with one coalesced rerun,
  backoff doubling to 30 min and reset on success, `stale: true` republishes previous
  windows, `--no-usage` never polls, api mode publishes once and stops. Mixed team
  (`codex-mixed.test.ts` fixture): only the Claude engine is polled, and only Claude turns
  count as busy.
- `protocol.test.ts`: `Usage` parses both example payloads and rejects utilization outside
  0-100; `ForemanStatus` without `usage` still parses.
- `protocol-examples.ts`: a subscription and an API example on `foreman.status`;
  `npm run check:protocol-doc` passes after `gen:protocol-doc` regenerates `docs/protocol.md`.

Mod: `./gradlew build` compiles with the new records. No JUnit on this branch; when it
lands, add a Gson parse test for `foreman.status` with `usage`, with `windows` absent, and
with `usage` absent. Manual: `/status` under `--use-claude-login`, under an API key, and the
header with the Foreman offline (stale path).

## 6. Irreversible decisions

- The field name `usage` on `ForemanStatus`, and `mode`, `windows`, `fetchedAt`, `stale`,
  `error` under it. Once a mod build parses them, renaming breaks Foreman/mod version
  compatibility. Everything else in this doc can change.
- The window ids `session`, `weekly` and the `weekly:<slug>` prefix with the slug rule
  above (lower-cased, runs of non-`a-z0-9` to `-`, leading and trailing `-` trimmed), final
  as implemented. Mods style by id; a changed id silently loses the styling but still renders, which
  is the designed degradation. `label` text is free to change.
- The `mode` values `api` and `subscription`. Adding a value is additive (the mod treats an
  unknown mode like `api`: show `costUsd`, no windows); removing or renaming is not.
- Not irreversible, by design: the SDK method name (feature-detected), the SDK response
  shape (lenient schema with a fallback path), cadence and backoff (Foreman-only), console
  wording, in-world placement.

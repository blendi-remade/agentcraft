// AgentCraft wire protocol, version 1.
//
// This file is the single source of truth. docs/protocol.md is GENERATED from it
// (`npm run gen:protocol-doc`) and the Java mod mirrors it. Every message is one JSON object per
// WebSocket text frame:  { "v": 1, "type": "<type>", "id"?: "<client correlation id>", ...payload }
//
// Conventions
//  - timestamps (`ts`, `createdAt`, `updated`, ...) are integer epoch milliseconds
//  - colors are "#RRGGBB"
//  - unknown fields must be ignored by receivers (forward compatibility); zod strips them here
//  - optional fields are omitted (never null)
import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------------------------

export const AgentState = z
  .enum(['idle', 'thinking', 'reading', 'editing', 'running', 'testing', 'waiting_user', 'blocked', 'done', 'error'])
  .describe('What the agent is doing right now; drives nameplate dot color, particles and animation.');
export type AgentState = z.infer<typeof AgentState>;

export const Station = z
  .enum(['desk', 'library', 'terminal', 'testbench', 'mergestation', 'meeting', 'lounge', 'user'])
  .describe('Where in the HQ the agent should walk to. `user` = next to the player / Decision Podium.');
export type Station = z.infer<typeof Station>;

export const AgentRole = z.enum(['lead', 'worker']);
export type AgentRole = z.infer<typeof AgentRole>;

export const TaskStatus = z
  .enum(['todo', 'doing', 'review', 'done', 'blocked', 'cancelled'])
  .describe('Task Wall column. `cancelled` tasks are kept for history but should not be shown on the wall.');
export type TaskStatus = z.infer<typeof TaskStatus>;

export const CiStatus = z.enum(['unknown', 'running', 'pass', 'fail']);
export type CiStatus = z.infer<typeof CiStatus>;

export const LogKind = z.enum(['text', 'tool', 'result', 'error', 'diff']);
export type LogKind = z.infer<typeof LogKind>;

export const DecisionKind = z.enum(['question', 'permission', 'merge']);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const DecisionStatus = z
  .enum(['open', 'answered', 'cancelled'])
  .describe('`cancelled` = became moot (agent stopped, task cancelled); render like answered.');
export type DecisionStatus = z.infer<typeof DecisionStatus>;

export const GoalStatus = z.enum(['planning', 'active', 'done', 'failed', 'cancelled']);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const FeedKind = z.enum(['goal', 'plan', 'task', 'message', 'decision', 'merge', 'ci', 'memory', 'system', 'error', 'user']);
export type FeedKind = z.infer<typeof FeedKind>;

export const NotifyLevel = z.enum(['info', 'warn', 'need_user']);
export type NotifyLevel = z.infer<typeof NotifyLevel>;

export const WorktreeStatus = z.enum(['active', 'merged', 'abandoned']);
export type WorktreeStatus = z.infer<typeof WorktreeStatus>;

export const BackendName = z.enum(['sim', 'claude', 'codex', 'openai']);
export type BackendName = z.infer<typeof BackendName>;

export const AuthStatus = z
  .enum(['ok', 'failed', 'unknown', 'checking'])
  .describe('`failed` must be shown loudly (in-world banner): the selected backend cannot run.');
export type AuthStatus = z.infer<typeof AuthStatus>;

const Id = z.string().min(1);
const Ts = z.number().int().nonnegative().describe('epoch milliseconds');
const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/).describe('"#RRGGBB"');

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

export const Agent = z.object({
  id: Id.describe('stable lowercase id, e.g. "kit"'),
  name: z.string().describe('display name, e.g. "Kit"'),
  role: AgentRole,
  title: z.string().optional().describe('short descriptive role from cast.json, e.g. "Backend tinkerer"'),
  color: HexColor.describe('agent color (scarf/badge/nameplate)'),
  accent: HexColor.optional(),
  skin: z.string().describe('skin id -> assets/agentcraft/textures/entity/agent/<skin>.png'),
  state: AgentState,
  activity: z.string().describe('one short line for the nameplate, e.g. "editing src/cli.ts" (<= 48 chars)'),
  station: Station,
  taskId: Id.optional(),
  repoId: Id.optional(),
  worktree: Id.optional().describe('id of the worktree the agent is working in (see Repo.worktrees)'),
  paused: z.boolean(),
  active: z.boolean().describe('false = off shift (not on the current team, or stopped by the user); render idle in the lounge'),
  engine: z.enum(['claude', 'codex', 'openai']).optional().describe('which engine runs this agent (absent: the sim)'),
  model: z.string().optional().describe('the model it runs, for display, e.g. "Opus 5.5" or "GPT-6 Astra" (the real model once a turn reported it)'),
});
export type Agent = z.infer<typeof Agent>;

export const LogEntry = z.object({
  ts: Ts,
  kind: LogKind,
  text: z.string().describe('may contain newlines; `diff` entries use unified +/- line prefixes'),
});
export type LogEntry = z.infer<typeof LogEntry>;

export const Task = z.object({
  id: Id.describe('e.g. "t3"'),
  title: z.string(),
  description: z.string().optional(),
  status: TaskStatus,
  assignee: Id.optional().describe('agent id'),
  deps: z.array(Id).describe('task ids that must be done before this one can start'),
  repoId: Id.optional(),
  goalId: Id.optional(),
  priority: z.number().int().describe('higher = sooner; default 0'),
  branch: z.string().optional().describe('git branch, e.g. "agentcraft/kit/t2-tag-parser"'),
  startBranch: z.string().optional().describe('the worker\'s branch starts from this branch instead of the base, e.g. a fetched pull request "agentcraft/pr-12"'),
  worktree: Id.optional(),
  ci: CiStatus,
  blockedReason: z.string().optional(),
  summary: z.string().optional().describe('worker/lead summary of the result'),
  createdBy: Id.describe('agent id or "user"'),
  createdAt: Ts,
  updatedAt: Ts,
});
export type Task = z.infer<typeof Task>;

export const DecisionAnswer = z.object({
  option: z.string().optional().describe('the chosen option label (one of Decision.options)'),
  text: z.string().optional().describe('free-text answer / feedback'),
  ts: Ts,
});
export type DecisionAnswer = z.infer<typeof DecisionAnswer>;

export const Decision = z.object({
  id: Id.describe('e.g. "d4"'),
  agentId: Id.describe('agent waiting on this decision'),
  kind: DecisionKind,
  question: z.string(),
  options: z.array(z.string()).describe('button labels; first is the default/recommended choice'),
  context: z
    .string()
    .optional()
    .describe('extra detail, multi-line plain text. permission: why it asks, the cwd, and a line `"Always allow for this team" covers: ...` (the scope of that choice). merge: summary + diff stat; after a refused merge the decision is open again and this ends with `Merge refused: <reason>`'),
  status: DecisionStatus,
  answer: DecisionAnswer.optional(),
  taskId: Id.optional(),
  repoId: Id.optional().describe('merge decisions: repo to request the diff from'),
  worktree: Id.optional().describe('merge decisions: worktree to request the diff for'),
  tool: z.string().optional().describe('permission decisions: tool name, e.g. "Bash"'),
  createdAt: Ts,
});
export type Decision = z.infer<typeof Decision>;

export const Worktree = z.object({
  id: Id.describe('e.g. "kit-t2" — use as `worktree` in diff.request'),
  agentId: Id,
  taskId: Id.optional(),
  branch: z.string(),
  base: z.string().describe('branch it was created from / will merge into'),
  path: z.string(),
  status: WorktreeStatus,
  ahead: z.number().int().nonnegative().describe('commits on branch not on base'),
  files: z.number().int().nonnegative().describe('files changed vs base (incl. uncommitted)'),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type Worktree = z.infer<typeof Worktree>;

export const Repo = z.object({
  id: Id.describe('e.g. "demo-app"'),
  name: z.string(),
  path: z.string().describe('absolute path of the user checkout'),
  branch: z.string().describe('base branch agents branch from and merge into'),
  head: z.string().optional().describe('short sha of base branch'),
  dirty: z.boolean().describe('user checkout has uncommitted tracked changes (merges are refused while dirty)'),
  worktrees: z.array(Worktree),
  ci: CiStatus.describe('latest CI/test result across this repo'),
});
export type Repo = z.infer<typeof Repo>;

export const MemoryEntry = z.object({
  id: Id.describe('"shared/<slug>" or "<agentId>/<slug>"'),
  scope: z.string().describe('"shared" or an agent id'),
  title: z.string(),
  body: z.string().describe('markdown'),
  updated: Ts,
  author: Id.optional().describe('agent id or "user" that last wrote it'),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

export const Goal = z.object({
  id: Id.describe('e.g. "g1"'),
  text: z.string(),
  progress: z.number().min(0).max(1),
  status: GoalStatus.describe('planning (lead is planning) -> active -> done (every non-cancelled task merged/done); cancelled: every task was cancelled or rejected (back to active if the lead adds a task); failed: planning failed'),
  repoId: Id.optional(),
  createdAt: Ts,
  updatedAt: Ts,
});
export type Goal = z.infer<typeof Goal>;

export const FeedItem = z.object({
  ts: Ts,
  kind: FeedKind,
  text: z.string(),
  agentId: Id.optional().describe('who it is about / from'),
  to: z.string().optional().describe('message recipient: agent id, "user" or "all"'),
});
export type FeedItem = z.infer<typeof FeedItem>;

export const ForemanStatus = z.object({
  version: z.string(),
  backend: BackendName,
  auth: AuthStatus,
  message: z.string().optional().describe('human-readable backend/auth status for the banner'),
  account: z.string().optional().describe('e.g. organization / plan when auth ok'),
  speed: z.number().optional().describe('sim: speed multiplier'),
  showcase: z.boolean().optional().describe('sim: holding a static showcase state (`--showcase` or `--showcase late`)'),
  costUsd: z.number().optional().describe('when reported by the provider: estimated spend of this profile (sum over all sessions, survives restarts)'),
  userName: z.string().optional().describe('the person the team works for, as the agents address them (UI: "<name> answered")'),
});
export type ForemanStatus = z.infer<typeof ForemanStatus>;

export const AgentLogs = z.object({ agentId: Id, entries: z.array(LogEntry) });
export type AgentLogs = z.infer<typeof AgentLogs>;

export const DiffLine = z.object({
  kind: z.enum(['add', 'del', 'ctx']),
  text: z.string().describe('line content without the +/-/space prefix'),
  oldNo: z.number().int().optional().describe('line number in base (del, ctx)'),
  newNo: z.number().int().optional().describe('line number in branch (add, ctx)'),
});
export type DiffLine = z.infer<typeof DiffLine>;

export const DiffHunk = z.object({
  header: z.string().describe('e.g. "@@ -12,6 +12,9 @@ export function run"'),
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  lines: z.array(DiffLine),
});
export type DiffHunk = z.infer<typeof DiffHunk>;

export const DiffFile = z.object({
  path: z.string(),
  oldPath: z.string().optional().describe('renames only'),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  binary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(DiffHunk),
});
export type DiffFile = z.infer<typeof DiffFile>;

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

const envelope = <T extends string>(type: T) => ({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal(type),
  id: z.string().optional().describe('client correlation id; the Foreman answers with `ack` {re: id}'),
});

// Foreman -> Mod ------------------------------------------------------------------------------

export const SnapshotMsg = z.object({
  ...envelope('snapshot'),
  foreman: ForemanStatus,
  agents: z.array(Agent),
  tasks: z.array(Task),
  decisions: z.array(Decision).describe('open decisions plus the most recent answered ones'),
  repos: z.array(Repo),
  memory: z.array(MemoryEntry),
  goal: Goal.optional().describe('current (latest) goal'),
  goals: z.array(Goal).describe('all goals, oldest first'),
  feed: z.array(FeedItem).describe('most recent feed items, oldest first (<= 200)'),
  logs: z.array(AgentLogs).describe('recent log tail per agent (<= 60 entries each)'),
});
export const AgentUpsertMsg = z.object({ ...envelope('agent.upsert'), agent: Agent });
export const AgentLogMsg = z.object({ ...envelope('agent.log'), agentId: Id, entries: z.array(LogEntry) });
export const AgentSayMsg = z.object({
  ...envelope('agent.say'),
  agentId: Id,
  text: z.string(),
  to: z.string().optional().describe('agent id, "user" or "all"; omitted = said to the room'),
  ts: Ts,
});
export const TaskUpsertMsg = z.object({ ...envelope('task.upsert'), task: Task });
export const DecisionUpsertMsg = z.object({ ...envelope('decision.upsert'), decision: Decision });
export const RepoUpsertMsg = z.object({ ...envelope('repo.upsert'), repo: Repo });
export const MemoryUpsertMsg = z.object({ ...envelope('memory.upsert'), entry: MemoryEntry });
export const GoalUpsertMsg = z.object({ ...envelope('goal.upsert'), goal: Goal });
export const FeedAddMsg = z.object({ ...envelope('feed.add'), item: FeedItem });
export const DiffMsg = z.object({
  ...envelope('diff'),
  requestId: z.string(),
  repoId: Id,
  worktree: Id,
  base: z.string().optional(),
  branch: z.string().optional(),
  files: z.array(DiffFile),
  stats: z.object({ files: z.number().int(), additions: z.number().int(), deletions: z.number().int() }),
  truncated: z.boolean().describe('true if very large files/hunks were cut'),
  error: z.string().optional(),
});
export const NotifyMsg = z.object({
  ...envelope('notify'),
  level: NotifyLevel,
  text: z.string(),
  decisionId: Id.optional(),
  ts: Ts,
});
export const ForemanStatusMsg = z.object({ ...envelope('foreman.status'), status: ForemanStatus });
export const AckMsg = z.object({
  ...envelope('ack'),
  re: z.string().describe('the `id` of the client message being acknowledged'),
  ok: z.boolean(),
  error: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional().describe('e.g. {goalId} for goal.submit, {repoId} for repo.add'),
});
export const ErrorMsg = z.object({
  ...envelope('error'),
  message: z.string(),
  re: z.string().optional(),
});

export const ServerMessage = z.discriminatedUnion('type', [
  SnapshotMsg,
  AgentUpsertMsg,
  AgentLogMsg,
  AgentSayMsg,
  TaskUpsertMsg,
  DecisionUpsertMsg,
  RepoUpsertMsg,
  MemoryUpsertMsg,
  GoalUpsertMsg,
  FeedAddMsg,
  DiffMsg,
  NotifyMsg,
  ForemanStatusMsg,
  AckMsg,
  ErrorMsg,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// Mod -> Foreman ------------------------------------------------------------------------------

export const HelloMsg = z.object({
  ...envelope('hello'),
  modVersion: z.string(),
  protocol: z.literal(PROTOCOL_VERSION),
  client: z.string().optional().describe('"mod" | "cli" | ... (informational)'),
});
export const GoalSubmitMsg = z.object({
  ...envelope('goal.submit'),
  text: z.string().min(1),
  repoId: Id.optional().describe('defaults to the only/most recently added repo'),
});
export const UserMessageMsg = z.object({
  ...envelope('user.message'),
  to: z.string().min(1).describe('agent id or "all". With "all", a leading "@name" in text routes to that agent.'),
  text: z.string().min(1),
});
export const DecisionAnswerMsg = z.object({
  ...envelope('decision.answer'),
  decisionId: Id,
  option: z
    .union([z.string(), z.number().int().nonnegative()])
    .optional()
    .describe('option label (preferred) or 0-based index into Decision.options'),
  text: z.string().optional().describe('free text (questions) or feedback (merge "Request changes")'),
});
export const TaskActionMsg = z.object({
  ...envelope('task.action'),
  taskId: Id,
  action: z.enum(['reassign', 'cancel', 'retry', 'prioritize']),
  arg: z.string().optional().describe('reassign: agent id; prioritize: integer priority (default: bump to top)'),
});
export const AgentActionMsg = z.object({
  ...envelope('agent.action'),
  agentId: Id,
  action: z
    .enum(['pause', 'resume', 'stop', 'spawn'])
    .describe(
      'pause: abort the current turn, keep the task (open questions are withdrawn); resume continues it. stop: off shift (active=false) until resume/spawn: turn aborted, open questions/permission prompts withdrawn, its doing tasks go back to the board and the next worker continues from the same branch. spawn: bring an off-shift agent onto the team.',
    ),
  arg: z.string().optional().describe('spawn: optional task id to assign to the agent'),
});
export const DiffRequestMsg = z.object({
  ...envelope('diff.request'),
  requestId: z.string().min(1),
  repoId: Id,
  worktree: Id.describe('worktree id (e.g. "kit-t2"); an agent id resolves to that agent\'s current worktree'),
});
export const RepoAddMsg = z.object({ ...envelope('repo.add'), path: z.string().min(1) });

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMsg,
  GoalSubmitMsg,
  UserMessageMsg,
  DecisionAnswerMsg,
  TaskActionMsg,
  AgentActionMsg,
  DiffRequestMsg,
  RepoAddMsg,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// Helper types ----------------------------------------------------------------------------------

/** A server message without the envelope's `v` (added by the sender). */
export type Outbound = ServerMessage extends infer M ? (M extends { v: 1 } ? Omit<M, 'v'> : never) : never;
export type ServerMessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
export type ClientMessageOf<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>;

export function parseClientMessage(raw: unknown): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'invalid JSON' };
    }
  }
  const r = ClientMessage.safeParse(data);
  if (r.success) return { ok: true, msg: r.data };
  return { ok: false, error: formatZodError(r.error) };
}

export function parseServerMessage(raw: unknown): { ok: true; msg: ServerMessage } | { ok: false; error: string } {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'invalid JSON' };
    }
  }
  const r = ServerMessage.safeParse(data);
  if (r.success) return { ok: true, msg: r.data };
  return { ok: false, error: formatZodError(r.error) };
}

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** Registry used by the doc generator and tests. Order = documentation order. */
export const SERVER_MESSAGES = {
  snapshot: { schema: SnapshotMsg, doc: 'Full state. Sent in reply to every `hello`; the mod rebuilds its view from it.' },
  'agent.upsert': { schema: AgentUpsertMsg, doc: 'An agent was created or changed (state, station, activity, task...). Replace by `agent.id`.' },
  'agent.log': { schema: AgentLogMsg, doc: 'New log lines for an agent monitor (append; keep a bounded tail).' },
  'agent.say': { schema: AgentSayMsg, doc: 'Speech bubble above the agent; also mirrored to the feed.' },
  'task.upsert': { schema: TaskUpsertMsg, doc: 'Task created or changed. Replace by `task.id`.' },
  'decision.upsert': { schema: DecisionUpsertMsg, doc: 'Decision opened, answered or cancelled. Replace by `decision.id`.' },
  'repo.upsert': { schema: RepoUpsertMsg, doc: 'Repo added or changed (worktrees, CI, head, dirty). Replace by `repo.id`.' },
  'memory.upsert': { schema: MemoryUpsertMsg, doc: 'Memory entry written. Replace by `entry.id`.' },
  'goal.upsert': { schema: GoalUpsertMsg, doc: 'Goal created or progress/status changed. Replace by `goal.id`; latest goal is current.' },
  'feed.add': { schema: FeedAddMsg, doc: 'Append to the activity feed.' },
  diff: { schema: DiffMsg, doc: 'Reply to `diff.request` (sent only to the requesting client). Structured unified diff of worktree vs base, including uncommitted changes.' },
  notify: { schema: NotifyMsg, doc: 'Toast/banner for the player. `need_user` = a decision is waiting (play a bell).' },
  'foreman.status': { schema: ForemanStatusMsg, doc: 'Backend/auth status changed (banner).' },
  ack: { schema: AckMsg, doc: 'Reply to any client message that carried an `id`.' },
  error: { schema: ErrorMsg, doc: 'A client message was invalid or failed (also sent as ack.ok=false when it had an id).' },
} as const;

export const CLIENT_MESSAGES = {
  hello: { schema: HelloMsg, doc: 'First message after connecting. The Foreman replies with `snapshot`, then streams upserts.' },
  'goal.submit': { schema: GoalSubmitMsg, doc: 'New goal for the lead (console: plain text).' },
  'user.message': { schema: UserMessageMsg, doc: 'Message an agent (console: `@name text`) or everyone.' },
  'decision.answer': { schema: DecisionAnswerMsg, doc: 'Answer an open decision. Merge decisions: option "Merge" merges, "Request changes" sends `text` back to the worker, "Reject" abandons the branch.' },
  'task.action': { schema: TaskActionMsg, doc: 'Steer a task from the Task Wall.' },
  'agent.action': { schema: AgentActionMsg, doc: 'Pause/resume/stop an agent, or spawn (activate) an off-shift worker.' },
  'diff.request': { schema: DiffRequestMsg, doc: 'Ask for the structured diff of a worktree. Answered with `diff` (same requestId).' },
  'repo.add': { schema: RepoAddMsg, doc: 'Register a local git repo (console: `/repo add <path>`).' },
} as const;

export const ENTITY_SCHEMAS = {
  Agent,
  LogEntry,
  Task,
  Decision,
  DecisionAnswer,
  Repo,
  Worktree,
  MemoryEntry,
  Goal,
  FeedItem,
  ForemanStatus,
  AgentLogs,
  DiffFile,
  DiffHunk,
  DiffLine,
} as const;

/** Merge decision option labels (exact strings). */
export const MERGE_OPTIONS = ['Merge', 'Request changes', 'Reject'] as const;
/** Permission decision option labels (exact strings). */
export const PERMISSION_OPTIONS = ['Allow once', 'Always allow for this team', 'Deny'] as const;

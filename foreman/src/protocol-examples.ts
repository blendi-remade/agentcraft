// One realistic example per message type. Used by docs/protocol.md generation and by the
// protocol round-trip tests (every example must validate against its schema).
import type { Agent, ClientMessage, Decision, MemoryEntry, Repo, ServerMessage, Task } from './protocol.js';

const ts = 1790850000000;

const agent: Agent = {
  id: 'kit',
  name: 'Kit',
  role: 'worker',
  title: 'Builder & tester',
  color: '#2E78C6',
  accent: '#F4EFE6',
  skin: 'kit',
  state: 'editing',
  activity: 'editing src/tags.ts',
  station: 'desk',
  taskId: 't2',
  repoId: 'demo-app',
  worktree: 'kit-t2',
  paused: false,
  active: true,
};

const task: Task = {
  id: 't2',
  title: 'Tag parser module (src/tags.ts)',
  description: 'parseTags/hasTag/normalizeTag with unit tests.',
  status: 'doing',
  assignee: 'kit',
  deps: ['t1'],
  repoId: 'demo-app',
  goalId: 'g1',
  priority: 2,
  branch: 'agentcraft/kit/t2-tag-parser-module',
  worktree: 'kit-t2',
  ci: 'fail',
  createdBy: 'marlow',
  createdAt: ts,
  updatedAt: ts + 60_000,
};

const decision: Decision = {
  id: 'd2',
  agentId: 'marlow',
  kind: 'merge',
  question: 'Merge t2 "Tag parser module (src/tags.ts)" (agentcraft/kit/t2-tag-parser-module) into main?',
  options: ['Merge', 'Request changes', 'Reject'],
  context: '2 files, +45 -0 | tests: pass',
  status: 'open',
  taskId: 't2',
  repoId: 'demo-app',
  worktree: 'kit-t2',
  createdAt: ts + 120_000,
};

const repo: Repo = {
  id: 'demo-app',
  name: 'demo-app',
  path: 'C:\\Projects\\agentcraft\\sandbox\\demo-app',
  branch: 'main',
  head: 'a6cbf49',
  dirty: false,
  ci: 'pass',
  worktrees: [
    {
      id: 'kit-t2',
      agentId: 'kit',
      taskId: 't2',
      branch: 'agentcraft/kit/t2-tag-parser-module',
      base: 'main',
      path: 'C:\\Users\\you\\.agentcraft\\claude\\worktrees\\demo-app\\kit-t2',
      status: 'active',
      ahead: 1,
      files: 2,
      additions: 45,
      deletions: 0,
    },
  ],
};

const memory: MemoryEntry = {
  id: 'shared/plan',
  scope: 'shared',
  title: 'Plan: #tags for pocket-notes',
  body: '# Plan\n\n- t2 Tag parser module - Kit\n- t3 `list --tag` - Juniper',
  updated: ts + 30_000,
  author: 'marlow',
};

type Ex<T> = Record<string, T>;

export const SERVER_EXAMPLES: Ex<ServerMessage> = {
  'snapshot.part': {v:1,type:'snapshot.part',transferId:'example',index:0,total:1,body:'{"type":"snapshot"}'},
  snapshot: {
    v: 1,
    type: 'snapshot',
    foreman: { version: '0.1.0', backend: 'claude', auth: 'ok', account: 'fal · Claude Enterprise', message: 'Claude (lead opus, workers sonnet)', costUsd: 0.42 },
    agents: [agent],
    tasks: [task],
    decisions: [decision],
    repos: [repo],
    memory: [memory],
    goal: { id: 'g1', text: 'Add #tags to pocket-notes', progress: 0.39, status: 'active', repoId: 'demo-app', createdAt: ts, updatedAt: ts + 120_000 },
    goals: [{ id: 'g1', text: 'Add #tags to pocket-notes', progress: 0.39, status: 'active', repoId: 'demo-app', createdAt: ts, updatedAt: ts + 120_000 }],
    feed: [{ ts: ts + 5_000, kind: 'plan', text: 'Marlow planned the goal into 9 tasks', agentId: 'marlow' }],
    logs: [{ agentId: 'kit', entries: [{ ts: ts + 90_000, kind: 'tool', text: 'Edit src/tags.ts' }] }],
  },
  'agent.upsert': { v: 1, type: 'agent.upsert', agent },
  'agent.log': {
    v: 1,
    type: 'agent.log',
    agentId: 'kit',
    entries: [
      { ts: ts + 91_000, kind: 'tool', text: '$ npm test' },
      { ts: ts + 92_000, kind: 'error', text: 'tests FAILED (0.4s) - tests 15, pass 12, fail 3\nFAIL parseTags keeps hyphenated tags' },
      { ts: ts + 93_000, kind: 'diff', text: 'src/tags.ts\n- const TAG_RE = /#(\\w+)/g;\n+ const TAG_RE = /(?:^|\\s)#(\\w[\\w-]*)/g;' },
    ],
  },
  'agent.say': { v: 1, type: 'agent.say', agentId: 'kit', to: 'juniper', text: 'parseTags() is in src/tags.ts - you are unblocked once it merges.', ts: ts + 95_000 },
  'task.upsert': { v: 1, type: 'task.upsert', task },
  'decision.upsert': { v: 1, type: 'decision.upsert', decision },
  'repo.upsert': { v: 1, type: 'repo.upsert', repo },
  'memory.upsert': { v: 1, type: 'memory.upsert', entry: memory },
  'goal.upsert': { v: 1, type: 'goal.upsert', goal: { id: 'g1', text: 'Add #tags to pocket-notes', progress: 0.56, status: 'active', repoId: 'demo-app', createdAt: ts, updatedAt: ts + 200_000 } },
  'feed.add': { v: 1, type: 'feed.add', item: { ts: ts + 210_000, kind: 'merge', text: 'Merged agentcraft/kit/t2-tag-parser-module into main (7cf1999, 2 files)', agentId: 'marlow' } },
  diff: {
    v: 1,
    type: 'diff',
    requestId: 'r7',
    repoId: 'demo-app',
    worktree: 'kit-t2',
    base: 'main',
    branch: 'agentcraft/kit/t2-tag-parser-module',
    files: [
      {
        path: 'src/tags.ts',
        status: 'added',
        binary: false,
        additions: 2,
        deletions: 0,
        hunks: [
          {
            header: '@@ -0,0 +1,2 @@',
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 2,
            lines: [
              { kind: 'add', text: '// Tag parsing for notes', newNo: 1 },
              { kind: 'add', text: 'export const TAG_RE = /(?:^|\\s)#(\\w[\\w-]*)/g;', newNo: 2 },
            ],
          },
        ],
      },
      {
        path: 'src/notes.ts',
        status: 'modified',
        binary: false,
        additions: 1,
        deletions: 1,
        hunks: [
          {
            header: '@@ -9,3 +9,3 @@ export interface Note {',
            oldStart: 9,
            oldLines: 3,
            newStart: 9,
            newLines: 3,
            lines: [
              { kind: 'ctx', text: 'export interface ListOptions {', oldNo: 9, newNo: 9 },
              { kind: 'del', text: '  all?: boolean;', oldNo: 10 },
              { kind: 'add', text: '  all?: boolean; tag?: string;', newNo: 10 },
              { kind: 'ctx', text: '}', oldNo: 11, newNo: 11 },
            ],
          },
        ],
      },
    ],
    stats: { files: 2, additions: 3, deletions: 1 },
    truncated: false,
  },
  notify: { v: 1, type: 'notify', level: 'need_user', text: 'Marlow: Merge t2 "Tag parser module" into main?', decisionId: 'd2', ts: ts + 120_000 },
  'foreman.status': { v: 1, type: 'foreman.status', status: { version: '0.1.0', backend: 'claude', auth: 'failed', message: 'Claude login check failed: not logged in. Run `claude` and /login, then restart the Foreman.' } },
  ack: { v: 1, type: 'ack', re: 'c12', ok: true, result: { goalId: 'g2' } },
  error: { v: 1, type: 'error', message: 'no agent named "kitt"', re: 'c13' },
};

export const CLIENT_EXAMPLES: Ex<ClientMessage> = {
  hello: { v: 1, type: 'hello', modVersion: '0.1.0', protocol: 1, client: 'mod' },
  'goal.submit': { v: 1, type: 'goal.submit', id: 'c12', text: 'Add a --version flag to the CLI', repoId: 'demo-app' },
  'user.message': { v: 1, type: 'user.message', id: 'c13', to: 'all', text: '@kit please also cover #tags with emoji' },
  'decision.answer': { v: 1, type: 'decision.answer', id: 'c14', decisionId: 'd2', option: 'Request changes', text: 'Export TAG_RE so format.ts can reuse it.' },
  'task.action': { v: 1, type: 'task.action', id: 'c15', taskId: 't5', action: 'reassign', arg: 'wren' },
  'harness.detect': { v: 1, type: 'harness.detect', id: 'c-harnesses', refresh: true },
  'team.configure': { v: 1, type: 'team.configure', id: 'c-team', roles: {lead:{provider:'codex'}, worker:{provider:'codex'}, reviewer:{provider:'claude',model:'sonnet',effort:'high'}} },
  'agent.models': { v: 1, type: 'agent.models', id: 'c-models', agentId: 'marlow' },
  'agent.configure': { v: 1, type: 'agent.configure', id: 'c-configure', agentId: 'marlow', model: 'gpt-6-astra', effort: 'medium' },
  'agent.action': { v: 1, type: 'agent.action', id: 'c16', agentId: 'juniper', action: 'pause' },
  'diff.request': { v: 1, type: 'diff.request', id: 'c17', requestId: 'r7', repoId: 'demo-app', worktree: 'kit-t2' },
  'repo.add': { v: 1, type: 'repo.add', id: 'c18', path: 'C:\\Projects\\agentcraft\\sandbox\\demo-app' },
};

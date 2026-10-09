// Orchestration test for the Codex engine with a scripted fake `codex app-server`
// (fixtures/fake-codex-native.mjs): the real engine, JSON-RPC client, policy, permission prompts, team
// tools, worktrees, CI, reviews and merges, with a fake model. No network, no Codex install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodexEngine } from '../src/agents/codex/engine.js';
import { shellCommand } from '../src/agents/codex/stream.js';
import { TeamBackend } from '../src/agents/team.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'fixtures', 'fake-codex-native.mjs');
const OUTSIDE = path.join(os.homedir(), 'agentcraft-codex-test-outside.txt');

const scenario = {
  turns: [
    {
      role: 'lead',
      match: '^New goal',
      steps: [
        { cmd: 'git log --oneline -3' },
        { tool: 'write_memory', args: { title: 'Plan: --version flag', body: '- t1 --version (Kit)', scope: 'shared' } },
        { tool: 'create_task', args: { title: 'Add a --version flag', description: 'print the package version', assignee: 'kit' } },
        { tool: 'send_message', args: { to: 'all', text: 'Plan is up.' } },
        { say: 'Planned one task.' },
      ],
    },
    {
      role: 'worker',
      match: 'Your task: t1',
      steps: [
        { cmd: 'git status' },
        { cmd: 'git status', foreign: true },
        { write: { file: 'src/cli.ts', content: '\n// --version\n' } },
        { cmd: 'npm install left-pad' },
        { editOutside: OUTSIDE },
        { tool: 'update_task', args: { task_id: 't1', status: 'review', summary: 'Added --version.' } },
        { say: 'Done: --version prints the version.' },
      ],
    },
    { role: 'lead', match: '^Review request: t1', steps: [{ tool: 'request_merge', args: { task_id: 't1', summary: 'Adds --version.' } }, { say: 'Looks good.' }] },
    {
      role: 'worker',
      match: 'requested changes',
      steps: [
        { write: { file: 'src/cli.ts', content: '\n// tweak\n' } },
        { tool: 'update_task', args: { task_id: 't1', status: 'review', summary: 'Tweaked as asked.' } },
      ],
    },
  ],
};

type LogLine = { pid: number; serverLocalAppData?: string; method?: string; params?: any; cmd?: string; foreign?: boolean; decision?: string; editOutside?: string; tool?: string; result?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const readLog = (file: string): LogLine[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogLine)
    : [];

/**
 * A Codex worker's writable roots: objects, its own worktree git dir, temp, and only its own
 * branches' refs and reflogs. Never the shared .git (config, hooks, other branches).
 */
const gitRoots = (repo: string, worktreeId: string, agent: string) => [
  path.join(fs.realpathSync(repo), '.git', 'objects'),
  path.join(fs.realpathSync(repo), '.git', 'worktrees', worktreeId),
  os.tmpdir(),
  path.join(fs.realpathSync(repo), '.git', 'refs', 'heads', 'agentcraft', agent),
  path.join(fs.realpathSync(repo), '.git', 'logs', 'refs', 'heads', 'agentcraft', agent),
];

let h: Harness;
let home: string;
let repoPath: string;
let logFile: string;

beforeAll(async () => {
  home = tempDir();
  repoPath = await demoRepo();
  const scenarioFile = path.join(home, 'scenario.json');
  logFile = path.join(home, 'codex-log.jsonl');
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
  process.env.FAKE_CODEX_SCENARIO = scenarioFile;
  process.env.FAKE_CODEX_LOG = logFile;
  h = makeForeman(home, ['--backend', 'codex', '--workers', 'kit', '--repo', repoPath]);
  const codex = new CodexEngine(h.fm, h.cfg.codex, { bin: process.execPath, args: [FAKE] });
  await h.fm.start(new TeamBackend(h.fm, h.cfg.claude, { name: 'codex', engines: { lead: codex, worker: codex } }));
});

afterAll(async () => {
  await h.fm.close();
  delete process.env.FAKE_CODEX_SCENARIO;
  delete process.env.FAKE_CODEX_LOG;
  rmrf(home);
  rmrf(path.dirname(repoPath));
  rmrf(OUTSIDE);
});

describe('codex engine (fake app-server)', () => {
  it('checks the Codex login and shows the team', () => {
    expect(h.fm.status.backend).toBe('codex');
    expect(h.fm.status.auth).toBe('ok');
    expect(h.fm.status.account).toBe('ChatGPT plus');
    expect(h.fm.status.message).toBe('Codex (lead gpt-fake, workers gpt-fake)');
  });

  it('plans, works in a worktree through the policy, asks, reviews, revises and merges', async () => {
    const fm = h.fm;
    const goal = await fm.submitGoal('Add a --version flag');
    await until(() => fm.tasks.list().length === 1 && fm.goal(goal.id)!.status === 'active', 30_000);
    expect(fm.memory.list().some((m) => m.title === 'Plan: --version flag')).toBe(true);

    // Kit: `git status` passes the policy silently; `npm install` asks (shown without the
    // PowerShell wrapper) -> Deny; the edit outside the worktree asks -> Deny
    await until(() => fm.decisions.open().some((d) => d.kind === 'permission'), 30_000);
    const perm = fm.decisions.open().find((d) => d.kind === 'permission')!;
    expect(perm.question).toBe('Kit wants to run PowerShell: npm install left-pad');
    await fm.answerDecision(perm.id, 'Deny');
    await until(() => fm.decisions.open().some((d) => d.kind === 'permission' && d.question.includes(OUTSIDE)), 30_000);
    await fm.answerDecision(fm.decisions.open().find((d) => d.kind === 'permission')!.id, 'Deny');

    // CI, the lead's review, a merge decision -> Request changes -> Kit revises in the same thread
    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 60_000);
    const m1 = fm.decisions.open().find((d) => d.kind === 'merge')!;
    await fm.answerDecision(m1.id, 'Request changes', 'Add a comment about the flag.');
    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1' && d.id !== m1.id), 60_000);
    const m2 = fm.decisions.open().find((d) => d.kind === 'merge')!;
    await fm.answerDecision(m2.id, 'Merge');
    await until(() => fm.goal(goal.id)!.status === 'done', 30_000);
    const cli = fs.readFileSync(path.join(repoPath, 'src', 'cli.ts'), 'utf8');
    expect(cli).toContain('// --version');
    expect(cli).toContain('// tweak');

    const log = readLog(logFile);
    const decisions = log.filter((l) => l.cmd);
    expect(decisions.find((l) => l.cmd === 'git log --oneline -3')!.decision).toBe('accept'); // lead, read-only command
    expect(decisions.find((l) => l.cmd === 'git status' && !l.foreign)!.decision).toBe('accept');
    expect(decisions.find((l) => l.foreign)!.decision).toBe('decline'); // another thread: never ours to approve
    expect(decisions.find((l) => l.cmd === 'npm install left-pad')!.decision).toBe('decline');
    expect(log.find((l) => l.editOutside)!.decision).toBe('decline');
    expect(fs.existsSync(OUTSIDE)).toBe(false);

    // thread setup: sandbox per role, approvals for everything, none of the user's own Codex setup,
    // the git safety env passed explicitly, the worktree's git dir writable (commits)
    const starts = log.filter((l) => l.method === 'thread/start');
    const lead = starts.find((l) => l.params.dynamicTools.some((t: { name: string }) => t.name === 'create_task'))!.params;
    const worker = starts.find((l) => !l.params.dynamicTools.some((t: { name: string }) => t.name === 'create_task'))!.params;
    expect(lead.sandbox).toBe('read-only');
    expect(worker.sandbox).toBe('workspace-write');
    expect(worker.approvalPolicy).toBe('untrusted');
    expect(worker.cwd).toContain(path.join('worktrees', 'demo-app'));
    expect(worker.config.mcp_servers.posthog.enabled).toBe(false);
    expect(worker.config.plugins['computer-use@openai-bundled'].enabled).toBe(false);
    expect(worker.config.features.computer_use).toBe(false);
    expect(worker.config.features.multi_agent).toBe(false);
    expect(worker.config.web_search).toBe('disabled');
    expect(worker.config.notify).toEqual([]);
    const set = worker.config.shell_environment_policy.set as Record<string, string>;
    expect(set.GIT_AUTHOR_NAME).toBe('AgentCraft Kit');
    const gitCfg = Object.fromEntries(Array.from({ length: Number(set.GIT_CONFIG_COUNT) }, (_x, i) => [set[`GIT_CONFIG_KEY_${i}`], set[`GIT_CONFIG_VALUE_${i}`]]));
    expect(gitCfg['protocol.allow']).toBe('never');
    expect(worker.config.sandbox_workspace_write.writable_roots).toEqual(gitRoots(repoPath, 'kit-t1', 'kit'));
    expect(lead.config.sandbox_workspace_write.writable_roots).toEqual([]);
    expect(worker.developerInstructions).toContain('Working in AgentCraft (Codex)');
    expect(worker.developerInstructions.includes('use npm.cmd and npx.cmd')).toBe(process.platform === 'win32');
    expect(worker.dynamicTools.map((t: { name: string }) => t.name).sort()).toEqual(['ask_user', 'list_tasks', 'read_memory', 'report_status', 'send_message', 'update_task', 'write_memory']);
    expect(worker.dynamicTools.find((t: { name: string }) => t.name === 'update_task').inputSchema.properties.status.enum).toContain('review');

    // the revision resumed Kit's thread; sessions are recorded as Codex sessions
    const kitThread = fm.store.data.sessions['kit:t1']!;
    expect(kitThread.engine).toBe('codex');
    expect(log.some((l) => l.method === 'thread/resume' && l.params.threadId === kitThread.sessionId)).toBe(true);

    // the world: Kit's monitor shows the real commands and edits, the lead's verdict
    const kitLog = fm.store.logTail('kit').map((e) => `${e.kind}:${e.text}`);
    expect(kitLog).toContain('tool:$ git status');
    expect(kitLog.some((l) => l.startsWith('tool:Edit src/cli.ts'))).toBe(true);
    expect(kitLog.some((l) => l.startsWith('diff:src/cli.ts'))).toBe(true);
    expect(kitLog.some((l) => l.includes('Alex denied: PowerShell: npm install left-pad'))).toBe(true);
    expect(kitLog.some((l) => /^result:turn complete \(\d+ steps · 1k tokens\)/.test(l))).toBe(true);
  }, 120_000);

  it.runIf(process.platform === 'win32')('isolates desktop runtime ACL setup while preserving shell app-data and git safety on start and resume', () => {
    const log = readLog(logFile);
    const isolated = path.join(h.cfg.dataDir, 'codex-localappdata');
    expect(fs.statSync(isolated).isDirectory()).toBe(true);
    const launches = log.filter((l) => l.serverLocalAppData !== undefined);
    expect(launches.length).toBeGreaterThan(2); // auth, lead/worker turns, revision
    expect(launches.every((l) => l.serverLocalAppData === isolated)).toBe(true);
    expect(process.env.LOCALAPPDATA).not.toBe(isolated);
    for (const entry of log.filter((l) => l.method === 'thread/start' || l.method === 'thread/resume')) {
      const set = entry.params.config.shell_environment_policy.set;
      expect(set.LOCALAPPDATA).toBe(process.env.LOCALAPPDATA);
      const pairs = Object.fromEntries(Array.from({ length: Number(set.GIT_CONFIG_COUNT) }, (_, i) => [set[`GIT_CONFIG_KEY_${i}`], set[`GIT_CONFIG_VALUE_${i}`]]));
      expect(pairs['protocol.allow']).toBe('never');
      expect(entry.params.approvalPolicy).toBe('untrusted');
      expect(['read-only', 'workspace-write']).toContain(entry.params.sandbox);
    }
    expect(log.some((l) => l.method === 'thread/resume')).toBe(true);
  });

  it('grants the verified worktree gitdir on resume as well as start', () => {
    const workers = readLog(logFile).filter((l) => (l.method === 'thread/start' || l.method === 'thread/resume') && l.params.sandbox === 'workspace-write');
    expect(workers.some((l) => l.method === 'thread/resume')).toBe(true);
    for (const worker of workers) {
      expect(worker.params.config.sandbox_workspace_write.writable_roots).toEqual(gitRoots(repoPath, 'kit-t1', 'kit'));
    }
  });

  it('refuses Git write grants when the worktree pointer names another worktree', async () => {
    const isolatedHome = tempDir();
    const isolatedRepo = await demoRepo();
    const isolated = makeForeman(isolatedHome, ['--backend', 'sim']);
    try {
      const repo = await isolated.fm.repos.add(isolatedRepo);
      const task = isolated.fm.tasks.create({ title: 'git access', createdBy: 'marlow', repoId: repo.id, assignee: 'kit' });
      const own = await isolated.fm.repos.createWorktree(repo.id, 'kit', task);
      task.worktree = own.id;
      const other = await isolated.fm.repos.createWorktree(repo.id, 'juniper', { id: 'other', title: 'other' });
      const engine = new CodexEngine(isolated.fm, isolated.cfg.codex);
      const backend = new TeamBackend(isolated.fm, isolated.cfg.claude, { name: 'codex', engines: { lead: engine, worker: engine } });
      const job = { kind: 'work' as const, agentId: 'kit', taskId: task.id, sessionKey: 'kit:test', prompt: '' };
      expect(await backend['writableRoots']('worker', job)).toEqual(gitRoots(isolatedRepo, own.id, 'kit'));
      const link = path.join(own.path, '.git');
      const original = fs.readFileSync(link, 'utf8');
      const overwrite = (value: string) => {
        const fd = fs.openSync(link, 'r+'); // Git hides this file on Windows.
        try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, value); } finally { fs.closeSync(fd); }
      };
      try {
        overwrite(fs.readFileSync(path.join(other.path, '.git'), 'utf8'));
        await expect(backend['writableRoots']('worker', job)).rejects.toThrow(/Cannot grant worktree Git access/);
        expect(await backend['writableRoots']('lead', job)).toEqual([]);
      } finally { overwrite(original); }
    } finally {
      await isolated.fm.close();
      rmrf(isolatedHome);
      rmrf(path.dirname(isolatedRepo));
    }
  });
});

describe('shell command unwrapping', () => {
  it('shows and checks the command inside Codex shell wrappers', () => {
    expect(shellCommand(`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'type hello.txt'`)).toEqual({ tool: 'PowerShell', command: 'type hello.txt' });
    expect(shellCommand(`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "type 'a b.txt'"`)).toEqual({ tool: 'PowerShell', command: "type 'a b.txt'" });
    // a real one from Codex (shlex-quoted: '...' and "..." pieces joined into one word)
    expect(shellCommand(`"C:\\x\\powershell.exe" -Command 'Get-Content src/cli.ts | Where-Object { $_ -match '"'"'^  notes '"' } | ForEach-Object { "'$helpMatch = 1 }'`)).toEqual({
      tool: 'PowerShell',
      command: "Get-Content src/cli.ts | Where-Object { $_ -match '^  notes ' } | ForEach-Object { $helpMatch = 1 }",
    });
    expect(shellCommand(`/bin/bash -lc 'echo "a b" '"'"'c'"'"''`)).toEqual({ tool: 'Bash', command: `echo "a b" 'c'` });
    expect(shellCommand(`/bin/bash -lc 'unterminated`)).toEqual({ tool: 'Bash', command: `'unterminated` });
    expect(shellCommand(`"C:\\x\\powershell.exe" -Command '$t = Join-Path (Get-Location).Path '"'"'.test-tmp'"'"'; npm test'`)).toEqual({ tool: 'PowerShell', command: "$t = Join-Path (Get-Location).Path '.test-tmp'; npm test" });
    expect(shellCommand(`/bin/bash -lc 'npm test'`)).toEqual({ tool: 'Bash', command: 'npm test' });
    expect(shellCommand(`/bin/zsh -lc "git status"`)).toEqual({ tool: 'Bash', command: 'git status' });
    expect(shellCommand('git status')).toEqual({ tool: 'Bash', command: 'git status' });
  });
});

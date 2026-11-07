import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyToolUse, type PolicyContext } from '../src/policy.js';
import { protectedProcesses } from '../src/agents/team.js';

const wt = path.join(os.tmpdir(), 'ac-policy', 'worktrees', 'demo-app', 'kit-t2');
const foreman = { pid: 4242, what: 'the Foreman', name: 'node', commandLine: 'C:\\Program Files\\nodejs\\node.exe --import tsx src/main.ts --backend claude' };
const ctx: PolicyContext = {
  role: 'worker',
  cwd: wt,
  tempDirs: [],
  protectedProcesses: [foreman, { pid: 4000, what: 'a parent of the Foreman', name: 'npm' }, { pid: 5151, what: "Kit's agent process", name: 'node' }],
  protectedPorts: [7878],
};
const verdict = (command: string, c: PolicyContext = ctx) => classifyToolUse('Bash', { command }, c);
const action = (command: string, c?: PolicyContext) => verdict(command, c).action;

describe('kills that would stop AgentCraft itself are refused', () => {
  // the command that took the Foreman down, and its relatives
  it.each([
    'taskkill //F //IM node.exe >/dev/null 2>&1; echo done',
    'taskkill /F /IM node.exe',
    'taskkill -f -im node.exe',
    'taskkill /IM "node*" /F',
    'taskkill //F //IM node.exe //FI "WINDOWTITLE eq vite"',
    'taskkill /F /FI "IMAGENAME eq node.exe"',
    'taskkill /IM javaw.exe /F',
    'taskkill /IM java.exe /F',
    'taskkill /PID 4242 /F',
    'taskkill //PID 4000 //T //F',
    'taskkill /PID 5151 /F',
    'taskkill /PID 1234,4242 /F',
    'Stop-Process -Name node -Force',
    'Stop-Process -Name "node","vite"',
    'Stop-Process -Id 4242',
    'Stop-Process 4242 -Force',
    'spps -Name java',
    'kill -Name node',
    'kill 4242',
    'kill -9 4242',
    'kill -s KILL 4242',
    'kill -9 -1',
    'kill 0',
    'kill -- -4000',
    'pkill node',
    'pkill -9 -f "node --import tsx"',
    'pkill -f "src/main.ts"',
    'pkill -P 4242',
    'killall node',
    'killall -9 java',
    'npm run build; taskkill /F /IM node.exe',
    'echo $(taskkill /IM node.exe /F)',
    'bash -c "taskkill /F /IM node.exe"',
    'ls | xargs taskkill /IM node.exe /F',
    'Get-Process node | Stop-Process -Force',
    'Get-Process -Name node | Stop-Process',
    '(Get-Process node).Kill()',
    'Get-Process node | ForEach-Object { $_.Kill() }',
    "wmic process where name='node.exe' delete",
    'pgrep node | xargs kill',
    'npx kill-port 7878',
    'fuser -k 7878/tcp',
    'taskkill /F /FI "MEMUSAGE gt 100000"',
  ])('%s', (command) => {
    const v = verdict(command);
    expect(v.action).toBe('deny');
    // the refusal tells the agent what to do instead
    if (v.action === 'deny') expect(v.reason).toMatch(/by their PID/);
  });

  it('an approval cannot unlock them', () => {
    const cmd = 'taskkill //F //IM node.exe >/dev/null 2>&1; echo done';
    const asked = verdict(cmd, { ...ctx, protectedProcesses: [] });
    expect(asked.action).toBe('deny'); // node is protected by name even with no known processes
    const approved = { ...ctx, alwaysAllow: ['Bash:kill', `Bash:exact:${'x'}`] };
    expect(action(cmd, approved)).toBe('deny');
  });

  it('names the protected process in the reason', () => {
    const v = verdict('taskkill /PID 4242 /F');
    expect(v.action === 'deny' && v.reason).toMatch(/pid 4242 is the Foreman/);
    const n = verdict('taskkill /F /IM node.exe');
    expect(n.action === 'deny' && n.reason).toMatch(/the Foreman \(pid 4242\)/);
  });
});

describe('stopping your own dev server still works (asked, then exact approval)', () => {
  it.each([
    'taskkill //PID 88016 //F //T',
    'taskkill /PID 1234 /F',
    'taskkill /IM vite.exe /F',
    'Stop-Process -Id 1234 -Force',
    'kill 1234',
    'kill -9 1234 5678',
    'pkill -f "vite --port 5173"',
    'pkill -f webpack-dev-server',
    'killall python3',
  ])('%s', (command) => {
    expect(action(command)).toBe('ask');
  });

  it('PIDs that cannot be checked ask with a warning', () => {
    for (const cmd of ['kill $PID', 'kill $(cat server.pid)', 'taskkill /PID $pid /F', 'Stop-Process -InputObject $p']) {
      const v = verdict(cmd);
      expect(v.action, cmd).toBe('ask');
      if (v.action === 'ask') expect(v.reason, cmd).toMatch(/cannot be checked/);
    }
  });

  it('kills of the shell\'s own jobs and kill -l stay as before', () => {
    expect(action('kill -l')).toBe('allow');
    expect(action('kill %1')).toBe('allow');
  });

  it('commands that merely mention node and kill are not refused by the query check', () => {
    expect(action('kill 1234; node server.js')).toBe('ask');
    expect(action('tasklist | findstr node')).toBe('allow');
  });
});

describe('protectedProcesses', () => {
  it('always includes the Foreman itself and its parent', () => {
    const list = protectedProcesses({ agentPids: [{ pid: 99, who: 'Kit' }] });
    expect(list.find((p) => p.pid === process.pid)?.what).toMatch(/Foreman/);
    expect(list.some((p) => p.pid === process.ppid)).toBe(true);
    expect(list.find((p) => p.pid === 99)?.what).toBe("Kit's agent process");
  });
});

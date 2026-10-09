import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shellCommand, ToolExecutor, toolText } from '../src/agents/coding-tools.js';
import { makeForeman, tempDir, rmrf, type Harness } from './helpers.js';
import { turnRequest } from './provider-helpers.js';
import { bashExecutable } from '../src/util/bash.js';

let h: Harness;
let dir: string;
afterEach(async () => { await h?.fm.close(); if (dir) rmrf(dir); });
function setup() {
  dir = tempDir();
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  h = makeForeman(path.join(dir, 'home'));
  return cwd;
}

describe('shared coding tools', () => {
  it('reads, finds and edits files, including literal replacement strings', async () => {
    const cwd = setup();
    const tools = new ToolExecutor(turnRequest(h, cwd));
    expect((await tools.call('1', 'Write', { file_path: 'src/a.txt', content: 'hello\nworld\n' })).isError).toBeUndefined();
    expect(toolText(await tools.call('2', 'Glob', { pattern: '**/*.txt' }))).toBe('src/a.txt');
    expect(toolText(await tools.call('3', 'Grep', { pattern: 'WORLD', case_insensitive: true }))).toContain('src/a.txt:2:world');
    expect(toolText(await tools.call('4', 'Read', { file_path: 'src/a.txt', offset: 2, limit: 1 }))).toBe('2\tworld');
    await tools.call('5', 'Edit', { file_path: 'src/a.txt', old_string: 'world', new_string: '$& literal' });
    expect(fs.readFileSync(path.join(cwd, 'src/a.txt'), 'utf8')).toBe('hello\n$& literal\n');
  });

  it('enforces role, outside-path, symlink, git push and abort restrictions', async () => {
    const cwd = setup();
    fs.writeFileSync(path.join(dir, 'private.txt'), 'secret');
    fs.symlinkSync(path.join(dir, 'private.txt'), path.join(cwd, 'link.txt'));
    const r = turnRequest(h, cwd);
    const tools = new ToolExecutor(r);
    expect((await tools.call('1', 'Write', { file_path: '../private.txt', content: 'changed' })).isError).toBe(true);
    expect((await tools.call('2', 'Read', { file_path: 'link.txt' })).isError).toBe(true);
    expect((await tools.call('3', 'Bash', { command: 'git push origin main' })).isError).toBe(true);
    const lead = new ToolExecutor(turnRequest(h, cwd, { role: 'lead' }));
    expect((await lead.call('4', 'Write', { file_path: 'new.txt', content: 'no' })).isError).toBe(true);
    r.abortController.abort();
    expect((await tools.call('5', 'Write', { file_path: 'new.txt', content: 'no' })).isError).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'new.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'private.txt'), 'utf8')).toBe('secret');
  });

  it('lets the lead inspect with Bash while policy prevents writes and tests', async () => {
    const cwd = setup();
    fs.writeFileSync(path.join(cwd, 'README.md'), 'read-only inspection\n');
    const tools = new ToolExecutor(turnRequest(h, cwd, { role: 'lead' }));
    const read = await tools.call('read', 'Bash', { command: 'cat README.md' });
    expect(read.isError).toBeUndefined();
    expect(toolText(read)).toContain('read-only inspection');
    expect((await tools.call('write', 'Bash', { command: 'echo changed > new.txt' })).isError).toBe(true);
    expect((await tools.call('test', 'Bash', { command: 'npm test' })).isError).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'new.txt'))).toBe(false);
  });

  it('kills an in-flight shell command when the turn is stopped', async () => {
    const cwd = setup();
    const r = turnRequest(h, cwd, { canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }) });
    const run = new ToolExecutor(r).call('1', 'Bash', { command: 'node -e "setTimeout(() => {}, 60000)"' + (process.platform === 'win32' ? '' : ' &') });
    setTimeout(() => r.abortController.abort(), 100);
    expect((await run).isError).toBe(true);
  });

  it('executes Bash quoting literally and does not source BASH_ENV', async () => {
    const cwd = setup();
    const startup = path.join(cwd, 'startup.sh');
    fs.writeFileSync(startup, 'touch startup-ran\n');
    const r = turnRequest(h, cwd);
    r.env.BASH_ENV = startup;
    const result = await new ToolExecutor(r).call('1', 'Bash', { command: "echo 'a & echo unexpected-second-command & rem '" });
    expect(result.isError).toBeUndefined();
    expect(toolText(result)).toContain('a & echo unexpected-second-command & rem');
    expect(fs.existsSync(path.join(cwd, 'startup-ran'))).toBe(false);
  });

  it('finds Git Bash on Windows and never falls back to cmd or WSL', () => {
    const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(bashExecutable({ Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd' }, 'win32', file => [git, bash].includes(file))).toBe(bash);
    expect(() => bashExecutable({ Path: 'C:\\Windows\\System32' }, 'win32', file => file.endsWith('bash.exe'))).toThrow('Git Bash is required');
  });

  it.each(['abort', 'timeout'])('settles on %s even when a reparented descendant retains stdout', async mode => {
    const cwd = setup();
    const r = turnRequest(h, cwd);
    fs.writeFileSync(path.join(cwd, 'detach.cjs'), `const fs = require('fs'); const p = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {detached: true, stdio: ['ignore', 'inherit', 'inherit']}); fs.writeFileSync('daemon-pid.txt', String(p.pid)); p.unref();`);
    const start = Date.now();
    const run = shellCommand('node detach.cjs; echo started', r, mode === 'timeout' ? 200 : 60_000);
    if (mode === 'abort') setTimeout(() => r.abortController.abort(), 200);
    try {
      expect((await run).isError).toBe(true);
      expect(Date.now() - start).toBeLessThan(process.platform === 'win32' ? 10_000 : 3000);
    } finally {
      const marker = path.join(cwd, 'daemon-pid.txt');
      if (fs.existsSync(marker)) { try { process.kill(Number(fs.readFileSync(marker, 'utf8')), 'SIGKILL'); } catch { /* already reaped */ } }
    }
  });
});

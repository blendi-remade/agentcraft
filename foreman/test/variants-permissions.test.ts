// Variant Studio picks answered in AgentCraft, the allow-all switch and the rules list, per-agent
// models and publishing a repo to its remote.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimBackend } from '../src/agents/sim/index.js';
import { ClaudeEngine } from '../src/agents/claude/engine.js';
import { publish, webUrl } from '../src/publish.js';
import type { ClientMessage, Outbound } from '../src/protocol.js';
import { git } from '../src/util/git.js';
import { studioDecision } from '../src/variants.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

let h: Harness;
let home: string;
let repoPath: string;
let studio: http.Server;
let port = 0;
const posted: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  home = tempDir();
  repoPath = await demoRepo();
  studio = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (u.searchParams.get('k') !== 'abc123') return res.writeHead(403).end();
    if (u.pathname === '/api/health') return res.writeHead(200).end('{"ok":true}');
    if (u.pathname === '/api/decision') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const d = JSON.parse(b);
        posted.push(d);
        // the real studio writes decision.json for the round
        fs.writeFileSync(path.join(repoPath, '.variant-studio', 'rounds', d.round, 'decision.json'), b);
        res.writeHead(200).end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => studio.listen(0, '127.0.0.1', () => r()));
  port = (studio.address() as { port: number }).port;
  h = makeForeman(home, ['--backend', 'sim', '--repo', repoPath, '--agent-models', 'kit=haiku']);
  await h.fm.start(new SimBackend(h.fm, h.cfg.sim));
});
afterAll(async () => {
  await h.fm.close();
  studio.close();
  rmrf(home);
  rmrf(path.dirname(repoPath));
});

type NoV<T> = T extends unknown ? Omit<T, 'v'> : never;
async function send(msg: NoV<ClientMessage>): Promise<Extract<Outbound, { type: 'ack' }>> {
  const replies: Outbound[] = [];
  await h.fm.handle({ v: 1, id: 'x', ...msg } as ClientMessage, (m) => replies.push(m));
  return replies.find((m) => m.type === 'ack') as Extract<Outbound, { type: 'ack' }>;
}

function round(id: string, variants: string[]) {
  const dir = path.join(repoPath, '.variant-studio', 'rounds', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'round.json'), JSON.stringify({ question: 'Which card?', variants: variants.map((v) => ({ id: v, label: `Card ${v}`, notes: 'n' })) }));
  for (const v of variants) fs.writeFileSync(path.join(dir, `${v}.html`), `<p>${v}</p>`);
  return dir;
}

describe('Variant Studio picks', () => {
  it('maps answers to the gallery actions', () => {
    const vs = [{ id: 'a', label: 'Big', notes: '', file: 'a.html' }, { id: 'b', label: '', notes: '', file: 'b.html' }];
    expect(studioDecision('001-x', vs, 'A · Big', undefined)).toMatchObject({ action: 'choose', selected: ['a'] });
    expect(studioDecision('001-x', vs, 'B', 'darker')).toMatchObject({ action: 'revise', selected: ['b'], note: 'darker' });
    expect(studioDecision('001-x', vs, 'None of these: new directions', 'more playful')).toMatchObject({ action: 'regenerate', note: 'more playful' });
  });

  it('an open round becomes a decision; the answer reaches the gallery', async () => {
    fs.mkdirSync(path.join(repoPath, '.variant-studio', 'state'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, '.variant-studio', 'state', 'server.json'), JSON.stringify({ port, key: 'abc123' }));
    round('001-card', ['a', 'b', 'c']);
    await h.fm.variants.scan();
    const d = h.fm.decisions.open().find((x) => x.tool === 'variant-studio')!;
    expect(d.question).toBe('Which card?');
    expect(d.options).toEqual(['A · Card a', 'B · Card b', 'C · Card c', 'None of these: new directions']);
    expect(d.context).toMatch(new RegExp(`Gallery: http://127.0.0.1:${port}/\\?k=abc123`));
    await h.fm.variants.scan(); // no duplicate
    expect(h.fm.decisions.open().filter((x) => x.tool === 'variant-studio')).toHaveLength(1);
    const ack = await send({ type: 'decision.answer', decisionId: d.id, option: 1 });
    expect(ack.ok).toBe(true);
    expect(posted.at(-1)).toMatchObject({ round: '001-card', action: 'choose', selected: ['b'] });
    expect(h.fm.decisions.get(d.id)?.status).toBe('answered');
  });

  it('deciding in the browser withdraws the decision', async () => {
    const dir = round('002-hero', ['a', 'b']);
    await h.fm.variants.scan();
    const d = h.fm.decisions.open().find((x) => x.tool === 'variant-studio')!;
    fs.writeFileSync(path.join(dir, 'decision.json'), '{}');
    await h.fm.variants.scan();
    expect(h.fm.decisions.get(d.id)?.status).toBe('cancelled');
  });
});

describe('permissions from the dashboard', () => {
  it('lists, revokes and clears rules; allow-all answers waiting prompts', async () => {
    h.fm.store.data.permissionRules = { kit: ['Bash:npm install'], '*': ['WebFetch:example.com'] };
    let r = await send({ type: 'permissions', action: 'list' });
    expect(r.result).toMatchObject({ mode: 'ask', rules: [{ agentId: 'kit', key: 'Bash:npm install' }, { agentId: '*', key: 'WebFetch:example.com' }] });
    r = await send({ type: 'permissions', action: 'revoke', agentId: 'kit', key: 'Bash:npm install' });
    expect((r.result as { rules: unknown[] }).rules).toHaveLength(1);
    const p = h.fm.createDecision({ agentId: 'wren', kind: 'permission', question: 'run x?', options: ['Allow once', 'Always allow for this agent', 'Deny', 'Always allow for every agent'], tool: 'Bash' });
    r = await send({ type: 'permissions', action: 'mode', mode: 'allow_all' });
    expect(r.result).toMatchObject({ mode: 'allow_all' });
    expect(h.fm.status.permissionMode).toBe('allow_all');
    await until(() => h.fm.decisions.get(p.id)?.status === 'answered');
    r = await send({ type: 'permissions', action: 'clear' });
    expect((r.result as { rules: unknown[] }).rules).toEqual([]);
    await send({ type: 'permissions', action: 'mode', mode: 'ask' });
  });
});

describe('per-agent models', () => {
  it('an agent model wins over the role model', () => {
    const e = new ClaudeEngine(h.fm, h.cfg.claude);
    expect(e.model('worker', 'kit')).toBe('haiku');
    expect(e.model('worker', 'wren')).toBe(h.cfg.claude.workerModel);
  });
});

describe('publish', () => {
  it('pushes the base branch, and opens a PR branch from the default branch', async () => {
    const remote = path.join(tempDir(), 'remote.git');
    await git(path.dirname(remote), ['init', '--bare', remote]);
    await git(repoPath, ['remote', 'add', 'origin', remote]);
    const branch = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    const res = await publish(repoPath, branch);
    expect(res).toMatchObject({ remote: 'origin', pushed: branch });
    expect((await git(remote, ['branch'])).stdout).toContain(branch);
    const pr = await publish(repoPath, branch, { pr: true, now: () => Date.UTC(2026, 9, 29, 12, 30) });
    expect(pr.pushed).toBe(branch === 'main' ? 'agentcraft/publish-202610291230' : branch);
    rmrf(path.dirname(remote));
  });

  it('web URLs from remotes', () => {
    expect(webUrl('git@github.com:me/app.git')).toBe('https://github.com/me/app');
    expect(webUrl('https://github.com/me/app.git')).toBe('https://github.com/me/app');
  });
});

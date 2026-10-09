import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TeamBackend } from '../src/agents/team.js';
import type { AgentRuntime, TurnRequest } from '../src/agents/runtime.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

let h: Harness;
const dirs: string[] = [];
afterEach(async () => { await h?.fm.close(); for (const dir of dirs.splice(0)) rmrf(dir); });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
async function boot(run: AgentRuntime['run']) {
  const home = tempDir();
  const repo = await demoRepo();
  dirs.push(home, path.dirname(repo));
  h = makeForeman(home, ['--backend', 'codex', '--repo', repo, '--workers', 'kit']);
  const runtime: AgentRuntime = { name: 'codex', label: 'Codex', checkAuth: async () => 'test', run };
  await h.fm.start(new TeamBackend(h.fm, h.cfg.codex, runtime));
}
const send = (text: string) => h.fm.handle({ v: 1, type: 'user.message', to: 'marlow', text }, () => {});

describe('live provider steering', () => {
  it('reserves messages during live delivery so team tools do not also consume them', async () => {
    const delivery = deferred<boolean>();
    const finished = deferred<void>();
    let request: TurnRequest | undefined;
    let prompt = '';
    await boot(async r => {
      request = r;
      r.onSession('session');
      r.onSteerReady?.(text => { prompt = text; return delivery.promise; });
      r.abortController.signal.addEventListener('abort', () => finished.resolve(), { once: true });
      await finished.promise;
      return { isError: false, errors: [] };
    });
    await h.fm.submitGoal('Investigate the project');
    await until(() => !!request);
    await send('Focus on the parser');
    await until(() => prompt.includes('Focus on the parser'));
    const list = await request!.tools.find(t => t.name === 'list_tasks')!.handler({});
    expect(JSON.stringify(list)).not.toContain('Focus on the parser');
    delivery.resolve(true);
    await until(() => h.fm.store.logTail('marlow').some(e => e.text.includes('delivered to the running agent')));
    expect(h.fm.bus.inbox('marlow')).toEqual([]);
    finished.resolve();
  });

  it('returns a rejected live message to the inbox and delivers it in a follow-up when the turn ends', async () => {
    const delivery = deferred<boolean>();
    const finished = deferred<void>();
    const calls: TurnRequest[] = [];
    await boot(async r => {
      calls.push(r);
      r.onSession('session');
      if (calls.length === 1) {
        r.onSteerReady?.(() => delivery.promise);
        r.abortController.signal.addEventListener('abort', () => finished.resolve(), { once: true });
        await finished.promise;
      }
      return { isError: false, errors: [] };
    });
    await h.fm.submitGoal('Investigate the project');
    await until(() => calls.length === 1);
    await send('Keep this instruction');
    finished.resolve(); // turn completion races with the RPC rejection
    delivery.resolve(false);
    await until(() => calls.length === 2);
    expect(calls[1]!.prompt).toContain('Keep this instruction');
    expect(h.fm.bus.inbox('marlow')).toEqual([]);
  });

  it('recovers messages reserved by a live delivery interrupted by a crash', async () => {
    await boot(async () => ({ isError: false, errors: [] }));
    const message = h.fm.bus.send('user', 'marlow', 'Do not lose this message');
    h.fm.bus.markRead('marlow', [message.id]);
    h.fm.store.data.backend.codex = { inflight: {}, ciFixes: {}, stopped: ['marlow'], steering: { marlow: [message.id] } };
    h.fm.store.markDirty();
    const home = h.home;
    await h.fm.close();
    h = makeForeman(home, ['--backend', 'codex']);
    await h.fm.start(new TeamBackend(h.fm, h.cfg.codex, { name: 'codex', label: 'Codex', checkAuth: async () => 'test', run: async () => ({ isError: false, errors: [] }) }));
    expect(h.fm.bus.inbox('marlow').map(m => m.text)).toEqual(['Do not lose this message']);
  });

  it('returns unconsumed steering to the inbox on pause and includes it once on resume', async () => {
    const delivery = deferred<boolean>();
    const finished = deferred<void>();
    const calls: TurnRequest[] = [];
    let queued = false;
    await boot(async r => {
      calls.push(r);
      r.onSession('session');
      if (calls.length === 1) {
        r.onSteerReady?.(() => { queued = true; return delivery.promise; });
        r.abortController.signal.addEventListener('abort', () => { delivery.resolve(false); finished.resolve(); }, { once: true });
        await finished.promise;
        return { isError: true, subtype: 'interrupted', errors: [] };
      }
      return { isError: false, errors: [] };
    });
    await h.fm.submitGoal('Investigate the project');
    await until(() => calls.length === 1);
    await send('Retain this steering message');
    await until(() => queued);
    await h.fm.agentAction('marlow', 'pause');
    await until(() => h.fm.bus.inbox('marlow').some(message => message.text === 'Retain this steering message'));
    await h.fm.agentAction('marlow', 'resume');
    await until(() => calls.length === 2);
    expect(calls[1]!.prompt.split('Retain this steering message')).toHaveLength(2);
    expect(h.fm.bus.inbox('marlow')).toEqual([]);
  });
});

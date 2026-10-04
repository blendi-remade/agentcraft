import { afterEach, expect, it, vi } from 'vitest';
import { Foreman, type Backend } from '../src/foreman.js';
import { silentLogger } from '../src/context.js';
import { parseClientMessage, type Outbound, type TeamRoles } from '../src/protocol.js';
import { tempDir, testConfig, rmrf } from './helpers.js';

const roles: TeamRoles = {
  lead: { provider: 'codex', model: 'astra', effort: 'medium' },
  worker: { provider: 'codex', model: 'sol', effort: 'high' },
  reviewer: { provider: 'claude', model: 'sonnet', effort: 'high' },
};
const homes: string[] = [];
const foremen: Foreman[] = [];
afterEach(async () => {
  await Promise.all(foremen.splice(0).map((fm) => fm.close()));
  homes.splice(0).forEach(rmrf);
});
function fixture() {
  const home = tempDir();
  homes.push(home);
  const catalog = vi.fn(async (provider: 'codex' | 'claude') => ({
    provider,
    installed: true,
    available: true,
    models: [],
  }));
  const fm = new Foreman({
    config: testConfig(home, ['--backend', 'codex']),
    logger: silentLogger,
    harnessCatalog: catalog,
  });
  foremen.push(fm);
  const configureTeam = vi.fn(async () => ({ roles, setupComplete: true }));
  const agentModels = vi.fn(async () => ({ models: [] }));
  const configureAgent = vi.fn(async () => ({ saved: true }));
  fm.backend = {
    name: 'codex',
    stop: async () => {},
    roleSelections: () => roles,
    configureTeam,
    agentModels,
    configureAgent,
  } as unknown as Backend;
  async function send(value: unknown) {
    const parsed = parseClientMessage(value);
    if (!parsed.ok) throw new Error(parsed.error);
    const replies: Outbound[] = [];
    await fm.handle(parsed.msg, (m) => replies.push(m));
    return replies.at(-1);
  }
  return { fm, catalog, configureTeam, agentModels, configureAgent, send };
}
it('returns detected harnesses, persisted setup state and agent override indicators', async () => {
  const h = fixture();
  h.fm.backend!.setupState = () => ({
    roles,
    setupComplete: true,
    hasAgentOverrides: true,
    agentOverrides: { kit: { provider: 'codex', models: { codex: { model: 'sol' } } } },
  });
  expect(await h.send({ v: 1, type: 'harness.detect', id: 'detect', refresh: true })).toMatchObject({
    type: 'ack',
    ok: true,
    result: {
      roles,
      setupComplete: true,
      canConfigure: true,
      hasAgentOverrides: true,
      agentOverrides: { kit: { provider: 'codex' } },
    },
  });
  expect(h.catalog).toHaveBeenCalledWith('codex', true);
  expect(h.catalog).toHaveBeenCalledWith('claude', true);
});
it('routes all team roles through a single atomic backend operation and preserves reset intent', async () => {
  const h = fixture();
  expect(await h.send({ v: 1, type: 'team.configure', id: 'save', roles, resetAgentOverrides: true })).toMatchObject({
    type: 'ack',
    ok: true,
    result: { setupComplete: true },
  });
  expect(h.configureTeam).toHaveBeenCalledExactlyOnceWith(roles, true);
});
it('returns a failed save as an error rather than claiming setup succeeded', async () => {
  const h = fixture();
  h.configureTeam.mockRejectedValue(new Error('Claude is unavailable'));
  expect(await h.send({ v: 1, type: 'team.configure', id: 'save', roles })).toMatchObject({ type: 'ack', ok: false });
  expect(h.fm.store.data.backend.execution).toBeUndefined();
});
it('passes explicit provider choices to agent preview and save', async () => {
  const h = fixture();
  await h.send({ v: 1, type: 'agent.models', id: 'preview', agentId: 'marlow', provider: 'claude' });
  expect(h.agentModels).toHaveBeenCalledWith('marlow', 'claude');
  await h.send({
    v: 1,
    type: 'agent.configure',
    id: 'save',
    agentId: 'marlow',
    provider: 'claude',
    model: 'sonnet',
    effort: 'high',
  });
  expect(h.configureAgent).toHaveBeenCalledWith('marlow', 'sonnet', 'high', 'claude');
});
it('rejects missing roles and unknown harness identifiers at the protocol boundary', () => {
  expect(parseClientMessage({ v: 1, type: 'team.configure', roles: { lead: roles.lead } }).ok).toBe(false);
  expect(
    parseClientMessage({ v: 1, type: 'team.configure', roles: { ...roles, worker: { provider: 'unknown' } } }).ok,
  ).toBe(false);
  expect(parseClientMessage({ v: 1, type: 'agent.models', agentId: 'marlow', provider: 'unknown' }).ok).toBe(false);
});

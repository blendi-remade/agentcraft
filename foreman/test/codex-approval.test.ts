import { describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../src/agents/codex/index.js';

// Exercise the actual JSON-RPC approval boundary with an owner decision stub.
const handler = (CodexAdapter.prototype as unknown as { handleServerRequest: (...args: unknown[]) => Promise<unknown> }).handleServerRequest;
const entry = { job: { agentId: 'juniper' } };
const where = { cwd: '/tmp/owned-worktree', role: 'worker' };
const turn = { signal: new AbortController().signal };

describe('Codex approval boundary', () => {
  it('classifies an outside execution cwd against the pinned job root', async () => {
    const permissionGranted = vi.fn(async (..._args: unknown[]) => false);
    const result = await handler.call({}, { method: 'item/commandExecution/requestApproval', params: { command: 'rm file', cwd: '/tmp/other-repo' } }, entry, {permissionGranted}, {}, where, turn);
    expect(result).toEqual({ decision: 'decline' });
    expect(permissionGranted.mock.calls[0]?.[0]).toBe('Bash');
    expect(permissionGranted.mock.calls[0]?.[1]).toEqual({ command: "cd '/tmp/other-repo' && rm file" });
  });
  it('requires owner approval for file changes despite an apparently safe grant root', async () => {
    const askUser = vi.fn(async (..._args: unknown[]) => 'Deny');
    const result = await handler.call({}, { method: 'item/fileChange/requestApproval', params: { grantRoot: where.cwd, changes: { '/tmp/outside.txt': 'write' } } }, entry, {askUser}, {}, where, turn);
    expect(result).toEqual({ decision: 'decline' });
    expect(askUser.mock.calls[0]?.[0]).toContain('/tmp/outside.txt');
  });
  it.each(['Allow once', 'Deny'])('returns only the owner-approved permission profile (%s)', async (answer) => {
    const requested = { network: { enabled: true }, fileSystem: { write: ['/tmp/outside'] } };
    const askUser = vi.fn(async (..._args: unknown[]) => answer);
    const result = await handler.call({}, { method: 'item/permissions/requestApproval', params: { permissions: requested } }, entry, {askUser}, {}, where, turn);
    expect(result).toEqual({ permissions: answer === 'Allow once' ? requested : {}, scope: 'turn' });
    expect(askUser.mock.calls[0]?.[0]).toContain('/tmp/outside');
  });
});

import { afterEach, expect, it } from 'vitest';
import { agentTools, buildTeamTools, type ToolHooks } from '../src/agents/tools.js';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

let h: Harness;
let dir: string;
afterEach(async () => { await h?.fm.close(); if (dir) rmrf(dir); });

const hooks: ToolHooks = {
  onReview() {}, onChangesRequested() {}, onTasksChanged() {}, onMergeRequested() {}, onWaiting() {},
};

function setup() {
  dir = tempDir();
  h = makeForeman(dir);
  return h.fm;
}

it('creates PR review tasks through the shared validated tool schema', async () => {
  const fm = setup();
  const create = agentTools(fm, 'marlow', 'lead', hooks).find(t => t.name === 'create_task')!;
  expect(create.inputSchema.start_branch).toBeDefined();
  const result = await create.handler({ title: 'PR #7: Feature', description: 'Review and retain contributor commits', assignee: 'kit', start_branch: 'agentcraft/pr-7' });
  expect(result.isError).toBeUndefined();
  expect(fm.tasks.list()).toMatchObject([{ startBranch: 'agentcraft/pr-7', assignee: 'kit' }]);
});

it('rejects arbitrary starting branches without creating a task', async () => {
  const fm = setup();
  const create = buildTeamTools(fm, 'marlow', 'lead', hooks).find(t => t.name === 'create_task')!;
  const result = await create.handler({ title: 'Review branch', description: 'Review', start_branch: 'main' });
  expect(result.isError).toBe(true);
  expect(fm.tasks.list()).toEqual([]);
});

it('keeps request cancellation when the engine calls the shared ask_user tool', async () => {
  const fm = setup();
  const turn = new AbortController();
  const request = new AbortController();
  const ask = agentTools(fm, 'kit', 'worker', hooks, { signal: turn.signal, reason: () => undefined }).find(t => t.name === 'ask_user')!;
  const answer = ask.handler({ question: 'Continue?' }, request.signal);
  expect(fm.decisions.open()).toHaveLength(1);
  request.abort();
  expect((await answer).isError).toBe(true);
  expect(fm.decisions.open()).toEqual([]);
  expect(turn.signal.aborted).toBe(false);
  expect(fm.agent('kit')?.state).not.toBe('waiting_user');
});

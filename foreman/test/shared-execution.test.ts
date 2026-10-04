// Deterministic transport doubles; Foreman, task graph, tools, decisions and scheduler are real.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedRunner } from '../src/agents/shared-runner.js';
import { ExecutionBackend } from '../src/agents/execution.js';
import { CodexAdapter } from '../src/agents/codex/index.js';
import { ClaudeAdapter } from '../src/agents/claude/index.js';
import { buildCodexTools } from '../src/agents/codex/tools.js';
import type { ExecutionAdapter, ExecutionConfig, ExecutionProvider, ExecutionRole, ExecutionState, Inflight, RoleSelection, TurnContext, TurnStats, Job } from '../src/agents/execution-types.js';
import type { Repo, Worktree } from '../src/protocol.js';
import { makeForeman, tempDir, rmrf, until, type Harness } from './helpers.js';

const catalog = {
  codex: [{model:'astra', label:'Astra', efforts:['medium','high'], defaultEffort:'medium'}, {model:'sol', label:'Sol', efforts:['high'], defaultEffort:'high'}],
  claude: [{model:'sonnet', label:'Sonnet', efforts:['default','high'], defaultEffort:'default'}],
};
const active: Harness[] = [];
const holds: Array<() => void> = [];
afterEach(async () => {
  holds.splice(0).forEach(release => release());
  for (const h of active.splice(0)) { await h.fm.close(); rmrf(h.home); }
  vi.restoreAllMocks();
});
function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  holds.push(release);
  return {wait, release};
}
function fixture(execution?: ExecutionConfig, script: (context: TurnContext) => Promise<void> = async () => {}, home = tempDir()) {
  const h = makeForeman(home, ['--backend','codex','--workers','kit']);
  active.push(h);
  h.cfg.codex.model = 'astra'; h.cfg.codex.effort = 'medium';
  h.cfg.claude.leadModel = 'sonnet'; h.cfg.claude.workerModel = 'sonnet';
  const repo: Repo = h.fm.repos.get('fixture') ?? {id:'fixture', name:'fixture', path:h.home, branch:'main', dirty:false, ci:'unknown', worktrees:[]};
  if (!h.fm.repos.get('fixture')) h.fm.store.data.repos.push(repo);
  vi.spyOn(h.fm.repos, 'refresh').mockResolvedValue(repo);
  vi.spyOn(h.fm.repos, 'sweepPendingRemovals').mockResolvedValue(0);
  vi.spyOn(h.fm.repos, 'createWorktree').mockImplementation(async (_repo, agentId, task) => {
    const wt: Worktree = {id:`${agentId}-${task.id}`, path:path.join(h.home, `${agentId}-${task.id}`), branch:`agentcraft/${agentId}/${task.id}`,
      base:'main', agentId, status:'active', ahead:1, files:1, additions:1, deletions:0};
    fs.mkdirSync(wt.path, {recursive:true});
    repo.worktrees.push(wt);
    return wt;
  });
  const ci = vi.spyOn(h.fm.repos, 'runTests').mockResolvedValue({pass:true, code:0, command:'fixture', output:'pass', durationMs:1, failures:[]});
  vi.spyOn(h.fm.repos, 'diff').mockResolvedValue({repoId:'fixture',worktree:'kit-t1',base:'main',branch:'fixture', files:[],stats:{files:1,additions:1,deletions:0},truncated:false});
  const merge = vi.spyOn(h.fm.repos, 'merge');
  const calls: TurnContext[] = [];
  const adapters = Object.fromEntries((['codex','claude'] as const).map(provider => [provider, {
    provider, checkAuth:async () => true,
    execute:async (context: TurnContext): Promise<TurnStats> => {
      calls.push(context);
      const sessionId = context.resume ?? `${provider}-${context.entry.job.sessionKey}`;
      context.recordSession(sessionId, context.selection.model);
      await script(context);
      return {sessionId, model:context.selection.model, isError:false, errors:[], numTurns:1, subtype:'success'};
    },
  }])) as Record<ExecutionProvider, ExecutionAdapter>;
  const capabilities = vi.fn(async (provider: ExecutionProvider) => ({available:true, models:catalog[provider]}));
  const backend = new SharedRunner(h.fm, {provider:'codex', config:h.cfg.codex, execution, capabilities, adapters});
  h.fm.backend = backend;
  return {h, backend, calls, adapters, ci, merge, capabilities};
}
async function tool(h: Harness, context: TurnContext, name: string, args: Record<string, unknown>) {
  const result = await buildCodexTools(h.fm, context.entry.job.agentId, context.policyRole, context.hooks, context.turn).call(name,args);
  expect(result.success, result.text).toBe(true);
  return result;
}

describe('one shared orchestration authority', () => {
  const team: Record<ExecutionRole,RoleSelection> = {lead:{provider:'codex',model:'astra',effort:'medium'},
    worker:{provider:'claude',model:'sonnet',effort:'high'},reviewer:{provider:'claude',model:'sonnet',effort:'default'}};

  it('keeps Codex work and chat running while a Claude reviewer waits, then resumes review after recovery', async () => {
    const roles = {lead:{provider:'codex' as const,model:'astra',effort:'medium'},worker:{provider:'codex' as const,model:'sol',effort:'high'},reviewer:{provider:'claude' as const,model:'sonnet',effort:'high'}};
    const f = fixture({roles}, async context => {
      if (context.entry.job.kind === 'plan') await tool(f.h,context,'create_task',{title:'Independent providers',description:'fixture',assignee:'kit'});
      if (context.entry.job.kind === 'work') {
        await tool(f.h,context,'update_task',{task_id:'t1',status:'review',summary:'done'});
        context.hooks.onReview('kit','t1');
      }
      if (context.entry.job.kind === 'review') await tool(f.h,context,'request_merge',{task_id:'t1',summary:'reviewed'});
    });
    f.capabilities.mockImplementation(async provider => ({available:provider === 'codex',models:catalog[provider]}));
    await f.h.fm.start(f.backend);
    expect(f.h.fm.status.auth).toBe('ok');
    expect(f.h.fm.status.message).toContain('Unavailable: claude');
    await f.h.fm.submitGoal('Independent providers','fixture');
    await until(() => f.h.fm.tasks.list().some(t => t.status === 'review') && f.ci.mock.calls.length === 1,2000);
    f.backend.onUserMessage('marlow','What is waiting?');
    await until(() => f.calls.some(c => c.entry.job.kind === 'followup'),1000);
    expect(f.calls.every(c => c.selection.provider === 'codex')).toBe(true);
    expect(f.h.fm.decisions.open().filter(d => d.kind === 'merge')).toHaveLength(0);
    f.capabilities.mockImplementation(async provider => ({available:true,models:catalog[provider]}));
    await f.backend.configureTeam(roles);
    await until(() => f.h.fm.decisions.open().some(d => d.kind === 'merge'),2000);
    expect(f.calls.filter(c => c.entry.job.kind === 'review')).toHaveLength(1);
    expect(f.calls.find(c => c.entry.job.kind === 'review')!.selection.provider).toBe('claude');
    expect(f.merge).not.toHaveBeenCalled();
  });

  it('does not let an unavailable off-team override block the active team', async () => {
    const f = fixture();
    await f.backend.configureAgent('tove','sonnet','high','claude');
    f.capabilities.mockImplementation(async provider => ({available:provider === 'codex',models:catalog[provider]}));
    await f.h.fm.start(f.backend);
    f.backend.onUserMessage('marlow','Hello');
    await until(() => f.calls.length === 1,1000);
    expect(f.h.fm.status.auth).toBe('ok');
    expect(f.calls[0]!.selection.provider).toBe('codex');
  });

  it('does not convert a transient catalog failure into a sign-in failure', async () => {
    const f = fixture();
    await f.h.fm.start(f.backend);
    f.capabilities.mockImplementation(async provider => ({available:false,models:catalog[provider],reason:'Could not query Codex. Check that its CLI starts correctly, then retry detection.'}));
    f.backend.onUserMessage('marlow','First attempt');
    await until(() => f.h.fm.agent('marlow')?.state === 'error',1000);
    expect(f.h.fm.status.auth).toBe('ok');
    f.capabilities.mockImplementation(async provider => ({available:true,models:catalog[provider]}));
    f.backend.onUserMessage('marlow','Try again');
    await until(() => f.calls.length === 1,1000);
  });

  it('does not classify a token-limit error as lost authentication', async () => {
    let turns = 0;
    const f = fixture(undefined,async () => {if (++turns === 1) throw new Error('Maximum token limit exceeded');});
    await f.h.fm.start(f.backend);
    f.backend.onUserMessage('marlow','First attempt');
    await until(() => f.calls.length === 1 && !(f.h.fm.store.data.backend.execution as ExecutionState).inflight.marlow,1000);
    f.backend.onUserMessage('marlow','A shorter question');
    await until(() => f.calls.length === 2,1000);
    expect(f.h.fm.status.auth).toBe('ok');
  });

  it.each(['done', 'failed', 'cancelled'] as const)('keeps chat separate from a %s goal', async status => {
    const f = fixture();
    f.h.fm.store.data.goals.push({id:'g1',text:'Previous work',status,progress:1,repoId:'fixture',createdAt:1,updatedAt:1});
    await f.h.fm.start(f.backend);
    f.backend.onUserMessage('marlow','Can we discuss the next idea?');
    await until(() => f.calls.length === 1,1000);
    const job = f.calls[0]!.entry.job;
    expect(job.goalId).toBeUndefined();
    expect(job.sessionKey).toBe('codex:marlow:conversation');
    expect(job.prompt).toContain('Do not create tasks for this conversation');
    expect(f.h.fm.goal('g1')!.status).toBe(status);
    expect(f.h.fm.tasks.list()).toHaveLength(0);
  });

  it('recovers queued chat and accepts goals after setup replaces an unavailable startup provider', async () => {
    const f = fixture();
    f.capabilities.mockImplementation(async provider => ({available:provider === 'claude',models:catalog[provider]}));
    await f.h.fm.start(f.backend);
    expect(f.h.fm.status.auth).toBe('failed');
    f.backend.onUserMessage('marlow', 'Hello after setup');
    expect(f.calls).toHaveLength(0);
    const claude = {provider:'claude' as const,model:'sonnet',effort:'high'};
    await f.backend.configureTeam({lead:claude,worker:claude,reviewer:claude});
    expect(f.h.fm.status.auth).toBe('ok');
    await until(() => f.calls.length === 1,1000);
    expect(f.calls[0]!.selection.provider).toBe('claude');
    await f.h.fm.submitGoal('Now start work', 'fixture');
    await until(() => f.calls.some(c => c.entry.job.kind === 'plan'),1000);
    expect(f.calls.every(c => c.selection.provider === 'claude')).toBe(true);
  });

  it('reports saved team roles after adapter probes and later model changes', async () => {
    const f = fixture({roles:team});
    f.adapters.claude.checkAuth = async () => {
      f.h.fm.setStatus({auth:'ok',message:'Claude (lead old, workers old)'});
      return true;
    };
    await f.h.fm.start(f.backend);
    expect(f.h.fm.status.message).toBe('Team roles · lead: codex / astra / medium · worker: claude / sonnet / high · reviewer: claude / sonnet / default');
    await f.backend.configureRole('worker',{provider:'codex',model:'sol',effort:'high'});
    expect(f.h.fm.status.message).toContain('worker: codex / sol / high');
    expect(f.h.fm.status.message).not.toContain('old');
  });

  it('validates the whole team before changing any saved role, override or setup status', async () => {
    const f = fixture();
    f.h.fm.store.data.backend.codex = {modelSettings:{marlow:{model:'sol',effort:'high'}}};
    f.backend.setupState();
    const saved = JSON.stringify(f.h.fm.store.data.backend);
    const dirty = vi.spyOn(f.h.fm.store,'markDirty');
    f.capabilities.mockImplementation(async provider => ({available:provider !== 'claude',models:catalog[provider]}));
    await expect(f.backend.configureTeam(team,true)).rejects.toThrow('unavailable');
    expect(JSON.stringify(f.h.fm.store.data.backend)).toBe(saved);
    expect(dirty).not.toHaveBeenCalled();
    f.capabilities.mockImplementation(async provider => ({available:true,models:catalog[provider]}));
    await expect(f.backend.configureTeam({...team,reviewer:{provider:'codex',model:'sol',effort:'medium'}},true)).rejects.toThrow('reasoning');
    expect(JSON.stringify(f.h.fm.store.data.backend)).toBe(saved);
    expect(dirty).not.toHaveBeenCalled();
    await expect(f.backend.configureTeam({lead:team.lead,worker:team.worker} as Record<ExecutionRole,RoleSelection>)).rejects.toThrow('reviewer');
    expect(JSON.stringify(f.h.fm.store.data.backend)).toBe(saved);
  });

  it('saves team roles and setup completion together while exposing preserved overrides', async () => {
    const f = fixture();
    f.h.fm.store.data.backend.codex = {modelSettings:{marlow:{model:'sol',effort:'high'}}};
    await f.backend.configureAgent('kit','sonnet','default','claude');
    const dirty = vi.spyOn(f.h.fm.store,'markDirty');
    const result = await f.backend.configureTeam(team);
    expect(dirty).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({roles:team,setupComplete:true,hasAgentOverrides:true,
      agentOverrides:{marlow:{models:{codex:{model:'sol',effort:'high'}}},kit:{provider:'claude',models:{claude:{model:'sonnet',effort:'default'}}}}});
    expect((await f.backend.agentModels('marlow')).next).toMatchObject({provider:'codex',model:'sol',effort:'high'});
    f.h.fm.store.flush();
    const persisted = JSON.parse(fs.readFileSync(f.h.fm.store.file,'utf8')) as {backend:{execution:ExecutionState}};
    expect(persisted.backend.execution).toMatchObject({roles:team,setupComplete:true});
    result.agentOverrides.marlow!.models.codex!.model = 'changed response';
    expect(f.backend.setupState().agentOverrides.marlow!.models.codex!.model).toBe('sol');
  });

  it('clears per-agent overrides only on an explicit team reset after successful validation', async () => {
    const f = fixture();
    f.h.fm.store.data.backend.codex = {modelSettings:{marlow:{model:'sol',effort:'high'}}};
    await f.backend.configureAgent('kit','sonnet','default','claude');
    const result = await f.backend.configureTeam(team,true);
    expect(result).toMatchObject({roles:team,setupComplete:true,hasAgentOverrides:false,agentOverrides:{}});
    expect((f.h.fm.store.data.backend.codex as {modelSettings?:unknown}).modelSettings).toBeUndefined();
    expect((await f.backend.agentModels('marlow')).next).toMatchObject({provider:'codex',model:'astra',effort:'medium'});
    expect((await f.backend.agentModels('kit')).next).toMatchObject({provider:'claude',model:'sonnet',effort:'high'});
  });

  it('previews another provider catalog without changing actual next or active settings', async () => {
    const hold = gate();
    const f = fixture(undefined,async () => {await hold.wait;});
    await f.h.fm.start(f.backend);
    f.backend.onUserMessage('marlow','Hello');
    await until(() => f.calls.length === 1,1000);
    const before = JSON.stringify(f.h.fm.store.data.backend);
    const preview = await f.backend.agentModels('marlow','claude');
    expect(preview).toMatchObject({provider:'codex',catalogProvider:'claude',models:catalog.claude,
      next:{provider:'codex',model:'astra',effort:'medium'},active:{provider:'codex',model:'astra',effort:'medium'}});
    expect(JSON.stringify(f.h.fm.store.data.backend)).toBe(before);
    hold.release();
  });

  it('Role defaults clears explicit provider and every agent override while preserving the active turn', async () => {
    const hold = gate();
    const f = fixture(undefined,async () => {await hold.wait;});
    await f.backend.configureAgent('kit','sol','high','codex');
    await f.backend.configureAgent('kit','sonnet','default','claude');
    await f.backend.configureAgent('marlow','sol','high','codex');
    const task = f.h.fm.tasks.create({title:'Reset routing',createdBy:'marlow',assignee:'kit',repoId:'fixture'});
    const wt = await f.h.fm.repos.createWorktree('fixture','kit',task);
    f.h.fm.tasks.update(task.id,{worktree:wt.id}); f.h.fm.tasks.setStatus(task.id,'doing',{force:true});
    f.h.fm.setAgent('kit',{active:true,taskId:task.id,repoId:'fixture',worktree:wt.id});
    f.backend.onUserMessage('kit','Continue');
    await until(() => f.calls.length === 1,1000);
    f.capabilities.mockImplementation(async provider => ({available:provider !== 'claude',models:catalog[provider]}));
    const reset = await f.backend.configureAgent('kit');
    expect(reset).toMatchObject({provider:'codex',selection:null,next:{provider:'codex',model:'astra',effort:'medium'},
      active:{provider:'claude',model:'sonnet',effort:'default'}});
    const state = f.h.fm.store.data.backend.execution as ExecutionState;
    expect(state.agentProviders?.kit).toBeUndefined(); expect(state.agentSettings?.kit).toBeUndefined();
    expect((f.h.fm.store.data.backend.codex as {modelSettings:Record<string,unknown>}).modelSettings.kit).toBeUndefined();
    expect(f.backend.setupState().agentOverrides.kit).toBeUndefined();
    expect(f.backend.setupState().agentOverrides.marlow).toBeDefined();
    expect(f.calls[0]!.turn.signal.aborted).toBe(false);
    f.h.fm.store.data.backend = JSON.parse(JSON.stringify(f.h.fm.store.data.backend));
    expect((await f.backend.agentModels('kit')).next).toMatchObject({provider:'codex',model:'astra',effort:'medium'});
    hold.release();
  });

  it.each([
    ['codex','codex','claude'], ['claude','codex','claude'], ['codex','claude','codex'], ['codex','codex','codex'], ['claude','claude','claude'],
  ] as const)('routes lead %s, worker %s and reviewer %s through one CI and owner decision', async (lead,worker,reviewer) => {
    const model = (provider: ExecutionProvider) => provider === 'codex' ? 'astra' : 'sonnet';
    const f = fixture({roles:{lead:{provider:lead,model:model(lead),effort:'high'}, worker:{provider:worker,model:model(worker),effort:'high'}, reviewer:{provider:reviewer,model:model(reviewer),effort:'high'}}}, async context => {
      if (context.entry.job.kind === 'plan') await tool(f.h,context,'create_task',{title:'Shared route',description:'fixture',assignee:'kit'});
      else if (context.entry.job.kind === 'work') {
        await tool(f.h,context,'update_task',{task_id:'t1',status:'review',summary:'done'});
        context.hooks.onReview('kit','t1'); context.hooks.onTasksChanged();
      } else if (context.entry.job.kind === 'review') {
        expect(context.policyRole).toBe('lead');
        await tool(f.h,context,'request_merge',{task_id:'t1',summary:'reviewed'});
        await tool(f.h,context,'request_merge',{task_id:'t1',summary:'duplicate verdict'});
      }
    });
    await f.h.fm.start(f.backend);
    await f.h.fm.submitGoal('Shared route', 'fixture');
    await until(() => f.h.fm.decisions.open().some(d => d.kind === 'merge'), 2000);
    expect(f.calls.map(c => [c.entry.job.kind,c.selection.provider,c.entry.job.role])).toEqual([
      ['plan',lead,'lead'],['work',worker,'worker'],['review',reviewer,'reviewer'],
    ]);
    expect(f.ci).toHaveBeenCalledTimes(1);
    expect(f.h.fm.decisions.open().filter(d => d.kind === 'merge')).toHaveLength(1);
    expect(f.merge).not.toHaveBeenCalled();
    expect(f.h.fm.store.logTail('marlow').some(log => log.text.includes('Provider changed'))).toBe(false);
    expect(f.h.fm.tasks.require('t1').status).toBe('review');
    expect(Object.keys(f.h.fm.store.data.sessions).every(key => /^(codex|claude):/.test(key))).toBe(true);
  });

  it('keeps saved per-agent overrides, separates providers and resumes each provider independently', async () => {
    const f = fixture();
    f.h.fm.store.data.backend.codex = {modelSettings:{marlow:{model:'astra',effort:'medium'},kit:{model:'sol',effort:'high'}}};
    await f.h.fm.start(f.backend);
    f.backend.onUserMessage('marlow','Hello');
    await until(() => f.calls.length === 1 && !(f.h.fm.store.data.backend.execution as ExecutionState).inflight.marlow, 1000);
    expect(f.calls[0]!.selection).toEqual({provider:'codex',model:'astra',effort:'medium'});
    await f.backend.configureAgent('marlow','sonnet','default','claude');
    f.backend.onUserMessage('marlow','Continue');
    await until(() => f.calls.length === 2 && !(f.h.fm.store.data.backend.execution as ExecutionState).inflight.marlow, 1000);
    expect(f.calls[1]!.resume).toBeUndefined();
    expect(f.h.fm.store.logTail('marlow').some(log => log.text.includes('Provider changed to claude'))).toBe(true);
    await f.backend.configureAgent('marlow',undefined,undefined,'codex');
    f.backend.onUserMessage('marlow','Back');
    await until(() => f.calls.length === 3,1000);
    expect(f.calls[2]!.resume).toBe(f.h.fm.store.data.sessions['codex:marlow:conversation']!.sessionId);
    expect(f.calls[2]!.selection).toEqual({provider:'codex',model:'astra',effort:'medium'});
    expect(f.h.fm.store.data.sessions['claude:marlow:conversation']!.sessionId).not.toBe(f.calls[2]!.resume);
    expect((await f.backend.agentModels('kit')).next).toEqual({provider:'codex',model:'sol',effort:'high'});
    expect(f.h.fm.goals()).toHaveLength(0); expect(f.h.fm.tasks.list()).toHaveLength(0);
  });

  it('freezes the active turn and applies role edits when an unstarted queued job executes', async () => {
    const hold = gate();
    const f = fixture(undefined, async context => {if(context.prompt === 'first') await hold.wait;});
    await f.h.fm.start(f.backend);
    const enqueue = (f.backend as unknown as {enqueue(job:Job):void}).enqueue.bind(f.backend);
    enqueue({kind:'followup',agentId:'marlow',sessionKey:'marlow:conversation',prompt:'first'});
    await until(() => f.calls.length === 1,1000);
    enqueue({kind:'followup',agentId:'marlow',sessionKey:'marlow:conversation',prompt:'second'});
    await f.backend.configureRole('lead',{provider:'claude',model:'sonnet',effort:'default'});
    expect((await f.backend.agentModels('marlow')).active).toMatchObject({provider:'codex',model:'astra',effort:'medium'});
    expect(f.calls).toHaveLength(1);
    hold.release();
    await until(() => f.calls.length === 2,1000);
    expect(f.calls[1]!.selection).toEqual({provider:'claude',model:'sonnet',effort:'default'});
    expect(f.calls[1]!.resume).toBeUndefined();
    const persisted = JSON.parse(JSON.stringify(f.h.fm.store.data.backend));
    f.h.fm.store.data.backend = persisted;
    expect(f.backend.roleSelections().lead).toEqual({provider:'claude',model:'sonnet',effort:'default'});
    expect(f.h.cfg.codex.model).toBe('astra');
  });

  it('rejects unavailable choices without fallback or changing saved settings', async () => {
    const f = fixture();
    await f.h.fm.start(f.backend);
    f.capabilities.mockImplementation(async provider => ({available:provider !== 'claude', models:catalog[provider]}));
    await expect(f.backend.configureRole('reviewer',{provider:'claude',model:'sonnet',effort:'high'})).rejects.toThrow('unavailable');
    await expect(f.backend.configureAgent('kit','missing','high','codex')).rejects.toThrow('available');
    expect(f.backend.roleSelections().reviewer.provider).toBe('codex');
    expect(f.calls).toHaveLength(0);
    (f.h.fm.store.data.backend.execution as ExecutionState).roles = {lead:{provider:'claude',model:'sonnet',effort:'high'}};
    f.backend.onUserMessage('marlow','Unavailable');
    await until(() => f.h.fm.agent('marlow')?.state === 'error',1000);
    expect(f.calls).toHaveLength(0);
    expect(f.h.fm.store.logTail('marlow').some(log => log.text.includes('unavailable'))).toBe(true);
  });

  it.each(['codex','claude'] as const)('withdraws one pending %s permission on stop; late approval cannot execute', async provider => {
    let allowed: boolean | undefined;
    const f = fixture({roles:{lead:{provider,model:provider === 'codex' ? 'astra' : 'sonnet',effort:'high'}}}, async context => {
      allowed = await context.permissionGranted('Bash',{command:'npm install left-pad'});
    });
    await f.h.fm.start(f.backend);
    // Worker policy is required for a risky executable command to reach owner approval.
    const task = f.h.fm.tasks.create({title:'Permission',createdBy:'marlow',assignee:'kit',repoId:'fixture'});
    const wt = await f.h.fm.repos.createWorktree('fixture','kit',task);
    f.h.fm.tasks.update(task.id,{worktree:wt.id}); f.h.fm.tasks.setStatus(task.id,'doing',{force:true});
    await f.backend.configureRole('worker',{provider,model:provider === 'codex' ? 'astra' : 'sonnet',effort:'high'});
    f.h.fm.setAgent('kit',{active:true,taskId:task.id,repoId:'fixture',worktree:wt.id});
    f.backend.onUserMessage('kit','Continue');
    await until(() => f.h.fm.decisions.open().some(d => d.kind === 'permission'),1000);
    const decision = f.h.fm.decisions.open().find(d => d.kind === 'permission')!;
    expect(f.h.fm.decisions.open()).toHaveLength(1);
    await f.backend.onAgentAction('kit','stop');
    await until(() => allowed !== undefined,1000);
    expect(allowed).toBe(false);
    expect(f.h.fm.decisions.get(decision.id)?.status).toBe('cancelled');
    await expect(f.h.fm.answerDecision(decision.id,'Allow once')).rejects.toThrow();
    expect(f.ci).not.toHaveBeenCalled(); expect(f.merge).not.toHaveBeenCalled();
  });

  it('resumes an interrupted worker on its saved provider despite subsequent role edits', async () => {
    const f = fixture(undefined, async context => {
      await new Promise<void>(resolve => context.turn.signal.addEventListener('abort', () => resolve(), {once:true}));
    });
    const task = f.h.fm.tasks.create({title:'Restart',createdBy:'marlow',assignee:'kit',repoId:'fixture'});
    const wt = await f.h.fm.repos.createWorktree('fixture','kit',task);
    f.h.fm.tasks.update(task.id,{worktree:wt.id}); f.h.fm.tasks.setStatus(task.id,'doing',{force:true});
    f.h.fm.setAgent('kit',{active:true,taskId:task.id,repoId:'fixture',worktree:wt.id});
    // Start directly after preparing the inflight fixture so startup reconciliation cannot claim it.
    f.backend.onUserMessage('kit','Continue');
    await until(() => f.calls.length === 1,1000);
    const savedId = f.h.fm.store.data.sessions['codex:kit:t1']!.sessionId;
    await f.backend.configureRole('worker',{provider:'claude',model:'sonnet',effort:'high'});
    await f.h.fm.close();
    const restarted = fixture(undefined, async context => {
      await tool(restarted.h,context,'update_task',{task_id:'t1',status:'blocked',blocked_reason:'fixture end'});
    },f.h.home);
    await restarted.h.fm.start(restarted.backend);
    await until(() => restarted.calls.length === 1,1000);
    expect(restarted.calls[0]!.selection).toEqual({provider:'codex',model:'astra',effort:'medium'});
    expect(restarted.calls[0]!.resume).toBe(savedId);
    expect(restarted.calls[0]!.entry.job.kind).toBe('followup');
    expect(restarted.backend.roleSelections().worker.provider).toBe('claude');
  });

  it('retains an unanswered question across restart and resumes the original review role after its answer', async () => {
    const f = fixture({roles:{reviewer:{provider:'claude',model:'sonnet',effort:'high'}}}, async context => {
      await Promise.race([context.askUser('Review detail?', ['Continue']),new Promise<void>(resolve => context.turn.signal.addEventListener('abort', () => resolve(), {once:true}))]);
    });
    await f.h.fm.start(f.backend);
    const task = f.h.fm.tasks.create({title:'Review restart',createdBy:'marlow',assignee:'kit',repoId:'fixture'});
    const wt = await f.h.fm.repos.createWorktree('fixture','kit',task);
    f.h.fm.tasks.update(task.id,{worktree:wt.id}); f.h.fm.tasks.setStatus(task.id,'review',{force:true});
    (f.backend as unknown as {enqueue(job:Job):void}).enqueue({kind:'review',agentId:'marlow',taskId:task.id,sessionKey:'marlow:adhoc',prompt:'Review'});
    await until(() => f.h.fm.decisions.open().some(d => d.kind === 'question'),1000);
    const decision = f.h.fm.decisions.open().find(d => d.kind === 'question')!;
    await f.h.fm.close();
    const restarted = fixture(undefined,async () => {},f.h.home);
    await restarted.h.fm.start(restarted.backend);
    expect(restarted.calls).toHaveLength(0);
    await restarted.h.fm.answerDecision(decision.id, 'Continue');
    await until(() => restarted.calls.length === 1,1000);
    expect(restarted.calls[0]!.entry.job.kind).toBe('review');
    expect(restarted.calls[0]!.entry.job.role).toBe('reviewer');
    expect(restarted.calls[0]!.selection.provider).toBe('claude');
    expect(restarted.calls[0]!.resume).toBe(f.calls[0]!.resume ?? f.h.fm.store.data.sessions['claude:marlow:adhoc']!.sessionId);
    expect(restarted.ci).not.toHaveBeenCalled();
  });

  it('cancels a pending reviewer and prevents a late verdict from opening a merge', async () => {
    let allowed: boolean | undefined;
    const f = fixture({roles:{reviewer:{provider:'claude',model:'sonnet',effort:'high'}}}, async context => {
      allowed = (await context.askUser('Finish review?', ['Continue'])) === 'Continue';
    });
    await f.h.fm.start(f.backend);
    const task = f.h.fm.tasks.create({title:'Cancel review',createdBy:'marlow',assignee:'kit',repoId:'fixture'});
    const wt = await f.h.fm.repos.createWorktree('fixture','kit',task);
    f.h.fm.tasks.update(task.id,{worktree:wt.id}); f.h.fm.tasks.setStatus(task.id,'review',{force:true});
    (f.backend as unknown as {enqueue(job:Job):void}).enqueue({kind:'review',agentId:'marlow',taskId:task.id,sessionKey:'marlow:adhoc',prompt:'Review'});
    await until(() => f.h.fm.decisions.open().some(d => d.kind === 'question'),1000);
    f.h.fm.tasks.setStatus(task.id,'cancelled',{force:true});
    f.backend.onTaskAction(f.h.fm.tasks.require(task.id),'cancel');
    await until(() => allowed !== undefined,1000);
    expect(allowed).toBe(false);
    expect(f.calls[0]!.turn.signal.aborted).toBe(true);
    expect(f.h.fm.decisions.open()).toHaveLength(0);
    expect(f.ci).not.toHaveBeenCalled(); expect(f.merge).not.toHaveBeenCalled();
  });

  it('does not schedule review after a task is cancelled during CI', async () => {
    const wait = gate();
    const f = fixture();
    f.ci.mockImplementation(async () => {await wait.wait; return {pass:true,code:0,command:'fixture',output:'pass',durationMs:1,failures:[]};});
    await f.h.fm.start(f.backend);
    const task = f.h.fm.tasks.create({title:'Cancel CI',createdBy:'marlow',assignee:'kit',repoId:'fixture'});
    const wt = await f.h.fm.repos.createWorktree('fixture','kit',task);
    f.h.fm.tasks.update(task.id,{worktree:wt.id}); f.h.fm.tasks.setStatus(task.id,'review',{force:true});
    const pipeline = f.backend as unknown as {afterWorkerDone(taskId:string):Promise<void>};
    const pending = pipeline.afterWorkerDone(task.id);
    await pipeline.afterWorkerDone(task.id);
    await until(() => f.ci.mock.calls.length === 1,1000);
    f.h.fm.tasks.setStatus(task.id,'cancelled',{force:true});
    f.backend.onTaskAction(f.h.fm.tasks.require(task.id),'cancel');
    wait.release();
    await pending;
    expect(f.h.fm.tasks.require(task.id).ci).toBe('pass');
    expect(f.calls).toHaveLength(0); expect(f.ci).toHaveBeenCalledTimes(1);
    expect(f.h.fm.decisions.open()).toHaveLength(0);
  });

  it('migrates known legacy sessions to their original provider when the default harness changes', async () => {
    const f = fixture();
    f.h.fm.store.data.backend.claude = {inflight:{},ciFixes:{},stopped:[]};
    f.h.fm.store.data.sessions['marlow:conversation'] = {sessionId:'legacy-claude',model:'sonnet',turns:1,costUsd:0,updatedAt:1};
    await f.h.fm.start(f.backend);
    f.backend.onUserMessage('marlow','New harness');
    await until(() => f.calls.length === 1,1000);
    expect(f.calls[0]!.selection.provider).toBe('codex'); expect(f.calls[0]!.resume).toBeUndefined();
    expect(f.h.fm.store.data.sessions['claude:marlow:conversation']!.sessionId).toBe('legacy-claude');
    expect(f.h.fm.store.data.sessions['marlow:conversation']).toBeUndefined();
  });

  const legacyRecoveryCases = (['codex','claude'] as const).flatMap(origin =>
    (['followup','work','review'] as const).flatMap(kind => [false,true].flatMap(changedDefault =>
      [false,true].map(frozenSelection => ({origin,kind,changedDefault,frozenSelection})))));
  it.each(legacyRecoveryCases)('resumes legacy $origin $kind inflight exactly once (changed default: $changedDefault, frozen selection: $frozenSelection)', async ({origin,kind,changedDefault,frozenSelection}) => {
    const hold = gate();
    const other = origin === 'codex' ? 'claude' : 'codex';
    const current = changedDefault ? other : origin;
    const choice = {provider:current,model:current === 'codex' ? 'astra' : 'sonnet',effort:'high'};
    const execution = {roles:{lead:choice,worker:choice,reviewer:choice}};
    const f = fixture(execution, async context => {
      if (context.resume === 'original-session') await hold.wait;
      if (context.entry.job.kind === 'work') await tool(f.h,context,'update_task',{task_id:context.entry.job.taskId!,status:'review',summary:'resumed work complete'});
    });
    f.h.cfg.backend = current;
    f.h.cfg.claude.effort = 'high'; f.h.cfg.claude.leadEffort = 'high';
    const agentId = kind === 'work' ? 'kit' : 'marlow';
    let taskId: string | undefined;
    let goalId: string | undefined;
    if (kind !== 'followup') {
      const goal = f.h.fm.createGoal('Interrupted legacy job','fixture');
      f.h.fm.setGoal(goal.id,{status:'active'}); goalId = goal.id;
      const task = f.h.fm.tasks.create({title:'Legacy recovery',createdBy:'marlow',assignee:'kit',repoId:'fixture',goalId});
      const wt = await f.h.fm.repos.createWorktree('fixture','kit',task);
      f.h.fm.tasks.update(task.id,{worktree:wt.id});
      f.h.fm.tasks.setStatus(task.id,kind === 'work' ? 'doing' : 'review',{force:true});
      taskId = task.id;
    }
    const sessionKey = kind === 'followup' ? 'marlow:conversation' : kind === 'work' ? `kit:${taskId}` : `marlow:${goalId}`;
    const original: RoleSelection = frozenSelection
      ? {provider:origin,model:origin === 'codex' ? 'sol' : 'sonnet',effort:origin === 'codex' ? 'high' : 'default'}
      : {provider:origin,model:origin === 'codex' ? 'sol' : 'sonnet',effort:'high'};
    const inf: Inflight = {kind,sessionKey,startedAt:1,...(taskId ? {taskId} : {}),...(goalId ? {goalId} : {}),...(frozenSelection ? {selection:original} : {})};
    f.h.fm.store.data.backend[origin] = {inflight:{[agentId]:inf},ciFixes:{},stopped:[],
      ...(!frozenSelection && origin === 'codex' ? {modelSettings:{[agentId]:{model:'sol',effort:'high'}}} : {})};
    f.h.fm.store.data.sessions[sessionKey] = {sessionId:'original-session',model:original.model,turns:3,costUsd:0,updatedAt:1};
    f.h.fm.store.data.sessions[`${other}:${sessionKey}`] = {sessionId:'foreign-session',turns:8,costUsd:0,updatedAt:1};
    vi.spyOn(CodexAdapter.prototype,'checkAuth').mockResolvedValue(true);
    vi.spyOn(ClaudeAdapter.prototype,'checkAuth').mockResolvedValue(true);
    vi.spyOn(CodexAdapter.prototype,'execute').mockImplementation(f.adapters.codex.execute);
    vi.spyOn(ClaudeAdapter.prototype,'execute').mockImplementation(f.adapters.claude.execute);
    // Exercise the production constructor: it removes legacy session aliases.
    const backend = new ExecutionBackend(f.h.fm,{execution,capabilities:f.capabilities});
    await f.h.fm.start(backend);
    await until(() => f.calls.some(context => context.resume === 'original-session'),1000);
    const resumed = f.calls.find(context => context.resume === 'original-session')!;
    expect(resumed.entry.job).toMatchObject({kind,...(taskId ? {taskId} : {}),...(goalId ? {goalId} : {}),resumed:true,
      sessionKey:`${origin}:${sessionKey}`,role:kind === 'review' ? 'reviewer' : kind === 'work' ? 'worker' : 'lead',selection:{provider:origin}});
    expect(resumed.selection).toEqual(original);
    expect(f.h.fm.store.data.sessions[sessionKey]).toBeUndefined();
    expect((f.h.fm.store.data.backend.execution as ExecutionState).inflight[agentId]?.sessionKey).toBe(`${origin}:${sessionKey}`);
    hold.release();
    if (kind === 'followup') {
      await until(() => !(f.h.fm.store.data.backend.execution as ExecutionState).inflight[agentId],1000);
      expect(f.h.fm.goals()).toHaveLength(0); expect(f.h.fm.tasks.list()).toHaveLength(0);
    } else await until(() => f.h.fm.decisions.open().some(decision => decision.kind === 'merge'),1000);
    expect(f.calls.filter(context => context.resume === 'original-session')).toHaveLength(1);
    expect(f.calls.filter(context => context.entry.job.kind === kind)).toHaveLength(1);
    expect(f.calls.some(context => context.entry.job.kind === 'plan' || context.resume === 'foreign-session')).toBe(false);
    expect(f.h.fm.store.data.sessions[`${origin}:${sessionKey}`]!.turns).toBe(4);
    expect(f.h.fm.store.data.sessions[`${other}:${sessionKey}`]!.sessionId).toBe('foreign-session');
    expect(f.ci).toHaveBeenCalledTimes(kind === 'work' ? 1 : 0);
    expect(f.h.fm.repos.createWorktree).toHaveBeenCalledTimes(kind === 'followup' ? 0 : 1);
    expect(f.merge).not.toHaveBeenCalled();
  });

  it.each(['codex','claude'] as const)('rejects foreign ownership in legacy %s inflight without rewriting it', async origin => {
    const f = fixture();
    const other = origin === 'codex' ? 'claude' : 'codex';
    const sessionKey = `${other}:marlow:conversation`;
    f.h.fm.store.data.backend[origin] = {inflight:{marlow:{kind:'followup',sessionKey,startedAt:1}},ciFixes:{},stopped:[]};
    f.h.fm.store.data.sessions[sessionKey] = {sessionId:'foreign-session',turns:1,costUsd:0,updatedAt:1};
    const saved = JSON.stringify(f.h.fm.store.data.backend);
    const backend = new ExecutionBackend(f.h.fm,{capabilities:f.capabilities});
    await expect(f.h.fm.start(backend)).rejects.toThrow('foreign provider');
    expect(JSON.stringify(f.h.fm.store.data.backend)).toBe(saved);
    expect(f.h.fm.store.data.sessions[sessionKey]!.sessionId).toBe('foreign-session');
    expect(f.calls).toHaveLength(0); expect(f.ci).not.toHaveBeenCalled();
  });

  it('rejects ambiguous legacy scheduler ownership rather than guessing a session provider', async () => {
    const f = fixture();
    f.h.fm.store.data.backend.codex = {inflight:{},ciFixes:{},stopped:[]};
    f.h.fm.store.data.backend.claude = {inflight:{},ciFixes:{},stopped:[]};
    await expect(f.backend.start()).rejects.toThrow('ambiguous');
    expect(f.calls).toHaveLength(0);
  });

  it('preserves role model settings when switching providers and rejects unsupported effort without mutation', async () => {
    const f = fixture();
    await f.backend.configureRole('reviewer',{provider:'codex',model:'sol',effort:'high'});
    await f.backend.configureRole('reviewer',{provider:'claude',model:'sonnet',effort:'default'});
    await f.backend.configureRole('reviewer',{provider:'codex'});
    expect(f.backend.roleSelections().reviewer).toEqual({provider:'codex',model:'sol',effort:'high'});
    await expect(f.backend.configureRole('reviewer',{provider:'codex',model:'sol',effort:'medium'})).rejects.toThrow();
    expect(f.backend.roleSelections().reviewer).toEqual({provider:'codex',model:'sol',effort:'high'});
  });

  it('enforces one worker concurrency limit across providers and does not duplicate awaited dispatch', async () => {
    const work = gate();
    const checkout = gate();
    const f = fixture(undefined, async context => {
      if (context.entry.job.kind === 'plan') {
        await tool(f.h,context,'create_task',{title:'First',description:'fixture',assignee:'kit'});
        await tool(f.h,context,'create_task',{title:'Second',description:'fixture',assignee:'juniper'});
      } else if (context.policyRole === 'worker') {
        if (context.entry.job.agentId === 'kit') await work.wait;
        await tool(f.h,context,'update_task',{task_id:context.entry.job.taskId!,status:'review',summary:'done'});
      }
    });
    f.h.cfg.codex.workers.push('juniper'); f.h.cfg.codex.maxConcurrent = 1; f.h.cfg.codex.leadReview = false;
    await f.backend.configureAgent('juniper','sonnet','high','claude');
    const create = vi.mocked(f.h.fm.repos.createWorktree);
    const implementation = create.getMockImplementation()!;
    create.mockImplementation(async (...args) => {if(args[1] === 'kit') await checkout.wait; return implementation(...args);});
    await f.h.fm.start(f.backend);
    await f.h.fm.submitGoal('Two workers','fixture');
    await until(() => create.mock.calls.length === 1,1000);
    // These events arrive while the first checkout creation is still awaited.
    f.backend.tick();
    await new Promise(resolve => setTimeout(resolve,80));
    expect(create).toHaveBeenCalledTimes(1);
    checkout.release();
    await until(() => f.calls.some(context => context.entry.job.agentId === 'kit'),1000);
    expect(f.calls.filter(context => context.policyRole === 'worker')).toHaveLength(1);
    work.release();
    await until(() => f.h.fm.decisions.open().filter(d => d.kind === 'merge').length === 2,1000);
    expect(f.calls.filter(context => context.policyRole === 'worker').map(context => context.selection.provider)).toEqual(['codex','claude']);
    expect(create).toHaveBeenCalledTimes(2); expect(f.ci).toHaveBeenCalledTimes(2);
    expect(f.merge).not.toHaveBeenCalled();
  });
});

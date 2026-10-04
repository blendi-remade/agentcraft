import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../src/agents/claude/index.js';
import { CodexAdapter, CodexBackend } from '../src/agents/codex/index.js';
import { CodexAppServer } from '../src/agents/codex/app-server.js';
import type { ProviderCapabilities, TurnContext } from '../src/agents/execution-types.js';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {if(h) {await h.fm.close(); rmrf(h.home); h=undefined;} vi.restoreAllMocks(); vi.unstubAllEnvs();});
function context(provider: 'codex'|'claude', capabilities?: ProviderCapabilities): TurnContext {
  h = makeForeman(tempDir(), ['--backend',provider]);
  const abort = new AbortController();
  const entry = {abort,job:{kind:'followup' as const,agentId:'marlow',prompt:'Hello',sessionKey:`${provider}:marlow:conversation`}};
  return {entry,turn:{signal:abort.signal,reason:()=>undefined},cwd:h.home,policyRole:'lead',selection:{provider,model:provider === 'claude' ? 'sonnet' : 'astra',effort:'default'},capabilities,
    systemAppend:'Read only.',prompt:'Hello',hooks:{onReview:vi.fn(),onChangesRequested:vi.fn(),onTasksChanged:vi.fn(),onMergeRequested:vi.fn(),onWaiting:vi.fn()},
    recordSession:vi.fn(),permissionGranted:vi.fn(async()=>false),askUser:vi.fn(async()=>undefined),markAuthFailed:vi.fn()};
}
describe('runtime follows discovered capabilities', () => {
  it('rejects a foreign-provider catalog preview in a single-harness facade', async () => {
    context('codex');
    const backend = new CodexBackend(h!.fm,h!.cfg.codex,{skipAuthCheck:true});
    await expect(backend.agentModels('marlow','claude')).rejects.toThrow('unavailable');
  });
  it.each(['login','api'] as const)('uses the discovered Claude executable and configured auth (%s) and omits the default effort sentinel', async auth => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN','fixture-token');
    const c = context('claude',{available:true,models:[],binaryPath:'/fixture/standalone/claude',auth});
    h!.cfg.claude.useClaudeLogin = auth === 'login';
    c.capabilities!.auth = auth === 'login' ? 'api' : 'login'; // Discovery cannot override host consent.
    const calls: Options[] = [];
    const queryFn = vi.fn(({options}: {options:Options}) => {
      calls.push(options);
      async function* messages() {
        yield {type:'system',subtype:'init',session_id:'claude-fixture',model:'sonnet'} as SDKMessage;
        yield {type:'result',subtype:'success',is_error:false,result:'ok',session_id:'claude-fixture',num_turns:1,total_cost_usd:0} as SDKMessage;
      }
      return Object.assign(messages(), {close:vi.fn()});
    });
    const adapter = new ClaudeAdapter(h!.fm,h!.cfg.claude,{queryFn:queryFn as never,skipAuthCheck:true});
    await adapter.execute(c);
    expect(calls[0]!.pathToClaudeCodeExecutable).toBe('/fixture/standalone/claude');
    expect(calls[0]!.effort).toBeUndefined();
    expect(calls[0]!.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(auth === 'login' ? 'fixture-token' : undefined);
    expect(calls[0]!.tools).toEqual(['Read','Grep','Glob']);
    expect(c.recordSession).toHaveBeenCalledWith('claude-fixture','sonnet');
  });

  it('passes the discovered Claude executable and login mode through its auth probe', async () => {
    const c = context('claude',{available:true,models:[],binaryPath:'/fixture/standalone/claude',auth:'login'});
    h!.cfg.claude.useClaudeLogin = true;
    const close = vi.fn();
    const queryFn = vi.fn(() => ({accountInfo:async()=>({tokenSource:'login'}),close}));
    const adapter = new ClaudeAdapter(h!.fm,h!.cfg.claude,{queryFn:queryFn as never});
    await expect(adapter.checkAuth(c.capabilities)).resolves.toBe(true);
    expect(queryFn.mock.calls[0]).toBeDefined();
    expect((queryFn.mock.calls[0] as unknown as [{options:Options}])[0].options.pathToClaudeCodeExecutable).toBe('/fixture/standalone/claude');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('uses the discovered Codex executable for its actual app-server turn and keeps lead policy', async () => {
    const c = context('codex',{available:true,models:[],binaryPath:'/fixture/standalone/codex',auth:'login'});
    c.selection.effort = 'high';
    h!.cfg.codex.binaryPath = '/wrong/legacy/codex';
    const constructed: Array<Record<string,unknown>> = [];
    let serverOptions: {onNotification(method:string,params:Record<string,unknown>):void};
    vi.spyOn(CodexAppServer.prototype,'start').mockImplementation(async function (this: CodexAppServer) {
      const opts = (this as unknown as {options:Record<string,unknown>}).options;
      constructed.push(opts);
      serverOptions = opts as unknown as typeof serverOptions;
    });
    vi.spyOn(CodexAppServer.prototype,'request').mockImplementation(async (method, params) => {
      if (method === 'thread/start') return {thread:{id:'codex-fixture',model:'astra'}};
      if (method === 'turn/start') {
        expect(params).toMatchObject({sandboxPolicy:{type:'readOnly',networkAccess:false},model:'astra',effort:'high'});
        queueMicrotask(() => serverOptions.onNotification('turn/completed',{threadId:'codex-fixture',turn:{id:'turn',status:'completed'}}));
        return {turn:{id:'turn'}};
      }
      return {};
    });
    vi.spyOn(CodexAppServer.prototype,'unsubscribe').mockResolvedValue(undefined);
    vi.spyOn(CodexAppServer.prototype,'close').mockResolvedValue(undefined);
    const adapter = new CodexAdapter(h!.fm,h!.cfg.codex,{skipAuthCheck:true});
    await adapter.execute(c);
    expect(constructed[0]!.binaryPath).toBe('/fixture/standalone/codex');
    expect(c.recordSession).toHaveBeenCalledWith('codex-fixture','astra');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Foreman } from '../src/foreman.js';
import { CodexStreamMapper } from '../src/agents/codex/stream.js';
import { tailLines } from '../src/util/text.js';

function fixture() {
  const agentLog = vi.fn();
  const mapper = new CodexStreamMapper({ agentLog, setAgent: vi.fn() } as unknown as Foreman, 'kit', '/project', 'worker');
  const retained = () => (mapper as unknown as { commandOutput: Map<string, string> }).commandOutput;
  return { mapper, agentLog, retained };
}

describe('Codex streamed command output', () => {
  it('bounds retained output from a noisy command while delivering every live delta', () => {
    const { mapper, agentLog, retained } = fixture();
    const chunk = 'build output line\n'.repeat(4096);
    for (let i = 0; i < 256; i++) mapper.handle('item/commandExecution/outputDelta', { itemId: 'build', delta: chunk });
    expect(retained().get('build')!.length).toBeLessThanOrEqual(16_384);
    expect(agentLog).toHaveBeenCalledTimes(256);
    mapper.handle('item/commandExecution/outputDelta', { itemId: 'build', delta: 'fatal: compilation failed\n' });
    mapper.handle('item/completed', { item: { id: 'build', type: 'commandExecution', exitCode: 1 } });
    expect(agentLog.mock.lastCall?.[2]).toBe(tailLines(chunk + 'fatal: compilation failed\n', 8, 900));
    expect(retained().size).toBe(0);
  });

  it('keeps independent command tails across fragmented Unicode and CRLF output', () => {
    const { mapper, agentLog } = fixture();
    mapper.handle('item/commandExecution/outputDelta', { itemId: 'a', delta: 'first\r' });
    mapper.handle('command/exec/outputDelta', { itemId: 'b', delta: 'other command\n' });
    mapper.handle('item/commandExecution/outputDelta', { itemId: 'a', delta: '\nlast 🚀\n' });
    mapper.handle('item/completed', { item: { id: 'a', type: 'commandExecution', exitCode: 0 } });
    expect(agentLog.mock.lastCall?.[2]).toBe('first\nlast 🚀');
    mapper.handle('item/completed', { item: { id: 'b', type: 'commandExecution', exitCode: 0 } });
    expect(agentLog.mock.lastCall?.[2]).toBe('other command');
  });

  it('uses authoritative aggregate output and releases orphaned buffers at turn completion', () => {
    const { mapper, agentLog, retained } = fixture();
    mapper.handle('item/commandExecution/outputDelta', { itemId: 'a', delta: 'partial' });
    mapper.handle('item/completed', { item: { id: 'a', type: 'commandExecution', aggregatedOutput: 'final output', exitCode: 0 } });
    expect(agentLog.mock.lastCall?.[2]).toBe('final output');
    mapper.handle('item/commandExecution/outputDelta', { itemId: 'orphan', delta: 'unfinished output' });
    mapper.handle('turn/completed', { turn: { status: 'interrupted' } });
    expect(retained().size).toBe(0);
  });
});

describe('Codex agent message logs', () => {
  it('renders a completed message as one readable entry rather than one row per token', () => {
    const {mapper,agentLog}=fixture();
    for(const delta of ['The ', 'change ', 'is ', 'ready', '.']) mapper.handle('item/agentMessage/delta',{itemId:'reply',delta});
    mapper.handle('item/completed',{item:{id:'reply',type:'agentMessage',text:'The change is ready.'}});
    expect(agentLog.mock.calls.filter(call=>call[1]==='text').map(call=>call[2])).toEqual(['The change is ready.']);
    expect(mapper.stats.resultText).toBe('The change is ready.');
  });
  it('keeps an interrupted partial response readable and does not duplicate completed messages', () => {
    const {mapper,agentLog}=fixture();
    mapper.handle('item/agentMessage/delta',{itemId:'a',delta:'First response.'});
    mapper.handle('item/completed',{item:{id:'a',type:'agentMessage',text:'First response.'}});
    mapper.handle('item/agentMessage/delta',{itemId:'b',delta:'Still '});
    mapper.handle('item/agentMessage/delta',{itemId:'b',delta:'checking'});
    mapper.handle('turn/completed',{turn:{status:'interrupted'}});
    expect(agentLog.mock.calls.filter(call=>call[1]==='text').map(call=>call[2])).toEqual(['First response.','Still checking']);
  });
});

it('bounds pending response count and text while retaining final authoritative content',()=>{
  const {mapper,agentLog}=fixture();
  for(let i=0;i<100;i++)mapper.handle('item/agentMessage/delta',{itemId:String(i),delta:'x'.repeat(50_000)});
  const pending=(mapper as unknown as {agentMessages:Map<string,string>}).agentMessages;
  expect(pending.size).toBeLessThanOrEqual(16);
  expect([...pending.values()].every(value=>value.length<=1201)).toBe(true);
  mapper.handle('item/completed',{item:{id:'99',type:'agentMessage',text:'Authoritative final response.'}});
  expect(agentLog.mock.lastCall?.[2]).toBe('Authoritative final response.');
  mapper.handle('turn/completed',{turn:{status:'completed'}});
  expect(pending.size).toBe(0);
});


it('preserves a completed response beyond the interrupted-stream prefix limit', () => {
  const {mapper,agentLog}=fixture();
  const response = 'Plan details. '.repeat(120) + 'Final verdict: changes requested.';
  mapper.handle('item/agentMessage/delta',{itemId:'long',delta:response});
  mapper.handle('item/completed',{item:{id:'long',type:'agentMessage',text:response}});
  expect(response.length).toBeGreaterThan(1200);
  expect(response.length).toBeLessThan(2000);
  expect(agentLog.mock.lastCall?.[2]).toBe(response);
});

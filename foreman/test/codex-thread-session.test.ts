import { expect, it, vi } from 'vitest';
import { resumeThread } from '../src/agents/codex/thread-session.js';
const locked = new Error('thread x already has an active writer');
it('resumes normally without reads or forks', async () => {
  const request=vi.fn().mockResolvedValue({thread:{id:'x'}});
  expect(await resumeThread({request},'x',{cwd:'/repo'},true,vi.fn())).toEqual({thread:{id:'x'}});
  expect(request).toHaveBeenCalledTimes(1);
});
it('forks only through the completed turn of a confirmed idle lead', async () => {
  const request=vi.fn().mockRejectedValueOnce(locked).mockResolvedValueOnce({thread:{status:{type:'idle'},turns:[{id:'t',status:'completed'}]}}).mockResolvedValueOnce({thread:{id:'fork'}});
  const notice=vi.fn();
  expect(await resumeThread({request},'x',{cwd:'/repo',sandbox:'read-only'},true,notice)).toEqual({thread:{id:'fork'}});
  expect(request).toHaveBeenLastCalledWith('thread/fork',{threadId:'x',lastTurnId:'t',cwd:'/repo',sandbox:'read-only'});
  expect(notice).toHaveBeenCalledOnce();
});
it.each(['active','notLoaded','systemError',undefined])('never forks a %s thread',async type=>{
  const request=vi.fn().mockRejectedValueOnce(locked).mockResolvedValueOnce({thread:{status:{type},turns:[{id:'t',status:'completed'}]}});
  await expect(resumeThread({request},'x',{},true,vi.fn())).rejects.toThrow(locked);
  expect(request).toHaveBeenCalledTimes(2);
});
it.each(['inProgress','interrupted','failed',undefined])('never forks a lead whose last turn is %s',async status=>{
  const request=vi.fn().mockRejectedValueOnce(locked).mockResolvedValueOnce({thread:{status:{type:'idle'},turns:[{id:'t',status}]}});
  await expect(resumeThread({request},'x',{},true,vi.fn())).rejects.toThrow(locked);
  expect(request).toHaveBeenCalledTimes(2);
});
it('never forks a worker or masks unrelated errors',async()=>{
  for(const [lead,error] of [[false,locked],[true,new Error('authentication failed')]] as const){
    const request=vi.fn().mockRejectedValue(error);
    await expect(resumeThread({request},'x',{},lead,vi.fn())).rejects.toThrow(error);
    expect(request).toHaveBeenCalledTimes(1);
  }
});

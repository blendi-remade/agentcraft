import {afterEach, expect, it} from 'vitest';
import {snapshotFrames} from '../src/snapshot-transfer.js';
import {SERVER_EXAMPLES} from '../src/protocol-examples.js';
import {parseServerMessage, type Outbound} from '../src/protocol.js';
import {makeForeman,tempDir,rmrf,type Harness} from './helpers.js';
let h:Harness|undefined;
afterEach(async()=>{if(h){await h.fm.close();rmrf(h.home);h=undefined;}});
function largeSnapshot(){
 const snapshot=structuredClone(SERVER_EXAMPLES.snapshot!);
 if(snapshot.type!=='snapshot')throw new Error('fixture');
 const goal=snapshot.goals[0]??snapshot.goal!;
 snapshot.goals=Array.from({length:1500},(_,i)=>({...goal,id:`g${i}`,text:'goal 🏠 '.repeat(500)}));
 return snapshot;
}
it('reconstructs every goal beyond 4 MiB, with bounded UTF-8 frames',()=>{
 const snapshot=largeSnapshot();const serialized=JSON.stringify(snapshot);
 expect(Buffer.byteLength(serialized)).toBeGreaterThan(4*1024*1024);
 const frames=snapshotFrames(snapshot);expect(frames.length).toBeGreaterThan(1);
 let body='';
 frames.forEach((frame,index)=>{
  expect(frame.type).toBe('snapshot.part');if(frame.type!=='snapshot.part')throw new Error('part');
  expect(frame.index).toBe(index);expect(frame.total).toBe(frames.length);
  expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(1024*1024);
  expect(parseServerMessage({...frame,v:1}).ok).toBe(true);
  body+=frame.body;
 });
 expect(body).toBe(serialized);expect(JSON.parse(body).goals).toHaveLength(1500);
});
it('negotiates parts while preserving the legacy hello contract',async()=>{
 h=makeForeman(tempDir());h.fm.store.data.goals=largeSnapshot().goals;
 const parts:Outbound[]=[];
 await h.fm.handle({v:1,type:'hello',modVersion:'test',protocol:1,snapshotParts:true},m=>parts.push(m));
 expect(parts.every(p=>p.type==='snapshot.part')).toBe(true);
 const legacy:Outbound[]=[];
 await h.fm.handle({v:1,type:'hello',modVersion:'test',protocol:1},m=>legacy.push(m));
 expect(legacy).toHaveLength(1);expect(legacy[0]?.type).toBe('snapshot');
});
it('keeps small snapshots unchanged',()=>{const s=SERVER_EXAMPLES.snapshot!;expect(snapshotFrames(s)).toEqual([s]);});

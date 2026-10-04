import { randomUUID } from 'node:crypto';
import type { Outbound } from './protocol.js';
const CHARS = 128 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;

/** Negotiated transport segmentation; clients apply the complete snapshot atomically. */
export function snapshotFrames(snapshot: Outbound): Outbound[] {
  const text = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(text);
  if (bytes <= 1024 * 1024) return [snapshot];
  if (bytes > MAX_BYTES) throw new Error('Studio snapshot exceeds the 64 MiB transfer limit; no state was discarded.');
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + CHARS, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    chunks.push(text.slice(start, end)); start = end;
  }
  const transferId = randomUUID();
  return chunks.map((body,index) => ({type:'snapshot.part',transferId,index,total:chunks.length,body}));
}

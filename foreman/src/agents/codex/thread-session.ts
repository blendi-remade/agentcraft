import type { CodexAppServer } from './app-server.js';

/** Recover an idle lead thread held by another client without taking over its writer. */
export async function resumeThread(
  server: Pick<CodexAppServer, 'request'>,
  threadId: string,
  config: Record<string, unknown>,
  recoverIdleLead: boolean,
  onFork: () => void,
): Promise<unknown> {
  try {
    return await server.request('thread/resume', { threadId, ...config });
  } catch (error) {
    if (!recoverIdleLead || !(error instanceof Error) || !error.message.includes('already has an active writer')) throw error;
    const result = await server.request('thread/read', { threadId, includeTurns: true }) as {
      thread?: { status?: { type?: string }; turns?: Array<{ id?: string; status?: string }> };
    };
    const last = result.thread?.turns?.at(-1);
    // Unknown/not-loaded status is insufficient: never duplicate an active or interrupted job.
    if (result.thread?.status?.type !== 'idle' || !last?.id || last.status !== 'completed') throw error;
    const fork = await server.request('thread/fork', { threadId, lastTurnId: last.id, ...config });
    onFork();
    return fork;
  }
}

// Each turn gets a short-lived, authenticated loopback MCP endpoint. Credentials stay in the
// Codex child environment; neither its command line nor persisted AgentCraft state contains them.
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ToolExecutor, toolResult } from '../coding-tools.js';
import type { TurnRequest } from '../runtime.js';

export async function startBridge(r: TurnRequest, onLimit: () => void) {
  const token = randomBytes(32).toString('hex');
  const executor = new ToolExecutor(r);
  let closed = false;
  let calls = 0;
  // Serialize tools even when the model requests a parallel batch (edits and task updates can
  // depend on each other). No new operation starts once the turn has closed or was cancelled.
  let tail = Promise.resolve();
  // Keep one MCP session for the turn. Cancellation arrives in a separate HTTP request, so a
  // fresh server per POST loses the original request controller and leaves the tool running.
  const mcp = new McpServer({ name: 'agentcraft', version: '0.1.0' });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  const call = (name: string, args: Record<string, unknown>, signal: AbortSignal) => {
    const result = tail.then(async () => {
      if (closed || r.abortController.signal.aborted || signal.aborted) return toolResult('Tool request stopped.', true);
      if (++calls > r.maxTurns) { onLimit(); return toolResult('Tool call limit reached.', true); }
      return executor.call(randomUUID(), name, args, signal);
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  for (const tool of executor.tools) {
    mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, (args, extra) => call(tool.name, args, extra.signal));
  }
  await mcp.connect(transport);
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) {
      res.writeHead(403).end(); return;
    }
    if (req.url !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(req.method ?? '')) { res.writeHead(405).end(); return; }
    if (closed) { res.writeHead(410).end(); return; }
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const body: unknown = req.method === 'POST' ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(400).end('Invalid MCP request');
      else res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, token,
    get calls() { return calls; },
    /** Legacy dynamic team aliases share the same queue, policy, budget and cleanup. */
    call,
    async close() {
      closed = true;
      // Abort wakes permission/questions and kills shells. Drain tool work before the
      // scheduler can commit WIP or start another turn in the same worktree.
      r.abortController.abort();
      await tail;
      await mcp.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

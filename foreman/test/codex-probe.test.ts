import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServer } from '../src/agents/codex/app-server.js';

const homes: string[] = [];
const clients: CodexAppServer[] = [];
function fixture(mode: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcraft-probe-'));
  homes.push(home);
  const executable = path.join(home, 'fake-codex');
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'mcp') {
  fs.writeFileSync(process.env.PROBE_HOME + '/probe-started', '1');
  setTimeout(() => {
    const mode = process.env.PROBE_MODE;
    if (mode === 'failure') process.exit(1);
    console.log(mode === 'invalid' ? 'broken' : mode === 'large' ? 'x'.repeat(2 * 1024 * 1024) : '[{"name":"test"},{"name":"test"}]');
  }, process.env.PROBE_MODE === 'slow' ? 350 : process.env.PROBE_MODE === 'hang' ? 30000 : 0);
} else {
  fs.writeFileSync(process.env.PROBE_HOME + '/app-started', '1');
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const m=JSON.parse(line); if(m.id) console.log(JSON.stringify({id:m.id,result:{}}));
  });
}
`, { mode: 0o700 });
  const client = new CodexAppServer({ binaryPath: executable, cwd: home,
    env: { ...process.env, PROBE_HOME: home, PROBE_MODE: mode },
    onNotification: () => {}, onServerRequest: async () => ({}) });
  clients.push(client);
  return { client, home };
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close(0)));
  homes.splice(0).forEach(home => fs.rmSync(home, { recursive:true, force:true }));
});

// The executable fixture uses a POSIX shebang; Windows transport qualification is separate.
describe.skipIf(process.platform === 'win32')('asynchronous MCP inspection', () => {
it('keeps the event loop responsive during a slow inspection and disables deduplicated servers', async () => {
  const {client} = fixture('slow');
  let finished = false;
  const start = client.start().then(() => { finished = true; });
  await new Promise(r => setTimeout(r, 30));
  expect(finished).toBe(false);
  await expect(client.start()).rejects.toThrow('already started');
  await start;
  expect(client.disabledMcpServerCount).toBe(1);
});

it('cancels a running probe on close without spawning the app server', async () => {
  const {client,home} = fixture('hang');
  const outcome = client.start().then(() => null, error => error);
  const deadline = Date.now()+3000;
  while (!fs.existsSync(path.join(home,'probe-started')) && Date.now()<deadline) {
    await new Promise(r=>setTimeout(r,10));
  }
  expect(fs.existsSync(path.join(home,'probe-started'))).toBe(true);
  await client.close(0);
  expect(await outcome).toBeInstanceOf(Error);
  expect(fs.existsSync(path.join(home,'app-started'))).toBe(false);
  await expect(client.start()).rejects.toThrow('closed');
});

it.each(['invalid','failure','large'])('fails closed on %s probe output', async mode => {
  const {client,home} = fixture(mode);
  await expect(client.start()).rejects.toThrow(/refusing to start/);
  expect(fs.existsSync(path.join(home,'app-started'))).toBe(false);
});

});

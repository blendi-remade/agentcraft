import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { splitArgs } from '../control.mjs';

const control = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'control.mjs');

test('splitArgs splits like a shell for simple cases', () => {
  assert.deepEqual(splitArgs('--effort low  --ci "npm test -- --run"'), ['--effort', 'low', '--ci', 'npm test -- --run']);
  assert.deepEqual(splitArgs("--goal 'a b'"), ['--goal', 'a b']);
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs(undefined), []);
});

test('the dashboard API needs the page token, a loopback host and its own origin', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-control-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [control, '--home', home, '--port', String(port), '--no-open', '--no-autostart'], { stdio: 'ignore' });
  t.after(() => {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    page = await fetch(`${base}/`).then((r) => r.text()).catch(() => undefined);
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  const token = /AC_TOKEN = '([^']+)'/.exec(page)?.[1];
  assert.ok(token && token !== '__AC_TOKEN__', 'the page carries a token');
  assert.equal((await fetch(`${base}/api/status`)).status, 403);
  const ok = await fetch(`${base}/api/status`, { headers: { 'x-agentcraft-token': token } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).foreman.state, 'stopped');
  const cross = await fetch(`${base}/api/status`, { headers: { 'x-agentcraft-token': token, origin: 'http://evil.example' } });
  assert.equal(cross.status, 403);
  // DNS rebinding: a foreign Host name is refused even for the page
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example:' + port } }, (r) => { r.resume(); resolve(r.statusCode); });
  });
  assert.equal(status, 403);
  // static files never escape the dashboard folder
  assert.equal((await fetch(`${base}/..%2fcontrol.mjs`)).status, 404);
});

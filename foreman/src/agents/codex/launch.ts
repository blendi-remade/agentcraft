import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Use argv throughout, including npm's Windows shim, so JSON/config values never enter cmd.exe. */
export function codexCommand(binary: string, args: string[], platform = process.platform): { command: string; args: string[] } {
  if (/\.[cm]?js$/i.test(binary)) return { command: process.execPath, args: [binary, ...args] };
  if (platform !== 'win32' || !/\.cmd$/i.test(binary)) return { command: binary, args };
  const directory = path.dirname(path.resolve(binary));
  const candidates = [path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')];
  try {
    const packageFile = createRequire(path.join(directory, 'agentcraft-resolver.cjs')).resolve('@openai/codex/package.json');
    candidates.push(path.join(path.dirname(packageFile), 'bin', 'codex.js'));
  } catch { /* A standalone executable needs no npm package. */ }
  const entry = candidates.find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  if (!entry) throw new Error('Cannot resolve the Codex npm shim. Set --codex-path to codex.exe or the installed @openai/codex/bin/codex.js.');
  return { command: process.execPath, args: [entry, ...args] };
}

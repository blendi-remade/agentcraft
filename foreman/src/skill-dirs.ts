import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Installed skill sources, read-only. Resolve direct installed aliases (e.g. superpowers),
 * but never follow arbitrary links inside a skill to unrelated files. Snapshot at startup. */
export function skillReadDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const roots = [path.join(home, '.agents', 'skills'), path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills')];
  const dirs = new Set<string>();
  for (const root of roots) {
    try {
      const canonical = fs.realpathSync(root);
      dirs.add(root);
      dirs.add(canonical);
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) continue;
        const target = fs.realpathSync(path.join(root, entry.name));
        if (fs.statSync(target).isDirectory()) {
          dirs.add(path.join(root, entry.name));
          dirs.add(path.resolve(root, fs.readlinkSync(path.join(root, entry.name))));
          dirs.add(target);
        }
      }
    } catch { /* no skills installed here */ }
  }
  return [...dirs];
}

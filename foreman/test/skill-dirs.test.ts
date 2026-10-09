import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { skillReadDirs } from '../src/skill-dirs.js';
import { classifyToolUse } from '../src/policy.js';
import { tempDir, rmrf } from './helpers.js';

it('trusts installed skill reads and aliases, without allowing writes, execution or nested link escapes', () => {
  const dir = tempDir();
  try {
    const home = path.join(dir, 'home'), cwd = path.join(dir, 'worktree');
    const root = path.join(home, '.agents', 'skills'), skill = path.join(root, 'review');
    const target = path.join(home, '.codex', 'superpowers', 'skills');
    const custom = path.join(home, 'custom-codex', 'skills', 'coding');
    for (const p of [cwd, skill, target, custom]) fs.mkdirSync(p, { recursive: true });
    for (const p of [skill, target, custom]) fs.writeFileSync(path.join(p, 'SKILL.md'), 'installed');
    const secret = path.join(home, 'secret'); fs.writeFileSync(secret, 'private');
    fs.symlinkSync(target, path.join(root, 'superpowers'), 'junction');
    if (process.platform !== 'win32') fs.symlinkSync(secret, path.join(skill, 'secret-link'));
    const ctx = { cwd, role: 'worker' as const, tempDirs: [], readDirs: skillReadDirs({ CODEX_HOME: path.join(home, 'custom-codex') }, home) };
    for (const p of [skill, target, custom, path.join(root, 'superpowers')]) {
      const file = path.join(p, 'SKILL.md');
      expect(classifyToolUse('Read', { file_path: file }, ctx).action, file).toBe('allow');
      expect(classifyToolUse('Bash', { command: `cat "${file}"` }, ctx).action).toBe('allow');
      expect(classifyToolUse('Write', { file_path: file, content: 'changed' }, ctx).action).toBe('ask');
      expect(classifyToolUse('Bash', { command: `bash "${file}"` }, ctx).action).toBe('ask');
    }
    expect(classifyToolUse('Read', { file_path: secret }, ctx).action).toBe('ask');
    if (process.platform !== 'win32') expect(classifyToolUse('Read', { file_path: path.join(skill, 'secret-link') }, ctx).action).toBe('ask');
  } finally { rmrf(dir); }
});

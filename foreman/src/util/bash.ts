import { existsSync } from 'node:fs';
import path from 'node:path';

/** The permission policy parses Bash syntax, so never execute its input via cmd.exe. */
export function bashExecutable(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  exists: (file: string) => boolean = existsSync,
): string {
  const custom = env.AGENTCRAFT_BASH_COMMAND;
  if (custom) {
    if (!(platform === 'win32' ? path.win32 : path).isAbsolute(custom)) throw new Error('AGENTCRAFT_BASH_COMMAND must be an absolute path to Bash');
    if (!exists(custom)) throw new Error(`Bash executable does not exist: ${custom}`);
    return custom;
  }
  if (platform !== 'win32') return exists('/bin/bash') ? '/bin/bash' : 'bash';
  const candidates: string[] = [];
  const value = (key: string) => Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  for (const dir of (value('PATH') ?? '').split(';').map(s => s.replace(/^"|"$/g, '')).filter(Boolean)) {
    // Git for Windows usually adds only Git/cmd to PATH; find Bash relative to git.exe.
    if (exists(path.win32.join(dir, 'git.exe'))) {
      candidates.push(path.win32.resolve(dir, '../bin/bash.exe'), path.win32.resolve(dir, '../usr/bin/bash.exe'));
    }
  }
  for (const root of [value('ProgramFiles'), value('ProgramFiles(x86)'), value('LOCALAPPDATA')]) {
    if (root) candidates.push(path.win32.join(root, 'Git/bin/bash.exe'), path.win32.join(root, 'Programs/Git/bin/bash.exe'));
  }
  const found = candidates.find(exists);
  if (found) return found;
  // Do not fall back to Windows' bash.exe shim: it may be WSL with different path semantics.
  throw new Error('Git Bash is required for coding commands on Windows. Install Git for Windows or set AGENTCRAFT_BASH_COMMAND to its bash.exe.');
}

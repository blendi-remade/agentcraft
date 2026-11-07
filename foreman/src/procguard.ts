// Process guard: which processes a kill command would stop, and whether one of them is AgentCraft
// itself. Agents stop dev servers they started (fine), but `taskkill /IM node.exe /F` also stops
// the Foreman (a node process), every agent's CLI (node) and Minecraft (java). Those commands are
// refused outright: an approval prompt for them reads like a harmless "stop the dev server", so a
// human approving it is not a safeguard.
//
//   by name     taskkill /IM, Stop-Process -Name, pkill, killall, `/FI "IMAGENAME eq ..."`
//               -> refused when the name (or wildcard) matches a protected image
//   by pattern  pkill -f <regex> -> refused when it matches a protected command line or image
//   by PID      refused when the PID is protected (the Foreman, its parents, agent CLIs)
//   everything  kill -1, kill 0, kill -- -<pgid>, taskkill /FI without a name or PID -> refused or
//               unverifiable
//   unknown     PIDs from variables, substitutions or a pipe -> unverifiable (asked exactly, with a
//               warning, never covered by a broad approval)
//
// Pure: the caller passes the protected processes (see PolicyContext.protectedProcesses).

export interface ProtectedProcess {
  pid: number;
  /** what it is, for messages: "the Foreman", "Kit's agent process", "a parent of the Foreman" */
  what: string;
  /** image name without .exe (`node`), when known */
  name?: string;
  /** full command line, when known (checked against `pkill -f` patterns) */
  commandLine?: string;
}

/**
 * Images AgentCraft runs as: the Foreman and the Claude CLI are node, Codex is codex (or node),
 * Minecraft is java/javaw. Stopping any of them by name stops AgentCraft too.
 */
export const PROTECTED_IMAGES = ['node', 'nodejs', 'java', 'javaw', 'claude', 'codex'];

export interface KillTargets {
  pids: number[];
  names: string[];
  /** pkill/pgrep patterns; `full`: matched against the whole command line (-f) */
  patterns: Array<{ text: string; full: boolean; exact: boolean; ignoreCase: boolean }>;
  /** parents whose children are stopped (pkill -P) */
  parents: number[];
  /** set when the command stops every process, a whole process group, or everything a filter matches */
  everything?: string;
  /** set when some target cannot be known before the command runs */
  unknown?: string;
  /** set for forms that stop nothing (kill -l) */
  none?: boolean;
}

const empty = (): KillTargets => ({ pids: [], names: [], patterns: [], parents: [] });
const stripExe = (n: string) => n.replace(/\.exe$/i, '');
const PS_PARAMS = /^-(id|pid|name|processname|inputobject|force|passthru|confirm|whatif|includeusername)(:.*)?$/i;

/**
 * The targets of a kill command (`cmd` lowercased, `.exe` stripped; `args` as lexed). `dynamic`
 * says whether a word comes from a variable or substitution.
 */
export function killTargets(cmd: string, args: string[], dynamic: (w: string) => boolean): KillTargets {
  if (cmd === 'taskkill') return taskkillTargets(args, dynamic);
  if (cmd === 'stop-process' || cmd === 'spps' || (cmd === 'kill' && args.some((a) => PS_PARAMS.test(a)))) return stopProcessTargets(args, dynamic);
  if (cmd === 'kill') return posixKillTargets(args, dynamic);
  if (cmd === 'pkill') return pkillTargets(args, dynamic);
  if (cmd === 'killall') return killallTargets(args, dynamic);
  return { ...empty(), unknown: `${cmd}: its targets cannot be checked` };
}

function addPid(t: KillTargets, v: string, dynamic: (w: string) => boolean): void {
  for (const part of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (dynamic(part)) t.unknown ??= `a process id comes from a variable or substitution (${part})`;
    else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n === 0) t.everything ??= 'PID 0 is the whole process group';
      else t.pids.push(n);
    } else if (/^-\d+$/.test(part)) t.everything ??= part === '-1' ? 'kill -1 stops every process you own' : `${part} is a whole process group`;
    else t.unknown ??= `not a process id: ${part}`;
  }
}

function addName(t: KillTargets, v: string, dynamic: (w: string) => boolean): void {
  for (const part of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (dynamic(part)) t.unknown ??= `a process name comes from a variable or substitution (${part})`;
    else t.names.push(stripExe(part));
  }
}

function taskkillTargets(args: string[], dynamic: (w: string) => boolean): KillTargets {
  const t = empty();
  // Git Bash needs `//PID` for `/PID`; taskkill also takes `-PID`
  const norm = args.map((a) => (/^(\/\/?|-)[a-z?]+$/i.test(a) ? `/${a.replace(/^(\/\/?|-)/, '').toLowerCase()}` : a));
  let filtered = false;
  for (let i = 0; i < norm.length; i++) {
    const a = norm[i]!;
    const v = norm[i + 1];
    if (a === '/pid' && v !== undefined) {
      addPid(t, v, dynamic);
      i++;
    } else if (a === '/im' && v !== undefined) {
      addName(t, v, dynamic);
      i++;
    } else if (a === '/fi' && v !== undefined) {
      i++;
      if (dynamic(v)) {
        t.unknown ??= 'a filter comes from a variable or substitution';
        continue;
      }
      const m = /^\s*(imagename|pid)\s+eq\s+(\S+)\s*$/i.exec(v);
      if (m) {
        if (m[1]!.toLowerCase() === 'pid') addPid(t, m[2]!, dynamic);
        else addName(t, m[2]!, dynamic);
      } else filtered = true;
    } else if ((a === '/s' || a === '/u' || a === '/p') && v !== undefined) {
      t.unknown ??= 'taskkill on another machine';
      i++;
    }
  }
  // taskkill /FI "MEMUSAGE gt 1000" (no /IM, no /PID) stops every process the filter matches
  if (filtered && !t.pids.length && !t.names.length) t.everything ??= 'a taskkill filter without /IM or /PID stops every process that matches it';
  if (!t.pids.length && !t.names.length && !t.everything && !t.unknown) t.unknown = 'no /PID or /IM given';
  return t;
}

function stopProcessTargets(args: string[], dynamic: (w: string) => boolean): KillTargets {
  const t = empty();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const colon = /^-(\w+):(.+)$/.exec(a);
    const p = (colon ? colon[1]! : /^-(\w+)$/.exec(a)?.[1] ?? '').toLowerCase();
    const v = colon ? colon[2] : args[i + 1];
    if (p === 'id' || p === 'pid') {
      if (v !== undefined) addPid(t, v, dynamic);
      if (!colon) i++;
    } else if (p === 'name' || p === 'processname') {
      if (v !== undefined) addName(t, v, dynamic);
      if (!colon) i++;
    } else if (p === 'inputobject') {
      t.unknown ??= 'Stop-Process -InputObject: the processes come from an object';
      if (!colon) i++;
    } else if (p) continue; // -Force, -PassThru, -Confirm:$false, ...
    else {
      // Stop-Process <ids>: the first positional parameter is -Id
      addPid(t, a, dynamic);
    }
  }
  if (!t.pids.length && !t.names.length && !t.everything && !t.unknown) t.unknown = 'the processes come from the pipeline';
  return t;
}

function posixKillTargets(args: string[], dynamic: (w: string) => boolean): KillTargets {
  const t = empty();
  let i = 0;
  if (args[0] === '-l' || args[0] === '-L' || args[0] === '--list' || args[0] === '--table') return { ...t, none: true };
  // signal: `-s SIG`, `-n NUM`, `--signal SIG`, or `-SIG` / `-9` before the targets
  if (['-s', '-n', '--signal'].includes(args[0] ?? '')) i = 2;
  else if (/^-[A-Za-z0-9+]+$/.test(args[0] ?? '') && args.length > 1) i = 1;
  if (args[i] === '--') i++;
  for (const a of args.slice(i)) {
    if (/^%/.test(a)) continue; // a job of the agent's own shell
    addPid(t, a, dynamic);
  }
  if (!t.pids.length && !t.everything && !t.unknown) t.none = true;
  return t;
}

const PKILL_VALUE_OPTS = new Set(['-s', '--session', '-t', '--terminal', '-u', '--euid', '-U', '--uid', '-g', '--pgroup', '-G', '--group', '-F', '--pidfile', '--signal', '--ns', '--nslist', '-q', '--queue']);

function pkillTargets(args: string[], dynamic: (w: string) => boolean): KillTargets {
  const t = empty();
  let full = false;
  let exact = false;
  let ignoreCase = false;
  const pats: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-P' || a === '--parent') {
      const v = args[++i];
      if (v === undefined) continue;
      for (const part of v.split(',')) {
        if (/^\d+$/.test(part)) t.parents.push(Number(part));
        else t.unknown ??= `pkill -P ${part}: the parent cannot be checked`;
      }
      continue;
    }
    if (a === '-g' || a === '--pgroup') {
      t.everything ??= 'pkill -g stops a whole process group';
      i++;
      continue;
    }
    if (PKILL_VALUE_OPTS.has(a)) {
      i++;
      continue;
    }
    if (a === '--full') full = true;
    else if (a === '--exact') exact = true;
    else if (a === '--ignore-case') ignoreCase = true;
    else if (/^-[A-Za-z]+$/.test(a) && !/^-[A-Z]{3,}$/.test(a)) {
      if (a.includes('f')) full = true;
      if (a.includes('x')) exact = true;
      if (a.includes('i')) ignoreCase = true;
    } else if (/^-/.test(a)) continue; // -9, -SIGTERM, --signal=...
    else pats.push(a);
  }
  for (const p of pats) {
    if (dynamic(p)) t.unknown ??= `the pattern comes from a variable or substitution (${p})`;
    else t.patterns.push({ text: p, full, exact, ignoreCase });
  }
  if (!pats.length && !t.parents.length && !t.everything && !t.unknown) t.unknown = 'pkill without a pattern';
  return t;
}

function killallTargets(args: string[], dynamic: (w: string) => boolean): KillTargets {
  const t = empty();
  let regex = false;
  let ignoreCase = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (['-s', '--signal', '-u', '--user', '-o', '--older-than', '-y', '--younger-than', '-n', '--ns'].includes(a)) {
      i++;
      continue;
    }
    if (a === '-r' || a === '--regexp') regex = true;
    else if (a === '-I' || a === '--ignore-case') ignoreCase = true;
    else if (/^-/.test(a)) continue;
    else if (dynamic(a)) t.unknown ??= `a process name comes from a variable or substitution (${a})`;
    else if (regex) t.patterns.push({ text: a, full: false, exact: false, ignoreCase });
    else t.names.push(stripExe(a));
  }
  if (!t.names.length && !t.patterns.length && !t.unknown) t.unknown = 'killall without a name';
  return t;
}

/** `node*`, `NODE.EXE`, `n?de` against an image name (Windows names are case-insensitive). */
function globMatches(glob: string, name: string): boolean {
  const re = new RegExp(`^${stripExe(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(name);
}

function patternMatches(p: KillTargets['patterns'][number], subject: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(p.exact ? `^(?:${p.text})$` : p.text, p.ignoreCase ? 'i' : '');
  } catch {
    return subject.includes(p.text);
  }
  return re.test(subject);
}

/**
 * Why `t` would stop a protected process, or undefined. Images in PROTECTED_IMAGES always count,
 * even when no protected process of that name is known (Minecraft's pid is not).
 */
export function protectedHit(t: KillTargets, protectedProcs: ProtectedProcess[]): string | undefined {
  const images = [...new Set([...PROTECTED_IMAGES, ...protectedProcs.flatMap((p) => (p.name ? [stripExe(p.name).toLowerCase()] : []))])];
  const label = (img: string) => {
    const procs = protectedProcs.filter((p) => p.name && stripExe(p.name).toLowerCase() === img);
    const known = procs.length ? `, including ${procs.map((p) => `${p.what} (pid ${p.pid})`).join(', ')}` : '';
    const note = img === 'java' || img === 'javaw' ? ' (Minecraft runs as java)' : img === 'node' || img === 'nodejs' ? ' (the AgentCraft Foreman and every agent run as node)' : '';
    return `every ${img} process${note}${known}`;
  };
  for (const n of t.names) {
    const img = images.find((i) => globMatches(n, i));
    if (img) return `stopping processes by the name "${n}" would stop ${label(img)}`;
  }
  for (const p of t.patterns) {
    // `node.exe --import tsx` is also matched as `node --import tsx` (how the agent writes it)
    const cmdHit = p.full ? protectedProcs.find((pp) => pp.commandLine && [pp.commandLine, pp.commandLine.replace(/\.exe\b/gi, '')].some((c) => patternMatches(p, c))) : undefined;
    if (cmdHit) return `the pattern "${p.text}" matches ${cmdHit.what} (pid ${cmdHit.pid})`;
    const img = images.find((i) => patternMatches(p, i) || patternMatches(p, `${i}.exe`));
    if (img) return `the pattern "${p.text}" matches ${label(img)}`;
  }
  for (const pid of t.pids) {
    const hit = protectedProcs.find((pp) => pp.pid === pid);
    if (hit) return `pid ${pid} is ${hit.what}`;
  }
  for (const pid of t.parents) {
    const hit = protectedProcs.find((pp) => pp.pid === pid);
    if (hit) return `the children of pid ${pid} (${hit.what}) include AgentCraft's own processes`;
  }
  return undefined;
}

/** What the refusal tells the agent to do instead. */
export const KILL_ADVICE =
  'Stop only processes you started, by their PID: use the PID your command printed, or find the one listening on your port (`netstat -ano | findstr :<port>` on Windows, `lsof -ti :<port>` elsewhere) and run `taskkill /PID <pid> /T /F` or `kill <pid>`. Never stop processes by name (node, java, ...).';

const PROTECTED_WORD = new RegExp(`(^|[^\\w-])(${PROTECTED_IMAGES.join('|')})(\\.exe)?(?![\\w-])`, 'i');
const PROC_QUERY = /\b(get-process|gps|get-ciminstance|gcim|get-wmiobject|gwmi|win32_process|wmic|system\.diagnostics\.process|pgrep|pidof|tasklist)\b/i;
const PROC_STOP = /\b(stop-process|spps|taskkill|pkill|killall|kill)\b|\.kill\s*\(|\bterminate\b|\bwmic\b[^|;&]*\bdelete\b/i;

/**
 * A whole-command check for kills the word-level classifier cannot see through: a process query
 * that names a protected image feeding a stop (`Get-Process node | Stop-Process`,
 * `(Get-Process node).Kill()`, `wmic process where name='node.exe' delete`,
 * `pgrep node | xargs kill`). Errs on the side of refusing: the agent can always stop a PID.
 */
export function stopsProtectedByQuery(command: string): string | undefined {
  if (!PROC_QUERY.test(command) || !PROC_STOP.test(command)) return undefined;
  const m = PROTECTED_WORD.exec(command);
  return m ? `it looks up "${m[2]}${m[3] ?? ''}" processes and stops them, which would stop AgentCraft itself (the Foreman and agents run as node, Minecraft as java)` : undefined;
}

/** A kill that names the Foreman's own port (`npx kill-port 7777`, `fuser -k 7777/tcp`). */
export function stopsProtectedPort(command: string, ports: number[]): string | undefined {
  if (!ports.length || !/\bkill-port\b|\bfuser\b[^|;&]*\s-k|\b(stop-process|spps|taskkill|kill)\b/i.test(command)) return undefined;
  const hit = ports.find((p) => new RegExp(`(^|[^\\d])${p}(?!\\d)`).test(command));
  return hit !== undefined ? `it stops whatever listens on port ${hit}, which is the AgentCraft Foreman` : undefined;
}

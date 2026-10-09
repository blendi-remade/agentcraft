// Permission policy shared by every real backend's `canUseTool`.
//
//   allow -> run without asking         (reads/edits inside the agent's worktree, safe dev commands)
//   ask   -> becomes a `permission` decision in-world   (outside worktree, network, destructive, unknown)
//   deny  -> refused outright            (git push - always; lead editing files; subagents)
//
// The Bash classifier is a small shell parser: quotes, redirections, heredocs and here-strings,
// brace expansion, a virtual `cd`, wrappers (env/xargs/timeout/...), nested shells and `eval`,
// inline `node -e` code, and command substitution: every `$(...)`, `...` and `<(...)` body is
// classified as a command of its own, and the value it produces is "unknown" wherever a path
// matters. Commands git runs for us (`rebase -x`, `bisect run`, `submodule foreach`,
// `filter-branch --tree-filter`, `difftool -x`, `-c alias.x=!cmd`) are classified the same way.
// Anything it cannot verify asks. It is one of three push guards: gitsafety.ts makes git itself
// refuse every transport in agent and CI processes, and the CLI gets
// `disallowedTools: Bash(git push:*)`.
//
// the user's checked-out branch only moves through an approved merge. Agents' git is kept on their
// own worktree: commands that mention GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / ... ask, writes,
// moves and deletes of a `.git` entry inside the worktree ask, git run from a directory outside
// the worktree (after `cd`, `-C`, or through a link) is checked as an outside repository, and
// gitsafety.ts stops git from walking up out of the worktree. Agents never sign (`-S` is refused).
//
// Rule keys ("Always allow for this team") are scoped so an approval never covers more than the
// prompt that created it. A command may need several keys; it runs only when all are approved.
//   Bash:<capability>                 something confined to the worktree (`Bash:rm -r`,
//                                     `Bash:npm install`, `Bash:find -delete`, `Bash:git reset --hard`).
//                                     Every path the command touches is checked separately, so the
//                                     key never unlocks the same action outside the worktree.
//   Bash:outside:<cmd>:<r|w|x>:<dir>  <cmd> reading / writing / running files directly in <dir>
//   Bash:outside:<cmd>:<r|w>tree:<p>  <cmd> reading / changing everything under exactly <p>
//   Bash:net:<cmd>:<hosts>            network access with that tool to those hosts
//   Bash:exact:<hash>                 only this exact command text: used whenever arguments cannot
//                                     be checked (xargs, variables, substitutions, unknown
//                                     programs, process/system commands, inline code)
//   Read:<dir>, Grep:tree:<p>, Write:<dir>, WebFetch:<host>, ...  for the non-Bash tools
//
// Pure apart from realpath lookups (links that lead out of the worktree), so it can be table-tested.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GIT_REDIRECT_VARS } from './gitsafety.js';
import { isInsideOrEqual } from './util/fsx.js';

export type Verdict =
  | { action: 'allow'; reason: string }
  /** ruleKeys: every key this call needs ("Always allow" stores all of them); ruleKey = ruleKeys[0] */
  | { action: 'ask'; reason: string; ruleKey: string; ruleKeys: string[] }
  | { action: 'deny'; reason: string };

export interface PolicyContext {
  role: 'lead' | 'worker';
  /** the agent's sandbox: its worktree (workers) or the repo checkout (lead, read-only) */
  cwd: string;
  /** extra directories the agent may read (e.g. the memory dir) */
  readDirs?: string[];
  /** scoped rule keys approved for this agent or its repository team */
  alwaysAllow?: string[];
  /** our in-process MCP server name */
  mcpServer?: string;
  /** home directory (tests); default os.homedir() */
  home?: string;
  /** scratch directories agents may read and write (default: the OS temp dir) */
  tempDirs?: string[];
  /** lead only: command prefixes the user declared read-only, e.g. `bd show` */
  leadReadCommands?: string[];
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const TREE_READ_TOOLS = new Set(['Grep', 'Glob']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const ALWAYS_OK = new Set(['TodoWrite', 'TodoRead', 'BashOutput', 'KillShell', 'KillBash', 'ExitPlanMode', 'TaskOutput', 'TaskStop']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);
const DENIED_TOOLS: Record<string, string> = {
  Task: 'Subagents are disabled in AgentCraft; do the work directly.',
  Agent: 'Subagents are disabled in AgentCraft; do the work directly.',
  AskUserQuestion: 'Use the mcp__agentcraft__ask_user tool to ask the user.',
  Skill: 'Skills are disabled for AgentCraft agents.',
  EnterWorktree: 'You already work in a dedicated git worktree.',
};

const PUSH_DENY = 'git push is never allowed in AgentCraft (the user pushes; agents only work in local worktrees)';
const TAMPER_DENY = "that would change AgentCraft's git safety settings (pushes and git network access are disabled for agents)";
const DYNAMIC_PUSH_DENY = 'a git subcommand that comes from a variable or substitution cannot be checked and could be a push';

function pathArg(input: Record<string, unknown>): string | undefined {
  for (const k of ['file_path', 'path', 'notebook_path']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function hashText(s: string): string {
  return createHash('sha256').update(s.trim()).digest('hex').slice(0, 16);
}

/** The rule key that covers exactly this command text and nothing else. */
export function exactKey(command: string): string {
  return `Bash:exact:${hashText(command)}`;
}

/** Plain-language scope of a rule key, shown on the permission prompt. */
export function describeRuleKey(key: string): string {
  let m: RegExpExecArray | null;
  if (key.startsWith('Bash:exact:')) return 'only this exact command';
  if ((m = /^Bash:outside:(.+?):(r|w|x)(tree)?:(.*)$/.exec(key))) {
    const verb = m[2] === 'r' ? 'reading' : m[2] === 'w' ? 'writing' : 'running';
    return m[3] ? `${m[1]} ${m[2] === 'r' ? 'reading' : 'changing'} everything under ${m[4]}` : `${m[1]} ${verb} files in ${m[4]}`;
  }
  if ((m = /^Bash:net:(.+?):(.*)$/.exec(key))) return `${m[1]} network access to ${m[2]}`;
  if ((m = /^Bash:cd:(.*)$/.exec(key))) return `changing directory to ${m[1]}`;
  if ((m = /^Bash:git (checkout|switch):(.*)$/.exec(key))) return `git ${m[1]} to exactly ${m[2] || '(no target)'}`;
  if ((m = /^Bash:npx (.*)$/.exec(key))) return `\`npx ${m[1]}\` even when that downloads it from the npm registry (paths outside still ask)`;
  if ((m = /^Bash:(vite|webpack) serve$/.exec(key))) return `starting the ${m[1]} dev server (it listens on a local port)`;
  if ((m = /^(\w+):\.git:(.*)$/.exec(key))) return `${m[1]} of ${m[2]} (git internals)`;
  if ((m = /^(Glob|Grep):pattern:/.exec(key))) return `${m[1]} with only this exact pattern`;
  if ((m = /^Bash:(.*)$/.exec(key))) return `\`${m[1]}\` inside this agent's worktree (paths outside still ask)`;
  if ((m = /^(Read|Grep|Glob|LS|NotebookRead):tree:(.*)$/.exec(key))) return `${m[1]} under ${m[2]}`;
  if ((m = /^(\w+):(.*)$/.exec(key))) return `${m[1]} in ${m[2]}`;
  return key;
}

// ---- paths ---------------------------------------------------------------------------------

/** Marks substituted text inside a word: \x01S<n>\x01 = substitution n, \x01D\x01 = unknowable. */
const MARK = '\u0001';
const MARK_RE = /\u0001S(\d+)\u0001/g;
const DYN = `${MARK}D${MARK}`;
/** heredoc placeholder left behind the `<<DELIM` word: \x02H<n>\x02 */
const HD_RE = /\u0002H(\d+)\u0002/;

const HOME_VARS = /^(?:\$HOME|\$\{HOME\}|\$USERPROFILE|\$\{USERPROFILE\}|%USERPROFILE%|%HOME%|\$env:USERPROFILE|\$env:HOME)(?=$|[\\/])/i;
const TEMP_VARS = /^(?:\$TMPDIR|\$\{TMPDIR\}|\$TMP|\$\{TMP\}|\$TEMP|\$\{TEMP\}|%TEMP%|%TMP%|\$env:TEMP|\$env:TMP)(?=$|[\\/])/i;
const PWD_VARS = /^(?:\$PWD|\$\{PWD\})(?=$|[\\/])/;
const ANY_VAR = /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%|\$env:[A-Za-z_][A-Za-z0-9_]*)/i;
/** shell expansions left in a word: $VAR, ${..}, $1, $@, `...`; cmd.exe %VAR% (3+ letters, so git's %H%n is not one) */
const EXPANSION_RE = /\$(?:\{|\(|[A-Za-z_]|\d|[@*#?$!])|`|%[A-Za-z_][A-Za-z0-9_]{2,}%/;
const SPECIAL_FILES = /^(\/dev\/(null|stdout|stderr|stdin|tty|fd\/\d+)|nul|con|-)$/i;

type Resolved = { kind: 'path'; abs: string } | { kind: 'special' } | { kind: 'unknown' };
type Vals = Map<number, string | undefined>;

function homeOf(ctx: PolicyContext): string {
  return ctx.home ?? os.homedir();
}

/** Resolve a path-ish token the way a shell would (~, $HOME, %USERPROFILE%, /c/..., relative). */
function resolveToken(tok: string, vcwd: string, ctx: PolicyContext, vals?: Vals): Resolved {
  if (tok.includes(DYN)) return { kind: 'unknown' };
  if (tok.includes(MARK)) {
    let unknown = false;
    tok = tok.replace(MARK_RE, (_m, k: string) => {
      const v = vals?.get(Number(k));
      if (v === undefined) unknown = true;
      return v ?? '';
    });
    if (unknown || tok.includes(MARK)) return { kind: 'unknown' };
  }
  if (SPECIAL_FILES.test(tok)) return { kind: 'special' };
  let p = tok;
  if (p === '~' || /^~[\\/]/.test(p)) p = homeOf(ctx) + p.slice(1);
  else if (/^~[A-Za-z]/.test(p)) return { kind: 'unknown' }; // another user's home
  else if (HOME_VARS.test(p)) p = p.replace(HOME_VARS, () => homeOf(ctx));
  else if (TEMP_VARS.test(p)) p = p.replace(TEMP_VARS, () => os.tmpdir());
  else if (PWD_VARS.test(p)) p = p.replace(PWD_VARS, () => vcwd);
  else if (ANY_VAR.test(p)) return { kind: 'unknown' };
  if (EXPANSION_RE.test(p)) return { kind: 'unknown' }; // e.g. src/$X or a$(cmd)
  if (/^\/tmp(?=$|\/)/.test(p)) p = os.tmpdir() + p.slice(4); // Git Bash maps /tmp to the user temp dir
  const m = /^\/([a-zA-Z])(?=$|\/)(.*)$/.exec(p); // Git Bash style /c/Users/...
  if (process.platform === 'win32' && m) p = `${m[1]}:/${m[2]}`;
  return { kind: 'path', abs: path.resolve(vcwd, p) };
}

/** Kept for the Read/Edit tool paths. */
function resolveIn(cwd: string, p: string, ctx?: PolicyContext): string {
  const r = resolveToken(p, cwd, ctx ?? { role: 'worker', cwd });
  return r.kind === 'path' ? r.abs : path.resolve(cwd, p);
}

/** The deepest existing ancestor's real path stays inside `root` (no symlink/junction escape). */
function realInside(abs: string, root: string): boolean {
  try {
    if (!fs.existsSync(root)) return true;
    let p = abs;
    while (!fs.existsSync(p)) {
      const up = path.dirname(p);
      if (up === p) return true;
      p = up;
    }
    return isInsideOrEqual(fs.realpathSync.native(p), fs.realpathSync.native(root));
  } catch {
    return true;
  }
}

interface AreaOpts {
  /** the operation covers the whole tree under the path */
  recursive?: boolean;
}

/** Inside the worktree (and really inside: no link out), a scratch temp dir, or a read dir. */
function inArea(ctx: PolicyContext, abs: string, mode: 'r' | 'w' | 'x', opts: AreaOpts = {}): boolean {
  if (isInsideOrEqual(abs, ctx.cwd)) return realInside(abs, ctx.cwd);
  for (const d of ctx.tempDirs ?? [os.tmpdir()]) {
    // scratch space, but never a recursive change of the temp dir itself
    if (isInsideOrEqual(abs, d) && !(opts.recursive && mode === 'w' && isInsideOrEqual(d, abs))) return true;
  }
  if (mode === 'r' && (ctx.readDirs ?? []).some((d) => isInsideOrEqual(abs, d) && realInside(abs, d))) return true;
  return false;
}

function inSandbox(ctx: PolicyContext, p: string, forRead: boolean): boolean {
  return inArea(ctx, resolveIn(ctx.cwd, p, ctx), forRead ? 'r' : 'w');
}

function insideGitDir(ctx: PolicyContext, p: string): boolean {
  return touchesGitLink(ctx, resolveIn(ctx.cwd, p, ctx));
}

function dirKey(abs: string): string {
  return path.dirname(abs).toLowerCase();
}

function isDynamic(word: string): boolean {
  return word.includes(MARK) || EXPANSION_RE.test(word) || ANY_VAR.test(word);
}

/**
 * Does this argument refer to a location that needs checking? Relative paths without `..` stay
 * in the cwd. `strict` (commands that write/delete): any expansion anywhere in the word counts.
 */
function isPathCandidate(tok: string, strict = false): boolean {
  if (!tok || /^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) return false; // URL
  if (tok.split(/[\\/]/).some(isGitName)) return true; // a `.git` entry (checked for writes)
  if (/^([a-zA-Z]:([\\/]|$)|[\\/]|~|\$\{?[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%|\$env:)/.test(tok) || /(^|[\\/])\.\.([\\/]|$)/.test(tok)) return true;
  if (tok.includes(MARK)) return true;
  if (EXPANSION_RE.test(tok) && (strict || /[\\/]/.test(tok))) return true;
  if (tok.includes('{')) {
    const alts = braceExpand(tok);
    if (alts.length > 1 || alts[0] !== tok) return alts.some((a) => isPathCandidate(a, strict));
  }
  return false;
}

/** Path candidates in argv: plain args, `--opt=value`, `KEY=value` and `@file` values. */
function argCandidates(args: string[], strict = false): string[] {
  const out: string[] = [];
  for (const a of args) {
    const eq = /^(?:--?[\w-]+|[A-Za-z_][\w.-]*)=(.*)$/s.exec(a);
    let v = eq ? eq[1]! : a.startsWith('-') ? '' : a;
    v = v.replace(/^@(?=.)/, '');
    if (v && isPathCandidate(v, strict)) out.push(v);
  }
  return out;
}

function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[++i]!;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** Bash brace expansion (`{a,b}`, `{x..y}` -> endpoints), capped; too many results -> unknowable. */
function braceExpand(word: string, limit = 64): string[] {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < word.length; i++) {
    const c = word[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth !== 0 || start < 0) continue;
      const inner = word.slice(start + 1, i);
      const parts = splitTopLevelCommas(inner);
      let alts: string[] | undefined;
      if (parts.length > 1) alts = parts;
      else {
        const m = /^([^.{}]+)\.\.([^.{}]+)(?:\.\.-?\d+)?$/.exec(inner);
        if (m) alts = [m[1]!, m[2]!];
      }
      if (!alts) {
        start = -1;
        continue;
      }
      const pre = word.slice(0, start);
      const post = word.slice(i + 1);
      const out: string[] = [];
      for (const a of alts) {
        for (const e of braceExpand(pre + a + post, limit)) {
          out.push(e);
          if (out.length > limit) return [`${word}${DYN}`];
        }
      }
      return out;
    }
  }
  return [word];
}

// Absolute paths embedded in code/scripts (node -e, sed/awk programs): Windows drives, Git Bash
// drives, home references and well-known Unix roots. Regex literals like /a/g do not match.
const EMBEDDED_PATH_RE =
  /(?:^|[\s'"`=(,;[{])((?:[A-Za-z]:[\\/]|\/[A-Za-z](?=\/)|~(?=[\\/])|\$HOME\b|\$\{HOME\}|\$USERPROFILE\b|%USERPROFILE%|\$env:USERPROFILE|\/(?:etc|usr|var|home|root|Users|bin|sbin|opt|mnt|proc|sys|boot|srv|Library|Applications|Windows|ProgramData)\b)[^\s'"`;|&<>(),]*)/gi;

function embeddedPaths(text: string): string[] {
  return [...text.matchAll(EMBEDDED_PATH_RE)].map((m) => m[1]!);
}

// ---- shell lexing --------------------------------------------------------------------------

/**
 * Pull here-document bodies out of a command (`cat > f <<'EOF' ... EOF`), so their lines are not
 * mistaken for commands. Each `<<DELIM` word gets a placeholder (\x02H<n>\x02) glued to it, so the
 * body can be found again wherever the operator ends up (even inside a `$(...)`).
 */
export function extractHeredocs(cmd: string, bodies: Array<{ body: string; quoted: boolean }> = []): { text: string; bodies: Array<{ body: string; quoted: boolean }> } {
  const lines = cmd.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const pending: Array<{ strip: boolean; delim: string; idx: number }> = [];
    const marked = line.replace(/(?<!<)<<(?!<)(-?)(\s*)(['"]?)([A-Za-z_][\w.-]*)\3(?![\w.-])(?!\u0002)/g, (m, dash: string, _sp: string, q: string, delim: string) => {
      const idx = bodies.length + pending.length;
      pending.push({ strip: dash === '-', delim, idx });
      bodies.push({ body: '', quoted: !!q });
      return `${m}\u0002H${idx}\u0002`;
    });
    out.push(marked);
    for (const p of pending) {
      const body: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[++i]!.replace(/\r$/, '');
        if ((p.strip ? next.replace(/^\t+/, '') : next) === p.delim) break;
        body.push(next);
      }
      bodies[p.idx]!.body = body.join('\n');
    }
  }
  return { text: out.join('\n'), bodies };
}

interface Subst {
  body: string;
  kind: '$(' | '`' | '<(' | '>(';
  unbalanced?: boolean;
}

/** Index of the `)` matching the `(` at `open` (quote-aware), or -1. */
function matchClose(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j < 0) return -1;
      i = j;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

const markOf = (k: number) => `${MARK}S${k}${MARK}`;

/**
 * Replace every command substitution in `text` with a marker and collect the bodies:
 * `$(...)`, backticks (also inside double quotes), `<(...)` / `>(...)` (unquoted), and the
 * substitutions nested in `$((arithmetic))`. `quotes=false` for unquoted heredoc bodies, where
 * quote characters are literal.
 */
function extractSubst(text: string, out: Subst[], quotes = true): string {
  let res = '';
  let q: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q === "'") {
      res += c;
      if (c === "'") q = null;
      continue;
    }
    if (c === '\\' && i + 1 < text.length) {
      res += c + text[i + 1]!;
      i++;
      continue;
    }
    if (quotes && c === "'" && q === null) {
      q = "'";
      res += c;
      continue;
    }
    if (quotes && c === '"') {
      q = q === '"' ? null : '"';
      res += c;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      const end = matchClose(text, i + 1);
      if (text[i + 2] === '(' && end > 0 && text[end - 1] === ')') {
        // $(( arithmetic )): a number, but it may contain substitutions of its own
        const before = out.length;
        extractSubst(text.slice(i + 3, end - 1), out, true);
        res += '0';
        for (let k = before; k < out.length; k++) res += markOf(k);
        i = end;
        continue;
      }
      if (end < 0) {
        out.push({ body: text.slice(i + 2), kind: '$(', unbalanced: true });
        res += markOf(out.length - 1);
        return res;
      }
      out.push({ body: text.slice(i + 2, end), kind: '$(' });
      res += markOf(out.length - 1);
      i = end;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let body = '';
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '\\' && j + 1 < text.length) {
          body += /[`\\$]/.test(text[j + 1]!) ? text[j + 1]! : text[j]! + text[j + 1]!;
          j += 2;
          continue;
        }
        body += text[j]!;
        j++;
      }
      out.push({ body, kind: '`', ...(j >= text.length ? { unbalanced: true } : {}) });
      res += markOf(out.length - 1);
      i = j;
      continue;
    }
    if (q === null && quotes && (c === '<' || c === '>') && text[i + 1] === '(' && text[i - 1] !== c) {
      const end = matchClose(text, i + 1);
      out.push({ body: end < 0 ? text.slice(i + 2) : text.slice(i + 2, end), kind: c === '<' ? '<(' : '>(', ...(end < 0 ? { unbalanced: true } : {}) });
      res += markOf(out.length - 1);
      if (end < 0) return res;
      i = end;
      continue;
    }
    res += c;
  }
  return res;
}

interface Segment {
  text: string;
  /** stdin comes from the previous segment through a pipe */
  pipeIn: boolean;
}

function splitSegmentsWithOps(cmd: string): Segment[] {
  const out: Segment[] = [];
  let cur = '';
  let quote: string | null = null;
  let pipeIn = false;
  const flush = (nextPipe: boolean) => {
    if (cur.trim()) out.push({ text: cur.trim(), pipeIn });
    cur = '';
    pipeIn = nextPipe;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i]!;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      if (cmd[i + 1] === '\n') {
        i++; // line continuation
        continue;
      }
      cur += c + cmd[++i]!;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    // redirections are not separators: 2>&1, >&2, &>file
    if (c === '&' && (cmd[i - 1] === '>' || cmd[i + 1] === '>')) {
      cur += c;
      continue;
    }
    if (c === '|') {
      if (cmd[i + 1] === '|') {
        i++;
        flush(false);
      } else {
        if (cmd[i + 1] === '&') i++; // |& pipes stderr too
        flush(true);
      }
      continue;
    }
    if (c === ';' || c === '\n' || c === '&' || c === '(' || c === ')') {
      if (c === '&' && cmd[i + 1] === '&') i++;
      flush(false);
      continue;
    }
    cur += c;
  }
  flush(false);
  return out;
}

/** Split a command line into simple segments on ; && || | & ( ) and newlines (quote-aware). */
export function splitSegments(cmd: string): string[] {
  return splitSegmentsWithOps(cmd).map((s) => s.text);
}

export interface Lexed {
  words: string[];
  /** file redirections: `>`/`>>` write the target, `<` reads it */
  redirects: Array<{ op: '>' | '<'; target: string }>;
  /** here-documents (`<<EOF`) this command reads: indices into extractHeredocs().bodies */
  heredocRefs?: number[];
  /** here-strings (`<<< word`) this command reads */
  herestrings?: string[];
}

function closeQuote(s: string, i: number, q: string): number {
  for (let j = i + 1; j < s.length; j++) {
    if (q === '"' && s[j] === '\\') {
      j++;
      continue;
    }
    if (s[j] === q) return j;
  }
  return s.length;
}

/** Words of one simple command, with quotes removed and file redirections pulled out. */
export function lex(seg: string): Lexed {
  const words: string[] = [];
  const redirects: Lexed['redirects'] = [];
  const heredocRefs: number[] = [];
  const herestrings: string[] = [];
  let cur = '';
  let started = false;
  let quotedInWord = false;
  let pending: '>' | '<' | 'heredoc' | 'herestring' | null = null;
  const push = () => {
    if (!started) return;
    if (pending === 'heredoc') {
      const m = HD_RE.exec(cur);
      heredocRefs.push(m ? Number(m[1]) : -1);
    } else if (pending === 'herestring') herestrings.push(cur);
    else if (pending) redirects.push({ op: pending, target: cur });
    else words.push(cur);
    pending = null;
    cur = '';
    started = false;
    quotedInWord = false;
  };
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === '"' || c === "'") {
      const end = closeQuote(seg, i, c);
      const content = seg.slice(i + 1, end);
      cur += c === '"' ? content.replace(/\\(["\\$`])/g, '$1') : content;
      started = true;
      quotedInWord = true;
      i = end;
      continue;
    }
    if (c === '\\' && i + 1 < seg.length && /[\s"'\\;&|<>()]/.test(seg[i + 1]!)) {
      cur += seg[++i]!;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if ((c === '>' || c === '<') && !quotedInWord && (!started || /^(\d+|&)$/.test(cur))) {
      let j = i + 1;
      if (c === '<' && seg[j] === '<') {
        if (seg[j + 1] === '<') {
          cur = '';
          started = false;
          pending = 'herestring';
          i = j + 1;
          continue;
        }
        while (seg[j] === '<' || seg[j] === '-') j++;
        cur = '';
        started = false;
        pending = 'heredoc';
        i = j - 1;
        continue;
      }
      if (c === '>' && (seg[j] === '>' || seg[j] === '|')) j++;
      if (seg[j] === '&') {
        // >&2, 2>&1, >&- duplicate a descriptor; >&file (bash) writes the file
        let k = j + 1;
        while (k < seg.length && !/\s/.test(seg[k]!)) k++;
        const word = seg.slice(j + 1, k);
        cur = '';
        started = false;
        if (/^(\d+|-)?$/.test(word)) {
          i = k - 1;
          continue;
        }
        pending = c === '>' ? '>' : '<';
        i = j;
        continue;
      }
      cur = '';
      started = false;
      pending = c === '>' ? '>' : '<';
      i = j - 1;
      continue;
    }
    if ((c === '>' || c === '<') && started && !quotedInWord) {
      // `a>b`: the word ends, the redirection starts
      push();
      i--;
      continue;
    }
    cur += c;
    started = true;
  }
  push();
  return { words, redirects, ...(heredocRefs.length ? { heredocRefs } : {}), ...(herestrings.length ? { herestrings } : {}) };
}

function baseCmd(word: string): string {
  const b = word.split(/[\\/]/).pop() ?? word;
  return b.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, '');
}

const WRAPPER_VALUE_OPTS: Record<string, string[]> = {
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  stdbuf: ['-i', '-o', '-e'],
  xargs: ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-lines', '--replace'],
  time: ['-f', '-o', '--format', '--output'],
  chrt: [],
  taskset: [],
  command: [],
  builtin: [],
  exec: ['-a'],
  nohup: [],
  setsid: [],
  unbuffer: [],
  watch: ['-n', '--interval', '-d', '--differences'],
  flock: ['-w', '--timeout', '-E'],
};

interface Unwrapped {
  words: string[];
  /** leading VAR=value assignments (for this command or the shell) */
  assigns: string[];
  /** path-taking wrapper options (env -C, xargs -a, time -o) to check */
  extraPaths: string[];
  /** arguments come from stdin (xargs) */
  viaXargs: boolean;
  /** `env -i` / `env -`: the git safety variables would be dropped */
  clearsEnv: boolean;
  /** `env -S "..."`: a command string to classify recursively */
  inner?: string;
}

/** Strip leading VAR=value assignments and wrapper commands (env, xargs, timeout, nohup, ...). */
function unwrap(words: string[]): Unwrapped {
  const res: Unwrapped = { words: [...words], assigns: [], extraPaths: [], viaXargs: false, clearsEnv: false };
  for (let guard = 0; guard < 8; guard++) {
    const w = res.words;
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) res.assigns.push(w.shift()!);
    if (!w.length) break;
    const cmd = baseCmd(w[0]!);
    const valueOpts = WRAPPER_VALUE_OPTS[cmd];
    if (!valueOpts) break;
    if (cmd === 'command' && w.some((a) => a === '-v' || a === '-V')) break; // lookup only
    w.shift();
    if (cmd === 'xargs') res.viaXargs = true;
    while (w.length) {
      const a = w[0]!;
      if (a === '--') {
        w.shift();
        break;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) && cmd === 'env') {
        res.assigns.push(w.shift()!);
        continue;
      }
      if (cmd === 'env' && (a === '-' || a === '-i' || a === '--ignore-environment')) {
        res.clearsEnv = true;
        w.shift();
        continue;
      }
      if (!a.startsWith('-') || a === '-') break;
      w.shift();
      const opt = a.replace(/=.*$/, '');
      const glued = a.includes('=') ? a.slice(a.indexOf('=') + 1) : undefined;
      if (valueOpts.includes(opt)) {
        const v = glued ?? w.shift() ?? '';
        if ((cmd === 'env' && (opt === '-C' || opt === '--chdir')) || (cmd === 'xargs' && (opt === '-a' || opt === '--arg-file')) || (cmd === 'time' && (opt === '-o' || opt === '--output'))) res.extraPaths.push(v);
        if (cmd === 'env' && (opt === '-S' || opt === '--split-string')) res.inner = v;
      }
    }
    // `timeout 30 cmd`, `nice 10 cmd`
    if ((cmd === 'timeout' || cmd === 'chrt' || cmd === 'taskset') && w.length && /^[\d.]+[smhd]?$|^0x[0-9a-f]+$/i.test(w[0]!)) w.shift();
  }
  return res;
}

// ---- judgements ----------------------------------------------------------------------------

interface Ask {
  reason: string;
  key: string;
}

/** The result of classifying a command (or part of one). */
interface J {
  /** refuse outright */
  deny?: string;
  /** approvals needed (each by its own scoped rule key) */
  asks: Ask[];
  /** changes nothing (the lead may run it) */
  readOnly: boolean;
  reason: string;
  /** `cd` target for the following segments */
  cwd?: string;
  /** stdout is a list of paths inside the worktree (find, git ls-files, grep -l, ...) */
  pathsOut?: boolean;
}

const ok = (reason: string, readOnly: boolean, extra: Partial<J> = {}): J => ({ asks: [], readOnly, reason, ...extra });
const refuse = (reason: string): J => ({ deny: reason, asks: [], readOnly: false, reason });
const need = (reason: string, key: string): J => ({ asks: [{ reason, key }], readOnly: false, reason });

/** Combine: any deny wins; asks add up; read-only only if all are. The last one's cwd/pathsOut win. */
function merge(a: J, ...rest: Array<J | undefined>): J {
  let out: J = { ...a, asks: [...a.asks] };
  for (const b of rest) {
    if (!b) continue;
    if (out.deny) return out;
    if (b.deny) return { ...b, asks: [...out.asks, ...b.asks] };
    out = {
      asks: [...out.asks, ...b.asks],
      readOnly: out.readOnly && b.readOnly,
      reason: b.asks.length ? b.reason : out.asks.length ? out.reason : b.reason,
      ...(b.cwd !== undefined ? { cwd: b.cwd } : out.cwd !== undefined ? { cwd: out.cwd } : {}),
      ...(b.pathsOut !== undefined ? { pathsOut: b.pathsOut } : {}),
    };
  }
  return out;
}

interface Env {
  ctx: PolicyContext;
  /** the whole command as the user sees it (for exact keys) */
  top: string;
  depth: number;
  /** here-document bodies of the top-level command */
  heredocs: Array<{ body: string; quoted: boolean }>;
  /** which heredoc bodies some segment consumed */
  usedHeredocs: Set<number>;
}

/** Per-segment view: the command's substitutions and what they evaluate to. */
interface SegCtx {
  env: Env;
  vcwd: string;
  vals: Vals;
  cmd: string;
}

const MAX_DEPTH = 4;

function exact(env: Env, reason: string): J {
  return need(reason, exactKey(env.top));
}

/** Check path tokens: outside the allowed area -> an ask with a key scoped to that path. */
function pathAsks(tokens: string[], mode: 'r' | 'w' | 'x', sc: SegCtx, opts: AreaOpts & { dir?: boolean } = {}): J {
  let j = ok('', true);
  const ctx = sc.env.ctx;
  for (const tok of tokens) {
    for (const t of braceExpand(tok)) {
      const r = resolveToken(t, sc.vcwd, ctx, sc.vals);
      if (r.kind === 'special') continue;
      if (r.kind === 'unknown') {
        j = merge(j, exact(sc.env, `${sc.cmd}: a path comes from a variable or substitution and cannot be checked (${tok})`));
        continue;
      }
      // the `.git` link decides which repository git works on: writing, moving or deleting it
      // could point the worktree at the user's checkout
      if (mode === 'w' && touchesGitLink(ctx, r.abs)) {
        j = merge(j, exact(sc.env, `${sc.cmd} changes git internals (.git): ${r.abs}`));
        continue;
      }
      if (inArea(ctx, r.abs, mode, opts)) continue;
      const lower = r.abs.toLowerCase();
      const what = mode === 'r' ? (opts.recursive ? 'reads everything under' : 'reads') : mode === 'x' ? 'runs' : opts.recursive ? 'changes everything under' : 'writes';
      const scope = opts.recursive && mode !== 'x' ? `${mode}tree:${lower}` : mode === 'x' || opts.dir ? `${mode}:${lower}` : `${mode}:${dirKey(r.abs)}`;
      j = merge(j, need(`${sc.cmd} ${what} a path outside the worktree: ${r.abs}`, `Bash:outside:${sc.cmd}:${scope}`));
    }
  }
  return j;
}

// ---- command tables ------------------------------------------------------------------------

const NET_HTTP = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);
const NET_SUBCOMMAND = new Set(['gh', 'hub', 'glab', 'vercel', 'netlify', 'fly', 'flyctl', 'heroku', 'firebase', 'wrangler']);
const NET_EXACT = new Set(['ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'docker', 'podman', 'kubectl', 'helm', 'aws', 'gcloud', 'az', 'start-bitstransfer', 'certutil', 'bitsadmin']);
/** process / system / account commands: arguments decide everything, so only exact approvals */
const SYSTEM_CMDS = new Set(['sudo', 'su', 'doas', 'runas', 'shutdown', 'reboot', 'halt', 'poweroff', 'format', 'mkfs', 'diskpart', 'reg', 'regedit', 'setx', 'takeown', 'icacls', 'cacls', 'chown', 'chgrp', 'kill', 'taskkill', 'pkill', 'killall', 'stop-process', 'crontab', 'schtasks', 'at', 'launchctl', 'systemctl', 'service', 'sc', 'net', 'netsh', 'mount', 'umount', 'bcdedit', 'vssadmin', 'cipher', 'set-executionpolicy', 'wmic', 'robocopy', 'trap', 'alias', 'function']);
const LINK_CMDS = new Set(['ln', 'mklink']);
/** deleting commands: recursive forms need `Bash:<cmd> -r` (inside) or a tree key (outside) */
const DELETE_CMDS = new Set(['rm', 'unlink', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'shred', 'wipe']);
/** read-only commands: arguments are only checked for outside paths */
const READ_CMDS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'echo', 'printf', 'pwd', 'which', 'where', 'whereis', 'diff', 'cmp', 'tree',
  'cut', 'tr', 'basename', 'dirname', 'realpath', 'readlink', 'stat', 'file', 'true', 'false', 'test', '[', '[[', 'date', 'printenv',
  'env', 'jq', 'yq', 'less', 'more', 'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'test-path', 'resolve-path', 'du',
  'nl', 'od', 'xxd', 'hexdump', 'sha1sum', 'sha256sum', 'md5sum', 'shasum', 'cksum', 'base64', 'seq', 'tac', 'rev', 'fold',
  'paste', 'join', 'comm', 'expand', 'unexpand', 'column', 'fmt', 'sleep', 'whoami', 'uname', 'hostname', 'id', 'locale',
  'command', 'hash', 'uniq', 'sort', 'clear', 'cls', 'ps', 'tasklist', 'df', 'free', 'uptime', 'nproc', 'arch', 'getconf',
  ':', 'exit', 'return', 'break', 'continue', 'wait', 'shift', 'set', 'shopt', 'umask', 'ulimit', 'read', 'unset', 'jobs', 'history',
]);
const NO_PATH_CMDS = new Set(['echo', 'printf', 'true', 'false', 'sleep', 'date', 'whoami', 'uname', 'hostname', 'id', 'locale', 'seq', 'pwd', 'clear', 'cls', 'command', 'hash', 'which', 'where', 'whereis', 'test', '[', '[[', 'ps', 'tasklist', 'nproc', 'arch', 'getconf', 'uptime', 'free', ':', 'exit', 'return', 'break', 'continue', 'wait', 'shift', 'set', 'shopt', 'umask', 'ulimit', 'read', 'unset', 'jobs', 'history', 'printenv', 'env']);
// PowerShell pipeline filters/formatters (Codex runs commands through PowerShell on Windows): they
// shape objects and print, never touch files. Script blocks (`ForEach-Object { ... }`) are split
// into their own segments and checked as commands.
const PS_FILTERS = [
  'select-object', 'select', 'where-object', '?', 'foreach-object', '%', 'foreach', 'sort-object', 'measure-object', 'measure',
  'format-table', 'ft', 'format-list', 'fl', 'format-wide', 'fw', 'out-string', 'out-host', 'oh', 'out-null', 'group-object', 'group',
  'get-unique', 'gu', 'get-member', 'gm', 'convertto-json', 'convertfrom-json', 'convertto-csv', 'get-location', 'gl', 'get-command',
  'gcm', 'get-date', 'write-output', 'write', 'write-host', 'join-path', 'split-path', 'get-help',
];
for (const c of PS_FILTERS) {
  READ_CMDS.add(c);
  NO_PATH_CMDS.add(c);
}
/** PowerShell cmdlets that run a script block: `ForEach-Object { Remove-Item $_ }` runs Remove-Item. */
const PS_BLOCK_CMDS = new Set(['foreach-object', '%', 'foreach', 'where-object', '?']);
/**
 * A script block's body is an expression (`$_.FullName`, `$_.Length -gt 100`) or commands. Braces and
 * `;`/`|` were split off already; leading parameter names (-Process, -FilterScript) are skipped.
 */
function psBlockCommand(rest: string[]): string | undefined {
  let i = 0;
  while (i < rest.length && /^-[a-z]+$/i.test(rest[i]!)) i++;
  const body = rest.slice(i);
  if (!body.length) return undefined;
  const expression = /^[$'"0-9(]/.test(body[0]!) && !body.some((w) => /^[a-z][a-z0-9]*-[a-z][a-z0-9]*$/i.test(w) || w === '&' || w === '.' || w === '=');
  return expression ? undefined : body.join(' ');
}
/** PowerShell cmdlets that write the file named by -Path/-LiteralPath/-FilePath (or the first argument). */
const PS_WRITERS = new Set(['set-content', 'add-content', 'ac', 'out-file']);
const RECURSIVE_READERS = new Set(['du', 'tree']);
/** commands that only write their path arguments (inside the worktree is fine) */
const WRITE_CMDS = new Set(['mkdir', 'md', 'touch', 'tee', 'truncate', 'new-item', 'ni']);
const COPY_CMDS = new Set(['cp', 'copy', 'install', 'xcopy', 'copy-item', 'cpi']);
const MOVE_CMDS = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item']);
/** dev tools that run project code or write build output inside the worktree */
const DEV_TOOLS = new Set(['tsc', 'vitest', 'jest', 'mocha', 'ava', 'pytest', 'eslint', 'prettier', 'biome', 'tsx', 'ts-node', 'make', 'cmake', 'ninja', 'esbuild', 'vite', 'rollup', 'webpack', 'turbo', 'nx', 'mypy', 'ruff', 'black', 'flake8', 'pylint', 'isort', 'go', 'cargo', 'rustc', 'gcc', 'g++', 'clang', 'javac', 'java', 'dotnet', 'gradle', 'gradlew', 'mvn', 'swift', 'zig']);
const INTERPRETERS = new Set(['node', 'nodejs', 'deno', 'bun', 'python', 'python3', 'py', 'ruby', 'perl', 'php', 'lua', 'rscript']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);
const GREP_CMDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'select-string', 'sls', 'findstr']);
const SYS_PKG = new Set(['pip', 'pip3', 'pipx', 'uv', 'poetry', 'pdm', 'conda', 'gem', 'bundle', 'brew', 'choco', 'winget', 'scoop', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'composer', 'nuget']);
const PY_SAFE_MODULES = new Set(['pytest', 'unittest', 'doctest', 'py_compile', 'compileall', 'json.tool', 'mypy', 'ruff', 'black', 'isort', 'flake8', 'pylint', 'coverage', 'timeit', 'tabnanny', 'pyflakes', 'tokenize', 'ast', 'dis']);
const NPX_SAFE = new Set(['tsc', 'vitest', 'jest', 'eslint', 'prettier', 'tsx', 'mocha', 'ts-node', 'biome', 'esbuild', 'vite', 'playwright']);
/** cmd.exe-style commands whose `/s`-like arguments are switches, not paths */
const CMD_SWITCH_CMDS = new Set(['del', 'erase', 'rd', 'rmdir', 'dir', 'copy', 'move', 'attrib', 'xcopy', 'findstr', 'tree']);
/** env vars that make later commands run code (pagers, editors, ssh commands, preloads) */
const EXEC_VARS = /^(GIT_PAGER|PAGER|MANPAGER|GIT_EDITOR|EDITOR|VISUAL|GIT_SEQUENCE_EDITOR|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_EXTERNAL_DIFF|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|BASH_ENV|ENV|PROMPT_COMMAND|NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|PYTHONSTARTUP|PERL5OPT|RUBYOPT|NPM_CONFIG_SCRIPT_SHELL|SHELL|COMSPEC)$/i;
const BENIGN_PAGER = /^(|cat|less|more|less -[A-Za-z]+|true|false)$/;
/** builtins that set shell variables by name */
const VAR_SETTERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly', 'read', 'mapfile', 'readarray', 'printf', 'let']);

const RISKY_CODE =
  /child_process|\bspawn(Sync)?\b|\bexec(Sync|File|FileSync)?\s*\(|\bfork\s*\(|process\.(env|kill|chdir|binding)|\bfetch\s*\(|https?:\/\/|\brequire\s*\(\s*['"](node:)?(net|http|https|http2|dgram|tls|dns|worker_threads|cluster|vm|inspector)['"]|\bimport\s*\(|\b(unlink|rm|rmdir|rename|copyFile|cp|symlink|link|chmod|chown|truncate|writeFile|appendFile|mkdir|mkdtemp|createWriteStream|utimes|lchown)(Sync)?\s*\(|\bopen(Sync)?\s*\([^)]*['"][wax]|os\.homedir|\bsubprocess\b|\bos\.(system|popen|remove|unlink|rmdir|removedirs|rename|renames|replace|makedirs|mkdir|chdir|chmod|chown|exec\w*|spawn\w*|kill|startfile)|shutil\.|\bsocket\b|urllib|\brequests\b|\bhttp\.client|\bopen\s*\([^)]*['"][wax+]|Path\([^)]*\)\.(write|unlink|rmdir|rename|mkdir|touch)|Deno\.(run|Command|remove|writeTextFile|writeFile|mkdir|rename)|Bun\.(spawn|write|\$)|\beval\s*\(|\bFunction\s*\(|\bsystem\s*\(|\bIO\.popen|\bKernel\.|\bFile\.(write|delete|open)|\bunlink\b|\u0001/;

function inlineCodeVerdict(cmd: string, code: string, sc: SegCtx): J {
  if (scanForPush(code)) return refuse(PUSH_DENY);
  if (RISKY_CODE.test(code)) return exact(sc.env, `${cmd} runs inline code that can write files, start processes or use the network`);
  const paths = embeddedPaths(code).filter((p) => {
    const r = resolveToken(p, sc.vcwd, sc.env.ctx, sc.vals);
    return r.kind !== 'path' || !inArea(sc.env.ctx, r.abs, 'r');
  });
  if (paths.length) return exact(sc.env, `${cmd} inline code uses a path outside the worktree: ${paths[0]}`);
  return ok(`${cmd} inline code (read-only)`, false);
}

/** git subcommands that push or speak to a remote for writing */
const PUSH_SUBS = new Set(['push', 'send-pack', 'http-push', 'svn', 'p4', 'request-pull']);
const GIT_GLOBAL_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix', '--list-cmds', '--attr-source']);

/** `git [global opts] push` anywhere in a token list (so wrappers like env/xargs/timeout/sudo do not hide it). */
function tokensHavePush(raw: string[]): boolean {
  const toks = raw.flatMap((t) => braceExpand(t));
  for (let i = 0; i < toks.length; i++) {
    const b = baseCmd(toks[i]!.replace(/\\(.)/g, '$1'));
    if (/^git-(push|send-pack|http-push)$/.test(b)) return true;
    if (b === 'git-lfs' || b === 'git-subtree') {
      if (pushVerbAt(toks, i + 1)) return true;
      continue;
    }
    if (b !== 'git') continue;
    let j = i + 1;
    while (j < toks.length && toks[j]!.startsWith('-')) j += GIT_GLOBAL_VALUE_OPTS.has(toks[j]!) ? 2 : 1;
    const sub = unescapeWord(toks[j] ?? '').toLowerCase();
    if (PUSH_SUBS.has(sub)) return true;
    // git lfs push / git subtree push
    if ((sub === 'lfs' || sub === 'subtree') && pushVerbAt(toks, j + 1)) return true;
  }
  return false;
}

function unescapeWord(w: string): string {
  return w.replace(/\\(.)/g, '$1');
}

/** The first non-option word from `k` (skipping `-P <prefix>` / `--prefix <prefix>`) is push / pre-push. */
function pushVerbAt(toks: string[], k: number): boolean {
  while (k < toks.length && toks[k]!.startsWith('-')) k += /^(-P|--prefix)$/.test(toks[k]!) ? 2 : 1;
  return /^(push|pre-push)$/i.test(unescapeWord(toks[k] ?? ''));
}

/** Push inside code (node -e "...execSync('git push')", spawn('git', ['push']), sed/awk programs). */
function scanForPush(code: string): boolean {
  return tokensHavePush(code.split(/[\s;&|()<>'"`,[\]{}]+/).filter(Boolean));
}

function mentionsSafetyVars(cmd: string): boolean {
  return /\bGIT_(ALLOW_PROTOCOL|CONFIG_COUNT|CONFIG_KEY_\d*|CONFIG_VALUE_\d*|CONFIG_PARAMETERS|CONFIG_NOSYSTEM|CONFIG_GLOBAL|CONFIG_SYSTEM|PROTOCOL_FROM_USER|CEILING_DIRECTORIES)\b/i.test(cmd);
}

/** GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...: point git at another repository (gitsafety.ts) */
const REDIRECT_VAR_RE = new RegExp(`\\b(${GIT_REDIRECT_VARS.join('|')})\\b`, 'i');
const REDIRECT_REASON = "points git at another repository, work tree or index (it could move the user's checked-out branch)";

/** `.git` (and the spellings Windows treats as `.git`: `.git.`, `.git `, the 8.3 name `GIT~1`) */
function isGitName(component: string): boolean {
  return /^\.git[. ]*$/i.test(component) || /^git~\d+$/i.test(component);
}

/** A path inside the worktree that is, or is under, a `.git` entry (the worktree's link to its repository). */
function touchesGitLink(ctx: PolicyContext, abs: string): boolean {
  if (!isInsideOrEqual(abs, ctx.cwd)) return false;
  return path.relative(ctx.cwd, abs).split(/[\\/]/).some(isGitName);
}

// list-only forms of git branch / tag
const BRANCH_LIST_FLAG = /^(-a|--all|-r|--remotes|-l|--list|-v|-vv|--verbose|--show-current|--no-color|--color(=\S*)?|--column(=\S*)?|--no-column|--sort=\S+|--format=\S+|--abbrev=\d+|--no-abbrev|-i|--ignore-case|--omit-empty|-q|--quiet|--(contains|no-contains|merged|no-merged|points-at)=\S+)$/;
const TAG_LIST_FLAG = /^(-l|--list|-n\d*|--sort=\S+|--format=\S+|-i|--ignore-case|--column(=\S*)?|--no-column|--color(=\S*)?|--omit-empty|--(contains|no-contains|merged|no-merged|points-at)=\S+)$/;
const LIST_VALUE_FLAGS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format']);

function listOnly(args: string[], flagRe: RegExp): boolean {
  const listMode = args.includes('--list') || args.includes('-l');
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (LIST_VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) {
      if (!flagRe.test(a)) return false;
      continue;
    }
    if (!listMode) return false;
  }
  return true;
}

const CONFIG_WRITE_FLAGS = /^(--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section|--edit|-e)$/;
const CONFIG_READ_FLAGS = /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--get-color|--get-colorbool)$/;

function configReadOnly(args: string[]): boolean {
  if (args.some((a) => CONFIG_WRITE_FLAGS.test(a))) return false;
  if (args.some((a) => CONFIG_READ_FLAGS.test(a))) return true;
  const positional = args.filter((a) => !a.startsWith('-'));
  if (positional[0] === 'get' || positional[0] === 'list') return true;
  if (['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(positional[0] ?? '')) return false;
  return positional.length === 1; // `git config user.name` reads; `git config key value` writes
}

const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'annotate', 'grep', 'shortlog', 'describe', 'cat-file', 'ls-tree', 'merge-base', 'rev-list', 'diff-tree', 'diff-files', 'diff-index', 'whatchanged', 'version', 'show-ref', 'for-each-ref', 'name-rev', 'check-ignore', 'check-attr', 'check-ref-format', 'count-objects', 'var', 'show-branch', 'range-diff', 'cherry', 'verify-commit', 'verify-tag', 'fsck']);
/** change only the agent's own worktree / branch */
const GIT_WORKTREE = new Set(['add', 'commit', 'restore', 'mv', 'rm', 'apply', 'revert', 'cherry-pick', 'merge', 'format-patch', 'am', 'stage', 'merge-file', 'read-tree', 'write-tree', 'update-index', 'hash-object', 'mktree', 'commit-tree', 'checkout-index', 'sparse-checkout']);
/** git transports are disabled for agents (gitsafety.ts): these fail anyway, so only exact approvals */
const GIT_NETWORK = new Set(['fetch', 'pull', 'clone', 'ls-remote', 'remote-https', 'remote-http', 'remote-ext', 'remote-fd', 'upload-pack', 'receive-pack', 'upload-archive', 'fetch-pack', 'http-fetch', 'credential', 'daemon', 'instaweb', 'send-email', 'imap-send', 'web--browse', 'shell', 'cvsserver', 'cvsimport', 'quiltimport', 'archimport']);
/** subcommands that create commits (and so could be signed with the user's key) */
const GIT_SIGNING_SUBS = new Set(['commit', 'merge', 'revert', 'cherry-pick', 'am', 'commit-tree', 'rebase', 'pull']);
/** option values that are text, not paths (commit messages, patterns, dates): `-m msg` or `--grep=x` */
const GIT_TEXT_OPTS = new Set(['-m', '--message', '--author', '--date', '--grep', '-S', '-G', '--since', '--until', '--after', '--before', '--committer', '-n', '--max-count', '--skip', '--trailer', '--cleanup', '--depth', '-L', '--subject-prefix', '--reroll-count', '--shallow-since', '--shallow-exclude']);
/** options whose text value is always glued (`--format=%H%n`) */
const GIT_GLUED_TEXT_OPTS = new Set(['--format', '--pretty', '--abbrev', '--encoding', '-U', '--unified', '--diff-filter', '--decorate', '--sort', '--word-diff-regex', '--color-words', '--stat', '--dirstat', '--since-as-filter']);
/** `git -c key=value` keys whose value is a command git runs */
const GIT_EXEC_CONFIG = /^(core\.(pager|editor|sshcommand|askpass|fsmonitor|hookspath|gitproxy|alternaterefscommand|worktree)|pager\..+|sequence\.editor|diff\..*(external|textconv|command)|diff\.external|merge\..+\.driver|filter\..+|credential\..*|include\.path|includeif\..+|uploadpack\..+|sendemail\..+|interactive\.difffilter|.*\.textconv|.*\.cmd|.*\.tool|.*\.helper|alias\..+)$/i;
/** `git -c key=value` keys that sign commits with the user's key (agents' commits are never signed) */
const GIT_SIGN_CONFIG = /^((commit|tag|push|merge|rebase)\.gpgsign|user\.signingkey|gpg\..+)$/i;
const SIGN_DENY = "agents' commits are never signed (the user's approved merge is the signed commit): run it without -S / --gpg-sign";
/** the filter-branch options whose value is a shell command */
const FILTER_BRANCH_CMD_OPTS = ['--tree-filter', '--index-filter', '--msg-filter', '--commit-filter', '--env-filter', '--parent-filter', '--tag-name-filter', '--setup'];

interface GitArgs {
  /** option -> values (`-x cmd`, `-xcmd`, `--exec cmd`, `--exec=cmd`) */
  vals: Map<string, string[]>;
  /** options without a value (`-i`, `--update-refs`; each letter of a `-abc` cluster) */
  flags: Set<string>;
  positional: string[];
  /** word index -> option name, for every word that belongs to a valued option (the option and its value) */
  valueIdx: Map<number, string>;
}

/** Parse a git subcommand's arguments the way git's parse-options does (short clusters, `--opt=value`, `--`). */
function parseGitArgs(rest: string[], shortVal: string, longVal: string[]): GitArgs {
  const res: GitArgs = { vals: new Map(), flags: new Set(), positional: [], valueIdx: new Map() };
  const add = (name: string, v: string, ...idx: number[]) => {
    res.vals.set(name, [...(res.vals.get(name) ?? []), v]);
    for (const n of idx) res.valueIdx.set(n, name);
  };
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (a === '--') {
      res.positional.push(...rest.slice(k + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) add(a.slice(0, eq), a.slice(eq + 1), k);
      else if (longVal.includes(a) && k + 1 < rest.length) {
        add(a, rest[k + 1]!, k, k + 1);
        k++;
      } else res.flags.add(a);
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let c = 1; c < a.length; c++) {
        const ch = a[c]!;
        if (shortVal.includes(ch)) {
          const glued = a.slice(c + 1);
          if (glued) add(`-${ch}`, glued, k);
          else if (k + 1 < rest.length) {
            add(`-${ch}`, rest[k + 1]!, k, k + 1);
            k++;
          }
          break;
        }
        res.flags.add(`-${ch}`);
      }
      continue;
    }
    res.positional.push(a);
  }
  return res;
}

function gitPathCandidates(args: string[]): { paths: string[]; outputs: string[] } {
  const paths: string[] = [];
  const outputs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const opt = a.replace(/=.*$/s, '');
    if (opt === '--output' || opt === '-o' || opt === '--output-directory') {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : (args[++i] ?? '');
      if (v) outputs.push(v);
      continue;
    }
    if (GIT_TEXT_OPTS.has(opt)) {
      if (!a.includes('=')) i++; // value in the next word
      continue;
    }
    if (GIT_GLUED_TEXT_OPTS.has(opt)) continue;
    for (const c of argCandidates([a])) paths.push(c);
  }
  return { paths, outputs };
}

/**
 * Commands a git subcommand runs for us (`rebase -x`, `bisect run`, `submodule foreach`,
 * `filter-branch --tree-filter`, `difftool -x`): their shell code and argv, and the arguments
 * that are left for the path checks.
 */
function gitRunsCommands(sub: string, rest: string[]): { code: string[]; argvs: string[][]; forPaths: string[] } {
  const strip = (p: GitArgs, names: string[]) => rest.filter((_a, k) => !names.includes(p.valueIdx.get(k) ?? ''));
  if (sub === 'rebase') {
    const p = parseGitArgs(rest, 'xsXC', ['--exec', '--onto', '--strategy', '--strategy-option', '--whitespace']);
    const names = ['-x', '--exec'];
    return { code: names.flatMap((n) => p.vals.get(n) ?? []), argvs: [], forPaths: strip(p, names) };
  }
  if (sub === 'filter-branch') {
    const p = parseGitArgs(rest, 'd', [...FILTER_BRANCH_CMD_OPTS, '--subdirectory-filter', '--original', '--state-branch']);
    return { code: FILTER_BRANCH_CMD_OPTS.flatMap((n) => p.vals.get(n) ?? []), argvs: [], forPaths: strip(p, FILTER_BRANCH_CMD_OPTS) };
  }
  if (sub === 'difftool' || sub === 'mergetool') {
    const p = parseGitArgs(rest, 'xtX', ['--extcmd', '--tool']);
    return { code: ['-x', '--extcmd'].flatMap((n) => p.vals.get(n) ?? []), argvs: [], forPaths: strip(p, ['-x', '--extcmd']) };
  }
  if (sub === 'bisect' && (rest[0] ?? '').toLowerCase() === 'run') {
    // git quotes the arguments and runs them through a shell: exactly this argv
    return { code: [], argvs: rest.length > 1 ? [rest.slice(1)] : [], forPaths: [] };
  }
  if (sub === 'submodule') {
    const k = rest.findIndex((a) => !a.startsWith('-'));
    if (k >= 0 && rest[k]!.toLowerCase() === 'foreach') {
      let m = k + 1;
      while (m < rest.length && /^(--recursive|-q|--quiet)$/.test(rest[m]!)) m++;
      const words = rest.slice(m);
      // one argument is shell code; several are a command line (`sh -c '<first> "$@"'`)
      return { code: words.length ? [words.join(' ')] : [], argvs: words.length > 1 ? [words] : [], forPaths: rest.slice(0, k) };
    }
  }
  return { code: [], argvs: [], forPaths: rest };
}

function classifyGit(args: string[], sc: SegCtx): J {
  const ctx = sc.env.ctx;
  let i = 0;
  let gitCwd = sc.vcwd;
  let outsideRepo: string | undefined;
  let j = ok('', true);
  while (i < args.length && args[i]!.startsWith('-')) {
    const a = args[i]!;
    if (a === '-C') {
      const target = args[i + 1] ?? '';
      const r = resolveToken(target, gitCwd, ctx, sc.vals);
      if (r.kind !== 'path') return exact(sc.env, `git -C ${target} cannot be checked`);
      gitCwd = r.abs;
      i += 2;
      continue;
    }
    if (a === '-c' || a.startsWith('--config-env')) {
      if (a.startsWith('--config-env')) return refuse(TAMPER_DENY);
      const kv = args[i + 1] ?? '';
      const eq = kv.indexOf('=');
      const key = (eq < 0 ? kv : kv.slice(0, eq)).trim();
      const value = eq < 0 ? '' : kv.slice(eq + 1);
      if (/^(protocol|url|remote)\./i.test(key)) return refuse(TAMPER_DENY);
      if (GIT_SIGN_CONFIG.test(key) && !(/gpgsign$/i.test(key) && /^(false|no|off|0)$/i.test(value.trim()))) return refuse(SIGN_DENY);
      if (/^alias\./i.test(key)) {
        if (tokensHavePush(['git', ...value.split(/\s+/)])) return refuse(PUSH_DENY);
        if (value.startsWith('!')) j = merge(j, classifyCommand(value.slice(1), sc.vcwd, { ...sc.env, depth: sc.env.depth + 1 }));
        else j = merge(j, exact(sc.env, `git -c ${key} defines an alias`));
      } else if (GIT_EXEC_CONFIG.test(key) && !(/pager/i.test(key) && BENIGN_PAGER.test(value.trim()))) {
        j = merge(j, exact(sc.env, `git -c ${key}=... makes git run a command`));
      }
      i += 2;
      continue;
    }
    if (/^--(git-dir|work-tree|exec-path)(=|$)/.test(a)) return merge(j, exact(sc.env, 'git --git-dir/--work-tree/--exec-path can act on another repository or run other programs'));
    i += GIT_GLOBAL_VALUE_OPTS.has(a) ? 2 : 1;
  }
  // git works on the repository that contains its cwd: after `cd` / `-C` out of the worktree
  // that is someone else's repository (the user's checkout, another worktree)
  if (!inArea(ctx, gitCwd, 'w')) outsideRepo = gitCwd;
  const subWord = args[i] ?? '';
  if (isDynamic(subWord)) return refuse(DYNAMIC_PUSH_DENY);
  const sub = subWord.toLowerCase();
  const rest = args.slice(i + 1);
  if (PUSH_SUBS.has(sub)) return refuse(PUSH_DENY);
  const flagged = (re: RegExp) => rest.some((a) => re.test(a));
  // agents' commits are never signed (gitsafety.ts disables signing; refuse clearly instead)
  if (GIT_SIGNING_SUBS.has(sub)) {
    const p = parseGitArgs(rest, sub === 'commit' ? 'mFCct' : sub === 'commit-tree' ? 'mFp' : sub === 'rebase' ? 'xsXC' : sub === 'merge' || sub === 'pull' ? 'msXF' : 'mX', ['--message', '--file', '--author', '--date', '--exec', '--onto', '--strategy', '--strategy-option']);
    if (p.flags.has('-S') || [...p.flags].some((f) => f.startsWith('--gpg-sign')) || [...p.vals.keys()].some((k) => k === '--gpg-sign')) return refuse(SIGN_DENY);
  }
  if (sub === 'tag') {
    const p = parseGitArgs(rest, 'muF', ['--message', '--file', '--local-user']);
    if (p.flags.has('-s') || p.flags.has('--sign') || p.vals.has('-u') || p.vals.has('--local-user') || [...p.flags].some((f) => f.startsWith('--local-user'))) return refuse(SIGN_DENY);
  }

  // commands git runs for us: classified like any other command (push inside -> deny)
  const runs = gitRunsCommands(sub, rest);
  const nestedEnv: Env = { ...sc.env, depth: sc.env.depth + 1 };
  for (const code of runs.code) {
    const nj = classifyCommand(code, gitCwd, nestedEnv);
    if (nj.deny) return nj;
    j = merge(j, { ...nj, cwd: undefined, pathsOut: undefined });
  }
  for (const argv of runs.argvs) {
    if (tokensHavePush(argv)) return refuse(PUSH_DENY);
    const c0 = baseCmd(argv[0]!);
    const nj = classifyWords(c0, argv[0]!, argv.slice(1), { ...sc, vcwd: gitCwd, cmd: c0, env: nestedEnv }, { docs: [], pipeTrusted: false, viaXargs: false });
    if (nj.deny) return nj;
    j = merge(j, { ...nj, cwd: undefined, pathsOut: undefined });
  }

  const read = GIT_READ.has(sub) || sub === '';
  const gsc: SegCtx = { ...sc, vcwd: gitCwd, cmd: 'git' };
  if (outsideRepo) {
    const lower = outsideRepo.toLowerCase();
    j = merge(j, read ? need(`git ${sub} on a repository outside the worktree: ${outsideRepo}`, `Bash:outside:git ${sub}:rtree:${lower}`) : exact(sc.env, `git ${sub} changes a repository outside the worktree: ${outsideRepo}`));
  }
  const { paths, outputs } = gitPathCandidates(runs.forPaths);
  j = merge(j, pathAsks(paths, read ? 'r' : 'w', gsc), pathAsks(outputs.map((o) => (isPathCandidate(o, true) ? o : `./${o}`)), 'w', gsc));
  // writing a file (`git diff --output=x`) is never read-only (the lead)
  const writesFile = outputs.length > 0;

  const capability = (reason: string, key: string): J => merge(j, need(reason, key));
  const done = (reason: string, readOnly: boolean, extra: Partial<J> = {}): J => merge(j, ok(reason, readOnly && !writesFile, extra));
  if (!sub) return done('git', true);
  // `git <sub> --help` / `git help <topic>` open the manual (Git for Windows: in the browser)
  if ((sub === 'help' && (rest.some((a) => !a.startsWith('-')) || flagged(/^(-w|--web|-i|--info|-m|--man)$/))) || rest.includes('--help')) return merge(j, exact(sc.env, 'opens the git manual (in a browser or viewer window)'));
  if (sub === 'help') return done('git help', true);
  if (sub === 'difftool' || sub === 'mergetool') return merge(j, exact(sc.env, `git ${sub} launches an external tool`));
  if (sub === 'citool' || sub === 'gui' || sub === 'gitk') return merge(j, exact(sc.env, `git ${sub} opens a GUI window`));
  if (sub === 'filter-branch' || sub === 'filter-repo') return merge(j, exact(sc.env, `git ${sub} rewrites the history of every branch it is given (that can include the user's)`));
  if (sub === 'grep' && rest.some((a) => /^-O|^--open-files-in-pager/.test(a))) return merge(j, exact(sc.env, 'git grep -O runs a pager command'));
  if (GIT_READ.has(sub)) {
    const names = rest.some((a) => /^(--name-only|--name-status|-l|-L|--files-with-matches|--files-without-match|--porcelain(=\S+)?|-s|--short|-z)$/.test(a));
    const pathsOut = !writesFile && (sub === 'ls-files' || (names && ['diff', 'ls-tree', 'status', 'grep', 'show', 'log', 'diff-tree'].includes(sub)));
    return done(`git ${sub}`, true, pathsOut ? { pathsOut: true } : {});
  }
  if (GIT_NETWORK.has(sub)) return merge(j, exact(sc.env, `git ${sub} uses the network or other repositories (git transports are disabled for agents)`));
  const positional = rest.filter((a) => !a.startsWith('-'));
  const sub2 = (positional[0] ?? '').toLowerCase();
  switch (sub) {
    case 'reset':
      if (flagged(/^--(hard|keep|merge)$/)) return capability(`git reset ${rest.find((a) => a.startsWith('--'))} discards work in the worktree`, 'Bash:git reset --hard');
      return done('git reset (own branch)', false);
    case 'clean':
      if (flagged(/^(-n|--dry-run)$/) && !flagged(/^-[a-z]*f/i)) return done('git clean --dry-run', true);
      return capability('git clean deletes untracked files in the worktree', 'Bash:git clean');
    case 'checkout':
    case 'switch': {
      if (flagged(/^--ignore-other-worktrees$/)) return merge(j, exact(sc.env, `git ${sub} --ignore-other-worktrees checks out a branch that is checked out elsewhere (the user's checkout)`));
      if (sub === 'checkout' && flagged(/^-[a-zA-Z]*B$/)) return merge(j, exact(sc.env, 'git checkout -B resets a branch in the shared repository'));
      if (sub === 'switch' && flagged(/^(-C|--force-create)$/)) return merge(j, exact(sc.env, 'git switch -C resets a branch in the shared repository'));
      if ((sub === 'checkout' && (flagged(/^-[a-zA-Z]*b$/) || rest.includes('--orphan'))) || (sub === 'switch' && flagged(/^(-c|--create|--orphan)$/))) {
        return capability(`git ${sub} creates a branch in the shared repository`, 'Bash:git checkout -b');
      }
      if (sub === 'checkout' && rest.includes('--')) return done('git checkout -- <paths> (restore files)', false);
      if (rest.includes('-')) return merge(j, exact(sc.env, `git ${sub} - (the previous branch) cannot be checked`));
      // the approval covers switching to exactly this target
      const target = positional.join(' ').toLowerCase();
      if (positional.some(isDynamic)) return merge(j, exact(sc.env, `git ${sub} to a target that cannot be checked`));
      return capability(`git ${sub} switches the worktree to ${target || 'another branch'}`, `Bash:git ${sub}:${target}`);
    }
    case 'rebase': {
      const p = parseGitArgs(rest, 'xsXC', ['--exec', '--onto', '--strategy', '--strategy-option', '--whitespace']);
      if (p.flags.has('--update-refs')) return merge(j, exact(sc.env, 'git rebase --update-refs moves other branches that point into the rebased commits'));
      if (p.positional.length >= 2 || (p.flags.has('--root') && p.positional.length >= 1)) return merge(j, exact(sc.env, `git rebase ${p.positional.at(-1)} checks out and rewrites another branch`));
      return capability('git rebase rewrites the worktree branch', 'Bash:git rebase');
    }
    case 'bisect':
      if (sub2 === 'visualize' || sub2 === 'view') return merge(j, exact(sc.env, 'git bisect visualize opens gitk'));
      if (sub2 === 'run') return done('git bisect run (the command is checked like any other)', false);
      return done(`git bisect ${sub2}`.trim(), ['log', 'terms', ''].includes(sub2));
    case 'submodule':
      if (sub2 === 'foreach') return done('git submodule foreach (the command is checked like any other)', false);
      if (!sub2 || sub2 === 'status' || sub2 === 'summary') return done(`git submodule ${sub2 || 'status'}`, true);
      return merge(j, exact(sc.env, `git submodule ${sub2} changes submodules in the repository shared with the user's checkout, or uses the network`));
    case 'lfs':
      if (sub2 === 'push' || sub2 === 'pre-push') return refuse(PUSH_DENY);
      if (['ls-files', 'status', 'env', 'version', 'logs', 'ext', 'pointer'].includes(sub2)) return done(`git lfs ${sub2}`, true);
      if (sub2 === 'track' || sub2 === 'untrack') return done(`git lfs ${sub2} (.gitattributes)`, false);
      return merge(j, exact(sc.env, `git lfs ${sub2}: changes hooks or config, or uses the network`));
    case 'subtree':
      if (sub2 === 'push') return refuse(PUSH_DENY);
      return merge(j, exact(sc.env, `git subtree ${sub2} creates commits or branches, or uses the network`));
    case 'archive':
      if (rest.some((a) => /^--(remote|exec)(=|$)/.test(a))) return merge(j, exact(sc.env, 'git archive --remote uses another repository'));
      return done('git archive', !writesFile && !rest.some((a) => /^-o/.test(a)));
    case 'bundle':
      if (sub2 === 'create') return merge(j, pathAsks(positional.slice(1, 2).map((f) => (isPathCandidate(f, true) ? f : `./${f}`)), 'w', gsc), ok('git bundle create', false));
      if (sub2 === 'verify' || sub2 === 'list-heads') return done(`git bundle ${sub2}`, true);
      return merge(j, exact(sc.env, `git bundle ${sub2} writes objects or refs`));
    case 'init':
      if (flagged(/^--separate-git-dir(=|$)/)) return merge(j, exact(sc.env, 'git init --separate-git-dir moves a repository'));
      return capability('git init creates a repository', 'Bash:git init');
    case 'branch':
      if (listOnly(rest, BRANCH_LIST_FLAG)) return done('git branch (list)', true);
      if (flagged(/^(-[a-zA-Z]*[dDfmMcC]|--delete|--force|--move|--copy|--set-upstream-to(=.*)?|-u|--unset-upstream|--edit-description|--track|--no-track)$/)) return merge(j, exact(sc.env, 'git branch moves, renames or deletes branches in the shared repository'));
      return capability('git branch creates a branch in the shared repository', 'Bash:git branch create');
    case 'tag':
      if (listOnly(rest, TAG_LIST_FLAG)) return done('git tag (list)', true);
      if (flagged(/^(-[a-zA-Z]*[df]|--delete|--force)$/)) return merge(j, exact(sc.env, 'git tag moves or deletes tags in the shared repository'));
      return capability('git tag creates a tag in the shared repository', 'Bash:git tag create');
    case 'config':
      if (rest.some((a) => a === '--global' || a === '--system')) return configReadOnly(rest) ? done('git config --global (read)', true) : merge(j, exact(sc.env, 'changes your global git config'));
      if (configReadOnly(rest)) return done('git config (read)', true);
      return merge(j, exact(sc.env, "git config writes the shared repository's config (worktrees share it with the user's checkout)"));
    case 'stash': {
      const s = (rest.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
      if (s === 'list' || s === 'show') return done(`git stash ${s}`, true);
      return merge(j, exact(sc.env, "git stash uses the stash stack shared with the user's checkout"));
    }
    case 'notes': {
      const s = (rest.find((a) => !a.startsWith('-')) ?? 'list').toLowerCase();
      if (s === 'list' || s === 'show') return done(`git notes ${s}`, true);
      return merge(j, exact(sc.env, 'git notes writes shared refs'));
    }
    case 'reflog': {
      const s = (rest.find((a) => !a.startsWith('-')) ?? 'show').toLowerCase();
      if (!['expire', 'delete', 'drop'].includes(s)) return done('git reflog', true);
      return merge(j, exact(sc.env, 'git reflog expire/delete destroys history'));
    }
    case 'worktree': {
      const s = (rest.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
      if (s === 'list') return done('git worktree list', true);
      return merge(j, exact(sc.env, 'git worktree changes the shared worktree list'));
    }
    case 'remote': {
      const s = (rest.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
      if (!s || s === 'get-url') return done('git remote (list)', true);
      return merge(j, exact(sc.env, `git remote ${s} changes or contacts remotes`));
    }
  }
  if (GIT_WORKTREE.has(sub)) return done(`git ${sub}`, false);
  return merge(j, exact(sc.env, `git ${sub} changes repository state`));
}

function classifyPackageManager(cmd: string, rest: string[], sc: SegCtx): J {
  const paths = pathAsks(argCandidates(rest), 'w', sc);
  // npm exec [--offline] -- <installed tool> has the same local execution semantics as npx.
  // Only accept the simple form: package/call/prefix/config options keep the normal prompt.
  if (cmd === 'npm') {
    let i = 0;
    const flags: string[] = [];
    const takeFlags = () => {
      while (['--offline', '--no', '--no-install'].includes(rest[i] ?? '')) flags.push(rest[i++]!);
    };
    takeFlags();
    if (rest[i] === 'exec' || rest[i] === 'x') {
      i++;
      takeFlags();
      const separated = rest[i] === '--';
      if (separated) i++;
      const tool = rest[i];
      if (separated && tool && NPX_SAFE.has(tool) && (flags.length > 0 || localBin(tool, sc))) {
        return merge(paths, classifyWords(tool, tool, rest.slice(i + 1), { ...sc, cmd: tool }, { docs: [], pipeTrusted: false, viaXargs: false }));
      }
    }
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  const sub = (positional[0] ?? '').toLowerCase();
  if (rest.some((a) => /^(-g|--global|--location=global|--location=user)$/.test(a))) return merge(paths, exact(sc.env, `${cmd} ${sub} --global changes tools outside the worktree`));
  const LOCAL = ['test', 't', 'tst', 'run', 'run-script', 'rum', 'urn', 'ls', 'list', 'll', 'la', 'why', 'explain', 'pack', 'help', 'start', 'stop', 'restart', 'prefix', 'root', 'bin', 'config', 'get', 'exec-tests', 'fund', 'query', 'version', 'pkg', 'c'];
  if (!sub || LOCAL.includes(sub)) {
    if (sub === 'version' && positional.length > 1) return merge(paths, exact(sc.env, `${cmd} version bumps the version and creates a git tag`));
    if ((sub === 'config' || sub === 'c') && positional.some((a) => ['set', 'delete', 'edit', 'fix', 'rm'].includes(a))) return merge(paths, exact(sc.env, `${cmd} config changes your npm configuration`));
    if (sub === 'pkg' && positional.some((a) => ['set', 'delete', 'fix'].includes(a))) return merge(paths, need(`${cmd} pkg changes package.json`, `Bash:${cmd} pkg set`));
    return merge(paths, ok(`${cmd} ${sub}`.trim(), ['ls', 'list', 'll', 'la', 'why', 'explain', 'help', 'prefix', 'root', 'bin', 'get', 'query'].includes(sub)));
  }
  const RUN_PKG = ['exec', 'x', 'dlx', 'create', 'init', 'innit'];
  if (RUN_PKG.includes(sub)) {
    const pkg = (positional[1] ?? '').toLowerCase();
    if (!pkg || isDynamic(pkg)) return merge(paths, exact(sc.env, `${cmd} ${sub} downloads and runs a package`));
    return merge(paths, need(`${cmd} ${sub} ${pkg} downloads and runs a package`, `Bash:${cmd} ${sub} ${pkg}`));
  }
  const INSTALL = ['install', 'i', 'in', 'ins', 'isntall', 'add', 'ci', 'clean-install', 'install-test', 'it', 'install-ci-test', 'update', 'up', 'upgrade', 'udpate', 'uninstall', 'remove', 'rm', 'r', 'un', 'unlink', 'link', 'ln', 'dedupe', 'ddp', 'prune', 'rebuild', 'rb'];
  if (INSTALL.includes(sub)) {
    if (sub === 'link' || sub === 'ln') return merge(paths, exact(sc.env, `${cmd} link links packages outside the worktree`));
    return merge(paths, need(`${cmd} ${sub} downloads packages (network) and changes dependencies`, `Bash:${cmd} ${sub}`));
  }
  const ACCOUNT = ['publish', 'unpublish', 'deprecate', 'dist-tag', 'owner', 'access', 'team', 'org', 'token', 'profile', 'login', 'logout', 'adduser', 'hook', 'star', 'unstar'];
  if (ACCOUNT.includes(sub)) return merge(paths, exact(sc.env, `${cmd} ${sub}: changes things on the package registry`));
  const REGISTRY = ['view', 'v', 'info', 'show', 'search', 's', 'se', 'find', 'outdated', 'audit', 'ping', 'whoami', 'doctor', 'stars', 'repo', 'docs', 'home', 'bugs', 'sbom'];
  if (REGISTRY.includes(sub)) {
    const fix = sub === 'audit' && positional.includes('fix') ? ' fix' : '';
    return merge(paths, need(`${cmd} ${sub}${fix}: network access (talks to the package registry)`, `Bash:${cmd} ${sub}${fix}`));
  }
  return merge(paths, exact(sc.env, `${cmd} ${sub}: package manager command that may use the network or change dependencies`));
}

/** Inline code for node/python/etc.: the code string, or undefined. */
function inlineCode(cmd: string, rest: string[]): string | undefined {
  const flags =
    cmd === 'python' || cmd === 'python3' || cmd === 'py' ? ['-c'] : cmd === 'php' ? ['-r'] : cmd === 'deno' ? ['eval'] : ['-e', '--eval', '-p', '--print', '-pe', '-ne'];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    for (const f of flags) {
      if (a === f) return rest[i + 1] ?? '';
      if (a.startsWith(`${f}=`)) return a.slice(f.length + 1);
    }
  }
  return undefined;
}

/** The value a substitution produces, when it is knowable: `$(pwd)`, or a list of worktree paths. */
function substValue(body: string, sj: J, vcwd: string, ctx: PolicyContext): string | undefined {
  const b = body.trim();
  if (sj.deny || sj.asks.length) return undefined;
  if (b === 'pwd') return vcwd;
  if (b === 'git rev-parse --show-toplevel' && isInsideOrEqual(vcwd, ctx.cwd)) return ctx.cwd;
  if (sj.pathsOut) return 'x';
  return undefined;
}

/** Classify one simple command (a segment between ; && || | etc.). */
function classifySegment(seg: Segment, vcwd: string, env: Env, substs: Subst[], pipeTrusted: boolean, piped: string | undefined): J {
  const ctx = env.ctx;
  const lx = lex(seg.text);
  // here-documents and here-strings this command reads
  const docs: string[] = [];
  let acc = ok('', true);
  for (const ref of lx.heredocRefs ?? []) {
    const hd = env.heredocs[ref];
    if (!hd) {
      acc = merge(acc, exact(env, 'a here-document cannot be matched to its command'));
      continue;
    }
    env.usedHeredocs.add(ref);
    docs.push(hd.quoted ? hd.body : extractSubst(hd.body, substs, false));
  }
  docs.push(...(lx.herestrings ?? []));

  // command substitutions used in this segment: classify each as a command of its own
  const vals: Vals = new Map();
  for (const text of [seg.text, ...docs]) {
    for (const m of text.matchAll(MARK_RE)) {
      const k = Number(m[1]);
      if (vals.has(k)) continue;
      const s = substs[k];
      if (!s) continue;
      if (s.unbalanced) acc = merge(acc, exact(env, 'unbalanced command substitution'));
      const sj = classifyCommand(s.body, vcwd, { ...env, depth: env.depth + 1 });
      acc = merge(acc, { ...sj, cwd: undefined, pathsOut: undefined });
      // <(cmd) / >(cmd) become a pipe path (/dev/fd/N); the command behind it was just checked
      vals.set(k, s.kind === '<(' || s.kind === '>(' ? '/dev/fd/63' : substValue(s.body, sj, vcwd, ctx));
      if (acc.deny) return acc;
    }
  }

  let words = lx.words.filter((w) => w !== '{' && w !== '}');
  // shell keywords: `if x`, `then y`, `do z`, `! cmd`, `time cmd`; list headers are data
  while (words.length && ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time', 'fi', 'done', 'esac', 'coproc'].includes(words[0]!)) words = words.slice(1);
  if (words.length && ['for', 'select', 'case', 'in'].includes(words[0]!)) words = [];
  if (tokensHavePush(words)) return refuse(PUSH_DENY);
  const writes = lx.redirects.filter((r) => r.op === '>').map((r) => r.target);
  const reads = lx.redirects.filter((r) => r.op === '<').map((r) => r.target);
  const uw = unwrap(words);
  const w = uw.words;
  const cmdWord = w[0] ?? '';
  const cmd = cmdWord ? baseCmd(cmdWord) : '';
  const rest = w.slice(1);
  const sc: SegCtx = { env, vcwd, vals, cmd: cmd || 'redirect' };

  if (uw.clearsEnv) return refuse(`env -i would drop ${TAMPER_DENY.replace(/^that would change /, '')}`);
  // variables whose NAME cannot be checked (`export "${x}DIR=..."`, `read "$v"`, namerefs) could be
  // a git variable that points git at the user's repository
  if (VAR_SETTERS.has(cmd)) {
    const names = rest.filter((a) => !/^[-+][A-Za-z]+$/.test(a)).map((a) => (a.includes('=') ? a.slice(0, a.indexOf('=')) : a));
    const nameref = rest.some((a) => /^-[A-Za-z]*n/.test(a)) && ['declare', 'typeset', 'local'].includes(cmd);
    const printfVar = cmd === 'printf' ? (rest[0] === '-v' ? [rest[1] ?? ''] : []) : undefined;
    const checked = printfVar ?? (cmd === 'read' || cmd === 'mapfile' || cmd === 'readarray' ? names.filter((n) => !/^-/.test(n)) : names);
    if (nameref || checked.some((n) => isDynamic(n))) acc = merge(acc, exact(env, `${cmd} sets a variable whose name cannot be checked`));
  }
  // VAR=value prefixes that make commands run code (GIT_PAGER, EDITOR, NODE_OPTIONS, ...)
  const assigns = cmd === 'export' || cmd === 'declare' || cmd === 'typeset' || cmd === 'local' || cmd === 'readonly' ? [...uw.assigns, ...rest.filter((a) => a.includes('='))] : uw.assigns;
  for (const a of assigns) {
    const name = a.slice(0, a.indexOf('='));
    const value = a.slice(a.indexOf('=') + 1);
    if (EXEC_VARS.test(name) && !(/PAGER/i.test(name) && BENIGN_PAGER.test(value.trim()))) acc = merge(acc, exact(env, `sets ${name}, which makes later commands run other programs`));
    if (/^YAMS_/i.test(name) && !(/^YAMS_(ALLOW_NET|NO_SERVICE)$/i.test(name) && value === (name.toUpperCase() === 'YAMS_ALLOW_NET' ? '0' : '1'))) {
      acc = merge(acc, exact(env, `sets ${name}, which can change Yams paths or enable downloads`));
    }
  }

  // redirections: `> file` writes, `< file` reads (relative targets resolve in the virtual cwd)
  acc = merge(acc, pathAsks(writes.map((t) => (isPathCandidate(t, true) ? t : `./${t}`)), 'w', sc), pathAsks(reads.filter((t) => isPathCandidate(t)), 'r', sc));
  const hasWrites = writes.some((t) => !SPECIAL_FILES.test(t));
  acc = merge(acc, pathAsks(uw.extraPaths, 'w', sc));

  let body: J;
  if (uw.inner !== undefined) body = { ...classifyCommand(uw.inner, vcwd, { ...env, depth: env.depth + 1 }), cwd: undefined };
  else body = classifyWords(cmd, cmdWord, rest, sc, { docs, pipeTrusted, piped, viaXargs: uw.viaXargs });
  const out = merge(acc, body);
  // a command that writes a file through a redirection is never read-only (lead: `git log > x`)
  return { ...out, readOnly: out.readOnly && !hasWrites, ...(body.cwd !== undefined ? { cwd: body.cwd } : {}), ...(body.pathsOut !== undefined ? { pathsOut: body.pathsOut && !hasWrites } : {}) };
}

interface WordsOpts {
  /** here-document / here-string bodies fed to stdin */
  docs: string[];
  /** stdin is a list of worktree paths */
  pipeTrusted: boolean;
  /** stdin is this literal text (`echo "..." | bash`) */
  piped?: string | undefined;
  viaXargs: boolean;
}

function stripCmdSwitches(cmd: string, args: string[]): { args: string[]; switches: string[] } {
  if (!CMD_SWITCH_CMDS.has(cmd)) return { args, switches: [] };
  const switches = args.filter((a) => /^\/[A-Za-z?]{1,2}(:\S*)?$/.test(a));
  return { args: args.filter((a) => !switches.includes(a)), switches };
}

function classifyWords(cmd: string, cmdWord: string, rest: string[], sc: SegCtx, o: WordsOpts): J {
  const env = sc.env;
  const ctx = env.ctx;
  const vcwd = sc.vcwd;
  if (!cmd) return ok('empty', true);
  if (isDynamic(cmdWord)) {
    if (rest.some((a) => PUSH_SUBS.has(a.toLowerCase()))) return refuse(DYNAMIC_PUSH_DENY);
    return exact(env, 'the command name comes from a variable or substitution and cannot be checked');
  }

  // xargs: the arguments come from stdin
  if (o.viaXargs) {
    const readOnlyCmd = (READ_CMDS.has(cmd) || GREP_CMDS.has(cmd)) && !['env', 'command'].includes(cmd);
    const inner = classifyWords(cmd, cmdWord, rest, sc, { ...o, viaXargs: false, docs: [], piped: undefined });
    if (inner.deny) return inner;
    if (readOnlyCmd && o.pipeTrusted) return { ...inner, pathsOut: false };
    return merge(inner, exact(env, `xargs ${cmd}: its arguments come from input and cannot be checked`), ok('', false, { pathsOut: false }));
  }

  // lead only: workers can write files, so their `bd` could be a fake on PATH
  if (ctx.role === 'lead' && leadReadCommand(cmd, cmdWord, rest, ctx)) return ok(`${cmd}: declared read-only`, true);

  // ---- directory changes ----
  if (['cd', 'pushd', 'chdir', 'set-location', 'sl'].includes(cmd)) {
    // cmd.exe style `cd /d <path>` (seen from real agents): the switch is not the target. In Git
    // Bash that command fails and the cwd stays put, so judging <path> is safe either way.
    const args = rest.length > 1 && /^\/d$/i.test(rest[0]!) ? rest.slice(1) : rest;
    const target = args.find((a) => !a.startsWith('-') || a === '-') ?? '~';
    if (target === '-') return exact(env, 'cd - (previous directory) cannot be checked');
    const r = resolveToken(target, vcwd, ctx, sc.vals);
    if (r.kind !== 'path') return exact(env, `cd to a path that cannot be checked: ${target}`);
    if (!inArea(ctx, r.abs, 'r')) return { ...need(`changes directory outside the worktree: ${r.abs}`, `Bash:cd:${r.abs.toLowerCase()}`), cwd: r.abs };
    return ok(`cd ${target}`, true, { cwd: r.abs });
  }
  if (cmd === 'popd') return ok('popd', true, { cwd: ctx.cwd });

  if (NET_HTTP.has(cmd)) {
    const paths = pathAsks(argCandidates(rest, true), 'w', sc);
    const hosts = [
      ...new Set(
        rest.flatMap((a) => {
          try {
            const u = new URL(a.replace(/^-+[\w-]+=/, ''));
            return /^https?:$|^ftps?:$/.test(u.protocol) && u.hostname ? [u.hostname.toLowerCase()] : [];
          } catch {
            return [];
          }
        }),
      ),
    ].sort();
    if (!hosts.length || rest.some((a) => a.includes(MARK))) return merge(paths, exact(env, `network access (${cmd})`));
    return merge(paths, need(`network access (${cmd} ${hosts.join(', ')})`, `Bash:net:${cmd}:${hosts.join(',')}`));
  }
  if (NET_SUBCOMMAND.has(cmd)) {
    const paths = pathAsks(argCandidates(rest, true), 'w', sc);
    const subs = rest.filter((a) => !a.startsWith('-')).slice(0, 2).map((s) => s.toLowerCase());
    if (!subs.length || ['api', 'alias', 'extension', 'ext', 'auth', 'secret', 'variable', 'ssh-key', 'gpg-key', 'config'].includes(subs[0]!) || subs.some(isDynamic)) return merge(paths, exact(env, `network access (${cmd}${subs[0] ? ` ${subs[0]}` : ''})`));
    return merge(paths, need(`network access (${cmd} ${subs.join(' ')})`, `Bash:net:${cmd}:${subs.join(' ')}`));
  }
  if (NET_EXACT.has(cmd)) return exact(env, `network or remote access (${cmd})`);
  if (SYSTEM_CMDS.has(cmd)) return exact(env, `process or system command (${cmd})`);
  if (LINK_CMDS.has(cmd) || ((cmd === 'new-item' || cmd === 'ni') && rest.some((a) => /^(symboliclink|junction|hardlink)$/i.test(a)))) return exact(env, `${cmd} creates a link (links can lead out of the worktree)`);

  if (DELETE_CMDS.has(cmd)) {
    const { args, switches } = stripCmdSwitches(cmd, rest);
    const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || /^--recursive$|^-recurse$/i.test(a)) || switches.some((s) => /^\/s$/i.test(s));
    const targets = args.filter((a) => !a.startsWith('-') || a === '-');
    const valueArgs = args.filter((a) => /^-(path|literalpath)$/i.test(a)).length ? args.filter((_a, i) => /^-(path|literalpath)$/i.test(args[i - 1] ?? '')) : [];
    const all = [...targets, ...valueArgs].map((t) => (isPathCandidate(t, true) ? t : `./${t}`));
    const paths = pathAsks(all, 'w', sc, { recursive });
    if (!recursive) return merge(paths, ok(`${cmd} inside the worktree`, false));
    // the capability key covers recursive deletes inside the worktree only; outside targets
    // carry their own tree keys (above)
    const inside = all.some((t) => {
      const r = resolveToken(t, sc.vcwd, ctx, sc.vals);
      return r.kind === 'path' && inArea(ctx, r.abs, 'w', { recursive: true });
    });
    return inside ? merge(paths, need(`recursive delete inside the worktree (${cmd})`, cmd === 'rm' ? 'Bash:rm -r' : `Bash:${cmd} -r`)) : merge(paths, ok('', false));
  }
  if (cmd === 'chmod' || cmd === 'attrib' || cmd === 'dd') {
    const { args, switches } = stripCmdSwitches(cmd, rest);
    const recursive = args.some((a) => /^-[a-zA-Z]*R/.test(a) || a === '--recursive') || switches.some((s) => /^\/s$/i.test(s));
    const paths = pathAsks(argCandidates(args, true), 'w', sc, { recursive });
    return merge(paths, need(`${cmd} changes files inside the worktree`, `Bash:${cmd}`));
  }

  if (cmd === 'git') return classifyGit(rest, sc);
  if (cmd === 'yams') {
    // Search and rebuild only the current project's local cache. Other projects, corpus/socket
    // overrides, wiki writes, downloads and unknown future flags need explicit approval.
    if (!isInsideOrEqual(vcwd, ctx.cwd) || !realInside(vcwd, ctx.cwd)) return exact(env, 'Yams outside this worktree');
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (isDynamic(arg)) return exact(env, 'Yams arguments cannot be checked');
      if (arg === '--') break;
      if (['--json', '--full', '--index', '--stats', '--no-gate', '--explain', '--version', '--help', '-h'].includes(arg)) continue;
      if (['-k', '--min-score', '--max-gap'].includes(arg)) {
        if (!/^-?\d+(\.\d+)?$/.test(rest[++i] ?? '')) return exact(env, 'Yams numeric option cannot be checked');
        continue;
      }
      if (/^-k\d+$|^--(?:min-score|max-gap)=-?\d+(\.\d+)?$/.test(arg)) continue;
      if (arg.startsWith('-')) return exact(env, `Yams option needs approval: ${arg}`);
    }
    return ok('Yams local project search/cache', !rest.includes('--index'));
  }
  if (cmd === 'playwright') {
    const paths = pathAsks(argCandidates(rest, true), 'w', sc);
    if (['test', '--version', '--help', '-h', 'help'].includes(rest[0] ?? '')) return merge(paths, ok('Playwright project tests', false));
    return merge(paths, need('Playwright downloads browsers, opens a browser or manages local processes', `Bash:playwright ${rest[0] ?? ''}`));
  }
  // eval "<cmd>": classify the evaluated command
  if (cmd === 'eval') return classifyCommand(rest.join(' '), vcwd, { ...env, depth: env.depth + 1 });
  // source/. runs a script in the current shell: like running a project script
  if (cmd === 'source' || cmd === '.') {
    const script = rest[0] ?? '';
    return merge(pathAsks([isPathCandidate(script, true) ? script : `./${script}`], 'x', sc), ok(`${cmd} (project script)`, false));
  }
  if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(cmd)) return ok(cmd, true);

  const bunFile = cmd === 'bun' && /[./\\]/.test(rest.find((a) => !a.startsWith('-')) ?? '') && !['run', 'test', 'x'].includes(rest[0] ?? '');
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) && !(cmd === 'bun' && (inlineCode(cmd, rest) !== undefined || bunFile))) return classifyPackageManager(cmd, rest, sc);
  if (cmd === 'npx' || cmd === 'pnpx' || cmd === 'bunx') {
    // npx [npx options] <tool> [tool args]: npx downloads (and runs) any tool that is not installed
    let k = 0;
    const npxFlags: string[] = [];
    while (k < rest.length && rest[k]!.startsWith('-')) {
      npxFlags.push(rest[k]!);
      if (/^(-p|--package|-c|--call)$/.test(rest[k]!)) npxFlags.push(rest[++k] ?? '');
      k++;
    }
    const toolWord = rest[k] ?? '';
    const tool = toolWord.toLowerCase();
    const paths = pathAsks(argCandidates(rest), 'w', sc);
    if (npxFlags.some((f) => /^(-c|--call)(=|$)/.test(f))) return merge(paths, exact(env, `${cmd} -c runs a shell command string`));
    if (!tool || isDynamic(tool)) return merge(paths, exact(env, `${cmd} may download and run a package`));
    const noInstall = npxFlags.some((f) => /^(--no-install|--no|--offline)$/.test(f));
    const fetches = cmd === 'pnpx' || npxFlags.some((f) => /^(-y|--yes|-p|--package(=.*)?)$/.test(f)) || tool.slice(1).includes('@');
    if (NPX_SAFE.has(tool) && !fetches && (noInstall || localBin(tool, sc))) {
      // a dev tool the project installed: judged like running the tool itself (`vite` serving asks)
      return merge(paths, classifyWords(tool, toolWord, rest.slice(k + 1), sc, { ...o, viaXargs: false }), ok(`${cmd} ${tool} (installed in the worktree)`, false));
    }
    return merge(paths, need(`${cmd} ${tool} may download and run a package${NPX_SAFE.has(tool) && !fetches ? ` (${tool} is not installed in this worktree)` : ''}`, `Bash:npx ${tool}`));
  }
  if (SYS_PKG.has(cmd)) {
    const sub = (rest.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
    if ((cmd === 'pip' || cmd === 'pip3') && ['list', 'show', 'freeze', 'check'].includes(sub)) return ok(`${cmd} ${sub}`, true);
    return exact(env, `${cmd} ${sub}: system package manager (network / installs outside the worktree)`);
  }

  // ---- interpreters: inline code is inspected; scripts in the worktree run like tests ----
  if (INTERPRETERS.has(cmd)) {
    const code = inlineCode(cmd, rest);
    if (code !== undefined) return inlineCodeVerdict(cmd, code, sc);
    const mi = rest.indexOf('-m');
    if ((cmd === 'python' || cmd === 'python3' || cmd === 'py') && mi >= 0) {
      const mod = (rest[mi + 1] ?? '').toLowerCase();
      const paths = pathAsks(argCandidates(rest.slice(mi + 2), true), 'w', sc);
      if (mod === 'pip') return merge(paths, exact(env, `${cmd} -m pip: package manager (network / installs)`));
      if (!PY_SAFE_MODULES.has(mod)) return merge(paths, isDynamic(mod) ? exact(env, `${cmd} -m <dynamic>`) : need(`${cmd} -m ${mod}`, `Bash:${cmd} -m ${mod}`));
      return merge(paths, ok(`${cmd} -m ${mod}`, false));
    }
    if (cmd === 'deno' && rest.some((a) => /^--allow-(net|run|all|write|env|ffi|sys)/.test(a) || a === '-A')) return exact(env, 'deno with broad permissions');
    const scriptIdx = rest.findIndex((a) => !a.startsWith('-'));
    const script = scriptIdx >= 0 ? rest[scriptIdx]! : undefined;
    const scriptJ = script && !['run', 'test', 'x'].includes(script) ? pathAsks([isPathCandidate(script, true) ? script : `./${script}`], 'x', sc) : ok('', true);
    const argsJ = pathAsks(argCandidates(rest.filter((_a, i) => i !== scriptIdx), true), 'w', sc);
    // code on stdin: a here-document, a here-string or `echo "..." | node`
    const stdin = !script ? [...o.docs, ...(o.piped !== undefined ? [o.piped] : [])] : [];
    let stdinJ = ok('', true);
    for (const d of stdin) stdinJ = merge(stdinJ, inlineCodeVerdict(cmd, d, sc));
    if (!script && !stdin.length && o.piped === undefined && !o.docs.length && rest.length === 0) stdinJ = ok('', false); // REPL / version check
    return merge(scriptJ, argsJ, stdinJ, ok(`${cmd} (runs project code)`, false));
  }

  // ---- nested shells: classify the inner command ----
  if (SHELLS.has(cmd)) {
    if (env.depth >= MAX_DEPTH) return exact(env, 'deeply nested shell');
    let inner: string | undefined;
    if (cmd === 'cmd') {
      const k = rest.findIndex((a) => /^\/[ckCK]$/.test(a));
      if (k >= 0) inner = rest.slice(k + 1).join(' ');
    } else if (cmd === 'powershell' || cmd === 'pwsh') {
      if (rest.some((a) => /^-(e|ec|en|enc|encodedcommand)$/i.test(a))) return exact(env, 'encoded PowerShell command cannot be checked');
      const k = rest.findIndex((a) => /^-(c|command)$/i.test(a));
      if (k >= 0) inner = rest.slice(k + 1).join(' ');
    } else {
      const k = rest.findIndex((a) => /^-[a-zA-Z]*c$/.test(a));
      if (k >= 0) inner = rest[k + 1] ?? '';
    }
    // a nested shell's `cd` does not carry over to the commands after it
    if (inner !== undefined) return { ...classifyCommand(inner, vcwd, { ...env, depth: env.depth + 1 }), cwd: undefined };
    const script = rest.find((a) => !a.startsWith('-') && a !== '-');
    if (script) {
      const r = resolveToken(script, vcwd, ctx, sc.vals);
      if (r.kind !== 'path') return exact(env, `${cmd} runs a script that cannot be checked: ${script}`);
      if (!inArea(ctx, r.abs, 'x')) return need(`${cmd} runs a script outside the worktree: ${r.abs}`, `Bash:outside:${cmd}:x:${r.abs.toLowerCase()}`);
      return need(`runs a shell script (${cmd} ${script})`, `Bash:${cmd} script:${path.relative(ctx.cwd, r.abs).replace(/\\/g, '/').toLowerCase()}`);
    }
    // script on stdin: here-document, here-string, or `echo "..." | bash`
    const stdin = [...o.docs, ...(o.piped !== undefined ? [o.piped] : [])];
    if (stdin.length) {
      let j = ok(`${cmd} reading a checked script`, false);
      for (const d of stdin) j = merge(j, { ...classifyCommand(d, vcwd, { ...env, depth: env.depth + 1 }), cwd: undefined });
      return j;
    }
    return exact(env, `runs a shell whose script comes from input and cannot be checked (${cmd})`);
  }

  if (cmd === 'find') return classifyFind(rest, sc);

  if (cmd === 'sed' || cmd === 'awk' || cmd === 'gawk' || cmd === 'mawk') {
    const scripts: string[] = [];
    const files: string[] = [];
    let explicitScript = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === '-e' || a === '--expression') {
        scripts.push(rest[++i] ?? '');
        explicitScript = true;
      } else if (a === '-f' || a === '--file') {
        files.push(rest[++i] ?? '');
        explicitScript = true;
      } else if (cmd !== 'sed' && (a === '-v' || a === '-F')) i++;
      else if (!a.startsWith('-')) files.push(a);
    }
    if (!explicitScript && files.length) scripts.push(files.shift()!);
    const inPlace = cmd === 'sed' && rest.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
    let j = ok('', true);
    for (const s of scripts) {
      if (scanForPush(s)) return refuse(PUSH_DENY);
      if (cmd === 'sed' && /(^|[;{}\n]|\/[gpiImMe\d]*)\s*[wWe]\b|\/[gpiImM\d]*[ew][gpiImM\d]*\s*($|[;}\n])/.test(s)) j = merge(j, exact(env, 'sed script writes files or runs commands (w/e)'));
      if (cmd !== 'sed' && /\bsystem\s*\(|\|\s*getline|\bprint[f]?\b[^;]*[>|]|getline\s*<|\bclose\s*\(/.test(s)) j = merge(j, exact(env, `${cmd} program runs commands or writes files`));
      j = merge(j, pathAsks(embeddedPaths(s), 'w', sc));
    }
    j = merge(j, pathAsks(files.filter((f) => isPathCandidate(f, inPlace)), inPlace ? 'w' : 'r', sc));
    return merge(j, ok(inPlace ? 'in-place edit inside worktree' : cmd, !inPlace, { pathsOut: false }));
  }

  if (GREP_CMDS.has(cmd)) {
    const { args, switches } = stripCmdSwitches(cmd, rest);
    const explicitPattern = args.some((a) => a === '-e' || a === '--regexp' || a === '-f' || a === '--file');
    let skippedPattern = explicitPattern;
    const paths: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (['-e', '--regexp', '-g', '--glob', '-t', '--type', '-m', '--max-count', '-A', '-B', '-C', '--context', '--include', '--exclude', '--exclude-dir', '-T', '--type-not', '--max-depth', '-d'].includes(a)) {
        i++;
        continue;
      }
      if (a === '-f' || a === '--file') {
        paths.push(args[++i] ?? '');
        continue;
      }
      if (a.startsWith('-')) continue;
      if (!skippedPattern) {
        skippedPattern = true;
        continue;
      }
      paths.push(a);
    }
    const recursive = ['rg', 'ag', 'ack'].includes(cmd) || args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive' || a === '--dereference-recursive' || a === '-Recurse') || switches.some((s) => /^\/s$/i.test(s));
    const j = pathAsks(paths.filter((p) => isPathCandidate(p)), 'r', sc, { recursive });
    const listsFiles = args.some((a) => /^(-[a-zA-Z]*[lL][a-zA-Z]*|--files-with-matches|--files-without-match|--files)$/.test(a));
    const filtersStdin = !paths.length && !args.some((a) => /^(-[a-zA-Z]*[ocbnH][a-zA-Z]*|--only-matching|--count|--byte-offset|--line-number|--with-filename|-r|--recursive)$/.test(a));
    return merge(j, ok(cmd, true, { pathsOut: (listsFiles && !j.asks.length) || (filtersStdin && o.pipeTrusted) }));
  }

  if (cmd === 'sort' || cmd === 'uniq') {
    const outFile = cmd === 'sort' ? rest[rest.findIndex((a) => a === '-o' || a === '--output') + 1] : rest.filter((a) => !a.startsWith('-'))[1];
    const ins = rest.filter((a) => !a.startsWith('-') && a !== outFile);
    const j = merge(pathAsks(argCandidates(ins), 'r', sc), outFile ? pathAsks([isPathCandidate(outFile, true) ? outFile : `./${outFile}`], 'w', sc) : undefined);
    return merge(j, ok(cmd, !outFile, { pathsOut: !ins.length && !outFile && o.pipeTrusted }));
  }

  if (PS_BLOCK_CMDS.has(cmd)) {
    const inner = psBlockCommand(rest);
    if (inner !== undefined) return merge({ ...classifyCommand(inner, sc.vcwd, { ...sc.env, depth: sc.env.depth + 1 }), cwd: undefined, pathsOut: undefined }, ok(cmd, false, { pathsOut: false }));
  }
  if (READ_CMDS.has(cmd)) {
    if (NO_PATH_CMDS.has(cmd)) {
      // `env`/`command` with a command after them were unwrapped already; what is left only prints
      return ok(cmd, true, { pathsOut: false });
    }
    const { args, switches } = stripCmdSwitches(cmd, rest);
    // readers that can also write a file: `tree -o out`, `xxd in out`, `yq -i`
    const outs = cmd === 'tree' && args.includes('-o') ? [args[args.indexOf('-o') + 1] ?? ''] : cmd === 'xxd' ? args.filter((a) => !a.startsWith('-')).slice(1, 2) : cmd === 'yq' && args.some((a) => /^(-i|--inplace)$/.test(a)) ? args.filter((a) => !a.startsWith('-')).slice(1) : [];
    if (outs.length) {
      const wj = pathAsks(outs.map((f) => (isPathCandidate(f, true) ? f : `./${f}`)), 'w', sc);
      return merge(pathAsks(argCandidates(args.filter((a) => !outs.includes(a))), 'r', sc), wj, ok(`${cmd} (writes ${outs.join(', ')})`, false, { pathsOut: false }));
    }
    const recursive = RECURSIVE_READERS.has(cmd) || (cmd === 'ls' && args.some((a) => /^-[a-zA-Z]*R/.test(a))) || ((cmd === 'get-childitem' || cmd === 'gci') && args.some((a) => /^-recurse$/i.test(a))) || (cmd === 'dir' && switches.some((s) => /^\/s$/i.test(s)));
    const j = pathAsks(argCandidates(args), 'r', sc, { recursive });
    const positional = args.filter((a) => !a.startsWith('-'));
    const passthrough = ['cat', 'head', 'tail', 'tac'].includes(cmd) && !positional.length && o.pipeTrusted;
    const listing = cmd === 'ls' && !args.some((a) => /^-[a-zA-Z]*[lgnos]/.test(a)) && !j.asks.length;
    return merge(j, ok(cmd, true, { pathsOut: passthrough || listing }));
  }
  if (PS_WRITERS.has(cmd)) {
    let target: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (/^-(path|literalpath|lp|filepath|pspath)$/i.test(a)) target = rest[++i];
      else if (/^-(value|encoding|inputobject|delimiter|stream|width)$/i.test(a)) i++;
      else if (!a.startsWith('-')) positional.push(a);
    }
    target ??= positional[0];
    if (!target) return exact(env, `${cmd} without a file to write`);
    return merge(pathAsks([isPathCandidate(target, true) ? target : `./${target}`], 'w', sc), ok(`${cmd} inside worktree`, false));
  }
  if (WRITE_CMDS.has(cmd)) {
    const { args } = stripCmdSwitches(cmd, rest);
    return merge(pathAsks(argCandidates(args, true), 'w', sc), ok(`${cmd} inside worktree`, false));
  }
  if (COPY_CMDS.has(cmd) || MOVE_CMDS.has(cmd)) {
    const { args, switches } = stripCmdSwitches(cmd, rest);
    const move = MOVE_CMDS.has(cmd);
    const recursive = args.some((a) => /^-[a-zA-Z]*[rRa]/.test(a) || a === '--recursive' || a === '--archive' || /^-recurse$/i.test(a)) || switches.some((s) => /^\/[se]$/i.test(s));
    let dest: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '-t' || /^-(destination)$/i.test(a)) {
        dest = args[++i];
        continue;
      }
      if (a.startsWith('--target-directory=')) {
        dest = a.slice(19);
        continue;
      }
      if (/^-(path|literalpath)$/i.test(a)) {
        positional.push(args[++i] ?? '');
        continue;
      }
      if (a.startsWith('-')) continue;
      positional.push(a);
    }
    if (dest === undefined && positional.length > 1) dest = positional.pop();
    const norm = (t: string) => (isPathCandidate(t, true) ? t : `./${t}`);
    // a moved directory takes its whole tree with it
    const srcJ = pathAsks(positional.map(norm), move ? 'w' : 'r', sc, { recursive: recursive || move });
    const destIsDir = dest !== undefined && (/[\\/]$/.test(dest) || positional.length > 1 || isDirectory(dest, sc));
    const destJ = dest !== undefined ? pathAsks([norm(dest)], 'w', sc, { recursive, dir: destIsDir }) : undefined;
    return merge(srcJ, destJ, ok(`${cmd} inside worktree`, false));
  }
  if (DEV_TOOLS.has(cmd)) {
    const sub = (rest[0] ?? '').toLowerCase();
    const paths = pathAsks(argCandidates(rest, true), 'w', sc);
    if ((cmd === 'go' && sub === 'install') || (cmd === 'cargo' && ['install', 'publish', 'login', 'owner', 'yank', 'logout'].includes(sub)) || (cmd === 'dotnet' && ['tool', 'workload', 'nuget'].includes(sub))) return merge(paths, exact(env, `${cmd} ${sub} installs or publishes outside the worktree`));
    if ((cmd === 'go' && ['get', 'mod'].includes(sub)) || (cmd === 'cargo' && ['add', 'update', 'search', 'fetch'].includes(sub)) || (cmd === 'dotnet' && ['add', 'restore', 'publish'].includes(sub))) return merge(paths, need(`${cmd} ${sub} uses the network`, `Bash:${cmd} ${sub}`));
    // dev servers listen on a local port (and keep running)
    const vsub = rest[0] && !rest[0].startsWith('-') ? sub : '';
    const versionOnly = rest.some((a) => /^(-v|--version|-h|--help)$/.test(a));
    if (!versionOnly && ((cmd === 'vite' && !['build', 'optimize', 'help'].includes(vsub)) || (cmd === 'webpack' && ['serve', 'server', 's'].includes(sub)))) {
      return merge(paths, need(`${cmd}${vsub ? ` ${vsub}` : ''} starts a dev server that listens on a local port`, `Bash:${cmd} serve`));
    }
    return merge(paths, ok(`${cmd} (project tool)`, false));
  }
  return exact(env, `unrecognised command: ${cmd}`);
}

/** "bd show" matches `bd show x`, not `./bd show x` or `bd showall`. */
function leadReadCommand(cmd: string, cmdWord: string, rest: string[], ctx: PolicyContext): boolean {
  if (/[\\/]/.test(cmdWord)) return false;
  return (ctx.leadReadCommands ?? []).some((entry) => {
    const [head, ...words] = entry.trim().split(/\s+/);
    return baseCmd(head!) === cmd && words.every((w, i) => rest[i] === w);
  });
}

/** `node_modules/.bin/<tool>` exists between the cwd and the worktree root (npx would not download it). */
function localBin(tool: string, sc: SegCtx): boolean {
  const ctx = sc.env.ctx;
  let dir = path.resolve(sc.vcwd);
  for (let guard = 0; guard < 64 && isInsideOrEqual(dir, ctx.cwd); guard++) {
    for (const ext of ['', '.cmd', '.exe', '.ps1']) {
      const bin = path.join(dir, 'node_modules', '.bin', tool + ext);
      try {
        if (fs.existsSync(bin) && realInside(bin, ctx.cwd)) return true;
      } catch {
        /* unreadable: not installed */
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}

function isDirectory(tok: string, sc: SegCtx): boolean {
  const r = resolveToken(tok, sc.vcwd, sc.env.ctx, sc.vals);
  try {
    return r.kind === 'path' && fs.statSync(r.abs).isDirectory();
  } catch {
    return false;
  }
}

/** find: start points, path-taking tests, and the actions (-delete, -exec <cmd>, -fprint). */
function classifyFind(rest: string[], sc: SegCtx): J {
  const env = sc.env;
  let i = 0;
  let follow = false;
  while (i < rest.length && /^-(H|L|P|D|O\d*)$/.test(rest[i]!)) {
    if (rest[i] === '-L') follow = true;
    if (rest[i] === '-D') i++;
    i++;
  }
  const roots: string[] = [];
  while (i < rest.length && !/^[-(!),]/.test(rest[i]!)) roots.push(rest[i++]!);
  if (!roots.length) roots.push('.');
  const expr = rest.slice(i);
  if (expr.includes('-follow')) follow = true;

  // where the roots are: inside (actions are checked per command) or outside (exact approval)
  const rootPaths: Array<{ tok: string; abs?: string; inside: boolean }> = roots.map((tok) => {
    const r = resolveToken(tok, sc.vcwd, env.ctx, sc.vals);
    if (r.kind !== 'path') return { tok, inside: false };
    return { tok, abs: r.abs, inside: inArea(env.ctx, r.abs, 'w', { recursive: true }) };
  });
  let j = pathAsks(roots.map((t) => (isPathCandidate(t, true) ? t : `./${t}`)), 'r', sc, { recursive: true });
  let hasAction = false;
  let printsPaths = true;
  for (let k = 0; k < expr.length; k++) {
    const a = expr[k]!;
    if (['-newer', '-anewer', '-cnewer', '-samefile', '-newerXY'].includes(a) || /^-newer[amcBt]{2}$/.test(a)) {
      j = merge(j, pathAsks(argCandidates([expr[++k] ?? '']), 'r', sc));
      continue;
    }
    if (['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-xtype', '-size', '-perm', '-user', '-group', '-maxdepth', '-mindepth', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-links', '-inum', '-uid', '-gid', '-fstype', '-lname', '-ilname', '-context', '-printf', '-regextype', '-used'].includes(a)) {
      if (a === '-printf') printsPaths = false;
      k++;
      continue;
    }
    if (a === '-fprint' || a === '-fprint0' || a === '-fls' || a === '-fprintf') {
      const f = expr[++k] ?? '';
      if (a === '-fprintf') k++;
      j = merge(j, pathAsks([isPathCandidate(f, true) ? f : `./${f}`], 'w', sc));
      hasAction = true;
      printsPaths = false;
      continue;
    }
    if (a === '-ls') printsPaths = false;
    if (a === '-delete') {
      hasAction = true;
      printsPaths = false;
      if (follow || rootPaths.some((r) => !r.inside)) j = merge(j, exact(env, 'find -delete on files outside the worktree (or following links)'));
      else j = merge(j, need('find -delete removes files inside the worktree', 'Bash:find -delete'));
      continue;
    }
    if (['-exec', '-execdir', '-ok', '-okdir'].includes(a)) {
      hasAction = true;
      printsPaths = false;
      const words: string[] = [];
      k++;
      while (k < expr.length && expr[k] !== ';' && !(expr[k] === '+' && words[words.length - 1] === '{}')) words.push(expr[k++]!);
      if (!words.length) continue;
      if (follow || rootPaths.some((r) => !r.inside)) {
        j = merge(j, exact(env, `find ${a} runs a command on files outside the worktree (or following links)`));
        const inner = classifyWords(baseCmd(words[0]!), words[0]!, words.slice(1), { ...sc, cmd: baseCmd(words[0]!) }, { docs: [], pipeTrusted: false, viaXargs: false });
        if (inner.deny) return inner;
        continue;
      }
      // judge the command once per start point, with {} standing for a file under it
      for (const r of rootPaths) {
        const rep = `${(r.abs ?? sc.vcwd).replace(/\\/g, '/')}/found`;
        const argv = words.map((wd) => wd.split('{}').join(rep));
        const vcwd = a === '-execdir' || a === '-okdir' ? (r.abs ?? sc.vcwd) : sc.vcwd;
        const c0 = baseCmd(argv[0]!);
        if (tokensHavePush(argv)) return refuse(PUSH_DENY);
        const inner = classifyWords(c0, argv[0]!, argv.slice(1), { ...sc, vcwd, cmd: c0 }, { docs: [], pipeTrusted: false, viaXargs: false });
        if (inner.deny) return inner;
        j = merge(j, { ...inner, cwd: undefined, pathsOut: undefined });
      }
      continue;
    }
  }
  const pathsOut = printsPaths && !follow && rootPaths.every((r) => r.inside) && !j.asks.length;
  return merge(j, ok('find', !hasAction, { pathsOut }));
}

/** Classify a whole command line. */
function classifyCommand(command: string, vcwd: string, parent: Env): J {
  if (mentionsSafetyVars(command)) return refuse(TAMPER_DENY);
  if (parent.depth > MAX_DEPTH) return exact(parent, 'nested too deeply to check');
  // here-documents go into the shared list; the text keeps a placeholder per `<<DELIM`, so a
  // nested command (a substitution, bash -c) finds its body again
  const env = parent;
  const text = extractHeredocs(command, env.heredocs).text;
  const substs: Subst[] = [];
  const outer = extractSubst(text, substs);
  let j = ok('safe command inside the worktree', true);
  // GIT_DIR=<the user's .git> git commit, export GIT_WORK_TREE=..., read GIT_INDEX_FILE, ...
  const redirect = REDIRECT_VAR_RE.exec(command);
  if (redirect) j = merge(j, exact(env, `${redirect[1]!.toUpperCase()} ${REDIRECT_REASON}`));
  let cwd = vcwd;
  let prevOut = false;
  let prevEcho: string | undefined;
  for (const seg of splitSegmentsWithOps(outer)) {
    const sj = classifySegment(seg, cwd, env, substs, seg.pipeIn && prevOut, seg.pipeIn ? prevEcho : undefined);
    j = merge(j, { ...sj, pathsOut: undefined });
    if (j.deny) return j;
    if (sj.cwd !== undefined) cwd = sj.cwd;
    prevOut = !!sj.pathsOut;
    prevEcho = echoText(seg.text);
  }
  // here-document bodies no command claimed (odd syntax): their substitutions still run
  if (parent.depth === 0) {
    env.heredocs.forEach((hd, idx) => {
      if (env.usedHeredocs.has(idx) || hd.quoted || j.deny) return;
      const extra: Subst[] = [];
      extractSubst(hd.body, extra, false);
      for (const s of extra) j = merge(j, classifyCommand(s.body, cwd, { ...env, depth: 1 }));
    });
  }
  // the command's stdout is the last segment's (for `$(git ls-files)` and pipes into xargs)
  return { ...j, cwd, pathsOut: prevOut };
}

/** `echo "text"` / `printf 'text'` with static arguments: the text it prints (for `| bash`). */
function echoText(seg: string): string | undefined {
  const lx = lex(seg);
  const w = lx.words;
  if (!w.length || !['echo', 'printf'].includes(baseCmd(w[0]!)) || lx.redirects.length) return undefined;
  const args = w.slice(1).filter((a) => !/^-[neE]+$/.test(a));
  if (args.some((a) => a.includes(MARK))) return undefined;
  return args.join(' ').replace(/\\n/g, '\n');
}

function rootEnv(command: string, ctx: PolicyContext): Env {
  return { ctx, top: command, depth: 0, heredocs: [], usedHeredocs: new Set() };
}

export function classifyBash(command: string, ctx: PolicyContext): Verdict {
  const j = classifyCommand(command, ctx.cwd, rootEnv(command, ctx));
  if (j.deny) return { action: 'deny', reason: j.deny };
  const seen = new Set<string>();
  const pending = j.asks.filter((a) => !ctx.alwaysAllow?.includes(a.key) && !seen.has(a.key) && (seen.add(a.key), true));
  if (pending.length) {
    // internal markers -> readable text
    const show = (s: string) => s.replace(MARK_RE, '$(...)').split(DYN).join('...').replace(/\u0002H\d+\u0002/g, '');
    const reasons = [...new Set(pending.map((a) => show(a.reason)))];
    return { action: 'ask', reason: reasons.join('; '), ruleKey: pending[0]!.key, ruleKeys: pending.map((a) => a.key) };
  }
  if (j.asks.length) return { action: 'allow', reason: `always allowed: ${[...new Set(j.asks.map((a) => a.key))].join(', ')}` };
  return { action: 'allow', reason: j.reason || 'safe command inside the worktree' };
}

/** Read-only check used for the lead (who works in the user's own checkout). */
export function isReadOnlyCommand(command: string, ctx: PolicyContext): boolean {
  const j = classifyCommand(command, ctx.cwd, rootEnv(command, ctx));
  return !j.deny && !j.asks.length && j.readOnly;
}

// ---- entry point ---------------------------------------------------------------------------

/**
 * Where a glob pattern reaches, relative to `base`: undefined if it stays under base, the
 * directory its fixed prefix names if that is elsewhere (`../../x/**`, `C:/Users/**`), or
 * 'unknown' if a `..` follows a wildcard (`**\/../..`) so no fixed directory bounds it.
 */
function patternRoot(base: string, pattern: string, ctx: PolicyContext): string | 'unknown' | undefined {
  const segs = pattern.split(/[\\/]/);
  const firstGlob = segs.findIndex((s) => /[*?[{]/.test(s));
  if (firstGlob >= 0 && segs.slice(firstGlob).some((s) => /(^|[{,])\.\.([,}]|$)/.test(s))) return 'unknown';
  const fixed = firstGlob < 0 ? segs : segs.slice(0, firstGlob);
  const absolute = /^([a-zA-Z]:([\\/]|$)|[\\/]|~|\$|%)/.test(pattern);
  if (!absolute && !fixed.includes('..')) return undefined;
  const prefix = fixed.join('/') || (absolute ? '/' : '.');
  return resolveIn(base, prefix, ctx);
}

function askVerdict(reason: string, key: string): Verdict {
  return { action: 'ask', reason, ruleKey: key, ruleKeys: [key] };
}

export function classifyToolUse(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): Verdict {
  const server = ctx.mcpServer ?? 'agentcraft';
  if (toolName.startsWith(`mcp__${server}__`)) return { action: 'allow', reason: 'AgentCraft tool' };
  if (toolName in DENIED_TOOLS) return { action: 'deny', reason: DENIED_TOOLS[toolName]! };
  if (ALWAYS_OK.has(toolName)) return { action: 'allow', reason: toolName };

  const always = (key: string): Verdict | undefined =>
    ctx.alwaysAllow?.includes(key) ? { action: 'allow', reason: `always allowed: ${key}` } : undefined;

  if (READ_TOOLS.has(toolName)) {
    const p = pathArg(input);
    // Glob's pattern (and Grep's glob filter) can climb out of the search root: `../../.ssh/*`
    const pattern = toolName === 'Glob' ? input.pattern : toolName === 'Grep' ? input.glob : undefined;
    if (typeof pattern === 'string' && pattern.trim()) {
      const base = p ? resolveIn(ctx.cwd, p, ctx) : ctx.cwd;
      const root = patternRoot(base, pattern.trim(), ctx);
      if (root === 'unknown') {
        const key = `${toolName}:pattern:${hashText(pattern)}`;
        return always(key) ?? askVerdict(`${toolName} pattern can reach outside the worktree (\`..\` after a wildcard): ${pattern}`, key);
      }
      if (root && !inArea(ctx, root, 'r')) {
        const key = `${toolName}:tree:${root.toLowerCase()}`;
        return always(key) ?? askVerdict(`read outside the worktree: ${root}`, key);
      }
    }
    const probe = p;
    if (!probe || inSandbox(ctx, probe, true)) return { action: 'allow', reason: 'read inside worktree' };
    const abs = resolveIn(ctx.cwd, probe, ctx);
    // Grep/Glob search a whole tree: scoped to exactly that tree; Read/LS to the file's directory
    const key = TREE_READ_TOOLS.has(toolName) ? `${toolName}:tree:${abs.toLowerCase()}` : toolName === 'LS' ? `LS:${abs.toLowerCase()}` : `Read:${path.dirname(abs).toLowerCase()}`;
    return always(key) ?? askVerdict(`read outside the worktree: ${abs}`, key);
  }

  if (EDIT_TOOLS.has(toolName)) {
    if (ctx.role === 'lead') return { action: 'deny', reason: 'The lead is read-only: create a task for a worker instead of editing files.' };
    const p = pathArg(input);
    if (!p) return askVerdict(`${toolName} without a path`, `${toolName}:nopath`);
    const abs = resolveIn(ctx.cwd, p, ctx);
    if (isInsideOrEqual(abs, ctx.cwd)) {
      if (insideGitDir(ctx, p)) {
        // per file: the `.git` link decides which repository git works on
        const key = `${toolName}:.git:${abs.toLowerCase()}`;
        return always(key) ?? askVerdict(`editing git internals (.git): ${abs}`, key);
      }
      if (!realInside(abs, ctx.cwd)) return askVerdict(`edit through a link that leads outside the worktree: ${abs}`, `${toolName}:link:${dirKey(abs)}`);
      return { action: 'allow', reason: 'edit inside worktree' };
    }
    if ((ctx.tempDirs ?? [os.tmpdir()]).some((d) => isInsideOrEqual(abs, d))) return { action: 'allow', reason: 'scratch file in the temp dir' };
    const key = `${toolName}:${dirKey(abs)}`;
    return always(key) ?? askVerdict(`edit outside the worktree: ${abs}`, key);
  }

  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = typeof input.command === 'string' ? input.command : '';
    const v = classifyBash(command, ctx);
    if (ctx.role !== 'lead' || v.action === 'deny') return v;
    // the lead works in the user's checkout: only inspection commands run without asking, and an
    // approval covers exactly that command
    if (v.action === 'allow' && isReadOnlyCommand(command, ctx)) return v;
    const key = `lead:${exactKey(command)}`;
    return always(key) ?? askVerdict(`the lead is read-only; this command may change things${v.action === 'ask' ? ` (${v.reason})` : ''}`, key);
  }

  if (NETWORK_TOOLS.has(toolName)) {
    let host = '';
    if (typeof input.url === 'string') {
      try {
        host = new URL(input.url).hostname;
      } catch {
        host = input.url;
      }
    }
    const key = `${toolName}:${host || 'search'}`;
    return always(key) ?? askVerdict(`network access (${toolName}${host ? ` ${host}` : ''})`, key);
  }

  if (toolName.startsWith('mcp__')) return always(toolName) ?? askVerdict(`external MCP tool ${toolName}`, toolName);
  return always(toolName) ?? askVerdict(`unrecognised tool ${toolName}`, toolName);
}

/** One-line human description of a tool call, for permission prompts and logs. */
export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return `${toolName}: ${input.command}`;
  const p = pathArg(input);
  if (p) return `${toolName} ${p}`;
  if (typeof input.url === 'string') return `${toolName} ${input.url}`;
  if (typeof input.query === 'string') return `${toolName} "${input.query}"`;
  if (typeof input.pattern === 'string') return `${toolName} ${input.pattern}`;
  return toolName;
}

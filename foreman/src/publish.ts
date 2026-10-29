// Publishing a repo from the dashboard: the user's base branch goes to the remote with the user's
// own git and credentials (agents never get a transport; see gitsafety.ts). Optionally as a pull
// request: a new branch at the base head is pushed and `gh pr create` opens it; without the GitHub
// CLI the result carries the compare URL to open it in the browser. Only ever runs on a click.
import { run } from './util/proc.js';

export interface PublishResult {
  remote: string;
  branch: string;
  pushed: string;
  prUrl?: string;
  compareUrl?: string;
  output: string;
}

async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const r = await run('git', args, { cwd, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim().slice(0, 400) || `exit ${r.code}`}`);
  return r.stdout.trim();
}

/** https://github.com/owner/repo from git@github.com:owner/repo.git or https://...git */
export function webUrl(remoteUrl: string): string | undefined {
  const m = /^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? `https://${m[1]}/${m[2]}` : undefined;
}

export async function publish(cwd: string, branch: string, opts: { pr?: boolean; title?: string; body?: string; now?: () => number } = {}): Promise<PublishResult> {
  const remotes = (await git(cwd, ['remote'])).split(/\s+/).filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!remote) throw new Error('this repo has no remote to push to (git remote add origin <url>)');
  const url = await git(cwd, ['remote', 'get-url', remote]);
  if (!opts.pr) {
    const out = await git(cwd, ['push', '-u', remote, branch], 300_000);
    return { remote, branch, pushed: branch, output: out };
  }
  const defaultBranch =
    (await git(cwd, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]).catch(() => ''))?.replace(`${remote}/`, '') || (branch === 'master' ? 'master' : 'main');
  // the PR branch: the base branch itself when it is not the remote's default, else a new one at its head
  const prBranch = branch !== defaultBranch ? branch : `agentcraft/publish-${new Date(opts.now?.() ?? Date.now()).toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  const out = await git(cwd, ['push', '-u', remote, prBranch === branch ? branch : `${branch}:refs/heads/${prBranch}`], 300_000);
  const web = webUrl(url);
  const compareUrl = web && /github\.com/i.test(web) ? `${web}/compare/${defaultBranch}...${prBranch}?expand=1` : undefined;
  const gh = await run('gh', ['pr', 'create', '--base', defaultBranch, '--head', prBranch, '--title', opts.title?.trim() || `AgentCraft: ${prBranch}`, '--body', opts.body?.trim() || 'Changes made by the AgentCraft team and approved in AgentCraft.'], { cwd, timeoutMs: 120_000 }).catch(() => undefined);
  const prUrl = gh && gh.code === 0 ? /https?:\/\/\S+/.exec(gh.stdout)?.[0] : undefined;
  return { remote, branch, pushed: prBranch, ...(prUrl ? { prUrl } : {}), ...(compareUrl ? { compareUrl } : {}), output: [out, gh?.stderr?.trim()].filter(Boolean).join('\n') };
}

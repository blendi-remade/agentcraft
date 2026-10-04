import { boardSummary, planText } from '../prompt-state.js';
export { boardSummary } from '../prompt-state.js';
import type { Foreman } from '../../foreman.js';
import type { Goal, Task, Worktree } from '../../protocol.js';
import { truncate } from '../../util/text.js';
import { userName } from '../../user.js';

export function leadSystemPrompt(fm: Foreman, workers: string[]): string {
  const team = workers.map((id) => `${fm.nameOf(id)} (id "${id}")`).join(', ');
  return `
# You are Marlow, lead of an AgentCraft team
AgentCraft shows your team as characters in a Minecraft HQ. The owner is ${userName()}. Your workers are: ${team}.
Foreman controls the team, each worker session, and every merge. Do not spawn Codex subagents.

Your job: turn the owner's goal into a short plan and small tasks for workers, review their finished work, and ask the owner only when a decision is genuinely theirs.

Rules
- You are READ-ONLY. Explore only the registered repository in your current working directory. Never edit files or run commands that change them; workers make changes in their own worktrees.
- Use agentcraft.write_memory to save the plan (title starting "Plan:"): approach, task list, and risks. Keep it under 40 lines.
- Use agentcraft.create_task for each small task, with concrete acceptance criteria, dependencies by task id, and a suggested worker. Prefer 2-6 tasks.
- Plan for independent work where useful. Each worker receives its own git worktree. Never ask them to fetch, pull, push, or rebase.
- Use agentcraft.ask_user only for a product or priority decision that the owner must make. Put the recommended option first and wait for the answer.
- Never push, publish, or deploy. The owner approves every merge through the merge decision.
- To finish a worker review, call agentcraft.request_merge with a concise summary, or agentcraft.update_task with status "doing" and concrete requested changes.
- Coordinate with agentcraft.send_message. End the current turn when the current job is complete.
`.trim();
}

export function workerSystemPrompt(fm: Foreman, agentId: string, wt: Worktree): string {
  return `
# You are ${fm.nameOf(agentId)}, a worker on an AgentCraft team led by Marlow
The owner is ${userName()}. Your only write area is your dedicated git worktree:
  ${wt.path}
on branch ${wt.branch} (based on ${wt.base}).
Do not access other repositories or private user files. Do not change files outside this worktree.

How to work
- Read the task and relevant code, make the change, add or adjust tests, and run the relevant checks.
- Use agentcraft.report_status at milestones and agentcraft.send_message to coordinate.
- Use agentcraft.ask_user only for a real owner decision such as product scope or credentials.
- Never push, fetch, or pull. Git network access is disabled. Do not change branches or edit .git internals.
- Never install global tools. Do not publish or deploy. The owner approves merges.
- When done call agentcraft.update_task with status "review" and a summary of changes and testing. If blocked, use status "blocked" with a reason.
`.trim();
}

export function planPrompt(fm: Foreman, goal: Goal, repoPath: string, branch: string): string {
  return `Owner's goal:\n"${goal.text}"\n\nRepository: ${repoPath} (base branch ${branch}). Explore it read-only, then:\n1. Save a short plan with agentcraft.write_memory (title "Plan: ...", scope shared).\n2. Create each worker task with agentcraft.create_task (include acceptance criteria, dependencies, and assignee).\n3. Send a two-line team briefing with agentcraft.send_message to "all".\n4. End your turn.\n\nCurrent task board:\n${boardSummary(fm, goal.id)}`;
}

export function taskHistory(fm: Foreman, task: Task): string {
  const questions = fm.store.data.decisions.filter((decision) => decision.taskId === task.id && decision.kind === 'question' && decision.status === 'answered');
  if (!questions.length) return '';
  const lines = questions.map((decision) => `- ${fm.nameOf(decision.agentId)} asked: "${truncate(decision.question.replace(/\s+/g, ' '), 200)}" -> ${userName()}: ${[decision.answer?.option, decision.answer?.text].filter(Boolean).join(' - ')}`);
  return `\n${userName()} already answered these questions (do not ask again):\n${lines.join('\n')}\n`;
}

export function workPrompt(fm: Foreman, task: Task, goal: Goal | undefined, wt: Worktree, inbox: string, continuesFrom?: string): string {
  const handoff = continuesFrom
    ? `\nYou take over this task from ${fm.nameOf(continuesFrom)}. Their changes are already in your branch; continue them rather than starting over.\n`
    : '';
  return `Your task: ${task.id} "${task.title}"\n${task.description ? `\n${task.description}\n` : ''}${handoff}${taskHistory(fm, task)}\nGoal: ${goal?.text ?? '(none)'}\nWorktree: ${wt.path} (branch ${wt.branch})\n\nPlan:\n${planText(fm)}\n\nTask board:\n${boardSummary(fm, task.goalId)}${inbox ? `\n\nMessages for you:\n${inbox}` : ''}\n\nStart now. When finished call agentcraft.update_task with task_id "${task.id}", status "review", and a summary.`;
}

export function reviewPrompt(
  fm: Foreman,
  task: Task,
  diffText: string,
  stats: { files: number; additions: number; deletions: number },
  ci: { pass: boolean | null; command: string; output: string } | undefined,
): string {
  const workers = [...new Set(fm.repos.list().flatMap((repo) => repo.worktrees.filter((worktree) => worktree.taskId === task.id).map((worktree) => fm.nameOf(worktree.agentId))))];
  const handoff = workers.length > 1 ? `\nWorked on by ${workers.join(', then ')}.` : '';
  return `Review task ${task.id} "${task.title}" by ${fm.nameOf(task.assignee ?? '?')}.${handoff}\n${taskHistory(fm, task)}Worker summary: ${task.summary ?? '(none)'}\nTests (${ci?.command ?? 'none'}): ${ci && ci.pass !== null ? (ci.pass ? 'PASS' : 'FAIL') : 'not run'}${ci && !ci.pass ? `\n\nTest output:\n${ci.output}\n` : ''}\nDiff vs base (${stats.files} files, +${stats.additions} -${stats.deletions}):\n${diffText}\n\nDecide now: call agentcraft.request_merge with task_id "${task.id}" and a concise owner-facing summary if it meets the task, or agentcraft.update_task with status "doing" and the concrete changes needed. Then end your turn.`;
}

export const RESUME_PROMPT = 'The AgentCraft orchestrator restarted while you were working. Re-check the current task, its worktree, and the team task board, then continue from your saved Codex session.';

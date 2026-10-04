import type { Foreman } from '../foreman.js';
import { truncate } from '../util/text.js';

export function boardSummary(fm: Foreman, goalId?: string): string {
  const tasks = fm.tasks.list().filter((task) => !goalId || task.goalId === goalId);
  if (!tasks.length) return '(no tasks yet)';
  return tasks
    .map((task) => `- ${task.id} [${task.status}] ${task.title}${task.assignee ? ` (${fm.nameOf(task.assignee)})` : ''}${task.deps.length ? ` deps: ${task.deps.join(', ')}` : ''}`)
    .join('\n');
}

export function planText(fm: Foreman): string {
  const plan = fm.memory.list().filter((memory) => memory.scope === 'shared' && /^plan/i.test(memory.title)).pop();
  return plan ? truncate(plan.body, 3000) : '(no plan in memory)';
}

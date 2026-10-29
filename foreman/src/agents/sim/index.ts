// Sim backend: deterministic scripted team working on a real sandbox repo.
import type { SimConfig } from '../../config.js';
import { ClientError, type Backend, type Foreman } from '../../foreman.js';
import type { Decision, Goal, Task } from '../../protocol.js';
import { truncate } from '../../util/text.js';
import { SimDirector, Stopped, type SimState } from './director.js';
import { BEATS, DEFAULT_SIM_GOAL } from './scenario.js';
import { userName } from '../../user.js';

const CANNED_REPLIES = [
  'Got it - noted.',
  'On it. I will fold that into what I am doing.',
  'Thanks! Adding it to my notes.',
  'Understood. I will flag anything that conflicts with the plan.',
];

export class SimBackend implements Backend {
  readonly name = 'sim' as const;
  private director: SimDirector | undefined;
  private running: Promise<void> | undefined;
  private replyCount = 0;
  /** resolves when the scenario reaches the showcase checkpoint or ends (tests) */
  private settledWaiters: Array<() => void> = [];

  constructor(
    private fm: Foreman,
    private cfg: SimConfig,
  ) {}

  get state(): SimState {
    const b = this.fm.store.data.backend;
    let st = b.sim as SimState | undefined;
    if (!st) {
      st = { beat: 0, vars: {} };
      b.sim = st;
      this.fm.store.markDirty();
    }
    return st;
  }

  get beatCount(): number {
    return BEATS.length;
  }

  async start(): Promise<void> {
    const st = this.state;
    // the same banner as before the restart: "- goal done" once the scenario has finished
    const done = st.goalId && st.finished ? ' - goal done' : '';
    this.fm.setStatus({ backend: 'sim', auth: 'ok', message: `Simulated team (speed x${this.cfg.speed})${done}`, speed: this.cfg.speed, ...(this.cfg.showcase ? { showcase: false } : {}) });
    if (st.goalId && !st.finished) {
      if (this.cfg.showcase && st.checkpoint === this.cfg.showcaseAt) {
        this.fm.setStatus({ showcase: true, message: 'Showcase (static)' });
        this.fm.log.info('sim: holding showcase state');
        return;
      }
      this.fm.log.info(`sim: resuming scenario at beat ${st.beat + 1}/${BEATS.length} (${BEATS[st.beat]?.name ?? 'end'})`);
      this.fm.bus.feed('system', `Foreman restarted - the team picks up where it left off (${BEATS[st.beat]?.name ?? 'end'}).`);
      this.launch();
    }
  }

  /** Called by main when --autostart/--showcase and no scenario has run yet. */
  async autostart(text?: string): Promise<Goal | undefined> {
    if (this.state.goalId) return undefined;
    return this.fm.submitGoal(text ?? DEFAULT_SIM_GOAL);
  }

  async submitGoal(goal: Goal): Promise<void> {
    const st = this.state;
    if (st.goalId && !st.finished) {
      this.fm.setGoal(goal.id, { status: 'cancelled' });
      throw new ClientError('the sim team is already working on a goal (restart with --reset to replay)');
    }
    if (st.finished) {
      this.fm.setGoal(goal.id, { status: 'cancelled' });
      this.fm.bus.send('marlow', 'user', 'The simulated team only knows one script and it is done. Restart the Foreman with --reset to replay it, or use --backend claude for real work.');
      return;
    }
    st.goalId = goal.id;
    st.beat = 0;
    st.vars = {};
    this.fm.store.markDirty();
    this.fm.setStatus({ message: `Simulated team (speed x${this.cfg.speed}) - working on ${goal.id}` });
    this.launch();
  }

  private launch(): void {
    if (this.running) return;
    const st = this.state;
    const d = new SimDirector(this.fm, this.cfg, st, () => this.fm.store.markDirty());
    this.director = d;
    d.instant = this.cfg.showcase && st.checkpoint !== this.cfg.showcaseAt;
    if (d.instant) this.fm.setStatus({ message: `Showcase: fast-forwarding to the ${this.cfg.showcaseAt === 'showcase-late' ? 'late ' : ''}showcase state...` });
    this.running = (async () => {
      try {
        while (st.beat < BEATS.length) {
          const beat = BEATS[st.beat]!;
          this.fm.log.debug(`sim beat ${st.beat + 1}/${BEATS.length}: ${beat.name}`);
          await beat.run(d);
          st.beat++;
          this.fm.store.markDirty();
          if (beat.checkpoint) {
            st.checkpoint = beat.checkpoint;
            if (this.cfg.showcase && beat.checkpoint === this.cfg.showcaseAt) {
              this.fm.flushLogs();
              this.fm.setStatus({ showcase: true, message: 'Showcase (static)' });
              this.fm.log.info('sim: showcase state reached; holding');
              this.store();
              return;
            }
          }
        }
        st.finished = true;
        this.store();
        this.fm.setStatus({ message: `Simulated team (speed x${this.cfg.speed}) - goal done` });
        this.fm.log.info('sim: scenario finished');
      } catch (e) {
        if (e instanceof Stopped) return;
        this.fm.log.error(`sim beat "${BEATS[st.beat]?.name}" failed: ${(e as Error).stack ?? e}`);
        this.fm.bus.feed('error', `Sim scenario error in "${BEATS[st.beat]?.name}": ${(e as Error).message}`);
        this.fm.notify('warn', `Sim error: ${truncate((e as Error).message, 120)}`);
      } finally {
        this.running = undefined;
        for (const w of this.settledWaiters.splice(0)) w();
      }
    })();
  }

  private store(): void {
    this.fm.store.markDirty();
    this.fm.store.flush();
  }

  /** For tests/tools: resolves when the scenario finishes, errors, or holds at the showcase. */
  idle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((r) => this.settledWaiters.push(r));
  }

  async stop(): Promise<void> {
    this.director?.stop();
    await this.running?.catch(() => undefined);
  }

  onUserMessage(to: string, text: string): void {
    const agents = to === 'all' ? ['marlow'] : [to];
    for (const id of agents) {
      const a = this.fm.agent(id);
      if (!a) continue;
      this.fm.agentLog(id, 'text', `Message from ${userName()}: ${text}`);
      const reply = CANNED_REPLIES[this.replyCount++ % CANNED_REPLIES.length]!;
      setTimeout(() => this.fm.bus.send(id, 'user', reply), 1200 / this.cfg.speed).unref?.();
    }
  }

  onDecisionSettled(_d: Decision): void {
    // the scenario awaits decisions itself (DecisionQueue.wait)
  }

  onTaskAction(task: Task, action: string): void {
    this.fm.agentLog('marlow', 'text', `${userName()}: ${action} ${task.id} (${task.title}). The sim script keeps its own course.`);
  }

  onAgentAction(agentId: string, action: string): void {
    if (action === 'pause') this.fm.agentLog(agentId, 'text', `Paused by ${userName()}.`);
    if (action === 'nudge') this.fm.agentLog(agentId, 'text', `Nudged by ${userName()}.`);
    if (action === 'resume' || action === 'spawn') {
      const a = this.fm.agent(agentId);
      if (a && !a.active) this.fm.setAgent(agentId, { active: true, activity: 'back on shift' });
      this.fm.agentLog(agentId, 'text', 'Resumed.');
    }
    if (action === 'stop') {
      // off shift: the scripted team waits for this agent's next step until /resume
      this.fm.setAgent(agentId, { active: false, state: 'idle', station: 'lounge', activity: 'stopped - off shift' });
      this.fm.agentLog(agentId, 'text', `Stopped by ${userName()} (off shift). The script waits for /resume.`);
    }
  }
}

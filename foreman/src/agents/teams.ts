// Build one scheduler with the provider selected for each role and agent.
import type { Config, EngineName } from '../config.js';
import type { Foreman } from '../foreman.js';
import { ClaudeEngine } from './claude/engine.js';
import { CodexRuntime } from './codex/index.js';
import { OpenAIRuntime } from './openai/index.js';
import { RuntimeEngine, type Engine } from './engine.js';
import { TeamBackend } from './team.js';

export function createTeam(fm: Foreman, cfg: Config): TeamBackend {
  if (cfg.backend === 'openai') return new TeamBackend(fm, cfg.openai, new OpenAIRuntime(cfg.openai, cfg.dataDir));
  let claude: Engine | undefined;
  let codex: Engine | undefined;
  const engine = (name: EngineName): Engine => name === 'codex'
    ? (codex ??= new RuntimeEngine(fm, cfg.codex, new CodexRuntime(cfg.codex, undefined, cfg.dataDir)))
    : (claude ??= new ClaudeEngine(fm, cfg.claude));
  const byAgent = Object.fromEntries(Object.entries(cfg.engines.byAgent).map(([agent, name]) => [agent, engine(name)]));
  return new TeamBackend(fm, cfg.backend === 'codex' ? cfg.codex : cfg.claude, {
    name: cfg.backend === 'codex' ? 'codex' : 'claude',
    engines: { lead: engine(cfg.engines.lead), worker: engine(cfg.engines.worker), byAgent },
  });
}

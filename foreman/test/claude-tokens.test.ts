// Token accounting for gateways: OpenCode Go bills the plan allowance, so Claude Code's USD
// estimate is hidden and the real token count is reported instead.
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeEngine } from '../src/agents/claude/engine.js';
import { StreamMapper, formatTokens } from '../src/agents/claude/stream.js';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

let h: Harness | undefined;
let home: string | undefined;
afterEach(async () => {
  await h?.fm.close();
  if (home) rmrf(home);
  h = undefined;
  home = undefined;
});

function resultMsg(usage: Record<string, number>) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    num_turns: 3,
    total_cost_usd: 0.044,
    session_id: '11111111-1111-4111-8111-111111111111',
    duration_ms: 1,
    duration_api_ms: 1,
    usage,
    modelUsage: {},
    permission_denials: [],
  } as never;
}

describe('claude token accounting', () => {
  it('formats compact token counts', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_500)).toBe('13k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatTokens(1_000_000)).toBe('1M');
  });

  it('records tokens and hides the Anthropic USD estimate for a gateway', async () => {
    home = tempDir();
    h = makeForeman(home, ['--backend', 'claude', '--workers', 'kit']);
    const mapper = new StreamMapper(h.fm, 'kit', home, 'worker', false);
    mapper.handle(resultMsg({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }));
    expect(mapper.stats.tokens).toBe(1260);
    expect(mapper.stats.costUsd).toBeUndefined();
  });

  it('keeps the USD estimate for a direct Anthropic key', async () => {
    home = tempDir();
    h = makeForeman(home, ['--backend', 'claude', '--workers', 'kit']);
    const mapper = new StreamMapper(h.fm, 'kit', home, 'worker', true);
    mapper.handle(resultMsg({ input_tokens: 1000, output_tokens: 200 }));
    expect(mapper.stats.tokens).toBe(1200);
    expect(mapper.stats.costUsd).toBe(0.044);
  });

  it('uses a per-agent model override and falls back to the role model', async () => {
    home = tempDir();
    h = makeForeman(home, ['--backend', 'claude', '--workers', 'kit,wren']);
    h.cfg.claude.modelsByAgent = { kit: 'kimi-k2.7-code' };
    const engine = new ClaudeEngine(h.fm, h.cfg.claude);
    expect(engine.model('worker', 'kit')).toBe('kimi-k2.7-code');
    expect(engine.model('worker', 'wren')).toBe(h.cfg.claude.workerModel);
    expect(engine.model('lead', 'marlow')).toBe(h.cfg.claude.leadModel);
  });
});

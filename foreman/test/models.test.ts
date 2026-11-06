// Model display names on the agents' nameplates.
import { describe, expect, it } from 'vitest';
import { modelLabel } from '../src/agents/models.js';

describe('modelLabel', () => {
  it.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-sonnet-5', 'Sonnet 5'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-opus-5-5[1m]', 'Opus 5.5'],
    ['opus', 'Opus'],
    ['sonnet', 'Sonnet'],
    ['gpt-6-astra', 'GPT-6 Astra'],
    ['gpt-5.1-codex-mini', 'GPT-5.1 Codex Mini'],
    ['o4-mini', 'o4 Mini'],
    ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'],
    ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
    ['muse-spark-1.3-contributor', 'Muse Spark 1.3'],
    ['kimi-k2.7-code', 'Kimi K2.7 Code'],
    ['glm-5.3-flash', 'GLM-5.3 Flash'],
    ['qwen3.8-flash', 'Qwen3.8 Flash'],
    ['minimax-m3.1-flash', 'MiniMax M3.1 Flash'],
    ['mimo-v2.6-flash', 'MiMo V2.6 Flash'],
    ['my-local-model', 'my-local-model'],
  ])('%s -> %s', (model, label) => {
    expect(modelLabel(model)).toBe(label);
  });

  it('has no label for an unknown or default model', () => {
    expect(modelLabel(undefined)).toBeUndefined();
    expect(modelLabel('')).toBeUndefined();
    expect(modelLabel('default')).toBeUndefined();
  });
});

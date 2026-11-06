// Display names for models, shown on the agents' nameplates ("Opus 5.5", "GPT-6 Astra").

const cap = (w: string) => (w ? w[0]!.toUpperCase() + w.slice(1) : w);

/**
 * "claude-opus-5-5" -> "Opus 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5", "opus" -> "Opus",
 * "gpt-6-astra" -> "GPT-6 Astra", "gpt-5.1-codex-mini" -> "GPT-5.1 Codex Mini", "o4-mini" -> "o4 Mini".
 * Anything unrecognised is shown as it is (trimmed).
 */
export function modelLabel(model: string | undefined): string | undefined {
  const m = model?.trim();
  if (!m || m === 'default') return undefined;
  const claude = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8})?(?:\[.*\])?$/i.exec(m);
  if (claude) return [cap(claude[1]!.toLowerCase()), claude[2] ? `${claude[2]}${claude[3] ? `.${claude[3]}` : ''}` : ''].filter(Boolean).join(' ');
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/i.exec(m);
  if (gpt) return [`GPT-${gpt[1]}`, ...(gpt[2] ?? '').split('-').filter(Boolean).map(cap)].join(' ');
  const o = /^(o\d+)(?:-(.+))?$/i.exec(m);
  if (o) return [o[1]!.toLowerCase(), ...(o[2] ?? '').split('-').filter(Boolean).map(cap)].join(' ');
  // OpenCode Go models
  const deepseek = /^deepseek-v([\d.]+)(?:-(flash|pro))?$/i.exec(m);
  if (deepseek) return [`DeepSeek V${deepseek[1]}`, deepseek[2] ? cap(deepseek[2].toLowerCase()) : ''].filter(Boolean).join(' ');
  const muse = /^muse-spark-([\d.]+)(?:-contributor)?$/i.exec(m);
  if (muse) return `Muse Spark ${muse[1]}`;
  const kimi = /^kimi-k([\d.]+)(?:-(.+))?$/i.exec(m);
  if (kimi) return [`Kimi K${kimi[1]}`, ...(kimi[2] ?? '').split('-').filter(Boolean).map(cap)].join(' ');
  const glm = /^glm-([\d.]+)(?:-(.+))?$/i.exec(m);
  if (glm) return [`GLM-${glm[1]}`, ...(glm[2] ?? '').split('-').filter(Boolean).map(cap)].join(' ');
  const qwen = /^qwen([\d.]+)(?:-(.+))?$/i.exec(m);
  if (qwen) return [`Qwen${qwen[1]}`, ...(qwen[2] ?? '').split('-').filter(Boolean).map(cap)].join(' ');
  const minimax = /^minimax-m([\d.]+)(?:-(.+))?$/i.exec(m);
  if (minimax) return [`MiniMax M${minimax[1]}`, ...(minimax[2] ?? '').split('-').filter(Boolean).map(cap)].join(' ');
  const mimo = /^mimo-v([\d.]+)(?:-(.+))?$/i.exec(m);
  if (mimo) return [`MiMo V${mimo[1]}`, ...(mimo[2] ?? '').split('-').filter(Boolean).map(cap)].join(' ');
  return m.slice(0, 24);
}

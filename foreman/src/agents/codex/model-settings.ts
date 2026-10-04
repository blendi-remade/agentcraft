export interface ModelChoice {
  model: string;
  label: string;
  efforts: string[];
  defaultEffort: string;
}
export interface ModelSelection { model: string; effort: string }

/** Only catalog-supported pairs may be persisted; omission restores role defaults. */
export function validateSelection(models: ModelChoice[], model?: string, effort?: string): ModelSelection | undefined {
  if (model === undefined && effort === undefined) return undefined;
  const choice = models.find(item => item.model === model);
  if (!choice) throw new Error('Choose a model available in the current Codex catalog.');
  if (!effort || !choice.efforts.includes(effort)) throw new Error('Choose a reasoning level supported by this model.');
  return { model: choice.model, effort };
}

export function modelChoices(data: unknown): ModelChoice[] {
  if (!Array.isArray(data)) throw new Error('Codex returned an invalid model catalog.');
  const choices: ModelChoice[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object' || item.hidden === true || typeof item.model !== 'string') continue;
    const efforts: string[] = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts.map((x: { reasoningEffort?: unknown }) => x?.reasoningEffort).filter((x: unknown): x is string => typeof x === 'string') : [];
    if (!efforts.length) continue;
    choices.push({model:item.model,label:typeof item.displayName === 'string' ? item.displayName : item.model,
      efforts:[...new Set(efforts)],defaultEffort:efforts.includes(item.defaultReasoningEffort) ? item.defaultReasoningEffort : efforts[0]!});
  }
  return choices;
}

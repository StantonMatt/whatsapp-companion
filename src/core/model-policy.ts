import type { ModelOption, Provider, ReasoningEffort, State } from '../shared/model';

const full: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const thinking = full.slice(1);
// General-purpose text models in the official provider catalogs, checked 2026-09-29.
// Keep this explicit: a prefix match would admit audio, coding-only and preview variants.
const current: Record<Provider, { id: string; efforts: ReasoningEffort[] }[]> = {
  openai: [
    { id: 'gpt-6-astra', efforts: thinking },
    { id: 'gpt-6.1-sol', efforts: thinking },
    { id: 'gpt-6-sol', efforts: full },
    { id: 'gpt-6-luna', efforts: full }
  ],
  anthropic: [
    { id: 'claude-fable-5-1', efforts: thinking },
    { id: 'claude-opus-5-5', efforts: thinking },
    { id: 'claude-sonnet-5-5', efforts: thinking },
    { id: 'claude-haiku-4-5', efforts: [] }
  ]
};

function matches(id: string, family: string) {
  return id === family || (id.startsWith(`${family}-`) && /^(?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(id.slice(family.length + 1)));
}

export function currentTextModels(provider: Provider, models: (ModelOption & { shutdown_date?: string | null })[]): ModelOption[] {
  return current[provider].flatMap(family => {
    const candidates = models.filter(model => matches(model.id, family.id) && !model.shutdown_date);
    // Prefer the moving alias; if the API lists only snapshots, show the newest one.
    const selected = candidates.find(model => model.id === family.id) ?? candidates.sort((a, b) => b.id.localeCompare(a.id))[0];
    return selected ? [{ id: selected.id, name: selected.name }] : [];
  });
}

export function reasoningLevels(provider: Provider, model: string): readonly ReasoningEffort[] {
  return current[provider].find(family => matches(model, family.id))?.efforts ?? [];
}
export function modelEffort(provider: Provider, model: string, requested?: ReasoningEffort): ReasoningEffort | undefined {
  const levels = reasoningLevels(provider, model);
  return requested && levels.includes(requested) ? requested : levels[0];
}
export function savedEffort(state: State, provider = state.provider, model = state.models[provider]) {
  return modelEffort(provider, model, state.reasoning[provider][model]);
}
export function setReasoning(state: State, provider: Provider, model: string, effort: ReasoningEffort) {
  if (!reasoningLevels(provider, model).includes(effort)) throw new Error('This reasoning effort is not supported by the selected model.');
  state.reasoning[provider][model] = effort;
}

export function reasoningBudget(effort?: ReasoningEffort) {
  // Output limits include hidden reasoning. Leave room for a visible reply at higher efforts.
  return effort ? { none: 1200, low: 4096, medium: 8192, high: 16384, xhigh: 32768, max: 32768 }[effort] : 1200;
}

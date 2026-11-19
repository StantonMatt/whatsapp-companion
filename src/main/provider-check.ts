import type { Provider } from '../shared/model';
import { generate, type GenerateInput } from './providers';

/** A check belongs to one configuration generation, including the configured key. */
export class ProviderCheck {
  private active = new Map<Provider, AbortController>();
  constructor(private generator: typeof generate = generate) {}
  invalidate(provider?: Provider) {
    for (const [p, ticket] of this.active) if (!provider || p === provider) { ticket.abort(); this.active.delete(p); }
  }
  async run(configuration: Pick<GenerateInput, 'provider' | 'model' | 'key' | 'effort'>): Promise<string | undefined> {
    this.invalidate(configuration.provider);
    const ticket = new AbortController(); this.active.set(configuration.provider, ticket);
    try {
      await this.generator({ ...configuration, signal: ticket.signal, reason: 'connection test', system: 'Return only the word Connected.', input: 'Synthetic connection check. No private conversation data.' });
      if (this.active.get(configuration.provider) === ticket) return 'Connected. Synthetic provider check passed.';
    } catch (error) {
      if (this.active.get(configuration.provider) === ticket) throw error;
    } finally { if (this.active.get(configuration.provider) === ticket) this.active.delete(configuration.provider); }
  }
}

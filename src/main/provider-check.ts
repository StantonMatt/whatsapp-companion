import { generate, type GenerateInput } from './providers';

/** A check belongs to one configuration generation, including the configured key. */
export class ProviderCheck {
  private active?: AbortController;
  constructor(private generator: typeof generate = generate) {}
  invalidate() { this.active?.abort(); this.active = undefined; }
  async run(configuration: Pick<GenerateInput, 'provider' | 'model' | 'key' | 'effort'>): Promise<string | undefined> {
    this.invalidate();
    const ticket = new AbortController(); this.active = ticket;
    try {
      await this.generator({ ...configuration, signal: ticket.signal, reason: 'connection test', system: 'Return only the word Connected.', input: 'Synthetic connection check. No private conversation data.' });
      if (this.active === ticket) return 'Connected. Synthetic provider check passed.';
    } catch (error) {
      if (this.active === ticket) throw error;
    } finally { if (this.active === ticket) this.active = undefined; }
  }
}

import type { RemoteCommand } from '../shared/connector';

// Reset on a new document: identical geometry must still initialize its rail.
export class ChromeSync {
  private previous?: string;
  constructor(private readonly deliver: (command: Extract<RemoteCommand, { type: 'chrome' }>) => void) {}
  reset() { this.previous = undefined; }
  next(command: Extract<RemoteCommand, { type: 'chrome' }>) {
    const key = JSON.stringify(command);
    if (key === this.previous) return undefined;
    this.deliver(command);
    this.previous = key;
    return command;
  }
}

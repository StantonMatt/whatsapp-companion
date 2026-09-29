import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { initialState, stateSchema, type State } from '../shared/model';

export function atomicWrite(path: string, text: string) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  const fd = openSync(temp, 'r+'); // Windows FlushFileBuffers requires a writable handle.
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
export class Store {
  state: State;
  private path: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'companion.json');
    // Invalid data is never silently overwritten with defaults.
    this.state = existsSync(this.path) ? stateSchema.parse(JSON.parse(readFileSync(this.path, 'utf8'))) : initialState();
    for (const rules of Object.values(this.state.auto)) rules.paused = true;
  }
  update(mutator: (state: State) => void) {
    const next = structuredClone(this.state);
    mutator(next);
    stateSchema.parse(next);
    atomicWrite(this.path, JSON.stringify(next));
    this.state = next;
  }
}

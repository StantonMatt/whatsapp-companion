import { safeStorage } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { apiKeyError, type Provider } from '../shared/model';
import { atomicWrite, syncSavedDirectory, type StorageFault } from './store';

const vaultSchema = z.object({ openai: z.string().optional(), anthropic: z.string().optional(), backend: z.enum(['kwallet', 'kwallet5', 'kwallet6', 'gnome_libsecret']).optional() }).strict();
export function configuredBackend(directory: string) {
  const path = join(directory, 'credentials.json');
  return existsSync(path) ? vaultSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).backend : undefined;
}
export class Vault {
  // Disposable fixture keys never touch safeStorage or credentials.json.
  private fixtureKeys = new Map<Provider, string>();
  private file: string;
  private encrypted: z.infer<typeof vaultSchema>;
  durabilityWarning = false;
  constructor(directory: string, private fault?: StorageFault, private fixture = false) {
    this.file = join(directory, 'credentials.json');
    this.encrypted = !fixture && existsSync(this.file) ? vaultSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))) : {};
  }
  private save(next: z.infer<typeof vaultSchema>) {
    if (this.durabilityWarning) this.durabilityWarning = !syncSavedDirectory(dirname(this.file), this.fault, 'vault:retry');
    this.durabilityWarning = !atomicWrite(this.file, JSON.stringify(next), this.fault, 'vault');
    this.encrypted = next;
  }
  secure() { return this.fixture || safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'); }
  has(provider: Provider) { return this.fixtureKeys.has(provider) || Boolean(this.encrypted[provider]); }
  get(provider: Provider) {
    if (this.fixtureKeys.has(provider)) return this.fixtureKeys.get(provider)!;
    if (!this.encrypted[provider]) throw new Error(`Add your ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key in Settings.`);
    if (!this.secure()) throw new Error('The OS keyring could not unlock this key. Unlock it or add the key again.');
    try { return safeStorage.decryptString(Buffer.from(this.encrypted[provider]!, 'base64')); }
    catch { throw new Error('The OS keyring could not unlock this key. Unlock it or add the key again.'); }
  }
  set(provider: Provider, key: string, _persist: true) {
    const error = apiKeyError(provider, key);
    if (error) throw new Error(error);
    if (this.fixture) { this.fixtureKeys.set(provider, key); return; }
    if (!this.secure()) throw new Error('Can’t save keys because secure storage is unavailable.' + (process.platform === 'linux' ? ' Unlock KWallet or Secret Service.' : ''));
    const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined;
    const next = vaultSchema.parse({ ...this.encrypted, ...(backend ? { backend } : {}), [provider]: safeStorage.encryptString(key).toString('base64') });
    this.save(next);
  }
  remove(provider: Provider) {
    if (this.fixture) { this.fixtureKeys.delete(provider); return; }
    const next = { ...this.encrypted }; delete next[provider];
    this.save(next);
  }
}

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const storage = vi.hoisted(() => ({ backend: 'kwallet6', available: true }));
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => storage.available,
  getSelectedStorageBackend: () => storage.backend,
  encryptString: (s: string) => Buffer.from(s.split('').reverse().join('')),
  decryptString: (s: Buffer) => s.toString().split('').reverse().join('')
} }));
import { Vault, configuredBackend } from '../src/main/vault';
import * as store from '../src/main/store';
let dir: string;
const key = 'sk-synthetic_fixture_key_never_real';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'companion-vault-')); storage.backend = 'kwallet6'; storage.available = true; });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
test('persisted credentials use OS encryption and survive a new vault instance', () => {
  const vault = new Vault(dir); vault.set('openai', key, true);
  expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).not.toContain(key);
  expect(new Vault(dir).get('openai')).toBe(key);
  expect(configuredBackend(dir)).toBe('kwallet6');
  expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600);
});
test('rejects basic_text and locked keyrings without writing', () => {
  storage.backend = 'basic_text'; const vault = new Vault(dir);
  expect(vault.secure()).toBe(false); expect(() => vault.set('openai', key, true)).toThrow('secure storage is unavailable');
  expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
  storage.available = false; expect(vault.secure()).toBe(false);
});
test('fixture keys never use the OS keyring or write credentials', () => {
  storage.available = false; const write = vi.spyOn(store, 'atomicWrite'), vault = new Vault(dir, undefined, true);
  vault.set('openai', key, true); expect(vault.secure()).toBe(true); expect(vault.get('openai')).toBe(key);
  expect(write).not.toHaveBeenCalled(); expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
  vault.remove('openai'); expect(vault.has('openai')).toBe(false);
});
test('removing a key clears durable credentials', () => {
  const vault = new Vault(dir); vault.set('openai', key, true); vault.remove('openai');
  expect(vault.has('openai')).toBe(false); expect(new Vault(dir).has('openai')).toBe(false);
});
test.each([
  ['openai', 'invalid-key', 'valid API key'],
  ['openai', 'sk-ant-synthetic_fixture_key_never_real', 'Anthropic key'],
  ['anthropic', key, 'OpenAI key']
] as const)('invalid %s key rejects without changing disk or exposing text', (provider, invalid, message) => {
  const vault = new Vault(dir); vault.set('openai', key, true);
  const path = join(dir, 'credentials.json'), before = readFileSync(path, 'utf8'), write = vi.spyOn(store, 'atomicWrite');
  expect(() => vault.set(provider, invalid, true)).toThrow(message);
  expect(write).not.toHaveBeenCalled(); expect(readFileSync(path, 'utf8')).toBe(before); expect(vault.get('openai')).toBe(key);
});
test.each(['write', 'sync', 'replace', 'rename', 'directory-sync', 'directory'])('vault removal failure at %s keeps disk and memory aligned on later writes', checkpoint => {
  let fail = false;
  const vault = new Vault(dir, step => { if (fail && step === `vault:${checkpoint}`) throw new Error('IO failure'); });
  vault.set('openai', key, true); fail = true;
  const replaced = !['write', 'sync', 'replace'].includes(checkpoint);
  if (replaced) expect(() => vault.remove('openai')).not.toThrow();
  else expect(() => vault.remove('openai')).toThrow('IO failure');
  expect(vault.has('openai')).toBe(!replaced); expect(new Vault(dir).has('openai')).toBe(!replaced);
  expect(vault.durabilityWarning).toBe(replaced); fail = false;
  vault.set('anthropic', 'sk-ant-synthetic_fixture_key_never_real', true);
  expect(new Vault(dir).has('openai')).toBe(!replaced); expect(vault.durabilityWarning).toBe(false);
});
test('vault replacement adopts durable state after directory sync failure', () => {
  let fail = false;
  const vault = new Vault(dir, step => { if (fail && step.endsWith(':directory-sync')) throw new Error('sync failed'); });
  vault.set('openai', key, true); fail = true;
  const replacement = 'sk-synthetic_replacement_never_real';
  expect(() => vault.set('openai', replacement, true)).not.toThrow();
  expect(vault.get('openai')).toBe(replacement); expect(vault.durabilityWarning).toBe(true);
  const restored = new Vault(dir); expect(restored.has('openai')).toBe(true);
  expect(restored.get('openai')).toBe(replacement);
  expect(() => vault.set('anthropic', 'sk-ant-synthetic_fixture_key_never_real', true)).not.toThrow();
  expect(vault.has('anthropic')).toBe(true); fail = false;
  vault.set('anthropic', 'sk-ant-synthetic_fixture_key_never_real', true); expect(vault.durabilityWarning).toBe(false);
  expect(new Vault(dir).has('openai')).toBe(true);
});

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
test('rejects basic_text and locked keyrings; session-only keys never persist', () => {
  storage.backend = 'basic_text'; const vault = new Vault(dir);
  expect(vault.secure()).toBe(false); expect(() => vault.set('openai', key, true)).toThrow('Secure OS storage');
  vault.set('openai', key, false); expect(vault.get('openai')).toBe(key);
  expect(new Vault(dir).has('openai')).toBe(false);
  storage.available = false; expect(vault.secure()).toBe(false);
});
test('removing a key clears both durable and session copies', () => {
  const vault = new Vault(dir); vault.set('anthropic', key, true); vault.remove('anthropic');
  expect(vault.has('anthropic')).toBe(false); expect(new Vault(dir).has('anthropic')).toBe(false);
});
test.each(['openai', 'anthropic'] as const)('session-only %s replacement clears only its stored key even with unavailable storage', (provider) => {
  const other = provider === 'openai' ? 'anthropic' : 'openai', sessionKey = 'sk-synthetic_session_key_never_real';
  const vault = new Vault(dir); vault.set(provider, key, true); vault.set(other, key, true);
  const path = join(dir, 'credentials.json'), before = JSON.parse(readFileSync(path, 'utf8'));
  storage.available = false; vault.set(provider, sessionKey, false);
  expect(vault.get(provider)).toBe(sessionKey);
  const after = JSON.parse(readFileSync(path, 'utf8'));
  expect(after).toEqual({ [other]: before[other], backend: before.backend });
  const restored = new Vault(dir); expect(restored.has(provider)).toBe(false);
  expect(() => restored.get(provider)).toThrow('API key in Settings');
  storage.available = true; expect(restored.get(other)).toBe(key); expect(configuredBackend(dir)).toBe('kwallet6');
});
test('session-only replacement clears a stored key with a basic_text backend', () => {
  const vault = new Vault(dir); vault.set('openai', key, true); storage.backend = 'basic_text';
  vault.set('openai', 'sk-synthetic_session_key_never_real', false);
  expect(vault.get('openai')).toBe('sk-synthetic_session_key_never_real'); expect(new Vault(dir).has('openai')).toBe(false);
});
test('session-only entry without a stored key does not write a file', () => {
  const write = vi.spyOn(store, 'atomicWrite'), vault = new Vault(dir);
  vault.set('openai', key, false);
  expect(vault.get('openai')).toBe(key); expect(write).not.toHaveBeenCalled(); expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
});
test('session-only entry without its own stored key leaves another provider untouched without writing', () => {
  const vault = new Vault(dir); vault.set('anthropic', key, true);
  const path = join(dir, 'credentials.json'), before = readFileSync(path, 'utf8'), write = vi.spyOn(store, 'atomicWrite');
  vault.set('openai', key, false);
  expect(write).not.toHaveBeenCalled(); expect(readFileSync(path, 'utf8')).toBe(before); expect(new Vault(dir).get('anthropic')).toBe(key);
});
test.each([false, true])('failed session-only removal preserves state with an existing session key: %s', (existingSession) => {
  const original = new Vault(dir); original.set('openai', key, true);
  const vault = existingSession ? original : new Vault(dir), path = join(dir, 'credentials.json'), before = readFileSync(path, 'utf8');
  mkdirSync(`${path}.tmp`);
  expect(() => vault.set('openai', 'sk-synthetic_session_key_never_real', false)).toThrow();
  expect(vault.get('openai')).toBe(key); expect(readFileSync(path, 'utf8')).toBe(before); expect(new Vault(dir).get('openai')).toBe(key);
});
test.each([false, true])('invalid key rejects without changing stored or session keys (persist: %s)', (persist) => {
  const vault = new Vault(dir); vault.set('openai', key, true);
  const path = join(dir, 'credentials.json'), before = readFileSync(path, 'utf8'), write = vi.spyOn(store, 'atomicWrite');
  expect(() => vault.set('openai', 'invalid-key', persist)).toThrow('valid API key');
  expect(write).not.toHaveBeenCalled(); expect(readFileSync(path, 'utf8')).toBe(before); expect(vault.get('openai')).toBe(key);
});

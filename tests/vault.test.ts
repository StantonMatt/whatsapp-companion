import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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
let dir: string;
const key = 'sk-synthetic_fixture_key_never_real';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'companion-vault-')); storage.backend = 'kwallet6'; storage.available = true; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
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

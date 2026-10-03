import { safeStorage } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Provider } from '../shared/model';
import { atomicWrite, syncSavedDirectory, type StorageFault } from './store';

const vaultSchema = z.object({ openai: z.string().optional(), anthropic: z.string().optional(), backend: z.enum(['kwallet', 'kwallet5', 'kwallet6', 'gnome_libsecret']).optional() }).strict();
export function configuredBackend(directory: string) {
  const path = join(directory, 'credentials.json');
  return existsSync(path) ? vaultSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).backend : undefined;
}
export class Vault {
  private session = new Map<Provider, string>();
  private file: string;
  private encrypted: z.infer<typeof vaultSchema>;
  durabilityWarning = false;
  constructor(directory: string, private fault?: StorageFault) {
    this.file = join(directory, 'credentials.json');
    this.encrypted = existsSync(this.file) ? vaultSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))) : {};
  }
  private save(next: z.infer<typeof vaultSchema>, applySession: () => void) {
    if (this.durabilityWarning) this.durabilityWarning = !syncSavedDirectory(dirname(this.file), this.fault, 'vault:retry');
    this.durabilityWarning = !atomicWrite(this.file, JSON.stringify(next), this.fault, 'vault');
    this.encrypted = next; applySession();
  }
  secure() { return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'); }
  has(provider: Provider) { return this.session.has(provider) || Boolean(this.encrypted[provider]); }
  get(provider: Provider) {
    if (this.session.has(provider)) return this.session.get(provider)!;
    if (!this.encrypted[provider]) throw new Error(`Add your ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key in Settings.`);
    if (!this.secure()) throw new Error('Unlock the OS keyring, or enter a key for this session. Plaintext credential storage is disabled.');
    try { return safeStorage.decryptString(Buffer.from(this.encrypted[provider]!, 'base64')); }
    catch { throw new Error('The OS keyring could not unlock this key. Unlock it or add the key again.'); }
  }
  set(provider: Provider, key: string, persist: boolean) {
    if (!/^sk-[A-Za-z0-9_-]{16,500}$/.test(key)) throw new Error('This does not look like a valid API key.');
    if (persist) {
      if (!this.secure()) throw new Error('Secure OS storage is unavailable. Unlock KWallet or Secret Service, or use a session-only key.');
      const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined;
      const next = vaultSchema.parse({ ...this.encrypted, ...(backend ? { backend } : {}), [provider]: safeStorage.encryptString(key).toString('base64') });
      this.save(next, () => this.session.set(provider, key)); return;
    } else if (this.encrypted[provider] !== undefined) {
      const next = { ...this.encrypted }; delete next[provider];
      this.save(next, () => this.session.set(provider, key)); return;
    }
    this.session.set(provider, key);
  }
  remove(provider: Provider) {
    const next = { ...this.encrypted }; delete next[provider];
    this.save(next, () => this.session.delete(provider));
  }
}

// Keys travel from an OS password dialog directly into the main process. No key IPC or renderer field.
export function promptKey(provider: Provider): Promise<string> {
  const title = `WhatsApp Companion — ${provider} API key`;
  let executable: string, args: string[];
  if (process.platform === 'linux') {
    executable = 'kdialog'; args = ['--title', title, '--password', 'Enter the dedicated API key. It stays outside WhatsApp and the app renderer.'];
  } else if (process.platform === 'darwin') {
    executable = '/usr/bin/osascript'; args = ['-e', `text returned of (display dialog "Enter your ${provider} API key" default answer "" with hidden answer with title "WhatsApp Companion")`];
  } else {
    executable = 'powershell.exe'; args = ['-NoProfile', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; $f=New-Object Windows.Forms.Form; $f.Text='${title}'; $f.Width=500; $f.Height=160; $t=New-Object Windows.Forms.TextBox; $t.UseSystemPasswordChar=$true; $t.Width=450; $t.Top=15; $t.Left=15; $b=New-Object Windows.Forms.Button; $b.Text='Save'; $b.Top=50; $b.Left=15; $b.DialogResult='OK'; $f.Controls.AddRange(@($t,$b)); $f.AcceptButton=$b; if($f.ShowDialog() -eq 'OK'){[Console]::Write($t.Text)}`];
  }
  return new Promise((resolve, reject) => execFile(executable, args, { timeout: 180000, maxBuffer: 2048, windowsHide: true }, (error, stdout) => {
    if (error || !stdout.trim()) reject(new Error('Key entry cancelled or unavailable. Linux requires kdialog and a desktop display.'));
    else resolve(stdout.trim());
  }));
}

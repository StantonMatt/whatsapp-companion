import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

type Options = { packaged: boolean; fixture: boolean; platform: NodeJS.Platform; configDirectory: string; executable: string;
  setLoginItemSettings: (settings: { openAtLogin: boolean; args: string[] }) => void };
export class StartAtLogin {
  constructor(private options: Options) {}
  initialize(stored: boolean | undefined, tray: boolean, save: (enabled: boolean) => void = () => {}) {
    if (!this.options.packaged || this.options.fixture || (stored === undefined && !tray)) return stored;
    const enabled = stored ?? true;
    this.change(enabled, stored === true, value => { if (value !== stored) save(value); }); return enabled;
  }
  change(enabled: boolean, previous: boolean, save: (enabled: boolean) => void) {
    this.apply(enabled);
    try { save(enabled); }
    catch (error) {
      try { this.apply(previous); }
      catch (rollback) { throw new AggregateError([error, rollback], 'Start at login could not be saved or restored.'); }
      throw error;
    }
  }
  apply(enabled: boolean) {
    const options = this.options;
    if (!options.packaged || options.fixture) return;
    if (options.platform !== 'linux') {
      options.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] }); return;
    }
    const directory = join(options.configDirectory, 'autostart'), path = join(directory, 'whatsapp-companion.desktop');
    if (!enabled) {
      try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return;
    }
    // Exec quoting is decoded after Desktop Entry string escaping. Percent is
    // a field-code escape, including inside a quoted executable name.
    if (/[\r\n\0]/.test(options.executable)) throw new Error('Invalid login executable.');
    const executable = options.executable.replace(/%/g, '%%').replace(/["`$\\]/g, '\\$&').replace(/\\/g, '\\\\');
    const entry = `[Desktop Entry]\nType=Application\nName=WhatsApp Companion\nExec="${executable}" --hidden\nIcon=whatsapp-companion\nX-GNOME-Autostart-enabled=true\n`;
    try {
      const current = lstatSync(path);
      if (current.isFile() && (current.mode & 0o777) === 0o600 && readFileSync(path, 'utf8') === entry) return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `.whatsapp-companion-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, entry, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}

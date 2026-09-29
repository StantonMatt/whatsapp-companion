import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runIconsTool } from 'app-builder-lib/out/toolsets/icons.js';

// Use the icon converter from the lockfile-pinned electron-builder toolchain.
// Exports are checked in; ordinary builds do not download or run the converter.
const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const inputFile = fileURLToPath(new URL('../assets/icon-source.png', import.meta.url));
await mkdir(`${assets}/icons`, { recursive: true });
for (const outputFormat of ['set', 'ico', 'icns']) {
  await runIconsTool({ inputFile, outputFormat, outDir: outputFormat === 'set' ? `${assets}/icons` : assets });
}
console.log('Exported Linux PNG sizes, Windows ICO and macOS ICNS to assets/.');

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIconsTool } from 'app-builder-lib/out/toolsets/icons.js';
import renderer from './render-icons.cjs';

// Render each PNG from its SVG, including the hand-tuned 16–48 px sources.
// Only macOS ICNS uses the lockfile-pinned electron-builder converter.
// Exports are checked in; ordinary builds do not download or run the converter.
const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const inputFile = fileURLToPath(new URL('../assets/icon-source.png', import.meta.url));
await renderer.renderIcons(join(assets, 'icon'), assets, {
  pngDir: join(assets, 'icons'), masterFile: 'icon-source.png'
});
await runIconsTool({ inputFile, outputFormat: 'icns', outDir: assets });
console.log('Exported Linux PNG sizes, Windows ICO and macOS ICNS to assets/.');

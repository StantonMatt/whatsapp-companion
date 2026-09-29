import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/ui', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' }),
  ...['local', 'remote'].map(name => build({ entryPoints: [`src/preload/${name}.ts`], outfile: `dist/${name}.cjs`, bundle: true, platform: 'browser', format: 'cjs', external: ['electron'], target: 'chrome140' })),
  build({ entryPoints: ['src/ui/index.tsx'], outfile: 'dist/ui/app.js', bundle: true, platform: 'browser', format: 'esm', target: 'chrome140', minify: true }),
  copyFile('src/ui/index.html', 'dist/ui/index.html'),
  copyFile('assets/icons/512x512.png', 'dist/icon.png'),
  copyFile('tests/fixtures/whatsapp.html', 'dist/fixture.html')
]);

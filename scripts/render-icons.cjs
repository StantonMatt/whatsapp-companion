// Renders the Buddy icon PNGs and a PNG-framed Windows ICO from the hand-made SVGs with
// Playwright's Chromium (Skia). Usage: node render-icons.cjs <svg-dir> <out-dir>
// Uses the repository's @playwright/test dependency. Sizes with a hand-tuned SVG use it;
// every other size is rendered from the master at that exact size (no bitmap resampling).
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const tuned = { 16: 'buddy-16.svg', 24: 'buddy-24.svg', 32: 'buddy-32.svg', 48: 'buddy-48.svg' };
const jobs = [{ size: 1024, svg: 'buddy.svg', out: 'icon-1024.png' }];
for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
  jobs.push({ size, svg: tuned[size] || 'buddy.svg', out: `${size}x${size}.png` });
}
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

function ico(frames) {
  // ICONDIR + ICONDIRENTRY per frame, each frame stored as PNG data (Windows Vista and later).
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e); header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...frames.map((f) => f.data)]);
}

async function renderIcons(svgDir, outDir, { pngDir = outDir, masterFile = 'icon-1024.png' } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(pngDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1100, height: 1100 } });
    for (const job of jobs) {
      const svg = fs.readFileSync(path.join(svgDir, job.svg)).toString('base64');
      await page.setContent(`<!doctype html><body style="margin:0;background:transparent"><img id="i" src="data:image/svg+xml;base64,${svg}" width="${job.size}" height="${job.size}" style="display:block">`);
      await page.waitForFunction(() => document.getElementById('i').complete && document.getElementById('i').naturalWidth > 0);
      const output = job.size === 1024 ? path.join(outDir, masterFile) : path.join(pngDir, job.out);
      await page.screenshot({ path: output, omitBackground: true, clip: { x: 0, y: 0, width: job.size, height: job.size } });
    }
  } finally {
    await browser.close();
  }
  const frames = icoSizes.map((size) => ({ size, data: fs.readFileSync(path.join(pngDir, `${size}x${size}.png`)) }));
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico(frames));
  console.log(`Rendered ${jobs.length} PNGs and icon.ico into ${outDir}`);
}

module.exports = { renderIcons };
if (require.main === module) {
  const [svgDir, outDir] = process.argv.slice(2);
  if (!svgDir || !outDir) throw new Error('usage: node scripts/render-icons.cjs <svg-dir> <out-dir>');
  renderIcons(svgDir, outDir).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

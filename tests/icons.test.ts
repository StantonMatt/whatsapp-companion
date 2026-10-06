import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const asset = (name: string) => readFileSync(new URL(`../assets/${name}`, import.meta.url));

function expectPng(data: Buffer, size: number) {
  expect(data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(data.toString('ascii', 12, 16)).toBe('IHDR');
  expect([data.readUInt32BE(16), data.readUInt32BE(20)]).toEqual([size, size]);
  expect([data[24], data[25]]).toEqual([8, 6]); // 8-bit RGBA, including transparency.
}

test('the master and Linux icon exports have the expected RGBA dimensions', () => {
  expectPng(asset('icon-source.png'), 1024);
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    expectPng(asset(`icons/${size}x${size}.png`), size);
  }
});

test('Windows ICO preserves the tuned PNG frames unchanged', () => {
  const data = asset('icon.ico');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  expect([data.readUInt16LE(0), data.readUInt16LE(2), data.readUInt16LE(4)]).toEqual([0, 1, sizes.length]);
  sizes.forEach((size, index) => {
    const entry = 6 + 16 * index;
    expect([data[entry] || 256, data[entry + 1] || 256]).toEqual([size, size]);
    const length = data.readUInt32LE(entry + 8), offset = data.readUInt32LE(entry + 12);
    expect(data.subarray(offset, offset + length)).toEqual(asset(`icons/${size}x${size}.png`));
  });
});

test('platform packaging paths resolve to the checked-in icon exports', () => {
  const { build } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expectPng(readFileSync(new URL(`../${build.linux.icon}/512x512.png`, import.meta.url)), 512);
  expect(readFileSync(new URL(`../${build.win.icon}`, import.meta.url)).readUInt16LE(2)).toBe(1);
  const icns = readFileSync(new URL(`../${build.mac.icon}`, import.meta.url));
  expect(icns.toString('ascii', 0, 4)).toBe('icns');
  expect(icns.readUInt32BE(4)).toBe(icns.length);
});

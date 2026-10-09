import { afterEach, expect, test, vi } from 'vitest';
import { decodeStickerTagFrames, tagImagesSchema } from '../src/main/sticker-tag-images';
const image = 'data:image/webp;base64,AAAA';
afterEach(() => vi.unstubAllGlobals());
function canvas() {
  const draws = vi.fn(); const sizes: [number, number][] = [];
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(width: number, height: number) { sizes.push([width, height]); }
    getContext() { return { drawImage: draws }; }
    async convertToBlob() { return new Blob([Uint8Array.of(137, 80, 78, 71)]); }
  });
  return { draws, sizes };
}
test('animated frames sample beginning, middle and end; close every frame and cap PNG dimensions', async () => {
  const { sizes } = canvas(), close = vi.fn(), decode = vi.fn(async (_options: { frameIndex: number }) => ({ image: { displayWidth: 1024, displayHeight: 512, close } })), finish = vi.fn();
  vi.stubGlobal('ImageDecoder', class { tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 9 } }; completed = Promise.resolve(); decode = decode; close = finish; });
  expect(await decodeStickerTagFrames(image, true)).toHaveLength(3);
  expect(decode.mock.calls.map(([arg]) => arg)).toEqual([{ frameIndex: 0 }, { frameIndex: 4 }, { frameIndex: 8 }]);
  expect(sizes).toEqual([[512, 256], [512, 256], [512, 256]]); expect(close).toHaveBeenCalledTimes(3); expect(finish).toHaveBeenCalledOnce();
});
test('an unreliable animation decoder retains a successful representative frame', async () => {
  canvas(); let index = 0; const close = vi.fn(), fallback = vi.fn();
  vi.stubGlobal('ImageDecoder', class { tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 9 } }; completed = Promise.resolve(); async decode() { if (++index > 1) throw new Error('unsupported'); return { image: { displayWidth: 80, displayHeight: 80, close } }; } close() {} });
  vi.stubGlobal('createImageBitmap', fallback);
  expect(await decodeStickerTagFrames(image, true)).toHaveLength(1); expect(fallback).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});
test('static PNG conversion and animation fallback close bitmap; oversized frame data is rejected', async () => {
  canvas(); const close = vi.fn(); vi.stubGlobal('ImageDecoder', undefined); vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 80, height: 80, close })));
  expect(tagImagesSchema.parse(await decodeStickerTagFrames(image, false))).toHaveLength(1);
  expect(await decodeStickerTagFrames(image, true)).toHaveLength(1); expect(close).toHaveBeenCalledTimes(2);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 8192, height: 8192, close })));
  await expect(decodeStickerTagFrames(image, false)).rejects.toThrow('dimensions');
  expect(() => tagImagesSchema.parse([{ mime: 'image/png', data: 'a'.repeat(2_800_001) }])).toThrow();
});
test('unsupported WebCodecs constructor falls back to a representative bitmap', async () => {
  canvas(); vi.stubGlobal('ImageDecoder', class { constructor() { throw new Error('unsupported codec'); } });
  const close = vi.fn(); vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 80, height: 80, close })));
  expect(await decodeStickerTagFrames(image, true)).toHaveLength(1); expect(close).toHaveBeenCalledOnce();
});

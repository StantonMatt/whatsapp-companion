import type { Sticker, DiscoveredSticker } from '../shared/model';
import { storedSticker } from './sticker-bytes';

export type StickerFingerprint = NonNullable<Sticker['fingerprint']>;
export type StickerPixels = (image: string) => Promise<unknown>;

// This self-contained function runs only in the trusted local controls renderer's
// isolated world. createImageBitmap selects an animated image's first frame.
// Main supplies the verified bytes; no values from WhatsApp's page are used.
export async function decodeStickerPixels(image: string): Promise<string> {
  const bytes = Uint8Array.from(atob(image.slice(image.indexOf(',') + 1)), c => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }), {
    resizeWidth: 9, resizeHeight: 8, resizeQuality: 'high', premultiplyAlpha: 'default'
  });
  try {
    const canvas = new OffscreenCanvas(9, 8), context = canvas.getContext('2d');
    if (!context) throw new Error('Sticker canvas unavailable.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 9, 8); context.drawImage(bitmap, 0, 0, 9, 8);
    const rgba = context.getImageData(0, 0, 9, 8).data;
    let rgb = '';
    for (let i = 0; i < rgba.length; i += 4) rgb += String.fromCharCode(rgba[i], rgba[i + 1], rgba[i + 2]);
    return btoa(rgb);
  } finally { bitmap.close(); }
}

// A paused/hung controls renderer must not leave main waiting indefinitely.
async function decodeWithDeadline(image: string, decode: StickerPixels, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Sticker decode timed out.')), 2000);
      cancel = () => reject(new Error('Sticker decode cancelled.'));
      signal?.addEventListener('abort', cancel, { once: true });
      Promise.resolve(decode(image)).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}

export async function fingerprintSticker(sticker: DiscoveredSticker, decode: StickerPixels, signal?: AbortSignal): Promise<StickerFingerprint> {
  const { animated } = storedSticker(sticker.image, sticker.id);
  checkStickerDimensions(sticker.image);
  const pixels = await decodeWithDeadline(sticker.image, decode, signal);
  if (typeof pixels !== 'string' || !/^[A-Za-z0-9+/]{288}$/.test(pixels)) throw new Error('Invalid sticker thumbnail.');
  const rgb = Buffer.from(pixels, 'base64');
  const grey = Array.from({ length: 72 }, (_, i) => rgb[i * 3] * 299 + rgb[i * 3 + 1] * 587 + rgb[i * 3 + 2] * 114);
  let hash = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash = (hash << 1n) | BigInt(grey[y * 9 + x] > grey[y * 9 + x + 1]);
  return { version: 1, animated, hash: hash.toString(16).padStart(16, '0'), pixels };
}

// A small encoded file can still declare an enormous decoded image. Check the
// canvas/frame dimensions before handing bytes to Chromium's decoder.
export function checkStickerDimensions(image: string) {
  const bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
  let dimensions = false;
  const check = (width: number, height: number) => {
    if (width > 2048 || height > 2048) throw new Error('Sticker dimensions exceed fingerprint limit.');
    dimensions = true;
  };
  const chunks = (start: number, end: number) => {
    for (let offset = start; offset + 8 <= end;) {
      const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), data = offset + 8;
      if (data + length > end) throw new Error('Invalid WebP image chunk.');
      if (type === 'VP8X' && length >= 10) check(1 + bytes.readUIntLE(data + 4, 3), 1 + bytes.readUIntLE(data + 7, 3));
      if (type === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
        const bits = bytes.readUInt32LE(data + 1); check(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
      }
      if (type === 'VP8 ' && length >= 10 && bytes.toString('hex', data + 3, data + 6) === '9d012a') check(bytes.readUInt16LE(data + 6) & 0x3fff, bytes.readUInt16LE(data + 8) & 0x3fff);
      if (type === 'ANMF' && length >= 16) {
        check(1 + bytes.readUIntLE(data + 6, 3), 1 + bytes.readUIntLE(data + 9, 3));
        chunks(data + 16, data + length);
      }
      offset = data + length + (length & 1);
    }
  };
  chunks(12, bytes.length);
  if (!dimensions) throw new Error('Missing WebP dimensions.');
}

export function nearSticker(a: StickerFingerprint, b: StickerFingerprint): boolean {
  // a is the observation, b the retained entry. A still can be a flattened
  // first-frame copy, but an animation must never be suppressed by a still.
  if (a.animated && !b.animated) return false;
  let bits = BigInt(`0x${a.hash}`) ^ BigInt(`0x${b.hash}`), distance = 0;
  while (bits) { bits &= bits - 1n; if (++distance > 4) return false; }
  const left = Buffer.from(a.pixels, 'base64'), right = Buffer.from(b.pixels, 'base64');
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference += Math.abs(left[i] - right[i]);
  // dHash alone confuses flat fills and simple monotonic gradients. Require the
  // thumbnail's mean absolute RGB difference to also be at most 12/255.
  return difference <= 12 * left.length;
}

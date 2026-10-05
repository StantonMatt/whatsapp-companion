import { createHash } from 'node:crypto';
import { MAX_STICKER_BYTES } from '../shared/sticker-limits';

// Validation failures are permanent for this observation; filesystem failures
// remain ordinary errors and can be retried by intake.
export class InvalidStickerError extends Error {}

// Walk RIFF chunks, including odd-length padding. Searching arbitrary bytes for
// ANIM would mistake compressed static image data for animation metadata.
export function storedSticker(image: string, id: string) {
  if (!/^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/.test(image)) throw new InvalidStickerError('Invalid stored sticker.');
  const bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
  return { ...verifyStickerBytes(bytes, id), image };
}

export function verifyStickerBytes(bytes: Buffer, id: string) {
  if (bytes.length < 12 || bytes.length > MAX_STICKER_BYTES || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== id) throw new InvalidStickerError('Stored sticker bytes do not match their hash.');
  let animated = false;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new InvalidStickerError('Invalid WebP chunk.');
    const length = bytes.readUInt32LE(offset + 4), end = offset + 8 + length + (length & 1);
    if (end > bytes.length) throw new InvalidStickerError('Invalid WebP chunk.');
    animated ||= bytes.toString('ascii', offset, offset + 4) === 'ANIM';
    offset = end;
  }
  return { animated, bytes };
}

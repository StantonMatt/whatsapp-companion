import { z } from 'zod';
import type { ProviderImage } from './providers';

export const tagImagesSchema = z.array(z.object({ mime: z.literal('image/png'), data: z.string().max(2_800_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict()).min(1).max(3);

// Bundled function, executed only in the local controls isolated world. Neither
// provider credentials nor a page-callable bridge enter this world.
export async function decodeStickerTagFrames(image: string, animated: boolean): Promise<ProviderImage[]> {
  const bytes = Uint8Array.from(atob(image.split(',')[1]), c => c.charCodeAt(0));
  const result: ProviderImage[] = [];
  const png = async (frame: CanvasImageSource & { width?: number; height?: number; displayWidth?: number; displayHeight?: number }) => {
    const width = frame.displayWidth ?? frame.width ?? 0, height = frame.displayHeight ?? frame.height ?? 0;
    if (!width || !height || width > 2048 || height > 2048) throw new Error('Invalid sticker dimensions.');
    const scale = Math.min(1, 512 / Math.max(width, height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Sticker canvas unavailable.');
    context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    const data = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    if (data.length > 2_000_000) throw new Error('Sticker frame too large.');
    let binary = '';
    for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
    result.push({ mime: 'image/png', data: btoa(binary) });
  };
  // WebCodecs typings are absent from lib.dom in some supported TS releases.
  const Decoder = (globalThis as unknown as { ImageDecoder?: new (options: { data: Uint8Array; type: string }) => {
    tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } }; completed: Promise<void>;
    decode(options: { frameIndex: number }): Promise<{ image: VideoFrame }>; close(): void;
  } }).ImageDecoder;
  if (animated && Decoder) {
    let decoder: InstanceType<NonNullable<typeof Decoder>> | undefined;
    try {
      decoder = new Decoder({ data: bytes, type: 'image/webp' });
      await decoder.tracks.ready; await decoder.completed;
      const count = decoder.tracks.selectedTrack?.frameCount ?? 1;
      for (const frameIndex of new Set([0, Math.floor((count - 1) / 2), count - 1])) {
        const { image: frame } = await decoder.decode({ frameIndex });
        try { await png(frame); } finally { frame.close(); }
      }
    } catch { /* A successfully decoded first frame is sufficient. */ }
    finally { decoder?.close(); }
  }
  if (!result.length) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
    try { await png(bitmap); } finally { bitmap.close(); }
  }
  return result;
}

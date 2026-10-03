import type { Store } from './store';

export const STICKER_SCHEME = 'companion-sticker';
// URL parsing alone normalizes traversal, escaping and userinfo. Accept only the
// canonical spelling, including Chromium's optional root slash.
export function stickerResponse(store: Pick<Store, 'readSticker'>, request: { url: string; method: string }): Response {
  const match = /^companion-sticker:\/\/([a-f0-9]{64})\/?$/.exec(request.url);
  if (!match || request.method !== 'GET') return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  try {
    const { bytes } = store.readSticker(match[1]);
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch { return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } }); }
}

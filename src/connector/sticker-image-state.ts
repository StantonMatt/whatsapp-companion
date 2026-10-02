type StickerImageState = 'ready' | 'pending' | 'settled';
const observed = new WeakMap<HTMLImageElement, { failedSource?: string }>();

// A broken image is complete in browsers, but also remember explicit errors
// while a mounted image still reports incomplete. A new source/load can retry.
export function stickerImageState(image: HTMLImageElement): StickerImageState {
  let state = observed.get(image);
  if (!state) {
    state = {};
    observed.set(image, state);
    const tracked = state;
    image.addEventListener('error', () => { tracked.failedSource = image.currentSrc || image.src; });
    image.addEventListener('load', () => { tracked.failedSource = undefined; });
  }
  const source = image.currentSrc || image.src;
  if (state.failedSource !== source) state.failedSource = undefined;
  if (state.failedSource === source) return 'settled';
  if (!image.complete) return 'pending';
  // Complete-but-undecodable and unsupported sources cannot become matches,
  // and must not hold scrolling or category exhaustion open forever.
  return image.naturalWidth > 0 && /^(blob:|data:image\/webp;)/.test(source) ? 'ready' : 'settled';
}

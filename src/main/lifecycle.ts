// A live webContents can already have a disposed frame during navigation/close.
type RendererContents = { isDestroyed(): boolean; readonly mainFrame: { isDestroyed(): boolean } | null; send(channel: string, ...args: unknown[]): void };

// Required command delivery must reach the caller's failure/settlement path.
// Only best-effort presentation and cleanup may discard delivery errors.
export function requireRendererSend(contents: RendererContents, closing: boolean, channel: string, ...args: unknown[]) {
  if (closing || contents.isDestroyed()) throw new Error('Renderer unavailable');
  const frame = contents.mainFrame;
  if (!frame || frame.isDestroyed()) throw new Error('Renderer unavailable');
  contents.send(channel, ...args);
}
export function safeRendererSend(contents: RendererContents, closing: boolean, channel: string, ...args: unknown[]) {
  try {
    requireRendererSend(contents, closing, channel, ...args); return true;
  } catch { return false; }
}
export function positiveBounds(bounds: { width: number; height: number }) {
  return Number.isFinite(bounds.width) && Number.isFinite(bounds.height) && bounds.width > 0 && bounds.height > 0;
}
export function startupThrottling(contents: { isDestroyed(): boolean; setBackgroundThrottling(value: boolean): void }) {
  let restored = false;
  return () => {
    if (restored || contents.isDestroyed()) return;
    try { contents.setBackgroundThrottling(true); restored = true; } catch { /* Disposed renderer. */ }
  };
}
export function cleanupOnce(steps: (() => void)[], quit: () => void) {
  let cleaned = false;
  return () => {
    if (cleaned) return; cleaned = true;
    try { for (const step of steps) { try { step(); } catch { /* One failed cleanup cannot prevent the next. */ } } }
    finally { quit(); }
  };
}

// Diagnostic IO is best effort; a slow disk must not keep the instance lock forever.
export async function quitAfterFlush(flush: () => Promise<void>, quit: () => void, timeoutMs = 1000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(flush),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })
    ]);
  } catch { /* Diagnostics cannot veto shutdown. */ }
  finally { clearTimeout(timer); quit(); }
}

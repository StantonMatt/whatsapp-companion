import type { WebContents } from 'electron';

const whatsappOrigin = 'https://web.whatsapp.com';
type PromptPermission = 'notifications' | 'media';

export function installRemotePermissions(remote: WebContents, fixtureURL: string | undefined, prompt: (permission: PromptPermission) => Promise<boolean>, notifications: NotificationConsent): void {
  const granted = new Set<PromptPermission>();
  const allowedURL = (url: string | undefined) => {
    if (!url) return false;
    if (fixtureURL) return url === fixtureURL;
    try { return new URL(url).origin === whatsappOrigin; }
    catch { return false; }
  };
  const allowedFrame = (contents: WebContents | null, details: { isMainFrame: boolean; requestingUrl?: string }) =>
    contents === remote && details.isMainFrame && allowedURL(details.requestingUrl);
  const allowedOrigin = (origin: string) => {
    // Electron serializes check origins as URLs with a trailing slash.
    if (!fixtureURL) {
      try { return new URL(origin).origin === whatsappOrigin; }
      catch { return false; }
    }
    // File origins can be serialized as file://, file:/// or null. The exact
    // fixture document URL is still required by allowedFrame.
    if (origin === 'null') return true;
    try { return new URL(origin).protocol === 'file:'; }
    catch { return false; }
  };
  const promptedPermission = (permission: string): permission is PromptPermission => permission === 'notifications' || permission === 'media';

  remote.session.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (notifications.isClosed() || !allowedFrame(contents, details) || !allowedOrigin(origin)) return false;
    // Covers ClipboardItem images and writeText. Chromium retains its gesture
    // checks; no clipboard reads or unsanitized writes are granted here.
    // A false media check reads as "denied" to permissions.query, and WhatsApp
    // then never calls getUserMedia. Each capture still goes through the
    // request handler, so the Allow prompt remains the gate.
    return permission === 'clipboard-sanitized-write' || permission === 'media' || (permission === 'notifications' && notifications.answer() === 'allowed');
  });
  remote.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (notifications.isClosed() || !allowedFrame(contents, details)) { callback(false); return; }
    if (permission === 'clipboard-sanitized-write') { callback(true); return; }
    if (!promptedPermission(permission)) { callback(false); return; }
    if (permission === 'notifications') {
      const answer = notifications.answer();
      if (answer !== undefined) callback(answer === 'allowed');
      else void notifications.request().then(allowed => callback(!notifications.isClosed() && allowed)).catch(() => callback(false));
      return;
    }
    if (granted.has(permission)) { callback(true); return; }
    void prompt(permission).then(answer => { const allowed = !notifications.isClosed() && answer; if (allowed) granted.add(permission); callback(allowed); }).catch(() => callback(false));
  });
}


type NotificationAnswer = 'allowed' | 'denied';
export class NotificationConsent {
  private pending?: { promise: Promise<boolean>; resolve: (allowed: boolean) => void };
  private dialog?: AbortController;
  private closed = false;
  private sessionAnswer?: NotificationAnswer;
  constructor(private options: { answer: () => NotificationAnswer | undefined; save: (answer: NotificationAnswer) => void;
    visible: () => boolean; prompt: (signal: AbortSignal) => Promise<boolean>; saveFailed?: () => void }) {}
  answer() { return this.sessionAnswer ?? this.options.answer(); }
  isClosed() { return this.closed; }
  change(allowed: boolean) {
    if (this.closed) return;
    const answer = allowed ? 'allowed' : 'denied';
    let failed = false;
    try { this.options.save(answer); this.sessionAnswer = undefined; }
    catch {
      // Keep the user's choice even when disk is unavailable. Heartbeats and
      // WhatsApp requests must not reopen the same consent dialog this session.
      this.sessionAnswer = answer; failed = true;
    }
    this.finish(allowed);
    if (failed) this.options.saveFailed?.();
  }
  request(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const answer = this.answer();
    if (answer !== undefined) return Promise.resolve(answer === 'allowed');
    if (!this.pending) {
      let resolve!: (allowed: boolean) => void;
      const promise = new Promise<boolean>(done => { resolve = done; });
      this.pending = { promise, resolve };
    }
    const promise = this.pending.promise;
    this.maybeAsk(); return promise;
  }
  maybeAsk() {
    if (this.closed || !this.pending || this.dialog || !this.options.visible()) return;
    const dialog = new AbortController(); this.dialog = dialog;
    void (async () => {
      try {
        const allowed = await this.options.prompt(dialog.signal);
        if (this.closed || dialog.signal.aborted) return;
        this.change(allowed);
      } catch { if (this.dialog === dialog) this.finish(false); }
    })();
  }
  private finish(allowed: boolean) {
    const pending = this.pending, dialog = this.dialog;
    this.pending = undefined; this.dialog = undefined;
    dialog?.abort(); pending?.resolve(allowed);
  }
  close() { this.closed = true; this.finish(false); }
}

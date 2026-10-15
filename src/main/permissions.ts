import type { WebContents } from 'electron';

const whatsappOrigin = 'https://web.whatsapp.com';
type PromptPermission = 'notifications' | 'media';

export function installRemotePermissions(remote: WebContents, fixtureURL: string | undefined, prompt: (permission: PromptPermission) => Promise<boolean>): void {
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
    if (!fixtureURL) return origin === whatsappOrigin;
    // File origins can be serialized as file://, file:/// or null. The exact
    // fixture document URL is still required by allowedFrame.
    if (origin === 'null') return true;
    try { return new URL(origin).protocol === 'file:'; }
    catch { return false; }
  };
  const promptedPermission = (permission: string): permission is PromptPermission => permission === 'notifications' || permission === 'media';

  remote.session.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (!allowedFrame(contents, details) || !allowedOrigin(origin)) return false;
    // Covers ClipboardItem images and writeText. Chromium retains its gesture
    // checks; no clipboard reads or unsanitized writes are granted here.
    // A false media check reads as "denied" to permissions.query, and WhatsApp
    // then never calls getUserMedia. Each capture still goes through the
    // request handler, so the Allow prompt remains the gate.
    return permission === 'clipboard-sanitized-write' || permission === 'media' || (promptedPermission(permission) && granted.has(permission));
  });
  remote.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!allowedFrame(contents, details)) { callback(false); return; }
    if (permission === 'clipboard-sanitized-write') { callback(true); return; }
    if (!promptedPermission(permission)) { callback(false); return; }
    if (granted.has(permission)) { callback(true); return; }
    void prompt(permission).then(allowed => { if (allowed) granted.add(permission); callback(allowed); }).catch(() => callback(false));
  });
}

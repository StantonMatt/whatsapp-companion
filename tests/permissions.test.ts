import type { Session, WebContents } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { installRemotePermissions } from '../src/main/permissions';

type Check = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
type Request = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
const origin = 'https://web.whatsapp.com';
const mainFrame = { isMainFrame: true, requestingUrl: `${origin}/` };

function setup(fixtureURL?: string) {
  let check!: Check, request!: Request;
  const remote = { session: {
    setPermissionCheckHandler: (handler: Check) => { check = handler; },
    setPermissionRequestHandler: (handler: Request) => { request = handler; }
  } } as unknown as WebContents;
  const prompt = vi.fn(async (_permission: 'notifications' | 'media') => true);
  installRemotePermissions(remote, fixtureURL, prompt);
  return { remote, check, request, prompt };
}

describe('remote permissions', () => {
  test('sanitized image/text writes are granted by both handlers without prompting', () => {
    const { remote, check, request, prompt } = setup();
    expect(check(remote, 'clipboard-sanitized-write', origin, mainFrame)).toBe(true);
    const callback = vi.fn();
    request(remote, 'clipboard-sanitized-write', callback, mainFrame);
    expect(callback).toHaveBeenCalledExactlyOnceWith(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  test.each(['clipboard-read', 'deprecated-sync-clipboard-read', 'clipboard-write', 'clipboard-unsanitized-write', 'geolocation', 'unknown'])('%s stays denied without prompting', permission => {
    const { remote, check, request, prompt } = setup();
    expect(check(remote, permission as Parameters<Check>[1], origin, mainFrame)).toBe(false);
    const callback = vi.fn();
    request(remote, permission as Parameters<Request>[1], callback, mainFrame);
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  test.each([
    ['other origin', { ...mainFrame, requestingUrl: 'https://example.com/' }, 'https://example.com'],
    ['HTTP', { ...mainFrame, requestingUrl: 'http://web.whatsapp.com/' }, 'http://web.whatsapp.com'],
    ['lookalike host', { ...mainFrame, requestingUrl: 'https://web.whatsapp.com.example.com/' }, 'https://web.whatsapp.com.example.com'],
    ['subframe', { ...mainFrame, isMainFrame: false }, origin],
    ['malformed URL', { ...mainFrame, requestingUrl: 'invalid' }, origin],
    ['empty URL', { ...mainFrame, requestingUrl: '' }, origin]
  ])('%s is denied in both handlers, including previously granted permissions', async (_label, details, requestingOrigin) => {
    const { remote, check, request, prompt } = setup();
    request(remote, 'notifications', vi.fn(), mainFrame);
    await vi.waitFor(() => expect(check(remote, 'notifications', origin, mainFrame)).toBe(true));
    prompt.mockClear();
    for (const permission of ['clipboard-sanitized-write', 'notifications', 'media'] as const) {
      expect(check(remote, permission, requestingOrigin, details)).toBe(false);
      const callback = vi.fn();
      request(remote, permission, callback, details);
      expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    }
    expect(prompt).not.toHaveBeenCalled();
  });

  test('checks require matching origin and a document URL', () => {
    const { remote, check } = setup();
    expect(check(remote, 'clipboard-sanitized-write', 'https://example.com', mainFrame)).toBe(false);
    expect(check(remote, 'clipboard-sanitized-write', origin, { isMainFrame: true })).toBe(false);
  });

  test.each([null, {} as WebContents])('other/missing webContents %j cannot check or request permissions', contents => {
    const { check, request, prompt } = setup();
    expect(check(contents, 'clipboard-sanitized-write', origin, mainFrame)).toBe(false);
    const callback = vi.fn();
    request(contents as WebContents, 'clipboard-sanitized-write', callback, mainFrame);
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  test.each(['notifications', 'media'] as const)('%s prompts and remembers only an explicit Allow', async permission => {
    const { remote, check, request, prompt } = setup();
    expect(check(remote, permission, origin, mainFrame)).toBe(false);
    prompt.mockResolvedValueOnce(false);
    const denied = vi.fn();
    request(remote, permission, denied, mainFrame);
    await vi.waitFor(() => expect(denied).toHaveBeenCalledExactlyOnceWith(false));
    expect(check(remote, permission, origin, mainFrame)).toBe(false);
    const allowed = vi.fn();
    request(remote, permission, allowed, mainFrame);
    await vi.waitFor(() => expect(allowed).toHaveBeenCalledExactlyOnceWith(true));
    expect(prompt).toHaveBeenNthCalledWith(1, permission);
    expect(prompt).toHaveBeenNthCalledWith(2, permission);
    expect(check(remote, permission, origin, mainFrame)).toBe(true);
    const cached = vi.fn();
    request(remote, permission, cached, mainFrame);
    expect(cached).toHaveBeenCalledExactlyOnceWith(true);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(check(remote, 'clipboard-read', origin, mainFrame)).toBe(false);
  });

  test('a failed prompt denies the request', async () => {
    const { remote, check, request, prompt } = setup();
    prompt.mockRejectedValueOnce(new Error('dialog closed'));
    const callback = vi.fn();
    request(remote, 'media', callback, mainFrame);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith(false));
    expect(check(remote, 'media', origin, mainFrame)).toBe(false);
  });

  test('fixture permission applies only to the exact fixture main frame', () => {
    const fixtureURL = 'file:///app/dist/fixture.html';
    const { remote, check, request, prompt } = setup(fixtureURL);
    const fixtureFrame = { isMainFrame: true, requestingUrl: fixtureURL };
    for (const fixtureOrigin of ['file://', 'file:///', 'null']) {
      expect(check(remote, 'clipboard-sanitized-write', fixtureOrigin, fixtureFrame)).toBe(true);
    }
    expect(check(remote, 'clipboard-sanitized-write', origin, fixtureFrame)).toBe(false);
    const callback = vi.fn();
    request(remote, 'clipboard-sanitized-write', callback, fixtureFrame);
    expect(callback).toHaveBeenCalledExactlyOnceWith(true);
    for (const details of [mainFrame, { ...fixtureFrame, isMainFrame: false }, { ...fixtureFrame, requestingUrl: 'file:///app/dist/ui/index.html' }]) {
      expect(check(remote, 'clipboard-sanitized-write', 'file://', details)).toBe(false);
      const denied = vi.fn();
      request(remote, 'clipboard-sanitized-write', denied, details);
      expect(denied).toHaveBeenCalledExactlyOnceWith(false);
    }
    expect(check(remote, 'clipboard-read', 'file://', fixtureFrame)).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });
});

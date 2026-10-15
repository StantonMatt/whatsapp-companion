import type { Session, WebContents } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { installRemotePermissions, NotificationConsent } from '../src/main/permissions';

type Check = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
type Request = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
// Electron passes check origins in this serialized URL form.
const origin = 'https://web.whatsapp.com/';
const mainFrame = { isMainFrame: true, requestingUrl: `${origin}/` };

function setup(fixtureURL?: string, initial?: 'allowed' | 'denied') {
  let check!: Check, request!: Request;
  const remote = { session: {
    setPermissionCheckHandler: (handler: Check) => { check = handler; },
    setPermissionRequestHandler: (handler: Request) => { request = handler; }
  } } as unknown as WebContents;
  const prompt = vi.fn(async (_permission: 'notifications' | 'media') => true);
  let answer = initial;
  const consent = new NotificationConsent({ answer: () => answer, save: value => { answer = value; }, visible: () => true, prompt: () => prompt('notifications') });
  installRemotePermissions(remote, fixtureURL, prompt, consent);
  return { remote, check, request, prompt, consent };
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

  test.each(['https://web.whatsapp.com', 'https://web.whatsapp.com/'])('checks accept the WhatsApp origin serialized as %s', requestingOrigin => {
    const { remote, check } = setup();
    expect(check(remote, 'media', requestingOrigin, mainFrame)).toBe(true);
    expect(check(remote, 'clipboard-sanitized-write', requestingOrigin, mainFrame)).toBe(true);
  });

  test.each(['https://example.com/', 'https://web.whatsapp.com.example.com/', 'invalid', 'null'])('checks deny origin %s from the WhatsApp frame', requestingOrigin => {
    const { remote, check } = setup();
    for (const permission of ['clipboard-sanitized-write', 'notifications', 'media'] as const) expect(check(remote, permission, requestingOrigin, mainFrame)).toBe(false);
  });

  test.each([
    ['other origin', { ...mainFrame, requestingUrl: 'https://example.com/' }, 'https://example.com/'],
    ['HTTP', { ...mainFrame, requestingUrl: 'http://web.whatsapp.com/' }, 'http://web.whatsapp.com/'],
    ['lookalike host', { ...mainFrame, requestingUrl: 'https://web.whatsapp.com.example.com/' }, 'https://web.whatsapp.com.example.com/'],
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

  test('media checks pass so WhatsApp requests capture, which still prompts', () => {
    const { remote, check, request, prompt } = setup();
    expect(check(remote, 'media', origin, mainFrame)).toBe(true);
    const callback = vi.fn();
    request(remote, 'media', callback, mainFrame);
    expect(prompt).toHaveBeenCalledExactlyOnceWith('media');
    expect(callback).not.toHaveBeenCalled();
  });

  test('media prompts and remembers only an explicit Allow', async () => {
    const permission = 'media';
    const { remote, check, request, prompt } = setup();
    const checked = permission === 'media';
    expect(check(remote, permission, origin, mainFrame)).toBe(checked);
    prompt.mockResolvedValueOnce(false);
    const denied = vi.fn();
    request(remote, permission, denied, mainFrame);
    await vi.waitFor(() => expect(denied).toHaveBeenCalledExactlyOnceWith(false));
    expect(check(remote, permission, origin, mainFrame)).toBe(checked);
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
    request(remote, 'notifications', callback, mainFrame);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith(false));
    expect(check(remote, 'notifications', origin, mainFrame)).toBe(false);
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


test.each(['allowed', 'denied'] as const)('saved %s notifications are checked live and requests never prompt', answer => {
  const { remote, check, request, prompt } = setup(undefined, answer);
  expect(check(remote, 'notifications', origin, mainFrame)).toBe(answer === 'allowed');
  const callback = vi.fn(); request(remote, 'notifications', callback, mainFrame);
  expect(callback).toHaveBeenCalledExactlyOnceWith(answer === 'allowed');
  expect(prompt).not.toHaveBeenCalled();
});
test.each([true, false])('the first WhatsApp notification request saves %s, including Deny', async allowed => {
  const { remote, check, request, prompt } = setup(); prompt.mockResolvedValue(allowed);
  expect(check(remote, 'notifications', origin, mainFrame)).toBe(false);
  const first = vi.fn(); request(remote, 'notifications', first, mainFrame);
  await vi.waitFor(() => expect(first).toHaveBeenCalledExactlyOnceWith(allowed));
  const second = vi.fn(); request(remote, 'notifications', second, mainFrame);
  expect(second).toHaveBeenCalledExactlyOnceWith(allowed); expect(prompt).toHaveBeenCalledOnce();
  expect(check(remote, 'notifications', origin, mainFrame)).toBe(allowed);
});
function consentSetup() {
  let answer: 'allowed' | 'denied' | undefined, visible = false;
  const save = vi.fn((value: 'allowed' | 'denied') => { answer = value; });
  let release!: (value: boolean) => void;
  const prompt = vi.fn((_signal: AbortSignal) => new Promise<boolean>(resolve => { release = resolve; }));
  const consent = new NotificationConsent({ answer: () => answer, save, visible: () => visible, prompt });
  return { consent, prompt, save, show: () => { visible = true; consent.maybeAsk(); }, release: (value: boolean) => release(value) };
}
test('hidden requests wait for show, coalesce into one prompt and save one answer', async () => {
  const c = consentSetup(); const first = c.consent.request(), second = c.consent.request();
  expect(c.prompt).not.toHaveBeenCalled(); c.show(); expect(c.prompt).toHaveBeenCalledOnce();
  c.release(false); expect(await first).toBe(false); expect(await second).toBe(false);
  expect(c.save).toHaveBeenCalledExactlyOnceWith('denied');
  expect(await c.consent.request()).toBe(false); expect(c.prompt).toHaveBeenCalledOnce();
});
test('quit aborts an open notification dialog without saving its late answer', async () => {
  const c = consentSetup(); c.show(); const pending = c.consent.request();
  c.consent.close(); expect(await pending).toBe(false);
  expect(c.prompt.mock.calls[0][0].aborted).toBe(true);
  c.release(true); await Promise.resolve(); expect(c.save).not.toHaveBeenCalled();
});
test('a tray toggle saves immediately and supersedes a pending dialog', async () => {
  const c = consentSetup(); c.show(); const pending = c.consent.request();
  c.consent.change(true); expect(c.save).toHaveBeenCalledExactlyOnceWith('allowed');
  expect(await pending).toBe(true); expect(c.prompt.mock.calls[0][0].aborted).toBe(true);
  c.release(false); await Promise.resolve(); expect(c.save).toHaveBeenCalledOnce();
});

test.each([true, false])('a failed consent save retains the actual %s answer for this session and reports once', async allowed => {
  const prompt = vi.fn(async () => allowed), save = vi.fn(() => { throw new Error('disk full'); }), saveFailed = vi.fn();
  const consent = new NotificationConsent({ answer: () => undefined, save, saveFailed, visible: () => true, prompt });
  expect(await consent.request()).toBe(allowed);
  expect(consent.answer()).toBe(allowed ? 'allowed' : 'denied');
  for (let i = 0; i < 5; i++) { expect(await consent.request()).toBe(allowed); consent.maybeAsk(); }
  expect(prompt).toHaveBeenCalledOnce(); expect(save).toHaveBeenCalledOnce(); expect(saveFailed).toHaveBeenCalledOnce();
});
test('a failed tray save settles an outstanding prompt with the chosen answer', async () => {
  const c = consentSetup(); c.show(); const pending = c.consent.request();
  c.save.mockImplementation(() => { throw new Error('disk full'); });
  c.consent.change(true); expect(await pending).toBe(true); expect(c.consent.answer()).toBe('allowed');
  c.release(false); await Promise.resolve(); expect(c.save).toHaveBeenCalledOnce();
});
test('closing revokes a saved Allow in permission checks and requests', () => {
  const { remote, check, request, prompt, consent } = setup(undefined, 'allowed');
  consent.close();
  expect(check(remote, 'notifications', origin, mainFrame)).toBe(false);
  const callback = vi.fn(); request(remote, 'notifications', callback, mainFrame);
  expect(callback).toHaveBeenCalledExactlyOnceWith(false); expect(prompt).not.toHaveBeenCalled();
});
test('closing also denies cached media, clipboard, and an Allow queued just before shutdown', async () => {
  const { remote, check, request, prompt, consent } = setup();
  const media = vi.fn(); request(remote, 'media', media, mainFrame);
  await vi.waitFor(() => expect(media).toHaveBeenCalledExactlyOnceWith(true));
  const notification = vi.fn(); request(remote, 'notifications', notification, mainFrame);
  consent.change(true); consent.close();
  await vi.waitFor(() => expect(notification).toHaveBeenCalledExactlyOnceWith(false));
  for (const permission of ['media', 'clipboard-sanitized-write'] as const) {
    expect(check(remote, permission, origin, mainFrame)).toBe(false);
    const callback = vi.fn(); request(remote, permission, callback, mainFrame);
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
  }
  expect(prompt).toHaveBeenCalledTimes(2);
});

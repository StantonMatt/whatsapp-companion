// @vitest-environment jsdom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { emptySnapshot, initialState, type Status, type StatusUpdate } from '../src/shared/model';
import { StatusCache, StatusPublisher, statusUpdate } from '../src/core/status';

const stickerActions = vi.hoisted(() => [] as ((action: { type: 'cancelAuto' }) => Promise<boolean>)[]);
vi.mock('../src/ui/stickers', async () => {
  const React = await import('react');
  return { Stickers: ({ act: action }: { act: (action: { type: 'cancelAuto' }) => Promise<boolean> }) => {
    stickerActions.push(action);
    return React.createElement('button', { onClick: () => void action({ type: 'cancelAuto' }) }, 'Fixture action');
  } };
});

const mounted = vi.hoisted(() => ({ root: undefined as Root | undefined }));
vi.mock('react-dom/client', async importOriginal => {
  const actual = await importOriginal<typeof import('react-dom/client')>();
  return { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => (mounted.root = actual.createRoot(...args)) };
});

test('controls leave loading announcements to the composer overlay and retain other status messages', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="root"></div>';
  let receive!: (update: StatusUpdate) => void;
  const unsubscribe = vi.fn();
  const status: Status = { sequence: 1, state: initialState(), chat: { ...emptySnapshot, canSendSticker: false }, runtimePaused: false,
    keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true,
    message: 'Thinking…', pending: null, panel: null };
  Object.assign(window, { companion: {
    status: vi.fn(async () => status), subscribe: (callback: typeof receive) => { receive = callback; return unsubscribe; },
    action: vi.fn(async () => ({ ok: true }))
  } });
  try {
    await act(async () => { await import('../src/ui/index'); });
    const hidden = document.querySelector('[data-testid=assistant-status]')!;
    expect(hidden.className).toBe('sr-only'); expect(hidden.textContent).toBe('');
    for (const [index, message] of ['Tab to accept · Esc to dismiss', 'Unable to connect to the provider.', 'Preparing an automatic reply…', 'Thinking…'].entries()) {
      await act(async () => receive({ ...status, sequence: index + 2, message }));
      expect(hidden.textContent).toBe(message === 'Thinking…' ? '' : message);
    }
  } finally {
    await act(async () => mounted.root?.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce(); document.body.replaceChildren(); vi.unstubAllGlobals();
  }
});


test('App keeps its action callback stable through status updates and retains action error handling', async () => {
  vi.resetModules(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="root"></div>'; stickerActions.length = 0;
  let receive!: (update: StatusUpdate) => void;
  const unsubscribe = vi.fn();
  const status: Status = { sequence: 1, state: initialState(), chat: { ...emptySnapshot, canSendSticker: false }, runtimePaused: false,
    keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true, message: '', pending: null, panel: 'stickers' };
  const action = vi.fn(async () => ({ ok: true } as { ok: boolean; error?: string }));
  Object.assign(window, { companion: { status: async () => status, subscribe: (callback: typeof receive) => { receive = callback; return unsubscribe; }, action } });
  try {
    await act(async () => { await import('../src/ui/index'); });
    const original = stickerActions.at(-1);
    await act(async () => receive({ ...status, sequence: 2, message: 'Unrelated update' }));
    expect(stickerActions.at(-1)).toBe(original);
    action.mockResolvedValueOnce({ ok: false, error: 'Save failed' });
    await act(async () => document.querySelector<HTMLButtonElement>('.panel button')!.click());
    expect(document.querySelector('.error-banner')?.textContent).toContain('Save failed');
    expect(stickerActions.at(-1)).toBe(original);
    await act(async () => document.querySelector<HTMLButtonElement>('.panel button')!.click());
    expect(document.querySelector('.error-banner')).toBeNull();
    expect(action).toHaveBeenCalledWith({ type: 'cancelAuto' });
  } finally {
    await act(async () => mounted.root?.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce(); document.body.replaceChildren(); vi.unstubAllGlobals();
  }
});

test.each(['reload', 'crash and reload'])('controls %s renders the reopened sticker panel from the refreshed publication baseline', async kind => {
  vi.resetModules(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="root"></div>';
  let receive: (update: StatusUpdate) => void = () => {};
  const publisher = new StatusPublisher(update => receive(update)), unsubscribe = vi.fn();
  const previous: Status = { sequence: 1, state: initialState(), chat: { ...emptySnapshot, canSendSticker: false }, runtimePaused: false,
    keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true, message: '', pending: null, panel: 'stickers' };
  publisher.next(previous);
  if (kind === 'crash and reload') publisher.reset();
  let current: Status = { ...previous, panel: null };
  Object.assign(window, { companion: {
    status: async () => new StatusCache().accept(statusUpdate(current))!,
    subscribe: (callback: typeof receive) => { receive = callback; publisher.reset(); publisher.next(current); return unsubscribe; },
    action: vi.fn(async () => ({ ok: true }))
  } });
  try {
    await act(async () => { await import('../src/ui/index'); });
    expect(document.querySelector('aside')).toBeNull();
    current = { ...current, sequence: 2, panel: 'stickers' };
    await act(async () => { publisher.next(current); });
    expect(document.querySelector('aside')?.getAttribute('aria-label')).toBe('Sticker library');
    expect(document.querySelector('aside')?.textContent).toContain('Fixture action');
  } finally {
    await act(async () => mounted.root?.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce(); document.body.replaceChildren(); vi.unstubAllGlobals();
  }
});

test('AI off hides scheduled-reply controls even during an intermediate pending status update', async () => {
  vi.resetModules(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="root"></div>';
  let receive!: (update: StatusUpdate) => void;
  const status: Status = { sequence: 1, state: initialState(), chat: { ...emptySnapshot, canSendSticker: false }, runtimePaused: false,
    keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true,
    message: '', pending: { text: 'Synthetic queued reply', due: Date.now() + 30_000 }, panel: 'settings' };
  Object.assign(window, { companion: { status: async () => status, subscribe: (callback: typeof receive) => { receive = callback; return () => {}; }, action: vi.fn(async () => ({ ok: true })) } });
  try {
    await act(async () => { await import('../src/ui/index'); });
    expect(document.querySelector('.pending')).toBeNull();
    await act(async () => receive({ sequence: 2, state: { global: { ...status.state.global, aiFeatures: true } } }));
    expect(document.querySelector('.pending')?.textContent).toContain('Synthetic queued reply');
    await act(async () => receive({ sequence: 3, state: { global: { ...status.state.global, aiFeatures: false } } }));
    expect(document.querySelector('.pending')).toBeNull();
  } finally { await act(async () => mounted.root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); }
});

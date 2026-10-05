// @vitest-environment jsdom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { emptySnapshot, initialState, type Status, type StatusUpdate } from '../src/shared/model';

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

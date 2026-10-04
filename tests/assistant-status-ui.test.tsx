// @vitest-environment jsdom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { emptySnapshot, initialState, type Status, type StatusUpdate } from '../src/shared/model';

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

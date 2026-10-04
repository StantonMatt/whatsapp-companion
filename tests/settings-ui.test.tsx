// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { initialState, type Status } from '../src/shared/model';
import { Settings } from '../src/ui/settings';

let root: Root, host: HTMLDivElement;
const status = (): Status => ({ sequence: 1, state: initialState(), runtimePaused: false,
  chat: { chatId: '123@c.us', settingsId: '123@c.us', name: 'Alex', kind: 'direct', ready: true, canSendSticker: true },
  keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true,
  message: '', pending: null, panel: 'settings' });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function deferred() {
  let resolve!: (result: boolean) => void;
  const promise = new Promise<boolean>(r => { resolve = r; });
  return { promise, resolve };
}

test('direct sticker checkbox reflects the click immediately, then follows published on/off state', async () => {
  let current = status(); const request = deferred(), off = deferred();
  const action = vi.fn().mockReturnValueOnce(request.promise).mockReturnValueOnce(off.promise);
  const draw = () => act(() => root.render(<Settings status={current} act={action} close={() => {}}/>));
  draw(); const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(checkbox.checked).toBe(false);
  act(() => checkbox.click());
  expect(action).toHaveBeenCalledExactlyOnceWith({ type: 'preferences', scope: 'global', patch: { directStickerSend: true } });
  expect(checkbox.checked).toBe(true); expect(checkbox.disabled).toBe(true);
  // A transient update or IPC completion can precede the durable status update.
  current = { ...current, sequence: 2, message: 'Ready' }; draw();
  expect(checkbox.checked).toBe(true);
  await act(async () => request.resolve(true));
  expect(checkbox.checked).toBe(true); expect(checkbox.disabled).toBe(true);
  current = { ...current, sequence: 3, state: { ...current.state, global: { ...current.state.global, directStickerSend: true } } }; draw();
  expect(checkbox.checked).toBe(true); expect(checkbox.disabled).toBe(false);
  act(() => checkbox.click());
  expect(action).toHaveBeenLastCalledWith({ type: 'preferences', scope: 'global', patch: { directStickerSend: false } });
  expect(checkbox.checked).toBe(false);
  // The opposite delivery order is also valid: status can arrive before IPC returns.
  current = { ...current, sequence: 4, state: { ...current.state, global: { ...current.state.global, directStickerSend: false } } }; draw();
  await act(async () => off.resolve(true));
  expect(checkbox.checked).toBe(false); expect(checkbox.disabled).toBe(false);
});

test.each([false, true])('a rejected direct sticker change rolls back to the persisted value (%s)', async saved => {
  const current = status(); current.state.global.directStickerSend = saved;
  const request = deferred(); const action = vi.fn(() => request.promise);
  act(() => root.render(<Settings status={current} act={action} close={() => {}}/>));
  const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  act(() => checkbox.click()); expect(checkbox.checked).toBe(!saved);
  await act(async () => request.resolve(false));
  expect(checkbox.checked).toBe(saved); expect(checkbox.disabled).toBe(false);
});

test('global direct opt-in reflects restored state and is absent from chat settings', () => {
  const current = status(); current.state.global.directStickerSend = true;
  const action = vi.fn(async () => true);
  act(() => root.render(<Settings status={current} act={action} close={() => {}}/>));
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  act(() => root.render(<Settings status={{ ...current, panel: 'chat' }} act={action} close={() => {}}/>));
  expect(host.textContent).not.toContain('Send stickers directly');
  expect(action).not.toHaveBeenCalled();
});

test.each([
  ['logged-out', 'WhatsApp logged out.'], ['account-warning', 'WhatsApp showed an account warning.'],
  ['send-error', 'a direct send failed.'], ['whatsapp-changed', 'WhatsApp changed.']
] as const)('Settings shows the short hint for %s only while off', (reason, line) => {
  const current = status(); current.state.global.directStickerDisabledReason = reason;
  current.state.global.directStickerDisabledAt = 100;
  const draw = () => act(() => root.render(<Settings status={current} act={vi.fn(async () => true)} close={() => {}}/>));
  draw(); expect(host.querySelector('.hint')?.textContent).toBe(`Turned off automatically: ${line}`);
  current.state.global.directStickerSend = true; draw();
  expect(host.textContent).not.toContain('Turned off automatically');
});

test('an immediate safety stop during re-enable releases the pending checkbox', async () => {
  const current = status(), request = deferred();
  current.state.global.directStickerDisabledReason = 'account-warning';
  const draw = () => act(() => root.render(<Settings status={current} act={() => request.promise} close={() => {}}/>));
  draw(); const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  act(() => checkbox.click()); expect(checkbox.checked).toBe(true);
  current.sequence++; draw();
  await act(async () => request.resolve(true));
  expect(checkbox.checked).toBe(false); expect(checkbox.disabled).toBe(false);
  expect(host.textContent).toContain('Turned off automatically: WhatsApp showed an account warning.');
});

test('opening Providers uses cached discovery and Refresh models requests a bypass', async () => {
  const current = status(); current.keys.openai = true;
  const models = vi.fn().mockResolvedValue({ models: [{ id: 'gpt-6-luna', name: 'Luna' }] });
  vi.stubGlobal('companion', { models });
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === name || b.textContent === name)!;
  await act(async () => root.render(<Settings status={current} act={vi.fn(async () => true)} close={() => {}}/>));
  await act(async () => button('Providers').click());
  expect(models).toHaveBeenCalledExactlyOnceWith('openai', false);
  await act(async () => button('Refresh models').click());
  expect(models).toHaveBeenLastCalledWith('openai', true); expect(models).toHaveBeenCalledTimes(2);
});

// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { initialState, type Status, type ReasoningEffort } from '../src/shared/model';
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

function reasoning(action: (action: unknown) => Promise<boolean>) {
  let current = status(); current.fixture = false;
  const draw = () => act(() => root.render(<Settings status={current} act={action} close={() => {}}/>));
  draw(); act(() => host.querySelector<HTMLButtonElement>('[aria-label="Providers"]')!.click());
  const slider = () => host.querySelector<HTMLInputElement>('input[type="range"]')!;
  const input = (index: number) => act(() => {
    // Use the native setter so React observes the browser's range input change.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider(), String(index));
    slider().dispatchEvent(new Event('input', { bubbles: true }));
  });
  const commit = (event = 'keyup') => act(() => slider().dispatchEvent(event === 'keyup'
    ? new KeyboardEvent(event, { key: 'ArrowRight', bubbles: true }) : new Event(event, { bubbles: true })));
  const publish = (effort: ReasoningEffort, provider = current.state.provider, model = current.state.models[provider]) => {
    current = { ...current, sequence: current.sequence + 1, state: { ...current.state, provider,
      models: { ...current.state.models, [provider]: model },
      reasoning: { ...current.state.reasoning, [provider]: { ...current.state.reasoning[provider], [model]: effort } } } }; draw();
  };
  return { slider, input, commit, publish };
}

test.each([false, true])('reasoning preserves the second keypress when the first status arrives (reply first: %s)', async replyFirst => {
  const first = deferred(), second = deferred();
  const action = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { slider, input, commit, publish } = reasoning(action);
  input(1); commit();
  if (replyFirst) await act(async () => first.resolve(true));
  input(2); publish('low');
  expect(slider().getAttribute('aria-valuetext')).toBe('Medium');
  commit();
  expect(action).toHaveBeenLastCalledWith({ type: 'reasoning', provider: 'openai', model: 'gpt-6-luna', effort: 'medium' });
  expect(action).toHaveBeenCalledTimes(2);
  publish('medium');
  await act(async () => { second.resolve(true); first.resolve(true); });
  expect(slider().getAttribute('aria-valuetext')).toBe('Medium');
  publish('high'); expect(slider().getAttribute('aria-valuetext')).toBe('High');
});

test('reasoning keeps newer uncommitted input when an older request fails', async () => {
  const first = deferred(), second = deferred();
  const action = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { slider, input, commit, publish } = reasoning(action);
  input(1); commit(); input(2);
  await act(async () => first.resolve(false));
  expect(slider().getAttribute('aria-valuetext')).toBe('Medium');
  commit(); publish('medium'); await act(async () => second.resolve(true));
  expect(slider().getAttribute('aria-valuetext')).toBe('Medium');
});

test.each([false, true])('reasoning reverts a failed latest request to current saved state (older reply first: %s)', async replyFirst => {
  const first = deferred(), second = deferred();
  const action = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { slider, input, commit, publish } = reasoning(action);
  input(1); commit(); input(2); commit(); publish('low');
  if (replyFirst) await act(async () => first.resolve(true));
  await act(async () => second.resolve(false));
  expect(slider().getAttribute('aria-valuetext')).toBe('Low');
  await act(async () => first.resolve(true));
  publish('high'); expect(slider().getAttribute('aria-valuetext')).toBe('High');
});

test('an out-of-order failed reply cannot undo a newer successful reasoning save', async () => {
  const first = deferred(), second = deferred();
  const action = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { slider, input, commit, publish } = reasoning(action);
  input(1); commit(); input(2); commit(); publish('medium');
  await act(async () => second.resolve(true));
  await act(async () => first.resolve(false));
  expect(slider().getAttribute('aria-valuetext')).toBe('Medium');
  publish('high'); expect(slider().getAttribute('aria-valuetext')).toBe('High');
});

test('reasoning follows an external update after acknowledgement while an older reply is delayed', async () => {
  const first = deferred(), second = deferred();
  const action = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { slider, input, commit, publish } = reasoning(action);
  input(1); commit(); input(2); commit(); publish('medium');
  await act(async () => second.resolve(true));
  publish('high'); await act(async () => first.resolve(true));
  expect(slider().getAttribute('aria-valuetext')).toBe('High');
});

test.each([false, true])('returning to saved reasoning supersedes an earlier save awaiting status (reply first: %s)', async replyFirst => {
  const first = deferred(), second = deferred();
  const action = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { slider, input, commit, publish } = reasoning(action);
  input(1); commit();
  if (replyFirst) await act(async () => first.resolve(true));
  input(0); commit();
  expect(action).toHaveBeenLastCalledWith({ type: 'reasoning', provider: 'openai', model: 'gpt-6-luna', effort: 'none' });
  publish('low'); expect(slider().getAttribute('aria-valuetext')).toBe('None');
  publish('none'); await act(async () => { second.resolve(true); first.resolve(true); });
  expect(slider().getAttribute('aria-valuetext')).toBe('None');
});

test.each(['pointerup', 'focusout'])('reasoning retains input through status updates until %s and avoids duplicate blur saves', async event => {
  const request = deferred(), action = vi.fn(() => request.promise);
  const { slider, input, commit, publish } = reasoning(action);
  publish('low'); expect(slider().getAttribute('aria-valuetext')).toBe('Low');
  input(2); input(3); publish('none');
  expect(slider().getAttribute('aria-valuetext')).toBe('High');
  commit(event); commit('focusout');
  expect(action).toHaveBeenCalledExactlyOnceWith({ type: 'reasoning', provider: 'openai', model: 'gpt-6-luna', effort: 'high' });
  publish('high'); await act(async () => request.resolve(true));
  publish('medium'); expect(slider().getAttribute('aria-valuetext')).toBe('Medium');
});

test.each(['model', 'provider'])('changing %s remounts reasoning even with a request in flight', async change => {
  const request = deferred(), action = vi.fn().mockReturnValueOnce(request.promise).mockResolvedValue(true);
  const { slider, input, commit, publish } = reasoning(action);
  input(2); commit();
  if (change === 'model') publish('low', 'openai', 'gpt-6-astra');
  else publish('low', 'anthropic', 'claude-sonnet-5-5');
  expect(slider().getAttribute('aria-valuetext')).toBe('Low');
  expect(slider().max).toBe('4');
  await act(async () => request.resolve(false));
  expect(slider().getAttribute('aria-valuetext')).toBe('Low');
  input(1); await act(async () => commit());
  expect(action).toHaveBeenLastCalledWith({ type: 'reasoning', provider: change === 'model' ? 'openai' : 'anthropic',
    model: change === 'model' ? 'gpt-6-astra' : 'claude-sonnet-5-5', effort: 'medium' });
});

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

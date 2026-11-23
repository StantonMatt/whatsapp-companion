// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { actionSchema, initialState, stateSchema, type Status, type ReasoningEffort } from '../src/shared/model';
import { Settings } from '../src/ui/settings';

let root: Root, host: HTMLDivElement;

const status = (): Status => ({ sequence: 1, state: { ...initialState(), global: { ...initialState().global, aiFeatures: true } }, runtimePaused: false,
  chat: { chatId: '123@c.us', settingsId: '123@c.us', name: 'Alex', kind: 'direct', ready: true, canSendSticker: true },
  keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true,
  message: '', pending: null, panel: 'settings' });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('companion', { models: vi.fn().mockResolvedValue({ models: [] }) });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function deferred() {
  let resolve!: (result: boolean) => void;
  const promise = new Promise<boolean>(r => { resolve = r; });
  return { promise, resolve };
}

function reasoning(action: (action: unknown) => Promise<boolean>) {
  let current = status(); current.fixture = false; current.keys.openai = true;
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
  draw(); const checkbox = [...host.querySelectorAll('label')].find(label => label.textContent?.includes('Send stickers directly'))?.querySelector<HTMLInputElement>('input')!;
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
  const checkbox = [...host.querySelectorAll('label')].find(label => label.textContent?.includes('Send stickers directly'))?.querySelector<HTMLInputElement>('input')!;
  act(() => checkbox.click()); expect(checkbox.checked).toBe(!saved);
  await act(async () => request.resolve(false));
  expect(checkbox.checked).toBe(saved); expect(checkbox.disabled).toBe(false);
});

test('global direct opt-in reflects restored state and is absent from chat settings', () => {
  const current = status(); current.state.global.directStickerSend = true;
  const action = vi.fn(async () => true);
  act(() => root.render(<Settings status={current} act={action} close={() => {}}/>));
  expect([...host.querySelectorAll('label')].find(label => label.textContent?.includes('Send stickers directly'))?.querySelector<HTMLInputElement>('input')?.checked).toBe(true);
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
  draw(); const checkbox = [...host.querySelectorAll('label')].find(label => label.textContent?.includes('Send stickers directly'))?.querySelector<HTMLInputElement>('input')!;
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

const findButton = (name: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === name || b.getAttribute('aria-label') === name)!;
const keySlot = (provider = 'OpenAI') => host.querySelector<HTMLElement>(`.key-slot[aria-label="${provider} API key"]`)!;
const keyField = (provider = 'OpenAI') => keySlot(provider).querySelector<HTMLInputElement>('input')!;
const typeKey = (text: string, provider = 'OpenAI') => act(() => {
  const input = keyField(provider);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
async function providerPage(options: { keys?: Status['keys']; secure?: boolean; action?: import('../src/ui/index').Act } = {}) {
  let current = status(); current.fixture = false; current.secureStorage = options.secure ?? true;
  current.keys = options.keys ?? { openai: false, anthropic: false };
  const draw = () => root.render(<Settings status={current} act={action} close={() => {}}/>);
  const action: import('../src/ui/index').Act = options.action ?? vi.fn(async (request, inline) => {
    if (request.type === 'key' || request.type === 'deleteKey') {
      current = { ...current, sequence: current.sequence + 1, keys: { ...current.keys, [request.provider]: request.type === 'key' } };
      draw();
    }
    inline?.({ ok: true, message: request.type === 'testProvider' ? '✓ Connected' : undefined });
    return true;
  });
  await act(async () => draw());
  await act(async () => findButton('Providers').click());
  return { action, publish: (change: Partial<Status>) => act(() => { current = { ...current, ...change }; draw(); }), current: () => current };
}

test('AI off has only the master switch, direct stickers, link confirmation and Reload; a failed optimistic change rolls back', async () => {
  const current = status(); current.state.global.aiFeatures = false;
  const request = deferred(), action = vi.fn(() => request.promise);
  act(() => root.render(<Settings status={current} act={action} close={() => {}}/>));
  expect(host.querySelector('h1')?.textContent).toBe('Settings');
  expect(host.querySelectorAll('input[type=checkbox]')).toHaveLength(3);
  expect(host.querySelector('nav')).toBeNull(); expect(host.textContent).not.toContain('All conversations');
  expect(host.textContent).not.toContain('Tag new stickers'); expect(findButton('Reload WhatsApp')).toBeDefined();
  const toggle = host.querySelector<HTMLInputElement>('input')!;
  act(() => toggle.click()); expect(toggle.checked).toBe(true); expect(findButton('Providers')).toBeDefined();
  await act(async () => request.resolve(false));
  expect(toggle.checked).toBe(false); expect(host.querySelector('nav')).toBeNull();
  expect(action).toHaveBeenCalledExactlyOnceWith({ type: 'preferences', scope: 'global', patch: { aiFeatures: true } });
});
test('link confirmation is a global switch with a reset for chats that skip it', async () => {
  const current = status(); current.state.global.aiFeatures = false; current.state.links = { confirm: true, skipChats: ['123@c.us', '456@c.us'] };
  const action = vi.fn(async () => true);
  const draw = () => act(() => root.render(<Settings status={current} act={action} close={() => {}}/>));
  draw();
  const toggle = () => [...host.querySelectorAll('label')].find(label => label.textContent === 'Ask before opening links')!.querySelector('input')!;
  expect(toggle().checked).toBe(true); expect(host.textContent).toContain('Links open without asking in 2 chats.');
  await act(async () => findButton('Ask in all chats').click()); expect(action).toHaveBeenLastCalledWith({ type: 'links', resetChats: true });
  await act(async () => toggle().click()); expect(action).toHaveBeenLastCalledWith({ type: 'links', confirm: false });
  current.state.links = { confirm: false, skipChats: ['123@c.us'] }; draw();
  expect(toggle().checked).toBe(false); expect(host.textContent).not.toContain('Links open without asking');
  current.panel = 'chat'; current.state.global.aiFeatures = true; draw();
  expect(host.textContent).not.toContain('Ask before opening links');
  expect(actionSchema.safeParse({ type: 'links', confirm: true }).success).toBe(true);
  expect(actionSchema.safeParse({ type: 'links', resetChats: false }).success).toBe(false);
  const { links: _links, ...legacy } = initialState();
  expect(stateSchema.parse(legacy).links).toEqual({ confirm: true, skipChats: [] });
});
test('AI off chat fallback opens global Settings and never offers a local master switch', async () => {
  const current = status(); current.state.global.aiFeatures = false; current.panel = 'chat';
  const action = vi.fn(async () => true);
  act(() => root.render(<Settings status={current} act={action} close={() => {}}/>));
  expect(host.textContent).toContain('AI features are off'); expect(host.querySelector('input')).toBeNull();
  await act(async () => findButton('Open settings').click()); expect(action).toHaveBeenCalledWith({ type: 'panel', panel: 'settings' });
});
test('Providers has ordered masked empty fields, fixed prefixes, Get key and no model controls until saved', async () => {
  const { action } = await providerPage();
  expect([...host.querySelectorAll('.key-head label')].map(label => label.textContent)).toEqual(['OpenAI API key', 'Anthropic API key']);
  for (const [p, placeholder] of [['OpenAI', 'sk-…'], ['Anthropic', 'sk-ant-…']]) {
    expect(keyField(p).type).toBe('password'); expect(keyField(p).autocomplete).toBe('off');
    expect(keyField(p).getAttribute('spellcheck')).toBe('false'); expect(keyField(p).getAttribute('autocapitalize')).toBe('off');
    expect(keyField(p).placeholder).toBe(placeholder); expect(findButton('Save', keySlot(p)).disabled).toBe(true);
  }
  expect(host.querySelector('select')).toBeNull(); expect(host.textContent).not.toContain('Session-only');
  await act(async () => keySlot().querySelector<HTMLAnchorElement>('a')!.click());
  expect(action).toHaveBeenCalledWith({ type: 'getKey', provider: 'openai' });
});
test('pasting trims without sending; Enter saves once and clears the field before showing Saved', async () => {
  const { action } = await providerPage(); const input = keyField();
  act(() => {
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => ' \nsk-synthetic_fixture_key_never_real\n ' } }); input.dispatchEvent(paste);
  });
  expect(input.value).toBe('sk-synthetic_fixture_key_never_real'); expect(action).not.toHaveBeenCalled();
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(action).toHaveBeenCalledTimes(1); expect(action).toHaveBeenCalledWith({ type: 'key', provider: 'openai', key: 'sk-synthetic_fixture_key_never_real' }, expect.any(Function));
  expect(input.value).toBe(''); expect(keySlot().textContent).toContain('✓ Saved'); expect(keyField()).toBeNull();
  expect(document.activeElement).toBe(findButton('Replace', keySlot()));
  expect(host.querySelector<HTMLOptionElement>('option[value=anthropic]')?.disabled).toBe(true);
  expect(host.querySelector('option[value=anthropic]')?.textContent).toBe('Anthropic · no key');
});
test.each([
  ['OpenAI', 'invalid', 'This does not look like a valid API key.'],
  ['OpenAI', 'sk-ant-synthetic_fixture_key_never_real', 'This looks like an Anthropic key.'],
  ['Anthropic', 'sk-synthetic_fixture_key_never_real', 'This looks like an OpenAI key.']
])('invalid paste in %s explains the error without sending', async (provider, text, message) => {
  const { action } = await providerPage(); typeKey(text, provider);
  await act(async () => findButton('Save', keySlot(provider)).click());
  expect(keySlot(provider).querySelector('[role=alert]')?.textContent).toBe(message); expect(action).not.toHaveBeenCalled();
  expect(keyField(provider).selectionStart).toBe(0); expect(keyField(provider).selectionEnd).toBe(text.length);
  typeKey('edited', provider); expect(keySlot(provider).querySelector('[role=alert]')).toBeNull();
});
test('failed save stays inline, retains and selects text, then clears its error on editing', async () => {
  const action = vi.fn<import('../src/ui/index').Act>(async (_action, inline) => { inline?.({ ok: false, error: 'Couldn’t save the key. Try again.' }); return false; });
  await providerPage({ action }); typeKey('sk-synthetic_fixture_key_never_real');
  await act(async () => findButton('Save', keySlot()).click());
  expect(keySlot().textContent).toContain('Couldn’t save the key. Try again.'); expect(keyField().value).toBe('sk-synthetic_fixture_key_never_real');
  typeKey('sk-new_synthetic_fixture_key_never_real'); expect(keySlot().querySelector('[role=alert]')).toBeNull();
});
test('Replace is empty and focused; Cancel/Escape clear it and keep the old key; Remove defaults to Keep', async () => {
  const { action } = await providerPage({ keys: { openai: true, anthropic: false } });
  await act(async () => findButton('Replace', keySlot()).click()); expect(keyField().value).toBe(''); expect(document.activeElement).toBe(keyField());
  typeKey('sk-synthetic_fixture_key_never_real'); const replacedInput = keyField();
  await act(async () => findButton('Cancel', keySlot()).click()); expect(replacedInput.value).toBe(''); expect(keySlot().textContent).toContain('✓ Saved');
  expect(document.activeElement).toBe(findButton('Replace', keySlot()));
  await act(async () => findButton('Replace', keySlot()).click()); typeKey('discard');
  act(() => keyField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(keySlot().textContent).toContain('✓ Saved');
  expect(document.activeElement).toBe(findButton('Replace', keySlot()));
  await act(async () => findButton('Remove', keySlot()).click()); expect(keySlot().textContent).toContain('Remove the OpenAI key?'); expect(document.activeElement).toBe(findButton('Keep', keySlot()));
  await act(async () => findButton('Keep', keySlot()).click()); expect(action).not.toHaveBeenCalled();
  await act(async () => findButton('Remove', keySlot()).click());
  act(() => keySlot().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(keySlot().textContent).not.toContain('Remove the OpenAI key?');
  await act(async () => findButton('Remove', keySlot()).click()); await act(async () => findButton('Remove', keySlot()).click());
  expect(action).toHaveBeenCalledWith({ type: 'deleteKey', provider: 'openai' }, expect.any(Function));
  expect(keyField().value).toBe(''); expect(keySlot().querySelector('a')?.textContent).toBe('Get key'); expect(host.querySelector('select')).toBeNull();
  expect(document.activeElement).toBe(keyField());
});
test.each(['OpenAI', 'Anthropic'])('%s save/remove focus waits for published key state; replacement Save returns to its own Replace', async provider => {
  const page = await providerPage({ action: async () => true });
  const p = provider === 'OpenAI' ? 'openai' : 'anthropic';
  const key = provider === 'OpenAI' ? 'sk-synthetic_fixture_key_never_real' : 'sk-ant-synthetic_fixture_key_never_real';
  typeKey(key, provider);
  await act(async () => findButton('Save', keySlot(provider)).click());
  page.publish({ keys: { ...page.current().keys, [p]: true } });
  expect(document.activeElement).toBe(findButton('Replace', keySlot(provider)));
  await act(async () => findButton('Replace', keySlot(provider)).click()); typeKey(key, provider);
  await act(async () => findButton('Save', keySlot(provider)).click());
  expect(document.activeElement).toBe(findButton('Replace', keySlot(provider)));
  await act(async () => findButton('Remove', keySlot(provider)).click());
  await act(async () => findButton('Remove', keySlot(provider)).click());
  page.publish({ keys: { ...page.current().keys, [p]: false } });
  expect(document.activeElement).toBe(keyField(provider));
});
test.each(['Replies', 'Providers', 'Style', 'Auto replies'])('opening %s focuses Back', async section => {
  const current = status(); if (section === 'Auto replies') current.panel = 'chat';
  await act(async () => root.render(<Settings status={current} act={async () => true} close={() => {}}/>));
  await act(async () => findButton(section).click());
  expect(document.activeElement).toBe(findButton('Back to settings'));
});
test.each([true, false])('Remove confirmation clears the slot connection result (success: %s)', async success => {
  await providerPage({ keys: { openai: true, anthropic: true }, action: async (_action, inline) => {
    inline?.(success ? { ok: true, message: '✓ Connected' } : { ok: false, error: 'Key rejected. Add a valid API key.' });
    return success;
  } });
  for (const provider of ['OpenAI', 'Anthropic']) await act(async () => findButton('Test connection', keySlot(provider)).click());
  const selector = success ? '[role=status]' : '[role=alert]';
  expect(keySlot().querySelector(selector)).not.toBeNull();
  await act(async () => findButton('Remove', keySlot()).click());
  expect(keySlot().querySelector(selector)).toBeNull();
  expect(keySlot('Anthropic').querySelector(selector)).not.toBeNull();
  await act(async () => findButton('Keep', keySlot()).click());
  expect(keySlot().querySelector(selector)).toBeNull();
});
test('each provider is independently busy and connection results belong to that provider', async () => {
  let finish!: () => void;
  const action = vi.fn<import('../src/ui/index').Act>((request, inline) => new Promise(resolve => { finish = () => { inline?.({ ok: true, message: '✓ Connected' }); resolve(true); }; }));
  await providerPage({ keys: { openai: true, anthropic: false }, action });
  await act(async () => findButton('Test connection', keySlot()).click());
  expect(findButton('Testing…', keySlot()).disabled).toBe(true); expect(findButton('Replace', keySlot()).disabled).toBe(true);
  typeKey('sk-ant-synthetic_fixture_key_never_real', 'Anthropic'); expect(findButton('Save', keySlot('Anthropic')).disabled).toBe(false);
  await act(async () => finish()); expect(keySlot().textContent).toContain('✓ Connected'); expect(keySlot('Anthropic').textContent).not.toContain('Connected');
  expect(action).toHaveBeenCalledWith({ type: 'testProvider', provider: 'openai' }, expect.any(Function));
});
test('secure storage unavailable disables entry and Replace, keeps Test/Remove, and offers Check again', async () => {
  const { action } = await providerPage({ secure: false, keys: { openai: true, anthropic: false } });
  expect(host.textContent).toContain('Can’t save keys because secure storage is unavailable.');
  expect(keyField('Anthropic').disabled).toBe(true); expect(findButton('Save', keySlot('Anthropic')).disabled).toBe(true);
  expect(findButton('Replace', keySlot()).disabled).toBe(true); expect(findButton('Test connection', keySlot()).disabled).toBe(false); expect(findButton('Remove', keySlot()).disabled).toBe(false);
  await act(async () => findButton('Check again').click()); expect(action).toHaveBeenCalledWith({ type: 'checkSecureStorage' });
});
test('Back, closing the panel and turning AI off discard unsaved key fields', async () => {
  const page = await providerPage(); typeKey('sk-synthetic_fixture_key_never_real'); const input = keyField();
  await act(async () => findButton('Back to settings').click()); expect(input.value).toBe('');
  await act(async () => findButton('Providers').click()); expect(keyField().value).toBe('');
  typeKey('sk-synthetic_fixture_key_never_real'); const next = keyField();
  page.publish({ state: { ...page.current().state, global: { ...page.current().state.global, aiFeatures: false } } });
  expect(next.value).toBe(''); expect(host.querySelector('.key-slot')).toBeNull();
  expect(host.textContent).not.toContain('Providers');
});

test.each([
  'Key rejected. Add a valid API key.', 'This key does not have access to the selected model.',
  'Rate limit or quota reached. Check provider usage and billing.', 'Model or request unavailable. Check the model ID and account access.',
  'Provider temporarily unavailable. Try again later.', 'The OS keyring could not unlock this key. Unlock it or add the key again.'
])('connection failure stays under its provider: %s', async error => {
  await providerPage({ keys: { openai: false, anthropic: true }, action: async (_action, inline) => { inline?.({ ok: false, error }); return false; } });
  await act(async () => findButton('Test connection', keySlot('Anthropic')).click());
  expect(keySlot('Anthropic').querySelector('[role=alert]')?.textContent).toBe(error);
  expect(keySlot('OpenAI').querySelector('[role=alert]')).toBeNull();
});
test('Saving is read-only per provider; Back clears the field while the main save completes', async () => {
  let finish!: () => void;
  const action = vi.fn<import('../src/ui/index').Act>((_action, inline) => new Promise(resolve => { finish = () => { inline?.({ ok: true }); resolve(true); }; }));
  await providerPage({ action }); typeKey('sk-synthetic_fixture_key_never_real');
  const field = keyField();
  await act(async () => findButton('Save', keySlot()).click());
  expect(field.disabled).toBe(true); expect(field.readOnly).toBe(true); expect(findButton('Saving…', keySlot()).disabled).toBe(true);
  expect(keyField('Anthropic').disabled).toBe(false);
  await act(async () => findButton('Back to settings').click()); expect(field.value).toBe('');
  await act(async () => finish()); await act(async () => findButton('Providers').click()); expect(keyField().value).toBe('');
});

// @vitest-environment jsdom
import { test, expect, vi, afterEach, describe } from 'vitest';
import { act as reactAct, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StickerTransfer } from '../src/core/sticker-transfer';
import { actionSchema, emptySnapshot, initialState, type Snapshot, type Status, type Sticker } from '../src/shared/model';
import { Stickers } from '../src/ui/stickers';
import type { Act } from '../src/ui/index';
const snapshot: Snapshot = { ...emptySnapshot, chatId: '123@c.us', settingsId: '123@c.us', name: 'A friend', ready: true, revision: '1' };
const destinationToken = '1';
const id = 'a'.repeat(64), nonce = '550e8400-e29b-41d4-a716-446655440000';
function begin(t: StickerTransfer, id: string, nonce: string, snapshot: Snapshot, now: number) {
  return t.begin(id, nonce, t.destinationToken(snapshot), snapshot, now);
}
function finding() {
  const transfer = new StickerTransfer(); begin(transfer, id, nonce, snapshot, 0); return transfer;
}
function sending() {
  const transfer = finding(); transfer.prepared(nonce, true, snapshot, 2); return transfer;
}
test('the local send action requires a content hash, fresh UUID and displayed destination token', () => {
  expect(actionSchema.safeParse({ type: 'sendSticker', id, nonce, destinationToken }).success).toBe(true);
  for (const action of [{ type: 'sendSticker', nonce, destinationToken }, { type: 'sendSticker', id: 'invalid', nonce, destinationToken }, { type: 'sendSticker', id, nonce: 'invalid', destinationToken }, { type: 'sendSticker', id, nonce }, { type: 'sendSticker', id, nonce, destinationToken: '' }, { type: 'sendSticker', id, nonce, destinationToken, extra: true }]) {
    expect(actionSchema.safeParse(action).success).toBe(false);
  }
});
test('a queued click for A cannot create or authorize a ticket after B arrives first', () => {
  const t = new StickerTransfer(), displayed = t.destinationToken(snapshot);
  const next = { ...snapshot, chatId: '456@c.us', settingsId: '456@c.us', name: 'B', revision: '2' };
  t.observe(next, 1);
  expect(() => t.begin(id, nonce, displayed, next, 2)).toThrow('conversation changed');
  expect(t.send).toBeNull();
  expect(t.prepared(nonce, true, next, 3)).toBeUndefined();
  expect(t.authorize(nonce, next, 4)).toBe(false);
});
test.each([
  { chatId: '456@c.us' }, { settingsId: '456@c.us' }, { name: 'Renamed' }, { revision: '2' }, { ready: false }, { composing: true }
])('destination tokens reject queued Send and Locate after identity changes: %j', change => {
  const t = new StickerTransfer(), displayed = t.destinationToken(snapshot), next = { ...snapshot, ...change };
  t.observe(next, 1);
  expect(() => t.requireDestination(displayed, next)).toThrow('conversation changed');
  expect(() => t.begin(id, nonce, displayed, next, 2)).toThrow('conversation changed');
  t.observe(snapshot, 3);
  expect(() => t.requireDestination(displayed, snapshot)).toThrow('conversation changed');
  expect(() => t.requireDestination(t.destinationToken(snapshot), snapshot)).not.toThrow();
});
test('new messages and draft edits preserve the displayed destination token', () => {
  const t = new StickerTransfer(), displayed = t.destinationToken(snapshot);
  const next = { ...snapshot, draft: 'My newer draft', messages: [{ id: 'new', outgoing: false, text: 'Hello' }] };
  t.observe(next, 1);
  expect(t.destinationToken(next)).toBe(displayed);
  expect(t.begin(id, nonce, displayed, next, 2)).toBeDefined();
});
test('Locate also strictly requires the displayed destination token', () => {
  expect(actionSchema.safeParse({ type: 'locateSticker', id, destinationToken }).success).toBe(true);
  for (const action of [{ type: 'locateSticker', id }, { type: 'locateSticker', id, destinationToken: '0' }, { type: 'locateSticker', id, destinationToken, nonce }]) {
    expect(actionSchema.safeParse(action).success).toBe(false);
  }
});
test('a card click authorizes lookup followed directly by one native activation', () => {
  const t = new StickerTransfer();
  expect(t.prepared(nonce, true, snapshot, 0)).toBeUndefined();
  expect(t.authorize(nonce, snapshot, 0)).toBe(false);
  expect(begin(t, id, nonce, snapshot, 0)).toMatchObject({ id, nonce, target: { name: snapshot.name, chatId: snapshot.chatId, revision: snapshot.revision } });
  expect(t.send).toEqual({ id, nonce, name: snapshot.name, state: 'finding' });
  expect(t.authorize(nonce, snapshot, 1)).toBe(false);
  expect(t.prepared('forged', true, snapshot, 2)).toBeUndefined();
  expect(t.send?.state).toBe('finding');
  expect(t.prepared(nonce, true, snapshot, 3)).toMatchObject({ id, nonce });
  expect(t.send?.state).toBe('sending');
  expect(t.prepared(nonce, true, snapshot, 4)).toBeUndefined();
  expect(t.authorize('wrong-token', snapshot, 4)).toBe(false);
  expect(t.authorize(nonce, snapshot, 4)).toBe(true);
  expect(t.authorize(nonce, snapshot, 4)).toBe(false);
  t.result('wrong-token', false); expect(t.send?.state).toBe('sending');
  t.result(nonce, true); expect(t.send?.state).toBe('sent');
  t.result(nonce, false); expect(t.send?.state).toBe('sent');
  expect(t.authorize(nonce, snapshot, 5)).toBe(false);
  expect(() => begin(t, id, nonce, snapshot, 5)).toThrow('already been used');
});
test.each(['finding', 'sending'] as const)('only one sticker may be in flight during %s', state => {
  const t = state === 'finding' ? finding() : sending();
  const original = t.send;
  expect(() => begin(t, 'b'.repeat(64), 'another-nonce', snapshot, 3)).toThrow('Wait');
  expect(() => begin(t, id, nonce, snapshot, 3)).toThrow('Wait');
  expect(t.send).toBe(original);
});
test.each([{ ready: false }, { composing: true }, { settingsId: null, chatId: null }])('a click without a ready recognized chat cannot create a ticket: %j', change => {
  const t = new StickerTransfer(); expect(() => begin(t, id, nonce, { ...snapshot, ...change }, 0)).toThrow('Open a conversation');
  expect(t.send).toBeNull(); expect(t.authorize(nonce, snapshot, 1)).toBe(false);
});
test('cancellation during finding revokes permission and keeps a terminal result', () => {
  const t = finding(); expect(t.cancel()).toBe(true);
  expect(t.send).toEqual({ id, nonce, name: snapshot.name, state: 'cancelled' });
  expect(t.cancel()).toBe(false);
  expect(t.prepared(nonce, true, snapshot, 2)).toBeUndefined();
  expect(t.authorize(nonce, snapshot, 3)).toBe(false);
  expect(() => begin(t, id, nonce, snapshot, 4)).toThrow();
  begin(t, id, 'new-nonce', snapshot, 5); expect(t.send?.state).toBe('finding');
});
test.each([false, true])('cancellation once sending is ignored, including after authorization=%s', authorized => {
  const t = sending();
  if (authorized) expect(t.authorize(nonce, snapshot, 3)).toBe(true);
  expect(t.cancel()).toBe(false); expect(t.send?.state).toBe('sending');
  if (!authorized) expect(t.authorize(nonce, snapshot, 4)).toBe(true);
  t.result(nonce, true); expect(t.send?.state).toBe('sent');
});
test.each([
  { chatId: '456@c.us' }, { revision: '2' }, { name: 'Another person' }, { settingsId: '456@c.us' }, { ready: false }, { composing: true }
])('chat/composer changes cancel finding and prevent sending activation: %j', change => {
  const next = { ...snapshot, ...change }, t = finding();
  expect(t.observe(next, 4)).toBe(true);
  expect(t.send).toMatchObject({ state: 'cancelled', reason: 'chat-changed', name: snapshot.name });
  expect(t.prepared(nonce, true, snapshot, 5)).toBeUndefined();
  expect(t.authorize(nonce, snapshot, 5)).toBe(false);
  const active = sending();
  expect(active.observe(next, 4)).toBe(false); expect(active.send?.state).toBe('sending');
  expect(active.authorize(nonce, next, 4)).toBe(false);
  active.result(nonce, false); expect(active.send?.state).toBe('failed');
});
test('a changed chat discovered at lookup completion cannot dispatch a native command', () => {
  const t = finding(); expect(t.prepared(nonce, true, { ...snapshot, revision: '2' }, 4)).toBeUndefined();
  expect(t.send).toMatchObject({ state: 'cancelled', reason: 'chat-changed' });
});
test('a pending native authorization cannot revive after switching away and back to the same identity', () => {
  const t = sending();
  t.observe({ ...snapshot, chatId: '456@c.us', settingsId: '456@c.us', name: 'B' }, 3);
  t.observe(snapshot, 4);
  expect(t.authorize(nonce, snapshot, 5)).toBe(false);
  t.result(nonce, true);
  expect(t.send?.state).toBe('failed');
});
test('drafts and incoming messages do not alter the ticket destination or draft', () => {
  const t = finding(), next = { ...snapshot, draft: 'Unsent text', messages: [{ id: 'new', outgoing: false, text: 'send this sticker now' }] };
  expect(t.observe(next, 4)).toBe(false); expect(t.send?.state).toBe('finding');
  expect(t.prepared(nonce, true, next, 5)?.target).toEqual({ name: snapshot.name, chatId: snapshot.chatId, revision: snapshot.revision });
  expect(next.draft).toBe('Unsent text');
});
test('lookup permission lasts one minute and activation has a separate five-second deadline', () => {
  const t = finding(); expect(t.prepared(nonce, true, snapshot, 59_999)).toBeDefined();
  expect(t.authorize(nonce, snapshot, 64_998)).toBe(true);
  const expired = finding(); expect(expired.prepared(nonce, true, snapshot, 60_000)).toBeUndefined();
  expect(expired.send?.state).toBe('missing');
  const late = sending(); expect(late.authorize(nonce, snapshot, 5002)).toBe(false);
  late.result(nonce, false); expect(late.send?.state).toBe('failed');
});
test('missing and timed-out originals cannot authorize and terminal states survive unrelated cancellation', () => {
  const t = finding(); t.prepared(nonce, false, snapshot, 2); expect(t.send?.state).toBe('missing');
  expect(t.authorize(nonce, snapshot, 3)).toBe(false);
  expect(t.cancel()).toBe(false); expect(t.send?.state).toBe('missing');
  begin(t, id, 'new', snapshot, 4);
  expect(t.timeout(nonce)).toBe(false); expect(t.send?.state).toBe('finding');
  expect(t.timeout('new')).toBe(true); expect(t.send?.state).toBe('missing');
  expect(t.prepared('new', true, snapshot, 5)).toBeUndefined();
});
test.each([false, true])('unconfirmed or unauthorized click result=%s fails and needs a fresh click to retry', clicked => {
  const t = sending(); t.result(nonce, clicked); expect(t.send?.state).toBe('failed');
  expect(t.authorize(nonce, snapshot, 4)).toBe(false); expect(() => begin(t, id, nonce, snapshot, 5)).toThrow();
  begin(t, id, 'new', snapshot, 6); expect(t.send?.state).toBe('finding');
});
test('an authorized click finishes with its result even when the chat changes afterwards', () => {
  const t = sending(); expect(t.authorize(nonce, snapshot, 3)).toBe(true);
  expect(t.observe({ ...snapshot, chatId: 'other' }, 4)).toBe(false);
  t.result(nonce, true); expect(t.send).toMatchObject({ state: 'sent', name: snapshot.name });
});

describe('sticker panel action races', () => {
  let root: Root | undefined;
  const scrollIntoView = Element.prototype.scrollIntoView;
  afterEach(async () => {
    if (root) await reactAct(() => root!.unmount());
    root = undefined;
    Element.prototype.scrollIntoView = scrollIntoView;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });
  const sticker = (id: string, lastSeen: number, searchTerms = 'saved terms'): Sticker => ({ id, lastSeen, firstSeen: 0, searchTerms, image: 'data:image/webp;base64,UklGRg==' });
  const panelStatus = (stickers = [sticker(id, 1)]): Status => ({
    sequence: 1, runtimePaused: false, state: { ...initialState(), stickers },
    chat: { chatId: snapshot.chatId, settingsId: snapshot.settingsId, name: snapshot.name, kind: snapshot.kind, ready: true, destinationToken },
    keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true, message: '', pending: null
  });
  async function render(status: Status, act: Act = async () => true) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Element.prototype.scrollIntoView = vi.fn();
    if (!root) { const container = document.createElement('div'); document.body.append(container); root = createRoot(container); }
    await reactAct(() => root!.render(createElement(Stickers, { status, act })));
  }
  function button(name: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === name || b.textContent === name);
    if (!button) throw new Error(`Missing button: ${name}`);
    return button;
  }
  async function click(name: string) { await reactAct(() => { button(name).focus(); button(name).click(); }); }
  async function type(selector: string, value: string) {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    await reactAct(() => {
      element.focus();
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  function deferred() {
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>(r => { resolve = r; });
    return { promise, resolve };
  }
  const cardIds = () => [...document.querySelectorAll('[data-sticker]')].map(card => card.getAttribute('data-sticker'));

  test('two newcomers retain their appended positions when lastSeen changes, until the query changes', async () => {
    const b = 'b'.repeat(64), c = 'c'.repeat(64);
    await render(panelStatus());
    await render(panelStatus([sticker(id, 1), sticker(b, 2)]));
    await render(panelStatus([sticker(id, 1), sticker(b, 2), sticker(c, 3)]));
    expect(cardIds()).toEqual([id, b, c]);
    await render(panelStatus([sticker(id, 1), sticker(b, 4), sticker(c, 3)]));
    expect(cardIds()).toEqual([id, b, c]);
    await type('.search', 'saved');
    expect(cardIds()).toEqual([b, c, id]);
  });
  test.each(['newer draft', 'saved terms'])('a delayed Save preserves newer text %j, including a return to the old saved terms', async newer => {
    const pending = deferred(), act: Act = action => action.type === 'sticker' ? pending.promise : Promise.resolve(true);
    await render(panelStatus(), act);
    await click('Edit search terms'); await type('textarea', 'submitted terms'); await click('Save');
    await type('textarea', newer);
    await render(panelStatus([sticker(id, 1, 'submitted terms')]), act);
    await reactAct(() => { pending.resolve(true); });
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(newer);
    expect(button('Save').disabled).toBe(false);
    expect(document.activeElement).toBe(document.querySelector('textarea'));
  });
  test('a delayed Save cannot close a reopened editor even when its text still matches the submission', async () => {
    const pending = deferred(), act: Act = action => action.type === 'sticker' ? pending.promise : Promise.resolve(true);
    await render(panelStatus(), act);
    await click('Edit search terms'); await type('textarea', 'submitted terms'); await click('Save');
    await render(panelStatus([sticker(id, 1, 'submitted terms')]), act);
    await click('Close'); await click('Edit search terms');
    await reactAct(() => { pending.resolve(true); });
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('submitted terms');
    expect(document.activeElement).toBe(document.querySelector('textarea'));
  });
  test('a superseded Save acknowledgement cannot close the editor while its newer Save is pending', async () => {
    const first = deferred(), second = deferred();
    let submissions = 0;
    const act: Act = action => action.type === 'sticker' ? (++submissions === 1 ? first.promise : second.promise) : Promise.resolve(true);
    await render(panelStatus(), act);
    await click('Edit search terms'); await type('textarea', 'submitted terms');
    await click('Save'); await click('Save');
    await reactAct(() => { first.resolve(true); });
    expect(document.querySelector('textarea')).not.toBeNull();
    await reactAct(() => { second.resolve(true); });
    expect(document.querySelector('textarea')).toBeNull();
  });
  test('a newer Locate action keeps its editor and focus when an older Save is acknowledged', async () => {
    const pending = deferred(), act: Act = action => action.type === 'sticker' ? pending.promise : Promise.resolve(true);
    await render(panelStatus(), act);
    await click('Edit search terms'); await type('textarea', 'submitted terms'); await click('Save');
    await render(panelStatus([sticker(id, 1, 'submitted terms')]), act);
    await click('Locate in WhatsApp');
    await reactAct(() => { pending.resolve(true); });
    expect(document.querySelector('textarea')).not.toBeNull();
    expect(document.activeElement).toBe(button('Locate in WhatsApp'));
  });
  test('Escape closes an editor to its replacement Cancel button before cancelling Finding', async () => {
    const act: Act = vi.fn(async () => true), status = panelStatus();
    await render(status, act); await click('Edit search terms');
    await render({ ...status, stickerSend: { id, nonce, name: snapshot.name, state: 'finding' } }, act);
    const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await reactAct(() => { escape(); });
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(button('Cancel sending'));
    expect(act).not.toHaveBeenCalled();
    await reactAct(() => { escape(); });
    expect(act).toHaveBeenCalledWith({ type: 'cancelSticker' });
  });
  test('closing during Sending returns focus to the card Send when Edit is unavailable', async () => {
    const status = panelStatus();
    await render(status); await click('Edit search terms');
    await render({ ...status, stickerSend: { id, nonce, name: snapshot.name, state: 'sending' } });
    await click('Close');
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(button('Sending sticker…'));
  });
  test('a delayed Forget cannot steal focus from a newer editor', async () => {
    const b = 'b'.repeat(64), pending = deferred();
    const act: Act = action => action.type === 'forgetSticker' ? pending.promise : Promise.resolve(true);
    await render(panelStatus([sticker(id, 2), sticker(b, 1)]), act);
    await click('Edit search terms'); await click('Forget');
    await render(panelStatus([sticker(b, 1)]), act); await click('Edit search terms');
    await type('textarea', 'newer B draft');
    await reactAct(() => { pending.resolve(true); });
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('newer B draft');
    expect(document.activeElement).toBe(document.querySelector('textarea'));
  });
  test('a delayed Forget cannot clear a newer draft after the same sticker is indexed again', async () => {
    const pending = deferred(), act: Act = action => action.type === 'forgetSticker' ? pending.promise : Promise.resolve(true);
    await render(panelStatus(), act);
    await click('Edit search terms'); await click('Forget');
    await render(panelStatus([]), act); await render(panelStatus(), act);
    await click('Edit search terms'); await type('textarea', 'newly indexed draft');
    await reactAct(() => { pending.resolve(true); });
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('newly indexed draft');
    expect(document.activeElement).toBe(document.querySelector('textarea'));
  });
  test('Forget falls back to Search when its remembered next card has also disappeared', async () => {
    const b = 'b'.repeat(64), pending = deferred();
    const act: Act = action => action.type === 'forgetSticker' ? pending.promise : Promise.resolve(true);
    await render(panelStatus([sticker(id, 2), sticker(b, 1)]), act);
    await click('Edit search terms'); await click('Forget');
    await render(panelStatus([]), act);
    await reactAct(() => { pending.resolve(true); });
    expect(document.activeElement).toBe(document.querySelector('.search'));
  });
});

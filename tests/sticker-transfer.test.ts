// @vitest-environment jsdom
import { test, expect, vi, afterEach, describe } from 'vitest';
import { act as reactAct, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StickerTransfer, composerProvablyEmpty, stickerRoute } from '../src/core/sticker-transfer';
import { actionSchema, emptySnapshot, initialState, type Snapshot, type Status, type Sticker } from '../src/shared/model';
import { Stickers } from '../src/ui/stickers';
import type { Act } from '../src/ui/index';
import { STICKER_MAKER_CONFIRMATION_MS, STICKER_MAKER_WATCHDOG_MS } from '../src/shared/sticker-transfer';
const snapshot: Snapshot = { ...emptySnapshot, chatId: '123@c.us', settingsId: '123@c.us', name: 'A friend', conversationOpen: true, ready: true, revision: '1' };
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
  { chatId: '456@c.us' }, { settingsId: '456@c.us' }, { name: 'Renamed' }, { revision: '2' }, { conversationOpen: false }, { ready: false }, { composing: true }
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
  expect(t.send).toEqual({ id, nonce, name: snapshot.name, route: 'picker', animated: true, state: 'finding' });
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
  t.result(nonce, true, true); expect(t.send?.state).toBe('sent');
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
test.each([{ name: '' }, { settingsId: null, chatId: null }, { conversationOpen: false }])('a click without a visible recognized chat cannot create a ticket: %j', change => {
  const t = new StickerTransfer(); expect(() => begin(t, id, nonce, { ...snapshot, ...change }, 0)).toThrow('Open a conversation');
  expect(t.send).toBeNull(); expect(t.authorize(nonce, snapshot, 1)).toBe(false);
});
test('cancellation during finding revokes permission and keeps a terminal result', () => {
  const t = finding(); expect(t.cancel()).toBe(true);
  expect(t.send).toEqual({ id, nonce, name: snapshot.name, route: 'picker', animated: true, state: 'cancelled' });
  expect(t.cancel()).toBe(false);
  expect(t.prepared(nonce, true, snapshot, 2)).toBeUndefined();
  expect(t.authorize(nonce, snapshot, 3)).toBe(false);
  expect(() => begin(t, id, nonce, snapshot, 4)).toThrow();
  begin(t, id, 'new-nonce', snapshot, 5); expect(t.send?.state).toBe('finding');
});
test('user cancellation cannot revoke a prepared picker, even before its grant', () => {
  const t = sending();
  expect(t.cancel()).toBe(false); expect(t.send?.state).toBe('sending');
  expect(t.authorize(nonce, snapshot, 3)).toBe(true);
  t.result(nonce, true, true); expect(t.send?.state).toBe('sent');
});
test.each([false, true])('deletion revokes a prepared picker only before authorization=%s', authorized => {
  const t = sending();
  if (authorized) expect(t.authorize(nonce, snapshot, 3)).toBe(true);
  expect(t.revokeIfNotAuthorized()).toBe(!authorized); expect(t.send?.state).toBe(authorized ? 'sending' : 'cancelled');
  if (!authorized) expect(t.authorize(nonce, snapshot, 4)).toBe(false);
  t.result(nonce, true, true); expect(t.send?.state).toBe(authorized ? 'sent' : 'cancelled');
});
test('queued picker commands cannot be revoked before the final grant', () => {
  const t = sending();
  expect(t.queuePickerSend('wrong')).toBe(false);
  expect(t.queuePickerSend(nonce)).toBe(true);
  expect(t.queuePickerSend(nonce)).toBe(false);
  expect(t.cancel()).toBe(false); expect(t.revokeIfNotAuthorized()).toBe(false);
  expect(t.authorize(nonce, snapshot, 3)).toBe(true);
  t.result(nonce, true, true); expect(t.send?.state).toBe('sent');
  begin(t, id, 'new-nonce', snapshot, 4);
  expect(t.revokeIfNotAuthorized()).toBe(true);
});
test.each([
  { chatId: '456@c.us' }, { revision: '2' }, { name: 'Another person' }, { settingsId: '456@c.us' }, { conversationOpen: false }, { ready: false }, { composing: true }
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
test('lookup permission includes a one-second delivery margin after the 15-second cap and activation has a separate five-second deadline', () => {
  const t = finding(); expect(t.prepared(nonce, true, snapshot, 15_999)).toBeDefined();
  expect(t.authorize(nonce, snapshot, 20_998)).toBe(true);
  const expired = finding(); expect(expired.prepared(nonce, true, snapshot, 16_000)).toBeUndefined();
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
  t.result(nonce, true, true); expect(t.send).toMatchObject({ state: 'sent', name: snapshot.name });
});

test('main watchdog leaves room for confirmation and connector teardown', () => {
  expect(STICKER_MAKER_CONFIRMATION_MS).toBeLessThanOrEqual(4000);
  expect(STICKER_MAKER_WATCHDOG_MS).toBeGreaterThanOrEqual(8000);
  expect(STICKER_MAKER_WATCHDOG_MS).toBeGreaterThan(STICKER_MAKER_CONFIRMATION_MS + 1000);
});

describe('maker final authorization races', () => {
  const editor = { ...snapshot, ready: false, stickerPreparation: nonce };
  const interruptions = [
    { name: 'cancel', interrupt: (t: StickerTransfer) => t.cancel() },
    { name: 'remote chat cancellation', interrupt: (t: StickerTransfer) => t.cancel('chat-changed', 'chat-changed') },
    { name: 'chat snapshot change', interrupt: (t: StickerTransfer) => t.observe({ ...snapshot, chatId: '456@c.us', settingsId: '456@c.us' }, 3) },
    { name: 'preparation timeout', interrupt: (t: StickerTransfer) => t.timeout(nonce) }
  ];
  function preparing() {
    const t = new StickerTransfer();
    t.begin(id, nonce, t.destinationToken(snapshot), snapshot, 0, 'maker', false);
    expect(t.disclose(nonce, snapshot, 1)).toBe(true);
    return t;
  }
  test.each(interruptions)('$name before authorization prevents the grant and a late click', ({ interrupt }) => {
    const t = preparing();
    expect(interrupt(t)).toBe(true);
    const terminal = t.send;
    expect(t.authorize(nonce, editor, 4)).toBe(false);
    t.clicked(nonce); t.result(nonce, true, true);
    expect(t.send).toBe(terminal);
  });
  for (const order of ['before clicked', 'after clicked', 'after result without clicked'] as const) {
    test.each(interruptions)(`$name ${order} after authorization preserves the real outcome`, ({ interrupt }) => {
      const t = preparing();
      expect(t.authorize(nonce, editor, 2)).toBe(true);
      expect(t.send?.state).toBe('sending');
      expect(t.authorize(nonce, editor, 3)).toBe(false);
      if (order === 'after clicked') t.clicked(nonce);
      if (order === 'after result without clicked') t.result(nonce, true, true);
      expect(interrupt(t)).toBe(false);
      if (order !== 'after result without clicked') {
        expect(t.send?.state).toBe('sending');
        expect(() => t.begin(id, 'next', t.destinationToken(snapshot), snapshot, 4, 'maker', false)).toThrow('Wait');
        t.clicked('other'); t.result('other', true, true);
        expect(t.send?.state).toBe('sending');
        t.clicked(nonce); t.result(nonce, true, true);
      } else {
        t.clicked(nonce);
      }
      expect(t.send).toMatchObject({ nonce, state: 'sent', sent: 'confirmed' });
      t.begin(id, 'next', t.destinationToken(snapshot), snapshot, 5, 'maker', false);
      t.clicked(nonce); t.result(nonce, true, true);
      expect(t.send).toMatchObject({ nonce: 'next', state: 'preparing' });
    });
  }
  test.each([false, true])('a cancelled grant with clicked=%s retains its reported outcome', clicked => {
    const t = preparing();
    expect(t.authorize(nonce, editor, 2)).toBe(true);
    expect(t.cancel()).toBe(false);
    t.result(nonce, clicked, false, clicked ? 'unconfirmed' : 'editor-unavailable');
    expect(t.send).toMatchObject({ state: 'failed', sent: clicked ? 'unknown' : 'not-sent' });
  });
  test('a clicked notification before authorization cannot prevent cancellation', () => {
    const t = preparing();
    t.clicked(nonce);
    expect(t.send?.state).toBe('preparing');
    expect(t.cancel()).toBe(true);
    expect(t.authorize(nonce, editor, 2)).toBe(false);
  });
});

test.each(['watchdog', 'preparation timeout', 'cancelled', 'sent'] as const)('late draft result cannot change the send outcome after a terminal maker result: %s', terminal => {
  const t = new StickerTransfer();
  t.begin(id, nonce, t.destinationToken(snapshot), snapshot, 0, 'maker', false);
  expect(t.disclose(nonce, snapshot, 1)).toBe(true);
  if (terminal === 'cancelled') t.cancel();
  else if (terminal === 'preparation timeout') t.timeout(nonce);
  else {
    const editor = { ...snapshot, ready: false, stickerPreparation: nonce };
    expect(t.authorize(nonce, editor, 2)).toBe(true);
    t.clicked(nonce);
    t.result(nonce, true, terminal === 'sent', terminal === 'sent' ? undefined : 'unconfirmed', terminal === 'sent' ? undefined : 'confirm-timeout');
  }
  const before = t.send;
  t.result('other', true, true, 'draft', 'draft-appeared');
  t.result(nonce, true, true); // Ordinary late results cannot revive permission.
  expect(t.send).toBe(before);
  const clicked = terminal === 'watchdog' || terminal === 'sent';
  t.result(nonce, clicked, terminal === 'sent', 'draft', 'draft-appeared');
  expect(t.send).toBe(before);
  expect(t.authorize(nonce, snapshot, 3)).toBe(false);
  t.begin(id, 'new', t.destinationToken(snapshot), snapshot, 4, 'maker', false);
  t.result(nonce, true, true, 'draft', 'draft-appeared');
  expect(t.send).toMatchObject({ nonce: 'new', state: 'preparing' });
});

test.each([
  { clicked: false, confirmed: false, sent: 'not-sent' },
  { clicked: false, confirmed: true, sent: 'not-sent' },
  { clicked: true, confirmed: false, sent: 'unknown' },
  { clicked: true, confirmed: true, sent: 'unknown' }
] as const)('draft appearing keeps clicked outcomes unknown: %j', ({ clicked, confirmed, sent }) => {
  const t = new StickerTransfer();
  t.begin(id, nonce, t.destinationToken(snapshot), snapshot, 0, 'maker', false);
  expect(t.disclose(nonce, snapshot, 1)).toBe(true);
  if (clicked) {
    expect(t.authorize(nonce, { ...snapshot, ready: false, stickerPreparation: nonce }, 2)).toBe(true);
    t.clicked(nonce);
  }
  t.result(nonce, clicked, confirmed, 'draft', 'draft-appeared');
  expect(t.send).toMatchObject({ state: 'failed', reason: 'draft', detail: 'draft-appeared', sent });
  expect(t.authorize(nonce, snapshot, 3)).toBe(false);
});

test('a maker click without explicit confirmation keeps the outcome unknown', () => {
  const t = new StickerTransfer();
  t.begin(id, nonce, t.destinationToken(snapshot), snapshot, 0, 'maker', false);
  expect(t.disclose(nonce, snapshot, 1)).toBe(true);
  expect(t.authorize(nonce, { ...snapshot, ready: false, stickerPreparation: nonce }, 2)).toBe(true);
  t.clicked(nonce);
  t.result(nonce, true, undefined, 'draft', 'draft-appeared');
  expect(t.send).toMatchObject({ state: 'failed', sent: 'unknown', reason: 'draft', detail: 'draft-appeared' });
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
  const sticker = (id: string, lastSeen: number, searchTerms = 'saved terms'): Sticker => ({ id, lastSeen, firstSeen: 0, searchTerms, groups: [], kind: 'static', size: 12 });
  const panelStatus = (stickers = [sticker(id, 1)]): Status => ({
    sequence: 1, runtimePaused: false, state: { ...initialState(), stickers },
    chat: { chatId: snapshot.chatId, settingsId: snapshot.settingsId, name: snapshot.name, kind: snapshot.kind, ready: true, canSendSticker: true, destinationToken },
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
  const tileButton = () => document.querySelector<HTMLButtonElement>('.sticker-art')!;
  async function editTile() {
    if ([...document.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Edit stickers')) await click('Edit stickers');
    await reactAct(() => { tileButton().focus(); tileButton().click(); });
  }
  async function click(name: string) { await reactAct(() => { button(name).focus(); button(name).click(); }); }
  // jsdom clicks are always synthetic. Invoke React's handler with the trusted
  // event seam here; the desktop suite checks the actual Chromium trust boundary.
  async function trustedClick(name: string) {
    const target = name === 'tile' ? tileButton() : button(name);
    const key = Object.keys(target).find(key => key.startsWith('__reactProps$'))!;
    const props = (target as unknown as Record<string, { onClick: (event: unknown) => void }>)[key];
    await reactAct(() => props.onClick({ nativeEvent: { isTrusted: true } }));
  }
  async function trustedSend(act: Act) {
    await trustedClick('tile');
    const action = vi.mocked(act).mock.calls.at(-1)![0];
    if (action.type !== 'sendSticker') throw new Error('Expected a send action');
    return action.nonce;
  }
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

  test('a recognized conversation without a composer still permits a trusted picker send', async () => {
    const act: Act = vi.fn(async () => true), status = panelStatus();
    await render({ ...status, chat: { ...status.chat, ready: false, canSendSticker: true } }, act);
    expect(tileButton().getAttribute('aria-disabled')).toBeNull();
    expect((document.querySelector('.sticker-strip')?.textContent ?? '')).not.toContain('Open a chat to send');
    await trustedSend(act);
    expect(act).toHaveBeenCalledOnce();
  });
  test('Send stays unavailable when presentation readiness outlasts an open conversation', async () => {
    const act: Act = vi.fn(async () => true), status = panelStatus();
    await render({ ...status, chat: { ...status.chat, ready: true, canSendSticker: false } }, act);
    expect(tileButton().getAttribute('aria-disabled')).toBe('true');
    expect((document.querySelector('.sticker-strip')?.textContent ?? '')).toContain('Open a chat to send');
    await trustedClick('tile');
    expect(act).not.toHaveBeenCalled();
  });

  test('cancelled maker cleanup explains unavailable Send and recovery requires a fresh trusted click', async () => {
    const act: Act = vi.fn(async () => true), status = panelStatus();
    await render(status, act);
    const cancelledNonce = await trustedSend(act);
    const cancelled = { id, nonce: cancelledNonce, name: snapshot.name, route: 'maker' as const, animated: false, state: 'cancelled' as const };
    await render({ ...status, chat: { ...status.chat, canSendSticker: false, stickerSendBlockedReason: 'busy' }, stickerSend: cancelled }, act);
    expect(tileButton().getAttribute('aria-disabled')).toBeNull();
    expect((document.querySelector('.sticker-strip')?.textContent ?? '')).toContain('Wait for the current sticker');
    expect(document.body.textContent).not.toContain('Open a chat to send');
    await trustedClick('tile');
    expect(act).toHaveBeenCalledTimes(1);
    await type('.search', 'no matching sticker');
    expect((document.querySelector('.sticker-strip')?.textContent ?? '')).toContain('Wait for the current sticker');
    await type('.search', '');
    await render({ ...status, stickerSend: cancelled }, act);
    expect(tileButton().getAttribute('aria-disabled')).toBeNull();
    expect((document.querySelector('.sticker-strip')?.textContent ?? '')).not.toContain('Wait for the current sticker');
    expect(act).toHaveBeenCalledTimes(1);
    expect(await trustedSend(act)).not.toBe(cancelledNonce);
    expect(act).toHaveBeenCalledTimes(2);
  });

  test.each(['missing', 'failed'] as const)('%s send offer stays unavailable during maker cleanup', async state => {
    const act: Act = vi.fn(async () => true), status = panelStatus();
    await render(status, act);
    const nonce = await trustedSend(act);
    const result = { id, nonce, name: snapshot.name, route: 'maker' as const, animated: false, state, sent: 'not-sent' as const, reason: 'editor-unavailable' as const };
    const label = state === 'missing' ? 'Send still' : 'Try again';
    await render({ ...status, chat: { ...status.chat, canSendSticker: false, stickerSendBlockedReason: 'busy' }, stickerSend: result }, act);
    expect(button(label).getAttribute('aria-disabled')).toBe('true');
    await trustedClick(label);
    expect(act).toHaveBeenCalledTimes(1);
    await render({ ...status, stickerSend: result }, act);
    expect(button(label).getAttribute('aria-disabled')).toBeNull();
    await trustedClick(label);
    expect(act).toHaveBeenCalledTimes(2);
  });

  test('a filtered-out maker result keeps a visible conversation available while its composer settles', async () => {
    const act: Act = vi.fn(async () => true), status = panelStatus();
    await render(status, act);
    const nonce = await trustedSend(act);
    const preparing = { id, nonce, name: snapshot.name, route: 'maker' as const, animated: false, state: 'preparing' as const };
    const settling = { ...status, chat: { ...status.chat, ready: false, canSendSticker: true } };
    await render({ ...settling, stickerSend: preparing }, act);
    await type('.search', 'no matching sticker');
    const sent = { ...preparing, state: 'sent' as const };
    await render({ ...settling, stickerSend: sent }, act);
    expect((document.querySelector('.sticker-strip')?.textContent ?? '')).toContain('Sent to ' + snapshot.name);
    expect(document.body.textContent).not.toContain('Open a chat to send');
    await type('.search', '');
    expect(tileButton().getAttribute('aria-disabled')).toBeNull();
    expect(await trustedSend(act)).not.toBe(nonce);
    expect(act).toHaveBeenCalledTimes(2);
  });

  test('Try again waits for conversation availability even if the destination stays presented ready', async () => {
    const act: Act = vi.fn(async () => true), status = panelStatus();
    await render(status, act);
    const nonce = await trustedSend(act);
    const failed = { id, nonce, name: snapshot.name, route: 'maker' as const, animated: false, state: 'failed' as const, sent: 'not-sent' as const, reason: 'editor-unavailable' as const };
    await render({ ...status, chat: { ...status.chat, canSendSticker: false }, stickerSend: failed }, act);
    expect(button('Try again').getAttribute('aria-disabled')).toBe('true');
    await trustedClick('Try again');
    expect(act).toHaveBeenCalledTimes(1);
    await render({ ...status, stickerSend: failed }, act);
    expect(button('Try again').getAttribute('aria-disabled')).toBeNull();
    await trustedClick('Try again');
    expect(act).toHaveBeenCalledTimes(2);
  });

  test('a filtered-out draft-appeared result updates the existing failed announcement', async () => {
    const act: Act = vi.fn(async () => true), status = panelStatus();
    await render(status, act);
    const nonce = await trustedSend(act);
    await type('.search', 'no matching sticker');
    const failed = { id, nonce, name: snapshot.name, route: 'maker' as const, animated: false, state: 'failed' as const, reason: 'unconfirmed' as const };
    await render({ ...status, stickerSend: failed }, act);
    expect((document.querySelector('.sticker-strip')?.textContent ?? '')).toContain('Couldn’t confirm');
    await render({ ...status, stickerSend: { ...failed, sent: 'unknown', reason: 'draft', detail: 'draft-appeared' } }, act);
    const message = 'Couldn’t confirm the sticker was sent. Check the chat before sending again.';
    expect((document.querySelector('.sticker-strip')?.textContent ?? '')).toContain(message);
    expect(document.querySelector('[aria-live]')?.textContent).toBe(message);
    expect(document.body.textContent).not.toContain('Send or clear your draft');
  });

  test.each([snapshot.chatId, null])('maker failure survives temporary scope loss while restoring composer (chatId=%s)', async chatId => {
    const act: Act = vi.fn(async () => true), status = panelStatus();
    status.chat = { ...status.chat, chatId, settingsId: chatId ?? 'local:original' };
    await render(status, act);
    const nonce = await trustedSend(act);
    const preparing = { id, nonce, name: snapshot.name, route: 'maker' as const, animated: false, state: 'preparing' as const };
    await render({ ...status, stickerSend: preparing }, act);
    const failed = { ...preparing, state: 'failed' as const, sent: 'not-sent' as const, reason: 'editor-unavailable' as const };
    await render({ ...status, chat: { ...status.chat, ready: false, canSendSticker: false }, stickerSend: failed }, act);
    await render({ ...status, chat: { ...status.chat, ready: false, canSendSticker: false, settingsId: null }, stickerSend: failed }, act);
    expect(document.body.textContent).toContain('WhatsApp didn’t open its sticker editor. Nothing was sent.');
    expect(button('Try again')).toBeDefined();
    await trustedClick('Try again');
    expect(act).toHaveBeenCalledTimes(1); // Restoration cannot grant a new send.
    await render({ ...status, stickerSend: failed }, act);
    expect(button('Try again')).toBeDefined();
    await render({ ...status, chat: { ...status.chat, settingsId: 'other-chat' }, stickerSend: failed }, act);
    expect(document.body.textContent).not.toContain('Nothing was sent.');
    await render({ ...status, stickerSend: failed }, act);
    expect(document.body.textContent).not.toContain('Nothing was sent.');
  });
  test('Escape dismisses an unconfirmed message before the panel can close', async () => {
    const status = panelStatus(), act: Act = vi.fn(async () => true);
    await render(status, act);
    await render({ ...status, stickerSend: { id, nonce, name: snapshot.name, route: 'maker', animated: false, state: 'failed', reason: 'unconfirmed' } }, act);
    expect(document.body.textContent).toContain('Couldn’t confirm');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await reactAct(() => { window.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    expect(document.body.textContent).not.toContain('Couldn’t confirm');
    expect(document.activeElement).toBe(tileButton());
    expect(act).not.toHaveBeenCalled();
  });
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
    await editTile(); await type('textarea', 'submitted terms'); await click('Save');
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
    await editTile(); await type('textarea', 'submitted terms'); await click('Save');
    await render(panelStatus([sticker(id, 1, 'submitted terms')]), act);
    await click('Close'); await editTile();
    await reactAct(() => { pending.resolve(true); });
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('submitted terms');
    expect(document.activeElement).toBe(document.querySelector('textarea'));
  });
  test('a superseded Save acknowledgement cannot close the editor while its newer Save is pending', async () => {
    const first = deferred(), second = deferred();
    let submissions = 0;
    const act: Act = action => action.type === 'sticker' ? (++submissions === 1 ? first.promise : second.promise) : Promise.resolve(true);
    await render(panelStatus(), act);
    await editTile(); await type('textarea', 'submitted terms');
    await click('Save'); await click('Save');
    await reactAct(() => { first.resolve(true); });
    expect(document.querySelector('textarea')).not.toBeNull();
    await reactAct(() => { second.resolve(true); });
    expect(document.querySelector('textarea')).toBeNull();
  });
  test('a newer Locate action keeps its editor and focus when an older Save is acknowledged', async () => {
    const pending = deferred(), act: Act = action => action.type === 'sticker' ? pending.promise : Promise.resolve(true);
    await render(panelStatus(), act);
    await editTile(); await type('textarea', 'submitted terms'); await click('Save');
    await render(panelStatus([sticker(id, 1, 'submitted terms')]), act);
    await click('Locate in WhatsApp');
    await reactAct(() => { pending.resolve(true); });
    expect(document.querySelector('textarea')).not.toBeNull();
    expect(document.activeElement).toBe(button('Locate in WhatsApp'));
  });
  test('Escape closes the editor to its tile, leaves edit mode, then cancels Finding', async () => {
    const act: Act = vi.fn(async () => true), status = panelStatus();
    await render(status, act); await editTile();
    await render({ ...status, stickerSend: { id, nonce, name: snapshot.name, route: 'picker', animated: true, state: 'finding' } }, act);
    const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await reactAct(() => { escape(); });
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(tileButton());
    expect(act).not.toHaveBeenCalled();
    await reactAct(() => { escape(); });
    expect(button('Edit stickers')).toBeDefined(); expect(act).not.toHaveBeenCalled();
    await reactAct(() => { escape(); });
    expect(act).toHaveBeenCalledWith({ type: 'cancelSticker' });
  });
  test('closing the editor during Sending returns focus to its tile', async () => {
    const status = panelStatus();
    await render(status); await editTile();
    await render({ ...status, stickerSend: { id, nonce, name: snapshot.name, route: 'picker', animated: true, state: 'sending' } });
    await click('Close');
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(tileButton());
  });
  test('a delayed Forget cannot steal focus from a newer editor', async () => {
    const b = 'b'.repeat(64), pending = deferred();
    const act: Act = action => action.type === 'forgetSticker' ? pending.promise : Promise.resolve(true);
    await render(panelStatus([sticker(id, 2), sticker(b, 1)]), act);
    await editTile(); await reactAct(() => document.querySelector<HTMLButtonElement>('button[aria-label="Delete sticker"]')!.click()); await click('Delete');
    await render(panelStatus([sticker(b, 1)]), act); await editTile();
    await type('textarea', 'newer B draft');
    await reactAct(() => { pending.resolve(true); });
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('newer B draft');
    expect(document.activeElement).toBe(document.querySelector('textarea'));
  });
  test('a delayed Forget cannot clear a newer draft after the same sticker is indexed again', async () => {
    const pending = deferred(), act: Act = action => action.type === 'forgetSticker' ? pending.promise : Promise.resolve(true);
    await render(panelStatus(), act);
    await editTile(); await reactAct(() => document.querySelector<HTMLButtonElement>('button[aria-label="Delete sticker"]')!.click()); await click('Delete');
    await render(panelStatus([]), act); await render(panelStatus(), act);
    await editTile(); await type('textarea', 'newly indexed draft');
    await reactAct(() => { pending.resolve(true); });
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('newly indexed draft');
    expect(document.activeElement).toBe(document.querySelector('textarea'));
  });
  test('Forget falls back to Search when its remembered next card has also disappeared', async () => {
    const b = 'b'.repeat(64), pending = deferred();
    const act: Act = action => action.type === 'forgetSticker' ? pending.promise : Promise.resolve(true);
    await render(panelStatus([sticker(id, 2), sticker(b, 1)]), act);
    await editTile(); await reactAct(() => document.querySelector<HTMLButtonElement>('button[aria-label="Delete sticker"]')!.click()); await click('Delete');
    await render(panelStatus([]), act);
    await reactAct(() => { pending.resolve(true); });
    expect(document.activeElement).toBe(document.querySelector('.search'));
  });
});

test.each([
  { draft: 'text' }, { draft: ' ' }, { draftIssue: 'unsupported' as const },
  { draftIssue: 'too-long' as const }, { composing: true }, { ready: false }
])('route selection treats an uncertain or nonempty composer as a draft: %j', patch => {
  const current = { ...snapshot, ...patch };
  expect(composerProvablyEmpty(current)).toBe(false);
  expect(stickerRoute(current, false)).toBe('picker');
  expect(stickerRoute(current, true)).toBe('picker');
  expect(stickerRoute(current, true, true)).toBe('maker');
  const t = new StickerTransfer();
  t.begin(id, nonce, t.destinationToken(current), current, 0, 'maker', true);
  expect(t.send).toMatchObject({ state: 'failed', sent: 'not-sent', reason: 'draft', detail: 'draft-present' });
  expect(t.disclose(nonce, current, 1)).toBe(false);
  expect(t.authorize(nonce, current, 2)).toBe(false);
});
test('empty composer selects maker for static and explicit still, picker for animated', () => {
  expect(composerProvablyEmpty(snapshot)).toBe(true);
  expect(stickerRoute(snapshot, false)).toBe('maker');
  expect(stickerRoute(snapshot, true, true)).toBe('maker');
  expect(stickerRoute(snapshot, true)).toBe('picker');
});
test.each(['miss', 'timeout'] as const)('static picker %s reports draft-present instead of an animated fallback', end => {
  const current = { ...snapshot, draft: 'Unsent text' }, t = new StickerTransfer();
  t.begin(id, nonce, t.destinationToken(current), current, 0, 'picker', false);
  if (end === 'miss') t.prepared(nonce, false, current, 1);
  else t.timeout(nonce);
  expect(t.send).toMatchObject({ state: 'failed', reason: 'draft', detail: 'draft-present', sent: 'not-sent' });
  expect(current.draft).toBe('Unsent text');
});
test.each([undefined, false, true])('picker requires an explicit confirming result: confirmed=%s', confirmed => {
  const t = sending(); expect(t.authorize(nonce, snapshot, 3)).toBe(true);
  t.result(nonce, true, confirmed);
  expect(t.send).toMatchObject({ state: confirmed ? 'sent' : 'failed', sent: confirmed ? 'confirmed' : 'unknown' });
});
test('picker can begin and authorize during composition without using the editor', () => {
  const current = { ...snapshot, composing: true }, t = new StickerTransfer();
  t.begin(id, nonce, t.destinationToken(current), current, 0, 'picker', false);
  expect(t.prepared(nonce, true, current, 1)).toBeDefined();
  expect(t.authorize(nonce, current, 2)).toBe(true);
});

test.each([{ draft: 'New draft' }, { draftIssue: 'unsupported' as const }, { composing: true }])('maker refuses a newly nonempty/uncertain composer before disclosure: %j', patch => {
  const t = new StickerTransfer();
  t.begin(id, nonce, t.destinationToken(snapshot), snapshot, 0, 'maker', false);
  expect(t.disclose(nonce, { ...snapshot, ...patch }, 1)).toBe(false);
  if (t.send?.state === 'preparing') t.observe({ ...snapshot, ...patch }, 2);
  expect(t.send).toMatchObject({ state: 'failed', reason: 'draft', detail: 'draft-appeared', sent: 'not-sent' });
});
test.each([{ draft: 'New draft' }, { draftIssue: 'unsupported' as const }, { composing: true }])('observing a new maker draft stops preparation with a draft result: %j', patch => {
  const t = new StickerTransfer();
  t.begin(id, nonce, t.destinationToken(snapshot), snapshot, 0, 'maker', false);
  expect(t.disclose(nonce, snapshot, 1)).toBe(true);
  expect(t.observe({ ...snapshot, ...patch, stickerPreparation: nonce }, 2)).toBe(true);
  expect(t.send).toMatchObject({ state: 'failed', reason: 'draft', detail: 'draft-appeared', sent: 'not-sent' });
});

test('an unavailable composer routes static through the picker in a recognized conversation', () => {
  const current = { ...snapshot, ready: false }, t = new StickerTransfer();
  t.begin(id, nonce, t.destinationToken(current), current, 0, stickerRoute(current, false), false);
  expect(t.send).toMatchObject({ route: 'picker', state: 'finding' });
  expect(t.prepared(nonce, true, current, 1)).toBeDefined();
  expect(t.authorize(nonce, current, 2)).toBe(true);
  t.result(nonce, true, true);
  expect(t.send).toMatchObject({ route: 'picker', state: 'sent' });
});

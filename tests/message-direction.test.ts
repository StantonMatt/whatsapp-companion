// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { DomConnector } from '../src/connector/dom';
import { fallbackDirection, messageDirection } from '../src/connector/message-direction';
import { autoDecision } from '../src/core/auto-reply';
import { snapshotKey, suggestionKey } from '../src/core/suggestions';
import { defaultAuto, emptySnapshot, snapshotSchema } from '../src/shared/model';
import { displayAckSchema, dismissEventSchema } from '../src/shared/connector';

const rect = (left: number, width: number, height = 40) => ({ left, right: left + width, width, height, top: 10, bottom: 10 + height } as DOMRect);
function pane() {
  document.body.innerHTML = '<div id="pane-side"><div aria-selected="true">Chat</div></div><div id="main"><header><span data-testid="conversation-info-header-chat-title">Chat</span></header><section></section><footer><div contenteditable="true" role="textbox"></div></footer></div>';
  const main = document.querySelector<HTMLElement>('#main')!;
  main.getBoundingClientRect = () => rect(0, 800, 600);
  document.querySelector<HTMLElement>('[role="textbox"]')!.getBoundingClientRect = () => rect(40, 600);
  return main;
}
function bubble(html: string, left = 350, width = 100) {
  const row = document.createElement('div'), id = `OPAQUE_${document.querySelectorAll('[data-id]').length}`;
  row.dataset.id = id; row.dataset.testid = `conv-msg-${id}`; row.innerHTML = `<div data-testid="msg-container">${html}</div>`;
  row.querySelector<HTMLElement>('[data-testid="msg-container"]')!.getBoundingClientRect = () => rect(left, width);
  document.querySelector('section')!.append(row); return row;
}
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

test('consecutive opaque incoming bubbles inherit the first tail even when geometry is ambiguous', () => {
  const main = pane(); const first = bubble('<span data-icon="tail-in"></span><span data-testid="msg-text">First</span>');
  const second = bubble('<span data-testid="msg-text">Second</span>');
  bubble('<span data-testid="msg-text">Third</span>');
  expect(messageDirection(first)).toBe(false); expect(messageDirection(second)).toBeNull();
  expect(fallbackDirection(second, main)).toBe(false);
  const messages = snapshotSchema.parse(new DomConnector(document, () => {}).read()).messages;
  expect(messages.map(m => m.outgoing)).toEqual([false, false, false]);
  expect(messages.map(m => m.directionFallback)).toEqual([undefined, true, true]);
});
test.each(['<div data-testid="date-divider">Today</div>', '<div role="separator"></div>', '<div data-testid="system-message">Security code changed</div>', '<div>Yesterday</div>'])('a divider/system row breaks inheritance: %s', divider => {
  const main = pane(); bubble('<span data-icon="tail-in"></span>');
  document.querySelector('section')!.insertAdjacentHTML('beforeend', divider);
  const last = bubble('<span data-testid="msg-text">Last</span>');
  expect(fallbackDirection(last, main)).toBeNull(); expect(new DomConnector(document, () => {}).read().messages.at(-1)!.outgoing).toBeNull();
});
test('a bare date text node at a wrapper boundary breaks inheritance', () => {
  const main = pane(); bubble('<span data-icon="tail-in"></span>');
  const last = bubble('Last'), wrapper = document.createElement('div');
  last.before(wrapper); wrapper.append('Yesterday', last);
  expect(fallbackDirection(last, main)).toBeNull();
});
test.each([[60, 100, false], [640, 100, true], [350, 100, null], [10, 780, null], [60, 0, null], [60, 100, null, 0], [-50, 100, null]] as Array<[number, number, boolean | null, number?]>)('geometry left=%s width=%s yields %s', (left, width, direction, height = 40) => {
  const main = pane(), row = bubble('<span data-testid="msg-text">No tail</span>', left, width);
  row.querySelector<HTMLElement>('[data-testid="msg-container"]')!.getBoundingClientRect = () => rect(left, width, height);
  expect(fallbackDirection(row, main)).toBe(direction);
});
test('opposite sides break inheritance, geometry still identifies the new incoming bubble', () => {
  const main = pane(); bubble('<span data-icon="tail-out"></span>', 640); const last = bubble('Incoming', 60);
  expect(fallbackDirection(last, main)).toBe(false);
});
test('explicit ID and tail signals precede suggestion-only geometry and quoted tails cannot establish direction', () => {
  pane(); const row = bubble('<span data-icon="tail-out"></span>', 60);
  expect(new DomConnector(document, () => {}).read().messages.at(-1)!.outgoing).toBe(true);
  row.dataset.id = 'false_123@c.us_verified';
  expect(new DomConnector(document, () => {}).read().messages.at(-1)!.outgoing).toBe(false);
  row.dataset.id = 'OPAQUE_0'; row.innerHTML = '<div data-testid="msg-container"><div data-testid="quoted-message"><span data-icon="tail-out"></span></div></div>';
  row.querySelector<HTMLElement>('[data-testid="msg-container"]')!.getBoundingClientRect = () => rect(350, 100);
  expect(new DomConnector(document, () => {}).read().messages.at(-1)!.outgoing).toBeNull();
});
test('inferred incoming messages allow inline suggestions but cannot authorize automatic sending', () => {
  pane(); bubble('<span data-testid="msg-text">Question</span>', 60);
  const message = new DomConnector(document, () => {}).read().messages[0];
  expect(message).toMatchObject({ outgoing: false, directionFallback: true });
  const snapshot = { ...emptySnapshot, chatId: '123@c.us', ready: true, atBottom: true, messages: [message] };
  const rules = { ...defaultAuto, enabled: true, paused: false, startHour: 0, endHour: 0 };
  expect(autoDecision(rules, snapshot, [], new Date())).toBe('No new incoming text');
  const explicit = { ...snapshot, messages: [{ ...message, directionFallback: undefined }] };
  expect(autoDecision(rules, explicit, [], new Date())).toBeNull();
  expect(snapshotKey(explicit)).not.toBe(snapshotKey(snapshot)); expect(suggestionKey(explicit)).toBe(suggestionKey(snapshot));
});
test.each(['<img alt="🫢">', '<span data-plain-text="🫢"></span>', '<span data-testid="msg-text"><img alt="🫢"></span>'])('jumbo emoji text is readable with %s', html => {
  pane(); bubble(html); expect(new DomConnector(document, () => {}).read().messages[0].text).toBe('🫢');
});
test('emoji extraction omits quote, reaction, author and media alt labels', () => {
  pane(); bubble('<span data-testid="msg-text">Body <img alt="😂"></span><img alt="🫢"><div data-testid="quoted-message"><img alt="😍"></div><span data-testid="author"><img alt="🤗"></span><div data-testid="reaction"><img alt="😡"></div><div data-testid="image-thumb"><img alt="Photo 😀"></div><img alt="Photo 😀">');
  expect(new DomConnector(document, () => {}).read().messages[0].text).toBe('Body 😂\n🫢');
});
test('display and dismissal IPC schemas reject malformed, extra and authority-bearing fields', () => {
  const id = '0b3455de-8a13-4f0c-ade8-f5c123456789';
  const ack = { type: 'displayAck', suggestionId: id, key: 'key', reason: 'key' };
  expect(displayAckSchema.safeParse(ack).success).toBe(true);
  for (const value of [{ ...ack, reason: 'send' }, { ...ack, suggestionId: 'untrusted' }, { ...ack, automatic: true }, { ...ack, text: 'private' }]) expect(displayAckSchema.safeParse(value).success).toBe(false);
  expect(dismissEventSchema.safeParse({ type: 'dismiss', suggestionId: id, key: 'key' }).success).toBe(true);
  expect(dismissEventSchema.safeParse({ type: 'dismiss', requestId: id }).success).toBe(true);
  expect(dismissEventSchema.safeParse({ type: 'dismiss', requestId: 'forged' }).success).toBe(false);
  expect(dismissEventSchema.safeParse({ type: 'dismiss', requestId: id, suggestionId: id, key: 'key' }).success).toBe(false);
  expect(dismissEventSchema.safeParse({ type: 'dismiss', suggestionId: id }).success).toBe(false);
  expect(dismissEventSchema.safeParse({ type: 'dismiss', key: 'key' }).success).toBe(false);
});
test('a full-width virtualized placeholder after a wide incoming bubble keeps its observed message and direction', () => {
  pane(); bubble('<span data-icon="tail-in"></span><span data-testid="msg-text">Wide first</span>', 10, 700);
  const second = bubble('<span data-testid="msg-text">Readable second</span>', 10, 700);
  const connector = new DomConnector(document, () => {});
  const observed = connector.read().messages.at(-1)!;
  expect(observed).toMatchObject({ text: 'Readable second' });
  second.innerHTML = '<div style="height:150px"></div>';
  second.getBoundingClientRect = () => rect(0, 800, 150);
  expect(connector.read().messages.at(-1)).toEqual(observed);
});
test('an unobserved placeholder is never relabelled by inference', () => {
  pane(); bubble('<span data-icon="tail-in"></span><span data-testid="msg-text">Wide first</span>', 10, 700);
  const second = bubble('', 10, 700); second.innerHTML = '<div style="height:150px"></div>';
  second.getBoundingClientRect = () => rect(0, 800, 150);
  expect(new DomConnector(document, () => {}).read().messages.at(-1)).toMatchObject({ text: '', outgoing: null });
});

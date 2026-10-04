// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest';
import { DomConnector, peerFromMessageId, caretAtEnd, readDraft, accountSafetyReason } from '../src/connector/dom';
import { stickerImageState } from '../src/connector/sticker-image-state';
import { snapshotSchema, initialState, type Snapshot, type State } from '../src/shared/model';
import { Assistant } from '../src/main/assistant';
import { ProviderError, type generate } from '../src/main/providers';
import type { Store } from '../src/main/store';
import type { Vault } from '../src/main/vault';
import { StickerTransfer, canSendSticker, stickerRoute } from '../src/core/sticker-transfer';
import { snapshotKey, suggestionKey } from '../src/core/suggestions';
import type { RemoteEvent, RemoteCommand } from '../src/shared/connector';
import { composerProvablyEmpty } from '../src/connector/draft';
import { emptyComposers } from './fixtures/empty-composers';
import { composerStyle } from '../src/connector/composer-style';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });
function fixture() {
  document.body.innerHTML = '<div id="main"><header><span title="A friend">A friend</span></header><div data-id="false_123@c.us_one"><span class="selectable-text copyable-text">Hi</span></div><footer><div contenteditable="true" role="textbox">A draft</div></footer></div>';
  const editor = document.querySelector<HTMLElement>('[role=textbox]')!;
  editor.getBoundingClientRect = () => ({ height: 40, width: 500, x: 0, y: 200, top: 200, bottom: 240, left: 0, right: 500, toJSON() {} });
  document.querySelector('#main')!.getBoundingClientRect = () => ({ height: 600, width: 600 } as DOMRect);
  return editor;
}
test('message identity recognizes personal, LID and group peers without relying on display names', () => {
  expect(peerFromMessageId('false_123@lid_a')).toBe('123@lid');
  expect(peerFromMessageId('true_123-456@g.us_b_123@c.us')).toBe('123-456@g.us');
  expect(peerFromMessageId('arbitrary_contact_title')).toBeNull();
});
test('connector waits for a stable identity, fails closed on mixed peers and detects replaced editors', () => {
  vi.useFakeTimers(); fixture(); const connector = new DomConnector(document, () => {});
  const first = connector.read(); expect(first.ready).toBe(false);
  vi.advanceTimersByTime(600); expect(connector.read()).toMatchObject({ ready: true, chatId: '123@c.us', kind: 'direct' });
  const editor = document.querySelector('[role=textbox]')!; editor.replaceWith(editor.cloneNode(true));
  expect(connector.read().revision).not.toBe(first.revision);
  const other = document.createElement('div'); other.dataset.id = 'false_456@g.us_second'; document.querySelector('#main')!.append(other);
  expect(connector.read().chatId).toBeNull(); expect(connector.read().ready).toBe(false);
});
test.each(['display', 'visibility', 'ancestor', 'zero-size'] as const)('a hidden conversation (%s) retains identity but cannot authorize sending', mode => {
  vi.useFakeTimers(); fixture();
  const connector = new DomConnector(document, () => {}), transfer = new StickerTransfer();
  connector.read(); vi.advanceTimersByTime(600);
  const before = connector.read(), displayed = transfer.destinationToken(before);
  expect(before.conversationOpen).toBe(true);
  const main = document.querySelector<HTMLElement>('#main')!;
  if (mode === 'display') main.style.display = 'none';
  if (mode === 'visibility') main.style.visibility = 'hidden';
  if (mode === 'ancestor') document.body.style.display = 'none';
  if (mode === 'zero-size') main.getBoundingClientRect = () => ({ width: 0, height: 0 } as DOMRect);
  try {
    const hidden = snapshotSchema.parse(connector.read());
    expect(hidden).toMatchObject({ chatId: before.chatId, name: before.name, conversationOpen: false, ready: false });
    expect(canSendSticker(hidden)).toBe(false);
    expect(transfer.destinationToken(hidden)).not.toBe(displayed);
    expect(() => transfer.begin('a'.repeat(64), 'hidden', transfer.destinationToken(hidden), hidden)).toThrow('Open a conversation');
    expect(transfer.send).toBeNull();
  } finally { document.body.style.display = ''; }
});
test.each(['missing', 'hidden', 'empty'] as const)('a visible conversation with a %s composer selects the appropriate static route', mode => {
  vi.useFakeTimers(); const editor = fixture(); editor.replaceChildren();
  const connector = new DomConnector(document, () => {}), transfer = new StickerTransfer();
  connector.read(); vi.advanceTimersByTime(600);
  if (mode === 'missing') editor.remove();
  if (mode === 'hidden') editor.style.display = 'none';
  const snapshot = snapshotSchema.parse(connector.read());
  expect(snapshot.conversationOpen).toBe(true);
  expect(snapshot.ready).toBe(mode === 'empty');
  expect(canSendSticker(snapshot)).toBe(true);
  const route = stickerRoute(snapshot, false);
  expect(route).toBe(mode === 'empty' ? 'maker' : 'picker');
  transfer.begin('a'.repeat(64), mode, transfer.destinationToken(snapshot), snapshot, 0, route, false);
  expect(transfer.send).toMatchObject({ route, state: mode === 'empty' ? 'preparing' : 'finding' });
});
test('conversation openness is required and strictly boolean at the remote schema boundary', () => {
  fixture(); const snapshot = new DomConnector(document, () => {}).read();
  const { conversationOpen, ...missing } = snapshot;
  expect(snapshotSchema.safeParse(snapshot).success).toBe(true);
  for (const value of [missing, { ...snapshot, conversationOpen: 'true' }, { ...snapshot, conversationOpen: null }, { ...snapshot, visible: true }]) {
    expect(snapshotSchema.safeParse(value).success).toBe(false);
  }
});
test('a visible chat settling without a composer still publishes its open state to main', () => {
  vi.useFakeTimers(); fixture().remove();
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event));
  connector.start();
  try {
    expect(events.find(event => event.type === 'snapshot')).toMatchObject({ snapshot: { conversationOpen: false, ready: false } });
    vi.advanceTimersByTime(800);
    expect(events.filter(event => event.type === 'snapshot').at(-1)).toMatchObject({ snapshot: { conversationOpen: true, ready: false } });
  } finally { connector.stop(); }
});
function modernFixture() {
  const editor = fixture();
  document.querySelector('#main header')!.innerHTML = '<button title="Profile details"></button><span data-testid="conversation-info-header-chat-title">A friend</span>';
  const side = document.createElement('div'); side.id = 'pane-side'; side.innerHTML = '<div aria-selected="true">A friend</div>'; document.body.prepend(side);
  const message = document.querySelector<HTMLElement>('#main [data-id]')!;
  message.dataset.id = 'ABC123456'; message.dataset.testid = 'conv-msg-ABC123456';
  return editor;
}
test.each([
  ['\u200eJose\u0301\u00a0 <img class="emoji" alt="😀">  Smith\u2069', 'José 😀 Smith'],
  ['Alex <span class="emoji" data-plain-text="👩🏽‍💻"></span>', 'Alex 👩🏽‍💻'],
  ['Alex <span alt="😀" style="background-image:url(emoji.png)"></span>', 'Alex 😀'],
  ['A'.repeat(200), 'A'.repeat(200)]
])('connector preserves the normalized full header title %s', (html, name) => {
  modernFixture();
  const node = document.querySelector('[data-testid="conversation-info-header-chat-title"]')!;
  node.setAttribute('title', 'Stale tooltip'); node.innerHTML = html;
  expect(snapshotSchema.parse(new DomConnector(document, () => {}).read()).name).toBe(name);
});
test('opaque live message IDs permit global assistance without inventing a persistent identity or sender', () => {
  vi.useFakeTimers(); modernFixture(); const connector = new DomConnector(document, () => {});
  expect(connector.read().ready).toBe(false); vi.advanceTimersByTime(600);
  expect(connector.read()).toMatchObject({ ready: true, name: 'A friend', chatId: null, kind: 'unknown', messages: [{ id: 'ABC123456', text: 'Hi', outgoing: null }] });
  document.querySelector('#main [data-id]')!.insertAdjacentHTML('beforeend', '<span data-icon="tail-in"></span>');
  expect(connector.read().messages[0].outgoing).toBe(false);
  document.querySelector('[data-icon="tail-in"]')!.setAttribute('data-icon', 'tail-out');
  expect(connector.read().messages[0].outgoing).toBe(true);
});
test('ghost text matches individual font properties and temporarily hides the real placeholder', () => {
  vi.useFakeTimers(); const editor = modernFixture(); editor.textContent = ''; editor.setAttribute('aria-placeholder', 'Type a message'); editor.tabIndex = 0;
  editor.style.cssText = 'font-family: sans-serif; font-size: 15px; font-weight: 400; letter-spacing: 0.2px';
  const placeholder = document.createElement('div'); placeholder.setAttribute('aria-hidden', 'true'); placeholder.textContent = 'Type a message'; editor.parentElement!.append(placeholder);
  const connector = new DomConnector(document, () => {}); connector.start();
  try {
    vi.advanceTimersByTime(600); editor.focus(); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    connector['refresh'](); connector.command({ type: 'suggestion', text: 'A synthetic reply', replace: false, key: suggestionKey(connector.read()) });
    expect(placeholder.style.visibility).toBe('hidden'); expect(connector['ghost'].style.fontFamily).toBe('sans-serif'); expect(connector['ghost'].style.fontSize).toBe('15px');
    connector.command({ type: 'clear' }); expect(placeholder.style.visibility).toBe('');
  } finally { connector.stop(); }
});
test('ghost text can arrive unfocused, survives clicks and focus changes, and rejects a stale result after editing begins', () => {
  vi.useFakeTimers(); const editor = modernFixture(); editor.textContent = ''; editor.tabIndex = 0;
  const connector = new DomConnector(document, () => {}); connector.start();
  try {
    vi.advanceTimersByTime(600); const key = suggestionKey(connector.read());
    const command = { type: 'suggestion' as const, text: 'Prepared reply', replace: false, key };
    connector.command(command); expect(connector['ghost'].textContent).toBe('Prepared reply');
    connector['activity']({ isTrusted: true } as Event); editor.focus(); connector['refresh']();
    editor.blur(); connector['refresh'](); expect(connector['ghost'].textContent).toBe('Prepared reply');
    connector['beforeInput']({ isTrusted: true, target: editor } as unknown as Event);
    expect(connector['ghost'].textContent).toBe(''); expect(connector.read().draft).toBe('');
    connector.command(command); expect(connector['ghost'].textContent).toBe('');
  } finally { connector.stop(); }
});
test('Escape rejects an already-queued reply and leaves navigation in other fields alone', () => {
  vi.useFakeTimers(); const editor = modernFixture(); editor.textContent = ''; editor.tabIndex = 0;
  const other = document.createElement('input'); document.body.append(other);
  const connector = new DomConnector(document, () => {}); connector.start();
  try {
    vi.advanceTimersByTime(600); const command = { type: 'suggestion' as const, text: 'A reply', replace: false, key: suggestionKey(connector.read()) };
    connector.command(command);
    const event = { isTrusted: true, key: 'Escape', preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), composedPath: () => [] };
    connector['keydown']({ ...event, target: other } as unknown as KeyboardEvent);
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(connector['ghost'].textContent).toBe('A reply');
    connector['keydown']({ ...event, target: editor } as unknown as KeyboardEvent);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(connector['ghost'].textContent).toBe('');
    connector.command(command); expect(connector['ghost'].textContent).toBe('');
  } finally { connector.stop(); }
});
test.each([['image-thumb', 'image'], ['sticker-container', 'sticker'], ['ptt-status', 'audio'], ['video-thumb', 'video'], ['document-thumb', 'document']])('observes %s without reading attachment contents', (testid, attachment) => {
  modernFixture(); const node = document.querySelector('#main [data-id]')!;
  node.innerHTML = `<span data-testid="${testid}"><img alt="Private content must not become a caption" src="data:image/png;base64,AA=="></span>`;
  const connector = new DomConnector(document, () => {});
  expect(connector.read().messages[0]).toEqual({ id: 'ABC123456', text: '', outgoing: null, attachment });
});
test('a shared PDF retains its visible filename and caption, without treating its preview as an image', () => {
  modernFixture(); const node = document.querySelector('#main [data-id]')!;
  node.innerHTML = '<span data-testid="author">Diego</span><div data-testid="document-thumb" title="View file"><div data-testid="image-thumb"><img src="blob:private-document-preview" alt="Private preview"></div><span dir="auto">Binder1 OUTDOOR 29092026.pdf</span><span data-testid="type">PDF</span><span>753 kB</span></div><span data-testid="selectable-text">Salimos en el mercurio</span>';
  const connector = new DomConnector(document, () => {});
  expect(connector.read().messages[0]).toEqual({ id: 'ABC123456', outgoing: false, sender: 'Diego', text: 'Salimos en el mercurio', attachment: 'document', attachmentName: 'Binder1 OUTDOOR 29092026.pdf' });
  const card = node.querySelector('[data-testid="document-thumb"]')!;
  card.querySelector('[dir="auto"]')!.textContent = 'a'.repeat(300);
  expect(connector.read().messages[0].attachmentName).toHaveLength(255);
  card.querySelector('[dir="auto"]')!.textContent = '  ';
  expect(connector.read().messages[0].attachmentName).toBeUndefined();
});
test('a quoted document stays separate from the current message attachment and filename', () => {
  modernFixture(); const node = document.querySelector('#main [data-id]')!;
  node.innerHTML = '<span data-testid="author">Alex</span><div data-testid="quoted-message"><span data-testid="author">Diego</span><div data-testid="document-thumb"><span dir="auto">Article.pdf</span></div></div><div data-testid="image-thumb"></div><span data-testid="selectable-text">Here is a photo too</span>';
  const snapshot = new DomConnector(document, () => {}).read();
  expect(snapshot.messages[0]).toEqual({ id: 'ABC123456', outgoing: false, sender: 'Alex', text: 'Here is a photo too', attachment: 'image', quoted: { text: '', sender: 'Diego', attachment: 'document', attachmentName: 'Article.pdf' } });
  expect(suggestionKey(snapshotSchema.parse(snapshot))).toBe(suggestionKey(snapshot));
});
test('avatars and inline emoji alone do not identify an image attachment', () => {
  modernFixture(); document.querySelector('#main [data-id]')!.innerHTML = '<img width="55" height="55"><img alt="😀" data-plain-text="😀">';
  expect(new DomConnector(document, () => {}).read().messages[0].attachment).toBeUndefined();
});
test('virtualized placeholders retain observed messages but mounted edits and chat changes invalidate them', () => {
  modernFixture(); const connector = new DomConnector(document, () => {}), node = document.querySelector('#main [data-id]')!;
  const original = connector.read().messages;
  node.innerHTML = '<div style="height:150px"></div>';
  expect(connector.read().messages).toEqual(original);
  node.innerHTML = '<div data-testid="msg-container"><span data-testid="selectable-text">Edited text</span></div>';
  expect(connector.read().messages[0].text).toBe('Edited text');
  node.innerHTML = '<div data-testid="msg-container">Deleted message</div>';
  expect(connector.read().messages[0].text).toBe('');
  node.innerHTML = '<span data-testid="selectable-text">Private chat text</span>'; connector.read();
  node.innerHTML = '<div style="height:150px"></div>';
  const row = document.querySelector('#pane-side [aria-selected]')!; row.replaceWith(row.cloneNode(true));
  expect(connector.read().messages[0].text).toBe('');
});
test('switching selected rows invalidates a same-name chat and an unselected layout fails closed', () => {
  vi.useFakeTimers(); modernFixture(); const connector = new DomConnector(document, () => {}); connector.read(); vi.advanceTimersByTime(600);
  const previous = connector.read();
  const selected = document.querySelector('#pane-side [aria-selected]')!; selected.replaceWith(selected.cloneNode(true));
  expect(connector.read()).toMatchObject({ ready: false, chatId: null }); expect(connector.read().revision).not.toBe(previous.revision);
  vi.advanceTimersByTime(600); expect(connector.read().ready).toBe(true);
  document.querySelector('#pane-side')!.remove(); expect(connector.read().ready).toBe(false);
});
test('the connector never dispatches automatically without a stable peer identity', async () => {
  vi.useFakeTimers(); const editor = modernFixture(); editor.textContent = '';
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event)); connector.start();
  const insert = vi.fn(); document.execCommand = insert;
  try {
    vi.advanceTimersByTime(600); const snapshot = connector.read(); expect(snapshot.ready).toBe(true);
    connector.command({ type: 'autoSend', key: snapshotKey(snapshot), text: 'Must not send', nonce: 'unidentified', expiresAt: Date.now() + 2000 });
    expect(insert).not.toHaveBeenCalled(); expect(events).toContainEqual({ type: 'result', nonce: 'unidentified', sent: false });
  } finally { connector.stop(); }
});
test('inline acceptance requires a collapsed caret at the end, not a selected range or mid-draft cursor', () => {
  const editor = fixture(), selection = document.getSelection()!, range = document.createRange();
  range.selectNodeContents(editor); range.collapse(false); selection.addRange(range); expect(caretAtEnd(editor)).toBe(true);
  range.setStart(editor.firstChild!, 2); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); expect(caretAtEnd(editor)).toBe(false);
  range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range); expect(caretAtEnd(editor)).toBe(false);
});
test('selection changes publish caret eligibility without changing the draft', () => {
  const editor = fixture(), events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event)); connector.start();
  try {
    const selection = document.getSelection()!, range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange'));
    expect(events.at(-1)).toMatchObject({ type: 'snapshot', snapshot: { draft: 'A draft', caretAtEnd: true } });
    range.setStart(editor.firstChild!, 2); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange'));
    expect(events.at(-1)).toMatchObject({ type: 'snapshot', snapshot: { draft: 'A draft', caretAtEnd: false } });
  } finally { connector.stop(); }
});
test('readable mention chips are unsupported for draft replacement but still readable as message context', () => {
  const editor = fixture(); editor.innerHTML = 'Hi <span contenteditable="false" data-mention-id="123">@Alice</span>';
  const connector = new DomConnector(document, () => {});
  expect(readDraft(editor)).toBe('Hi @Alice'); expect(connector.read().draftIssue).toBe('unsupported');
  expect(editor.querySelector('[data-mention-id]')?.getAttribute('data-mention-id')).toBe('123');
});
test.each(['activity', 'cancel', 'navigation', 'control-pointer'])('queued automatic dispatch is rejected after %s even when the DOM is unchanged', reason => {
  vi.useFakeTimers(); const editor = fixture(); editor.textContent = '';
  document.querySelector<HTMLElement>('[data-id]')!.getBoundingClientRect = () => ({ height: 20, width: 200, x: 0, y: 80, top: 80, bottom: 100, left: 0, right: 200, toJSON() {} });
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event)); connector.start();
  try {
    vi.advanceTimersByTime(600); const before = connector.read(); expect(before.ready && before.atBottom).toBe(true);
    if (reason === 'activity') connector['activity']({ isTrusted: true } as Event);
    else if (reason === 'control-pointer') connector['pointer']({ isTrusted: true, composedPath: () => [connector['navigation']!.host] } as unknown as Event);
    else connector['navigation']!['emit'](reason === 'cancel' ? { type: 'cancelAuto' } : { type: 'navigate', panel: 'settings' });
    connector.command({ type: 'autoSend', key: snapshotKey(before), text: 'Must not send', nonce: 'queued', expiresAt: Date.now() + 2000 });
    expect(editor.textContent).toBe(''); expect(events).toContainEqual({ type: 'result', nonce: 'queued', sent: false });
  } finally { connector.stop(); }
});
test('image-based emoji are draft content and unknown embeds cannot be mistaken for an empty composer', () => {
  const editor = fixture(); editor.innerHTML = '<p><img alt="😀"></p>';
  expect(readDraft(editor)).toBe('😀'); const connector = new DomConnector(document, () => {}); expect(connector.read().draft).toBe('😀');
  const range = document.createRange(); range.selectNodeContents(editor); range.collapse(true); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); expect(caretAtEnd(editor)).toBe(false);
  editor.innerHTML = '<img>'; expect(connector.read().draftIssue).toBe('unsupported');
  editor.innerHTML = '<svg><path d="M0 0"></path></svg>'; expect(connector.read().draftIssue).toBe('unsupported'); expect(connector.read().draft).not.toBe('');
  editor.innerHTML = '<p>First</p><p>Second<img alt="🙂"></p>'; expect(readDraft(editor)).toBe('First\nSecond🙂');
});
test.each(['Enter', ' ', 'Tab'])('keyboard use of a native control counts as takeover: %s', key => {
  fixture(); const native = document.createElement('button'); document.querySelector('footer')!.append(native);
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event)); connector.start();
  try {
    const before = connector.read().activity;
    connector['keydown']({ isTrusted: true, key, target: native, composedPath: () => [native] } as unknown as KeyboardEvent);
    expect(connector.read().activity).toBe(before + 1);
    expect(events).toContainEqual({ type: 'activity', editing: false });
  } finally { connector.stop(); }
});
test('refinement updates a written draft immediately without a result popup or sending', async () => {
  vi.useFakeTimers(); const editor = fixture();
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event)); connector.start();
  const insert = vi.fn(() => true); document.execCommand = insert;
  try {
    await vi.advanceTimersByTimeAsync(600); editor.focus();
    connector.command({ type: 'suggestion', key: suggestionKey(connector.read()), text: 'Revised draft', replace: true });
    expect(insert).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(50);
    expect(insert).toHaveBeenCalledExactlyOnceWith('insertText', false, 'Revised draft');
    expect(connector['popup'].hidden).toBe(true); expect(connector['suggestion']).toBeUndefined();
    expect(events).toContainEqual({ type: 'activity', editing: true });
    expect(events.some(event => event.type === 'result')).toBe(false);
  } finally { connector.stop(); }
});
test('ordinary composer Tab preserves navigation and invalidates automatic-send snapshots', () => {
  const editor = fixture(), events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event)); connector.start();
  try {
    const before = connector.read().activity, preventDefault = vi.fn();
    connector['keydown']({ isTrusted: true, key: 'Tab', target: editor, composedPath: () => [editor], preventDefault } as unknown as KeyboardEvent);
    expect(connector.read().activity).toBe(before + 1); expect(preventDefault).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('A draft');
  } finally { connector.stop(); }
});
test.each(['First<div><br></div>', 'First\n\n', 'First<br><br>', 'First<p></p>'])('caret before remaining line breaks is not at the end: %s', html => {
  const editor = fixture(); editor.innerHTML = html;
  const selection = document.getSelection()!, range = document.createRange(); range.setStart(editor.firstChild!, 5); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
  expect(caretAtEnd(editor)).toBe(false);
  range.selectNodeContents(editor); range.collapse(false); selection.removeAllRanges(); selection.addRange(range); expect(caretAtEnd(editor)).toBe(true);
});
test.each(['<p><span>Hello</span></p>', '<p>First</p><p><span>Last</span></p>', '<div><span>Hello</span></div>'])('terminal text carets inside ancestor wrappers remain eligible: %s', html => {
  const editor = fixture(); editor.innerHTML = html;
  const last = editor.querySelectorAll('span'); const text = last[last.length - 1].firstChild!;
  const range = document.createRange(); range.setStart(text, text.textContent!.length); range.collapse(true);
  const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  expect(caretAtEnd(editor)).toBe(true);
});
test('a placeholder paragraph is an empty eligible composer', () => {
  const editor = fixture(); editor.innerHTML = '<p><br></p>'; const range = document.createRange(); range.setStart(editor.firstChild!, 0); range.collapse(true);
  const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); expect(caretAtEnd(editor)).toBe(true);
});
test.each(['<p>First</p><p><br></p>', 'First<div><br></div>', '<p>First<br><br></p>', '<p>First<br></p>'])('a caret before the terminal placeholder is eligible: %s', html => {
  const editor = fixture(); editor.innerHTML = html;
  const breaks = editor.querySelectorAll('br'), last = breaks[breaks.length - 1];
  const range = document.createRange(); range.setStartBefore(last); range.collapse(true);
  const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  expect(caretAtEnd(editor)).toBe(true);
});
test.each(['replacement', 'removal'])('IME state does not survive composer %s or clear a newer composition', change => {
  const old = fixture(), connector = new DomConnector(document, () => {}); connector.start();
  try {
    old.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); expect(connector.read().composing).toBe(true);
    const next = old.cloneNode(true) as HTMLElement;
    if (change === 'removal') { old.remove(); expect(connector.read().composing).toBe(false); document.querySelector('footer')!.append(next); }
    else old.replaceWith(next);
    expect(connector.read().composing).toBe(false);
    next.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    connector['compositionEnd']({ target: old } as unknown as Event); expect(connector.read().composing).toBe(true);
    next.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); expect(connector.read().composing).toBe(false);
  } finally { connector.stop(); }
});
test('IME composition in another field does not alter the WhatsApp composer state', () => {
  fixture(); const input = document.createElement('input'); document.body.append(input);
  const connector = new DomConnector(document, () => {});
  connector['compositionStart']({ target: input } as unknown as Event); expect(connector.read().composing).toBe(false);
  connector['compositionEnd']({ target: input } as unknown as Event); expect(connector.read().composing).toBe(false);
});
test('oversized composers are flagged rather than eligible for truncated replacement', () => {
  const editor = fixture(); editor.textContent = 'x'.repeat(8001); const connector = new DomConnector(document, () => {});
  expect(connector.read()).toMatchObject({ draftIssue: 'too-long', draft: 'x'.repeat(8000) });
});
test.each(['send', 'activity', 'cancel', 'expired-wait', 'denied', 'failed-channel', 'cancel-during-approval', 'expiry-during-approval'])('asynchronous Send control respects %s', async scenario => {
  vi.useFakeTimers(); const editor = fixture(); editor.textContent = '';
  document.querySelector<HTMLElement>('[data-id]')!.getBoundingClientRect = () => ({ height: 20, width: 200, x: 0, y: 80, top: 80, bottom: 100, left: 0, right: 200, toJSON() {} });
  const events: RemoteEvent[] = [], clicked = vi.fn(), connector = new DomConnector(document, e => events.push(e), async () => {
    if (scenario === 'failed-channel') throw new Error('IPC unavailable');
    if (scenario === 'cancel-during-approval') connector['activity']({ isTrusted: true } as Event);
    if (scenario === 'expiry-during-approval') vi.setSystemTime(Date.now() + 2000);
    return scenario !== 'denied';
  }); connector.start();
  document.execCommand = (_name, _show, text) => {
    editor.textContent = text ?? '';
    setTimeout(() => {
      const button = document.createElement('button'); button.innerHTML = '<span data-icon="send"></span>'; button.onclick = clicked;
      button.getBoundingClientRect = () => ({ height: 30 } as DOMRect); document.querySelector('footer')!.append(button);
    }, 100); return true;
  };
  try {
    await vi.advanceTimersByTimeAsync(600);
    connector.command({ type: 'autoSend', key: snapshotKey(connector.read()), text: 'Reply', nonce: 'async', expiresAt: Date.now() + (scenario === 'expired-wait' ? 50 : 2000) });
    if (scenario === 'activity') setTimeout(() => connector['activity']({ isTrusted: true } as Event), 50);
    if (scenario === 'cancel') setTimeout(() => connector['navigation']!['emit']({ type: 'cancelAuto' }), 50);
    await vi.advanceTimersByTimeAsync(200);
    expect(clicked).toHaveBeenCalledTimes(scenario === 'send' ? 1 : 0);
    expect(events).toContainEqual({ type: 'result', nonce: 'async', sent: scenario === 'send' });
  } finally { connector.stop(); }
});
test.each(['delayed', 'suspended', 'missing'])('rejects %s automatic authorization before inserting a draft', async reason => {
  vi.useFakeTimers(); const editor = fixture(); editor.textContent = '';
  document.querySelector<HTMLElement>('[data-id]')!.getBoundingClientRect = () => ({ height: 20, width: 200, x: 0, y: 80, top: 80, bottom: 100, left: 0, right: 200, toJSON() {} });
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event)); connector.start();
  const insert = vi.fn(); document.execCommand = insert;
  try {
    await vi.advanceTimersByTimeAsync(600);
    const command = { type: 'autoSend' as const, key: snapshotKey(connector.read()), text: 'Must not insert', nonce: 'expired', expiresAt: reason === 'missing' ? NaN : Date.now() + 2000 };
    if (reason === 'delayed') await vi.advanceTimersByTimeAsync(2000);
    if (reason === 'suspended') vi.setSystemTime(Date.now() + 3600000);
    connector.command(command);
    expect(insert).not.toHaveBeenCalled(); expect(editor.textContent).toBe('');
    expect(events).toContainEqual({ type: 'result', nonce: 'expired', sent: false });
  } finally { connector.stop(); }
});
function mockStickerData(size = 20, type = 'image/webp') {
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => ({ size, type, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) })));
  vi.stubGlobal('crypto', { subtle: { digest: async () => new Uint8Array(32).buffer } });
  vi.stubGlobal('FileReader', class { result = 'data:image/webp;base64,AQID'; onload?: () => void; readAsDataURL() { this.onload?.(); } });
}
function stickerImage(i: number) {
  const img = document.createElement('img'); img.alt = 'sticker'; img.src = `data:image/webp;base64,AA${i}`;
  Object.defineProperties(img, { complete: { value: true, configurable: true }, naturalWidth: { value: 100, configurable: true } }); document.body.append(img); return img;
}
function setStickerLoadState(img: HTMLImageElement, state: string) {
  Object.defineProperties(img, { complete: { value: state === 'broken', configurable: true }, naturalWidth: { value: 0, configurable: true } });
  if (state === 'error') { stickerImageState(img); img.dispatchEvent(new Event('error')); }
}

test.each(['pending', 'broken', 'error'])('discovery indexes ready stickers beyond a full batch of %s images', async state => {
  mockStickerData();
  for (let i = 0; i < 150; i++) setStickerLoadState(stickerImage(i), state);
  const ready = stickerImage(151);
  const events: RemoteEvent[] = [], connector = new DomConnector(document, e => events.push(e));
  await connector['indexStickers']();
  expect(events).toEqual([{ type: 'sticker', image: 'data:image/webp;base64,AQID' }]);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(ready.src, expect.anything());
});

test('discovery retries a loading sticker once ready, without suppressing other ready stickers', async () => {
  mockStickerData(); const loading = stickerImage(1); setStickerLoadState(loading, 'pending'); stickerImage(2);
  const events: RemoteEvent[] = [], connector = new DomConnector(document, e => events.push(e));
  await connector['indexStickers'](); expect(events).toHaveLength(1);
  Object.defineProperties(loading, { complete: { value: true }, naturalWidth: { value: 100 } });
  loading.dispatchEvent(new Event('load'));
  await connector['indexStickers'](); expect(events).toHaveLength(2);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each(['pending', 'broken', 'error'])('Locate in WhatsApp finds a ready match after a %s image with the same indexed hash', async state => {
  mockStickerData(); const unavailable = stickerImage(1), ready = stickerImage(2);
  const events: RemoteEvent[] = [], connector = new DomConnector(document, e => events.push(e));
  await connector['indexStickers'](); events.length = 0;
  setStickerLoadState(unavailable, state);
  for (const image of [unavailable, ready]) {
    image.scrollIntoView = vi.fn(); image.animate = vi.fn(); image.checkVisibility = () => true;
    image.getBoundingClientRect = () => ({ width: 100 } as DOMRect);
  }
  connector.command({ type: 'locateSticker', id: '0'.repeat(64), nonce: 'locate' });
  expect(ready.scrollIntoView).toHaveBeenCalled(); expect(unavailable.scrollIntoView).not.toHaveBeenCalled();
  expect(events).toEqual([{ type: 'stickerLocated', nonce: 'locate', found: true }]);
});
test('Locate shares error/source retry readiness without granting native activation', async () => {
  mockStickerData(); const image = stickerImage(1);
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event));
  await connector['indexStickers'](); events.length = 0;
  image.checkVisibility = () => true; image.getBoundingClientRect = () => ({ width: 100 } as DOMRect);
  image.scrollIntoView = vi.fn(); image.animate = vi.fn(); image.click = vi.fn();
  setStickerLoadState(image, 'error');
  connector.command({ type: 'locateSticker', id: '0'.repeat(64), nonce: 'failed' });
  Object.defineProperties(image, { complete: { value: true, configurable: true }, naturalWidth: { value: 100, configurable: true } });
  image.dispatchEvent(new Event('load'));
  connector.command({ type: 'locateSticker', id: '0'.repeat(64), nonce: 'retried' });
  expect(events).toEqual([{ type: 'stickerLocated', nonce: 'failed', found: false }, { type: 'stickerLocated', nonce: 'retried', found: true }]);
  expect(image.scrollIntoView).toHaveBeenCalledOnce(); expect(image.click).not.toHaveBeenCalled();
});
test.each([[936210, 'image/webp', 1], [1048576, 'image/webp', 1], [1048577, 'image/webp', 0], [936210, 'image/png', 0]])('sticker intake handles %i bytes of %s within its size/type boundary', async (size, type, count) => {
  mockStickerData(size as number, type as string); stickerImage(1);
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event));
  await connector['indexStickers'](); expect(events).toHaveLength(count as number);
});
test('progressive indexing reaches loaded images beyond the first batch', async () => {
  mockStickerData(); for (let i = 0; i < 151; i++) stickerImage(i);
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event));
  await connector['indexStickers'](); expect(events).toHaveLength(150);
  await connector['indexStickers'](); expect(events).toHaveLength(151);
});
test('unsupported HTTPS images do not starve later supported sticker sources', async () => {
  mockStickerData(); for (let i = 0; i < 150; i++) stickerImage(i).src = `https://example.invalid/sticker-${i}.webp`; stickerImage(151);
  const events: RemoteEvent[] = [], connector = new DomConnector(document, e => events.push(e));
  await connector['indexStickers'](); expect(events).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(1);
});
test('locating a hash finds its new loaded blob/data source after the old image disappears', async () => {
  mockStickerData(); const old = stickerImage(1), newer = stickerImage(2);
  const connector = new DomConnector(document, () => {}); await connector['indexStickers'](); old.remove();
  newer.scrollIntoView = vi.fn(); newer.animate = vi.fn(); newer.checkVisibility = () => true;
  newer.getBoundingClientRect = () => ({ width: 100 } as DOMRect);
  connector.command({ type: 'locateSticker', id: '0'.repeat(64), nonce: 'request-1' });
  expect(newer.scrollIntoView).toHaveBeenCalled();
});
test('missing or hidden stickers return a correlated result without opening a remote notice', async () => {
  mockStickerData(); const image = stickerImage(1);
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event));
  await connector['indexStickers'](); events.length = 0;
  image.checkVisibility = () => false;
  image.scrollIntoView = vi.fn(); image.click = vi.fn();
  connector.command({ type: 'locateSticker', id: '0'.repeat(64), nonce: 'hidden' });
  image.remove();
  connector.command({ type: 'locateSticker', id: '0'.repeat(64), nonce: 'missing' });
  expect(events).toEqual([{ type: 'stickerLocated', nonce: 'hidden', found: false }, { type: 'stickerLocated', nonce: 'missing', found: false }]);
  expect(image.scrollIntoView).not.toHaveBeenCalled(); expect(image.click).not.toHaveBeenCalled();
});

test('navigation uses closed shadows and synthetic page clicks cannot open privileged controls', async () => {
  const { Navigation } = await import('../src/connector/navigation');
  fixture(); const events: RemoteEvent[] = [], nav = new Navigation(document, e => events.push(e));
  try {
    expect(nav.host.shadowRoot).toBeNull(); expect(nav.chatHost.shadowRoot).toBeNull();
    nav['buttons'].settings.click(); nav['buttons'].chat.click(); nav['buttons'].stickers.click();
    const native = document.createElement('button'); native.setAttribute('data-navbar-item', 'true'); document.body.append(native);
    native.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(events).toEqual([]);
    const header = document.querySelector<HTMLElement>('#main header')!;
    header.style.backgroundColor = 'rgb(255, 255, 255)'; nav.refresh(true); expect(nav.theme).toBe('light');
    header.style.backgroundColor = 'rgb(22, 23, 23)'; nav.refresh(true); expect(nav.theme).toBe('dark');
  } finally { nav.stop(); }
});

test('group context retains each visible sender, including media without a tail and grouped text metadata', () => {
  vi.useFakeTimers(); modernFixture();
  document.querySelector('#main [data-id]')!.remove();
  document.querySelector('#main footer')!.insertAdjacentHTML('beforebegin', `
    <div data-id="PHOTO_MUM" data-testid="conv-msg-PHOTO_MUM"><div data-testid="msg-container"><span data-testid="author">Mum</span><div data-testid="image-thumb"></div></div></div>
    <div data-id="VIDEO_MUM" data-testid="conv-msg-VIDEO_MUM"><div data-testid="msg-container"><span data-testid="author">Mum</span><div data-testid="video-content"></div></div></div>
    <div data-id="BROTHER_1" data-testid="conv-msg-BROTHER_1"><div data-testid="msg-container"><span data-icon="tail-in"></span><span data-testid="author">Brother</span><div data-pre-plain-text="[16:45, 28/09/2026] Brother: "><span data-testid="selectable-text">Lovely photos</span></div></div></div>
    <div data-id="BROTHER_2" data-testid="conv-msg-BROTHER_2"><div data-testid="msg-container"><div data-pre-plain-text="[16:46, 28/09/2026] Brother: "><span data-testid="selectable-text">Enjoy the rest of your trip</span></div></div></div>`);
  const connector = new DomConnector(document, () => {}); connector.read(); vi.advanceTimersByTime(600);
  expect(connector.read()).toMatchObject({ kind: 'group', ready: true, messages: [
    { sender: 'Mum', outgoing: false, attachment: 'image', text: '' },
    { sender: 'Mum', outgoing: false, attachment: 'video', text: '' },
    { sender: 'Brother', outgoing: false, text: 'Lovely photos' },
    { sender: 'Brother', outgoing: null, text: 'Enjoy the rest of your trip' }
  ] });
});

test('quoted author, text, own-label and media never become the current message’s author, direction or body', () => {
  modernFixture();
  const node = document.querySelector<HTMLElement>('#main [data-id]')!;
  node.innerHTML = `<div data-testid="msg-container">
    <span data-testid="author">Brother</span>
    <div data-testid="quoted-message"><span data-testid="author">Mum</span><span aria-label="You:"></span><span data-icon="tail-out"></span><div data-testid="image-thumb"></div><span data-testid="selectable-text">Photos from my holiday</span></div>
    <span data-testid="selectable-text">Lovely photos</span>
  </div>`;
  expect(new DomConnector(document, () => {}).read().messages).toEqual([{
    id: 'ABC123456', text: 'Lovely photos', sender: 'Brother', outgoing: false,
    quoted: { sender: 'Mum', text: 'Photos from my holiday', attachment: 'image' }
  }]);
  node.querySelector('[data-testid="author"]')!.remove();
  expect(new DomConnector(document, () => {}).read().messages[0]).toMatchObject({ outgoing: null, text: 'Lovely photos' });
  expect(new DomConnector(document, () => {}).read().messages[0].sender).toBeUndefined();
});

test('confirmed outgoing messages stay owner-authored even when quoting another participant', () => {
  modernFixture(); const node = document.querySelector<HTMLElement>('#main [data-id]')!;
  node.innerHTML = '<span aria-label="You:"></span><div data-testid="quoted-message"><span data-testid="author">Mum</span><span data-icon="tail-in"></span><span data-testid="selectable-text">Lovely photos</span></div><div data-pre-plain-text="[16:50, 28/09/2026] Account owner: "><span data-testid="selectable-text">Thank you!</span></div>';
  expect(new DomConnector(document, () => {}).read().messages[0]).toMatchObject({ outgoing: true, sender: 'Account owner', text: 'Thank you!', quoted: { sender: 'Mum', text: 'Lovely photos' } });
});


test('a quoted-message suggestion survives main-process schema validation and displays in the composer', () => {
  vi.useFakeTimers(); const editor = modernFixture(); editor.textContent = '';
  const node = document.querySelector<HTMLElement>('#main [data-id]')!;
  node.innerHTML = '<span data-testid="author">Brother</span><div data-testid="quoted-message"><span data-testid="author">Mum</span><span data-testid="selectable-text">Some photos</span></div><span data-testid="selectable-text">Lovely photos</span>';
  const connector = new DomConnector(document, () => {}); connector.start();
  try {
    vi.advanceTimersByTime(600);
    const validated = snapshotSchema.parse(connector.read());
    connector.command({ type: 'suggestion', text: 'Thanks for sharing!', replace: false, key: suggestionKey(validated) });
    expect(connector['ghost'].textContent).toBe('Thanks for sharing!');
  } finally { connector.stop(); }
});

test('an empty composer requests immediately from the star, then refines the shown suggestion', async () => {
  vi.useFakeTimers(); const clicks = retryClicks(); const editor = fixture(); editor.textContent = '';
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event)); connector.start();
  try {
    await vi.advanceTimersByTimeAsync(600);
    expect(connector['button'].title).toBe('Suggest reply');
    connector['button'].click(); expect(events.some(e => e.type === 'request')).toBe(false);
    clicks.trigger(connector);
    expect(events.filter(e => e.type === 'request')).toEqual([{ type: 'request', instruction: undefined, key: suggestionKey(connector.read()) }]);
    expect(connector['popup'].hidden).toBe(true);
    connector.command({ type: 'suggestion', key: suggestionKey(connector.read()), id: '00000000-0000-4000-8000-000000000001', text: 'The visible suggestion', replace: false });
    expect(connector['button'].title).toBe('Refine suggestion'); clicks.trigger(connector);
    expect(connector['popup'].getAttribute('aria-label')).toBe('Refine suggestion');
    expect(connector['popup'].querySelectorAll('.action')).toHaveLength(10);
    expect(connector['ghost'].textContent).toBe('The visible suggestion');
    expect(editor.textContent).toBe('');
  } finally { connector.stop(); clicks.stop(); }
});
test('typing during pending refinement hides it and rejects a queued result', async () => {
  vi.useFakeTimers(); const editor = fixture();
  const connector = new DomConnector(document, () => {}); connector.start();
  try {
    await vi.advanceTimersByTimeAsync(600); const key = suggestionKey(connector.read());
    connector.command({ type: 'refining', origin: 'user', key, requestId: '00000000-0000-4000-8000-000000000003' }); expect(connector['ghost'].querySelector('.dots')).not.toBeNull();
    connector['beforeInput']({ isTrusted: true, target: editor } as unknown as Event);
    expect(connector['popup'].hidden).toBe(true); expect(connector['button'].getAttribute('aria-expanded')).toBe('false');
    connector.command({ type: 'suggestion', key, text: 'Stale result', replace: true });
    expect(connector['popup'].hidden).toBe(true); expect(editor.textContent).toBe('A draft');
  } finally { connector.stop(); }
});

test('reopening refinement of an empty-composer result keeps that text visible as a ghost', async () => {
  vi.useFakeTimers(); const editor = fixture(); editor.textContent = '';
  const connector = new DomConnector(document, () => {}); connector.start();
  try {
    await vi.advanceTimersByTimeAsync(600);
    connector.command({ type: 'suggestion', key: suggestionKey(connector.read()), id: '00000000-0000-4000-8000-000000000002', text: 'A revised reply', replace: true });
    expect(connector['popup'].hidden).toBe(true); expect(connector['ghost'].textContent).toBe('A revised reply');
    connector['openPopup']();
    expect(connector['popup'].getAttribute('aria-label')).toBe('Refine suggestion');
    connector['pointer']({ isTrusted: true, composedPath: () => [editor] } as unknown as Event);
    expect(connector['popup'].hidden).toBe(true); expect(connector['ghost'].textContent).toBe('A revised reply');
    expect(editor.textContent).toBe('');
  } finally { connector.stop(); }
});

test('refocusing during refinement preserves the request and shows the revised ghost inline', async () => {
  vi.useFakeTimers(); const editor = fixture(); editor.textContent = '';
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event)); connector.start();
  try {
    await vi.advanceTimersByTimeAsync(600); const key = suggestionKey(connector.read());
    connector.command({ type: 'refining', origin: 'user', key, requestId: '00000000-0000-4000-8000-000000000003' });
    connector['pointer']({ isTrusted: true, composedPath: () => [editor] } as unknown as Event);
    expect(events.some(event => event.type === 'dismiss')).toBe(false);
    connector.command({ type: 'suggestion', key, text: 'An updated suggestion', replace: true });
    expect(connector['popup'].hidden).toBe(true); expect(connector['ghost'].textContent).toBe('An updated suggestion');
    expect(editor.textContent).toBe('');
  } finally { connector.stop(); }
});
test('retry notices belong to their original context and disappear on successful recovery', async () => {
  vi.useFakeTimers(); fixture(); const connector = new DomConnector(document, () => {}); connector.start();
  try {
    await vi.advanceTimersByTimeAsync(600); const key = suggestionKey(connector.read());
    connector.command({ type: 'notice', text: 'Network unavailable', retryKey: 'stale' });
    expect(connector['popup'].hidden).toBe(true);
    connector.command({ type: 'notice', text: 'Network unavailable', retryKey: key });
    expect(connector['popup'].textContent).toContain('Try again');
    connector.command({ type: 'suggestion', key, text: ' recovered', replace: false });
    expect(connector['popup'].hidden).toBe(true); expect(connector['ghost'].textContent).toContain('recovered');
  } finally { connector.stop(); }
});

test.each(['typing', 'dismiss', 'incoming', 'caret', 'newer'])('a replacement waiting for native selection rejects %s changes', async change => {
  vi.useFakeTimers(); const editor = fixture();
  const connector = new DomConnector(document, () => {}); connector.start(); const insert = vi.fn(() => true); document.execCommand = insert;
  try {
    await vi.advanceTimersByTimeAsync(600); editor.focus(); const key = suggestionKey(connector.read());
    connector.command({ type: 'suggestion', key, text: 'Old revision', replace: true });
    if (change === 'typing') connector['beforeInput']({ isTrusted: true, target: editor } as unknown as Event);
    if (change === 'dismiss') connector['dismissPopup']();
    if (change === 'incoming') { document.querySelector('[data-id] .selectable-text')!.textContent = 'New message'; connector['refresh'](); }
    if (change === 'caret') connector['pointer']({ isTrusted: true, composedPath: () => [editor] } as unknown as Event);
    if (change === 'newer') connector.command({ type: 'suggestion', key, text: 'New revision', replace: true });
    await vi.advanceTimersByTimeAsync(50);
    if (change === 'newer') expect(insert).toHaveBeenCalledExactlyOnceWith('insertText', false, 'New revision');
    else expect(insert).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});

test.each(['typing', 'Backspace', 'ArrowLeft', 'composition', 'clear'])('temporary select-all restores the caret before %s can affect the original draft', async change => {
  vi.useFakeTimers(); const editor = fixture(); const connector = new DomConnector(document, () => {}); connector.start();
  const insert = vi.fn(() => true); document.execCommand = insert;
  try {
    await vi.advanceTimersByTimeAsync(600); editor.focus();
    const selection = document.getSelection()!, range = document.createRange();
    range.setStart(editor.firstChild!, 3); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
    connector.command({ type: 'suggestion', key: suggestionKey(connector.read()), text: 'Replacement', replace: true });
    expect(selection.toString()).toBe('A draft');
    if (change === 'typing') connector['beforeInput']({ isTrusted: true, target: editor } as unknown as Event);
    else if (change === 'composition') connector['compositionStart']({ target: editor } as unknown as Event);
    else if (change === 'clear') connector.command({ type: 'clear' });
    else connector['keydown']({ isTrusted: true, key: change, target: editor, composedPath: () => [editor] } as unknown as KeyboardEvent);
    expect(selection.isCollapsed).toBe(true); expect(selection.anchorNode).toBe(editor.firstChild); expect(selection.anchorOffset).toBe(3);
    await vi.advanceTimersByTimeAsync(50); expect(insert).not.toHaveBeenCalled(); expect(editor.textContent).toBe('A draft');
    expect(connector['suggestion']).toBeUndefined();
  } finally { connector.stop(); }
});

test('a pointer selection during replacement preserves both the draft and the new selection', async () => {
  vi.useFakeTimers(); const editor = fixture(); const connector = new DomConnector(document, () => {}); connector.start();
  const insert = vi.fn(() => true); document.execCommand = insert;
  try {
    await vi.advanceTimersByTimeAsync(600); editor.focus();
    connector.command({ type: 'suggestion', key: suggestionKey(connector.read()), text: 'Revised draft', replace: true });
    const selection = document.getSelection()!, range = document.createRange();
    range.setStart(editor.firstChild!, 0); range.setEnd(editor.firstChild!, 3); selection.removeAllRanges(); selection.addRange(range);
    connector['selectionChanged'](); await vi.advanceTimersByTimeAsync(50);
    expect(insert).not.toHaveBeenCalled(); expect(editor.textContent).toBe('A draft'); expect(selection.toString()).toBe('A d');
    expect(connector['suggestion']).toBeUndefined();
  } finally { connector.stop(); }
});

test.each(['return', 'edit', 'incoming'])('a revision arriving in another field preserves focus and handles %s', async action => {
  vi.useFakeTimers(); const editor = fixture();
  const search = document.createElement('input'); document.body.prepend(search);
  const connector = new DomConnector(document, () => {}); connector.start(); const insert = vi.fn(() => true); document.execCommand = insert;
  try {
    await vi.advanceTimersByTimeAsync(600); search.focus();
    connector.command({ type: 'suggestion', key: suggestionKey(connector.read()), text: 'Revised draft', replace: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(document.activeElement).toBe(search); expect(insert).not.toHaveBeenCalled(); expect(editor.textContent).toBe('A draft');
    if (action === 'edit') connector['beforeInput']({ isTrusted: true, target: editor } as unknown as Event);
    if (action === 'incoming') { document.querySelector('[data-id] .selectable-text')!.textContent = 'New message'; connector['refresh'](); }
    editor.focus(); connector['refresh'](); await vi.advanceTimersByTimeAsync(50);
    if (action === 'return') expect(insert).toHaveBeenCalledExactlyOnceWith('insertText', false, 'Revised draft');
    else expect(insert).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});


test.each(['newline', 'breaks', 'empty-mention'] as const)('normalized %s draft cannot be advertised as a provably empty composer', kind => {
  const editor = fixture(); editor.replaceChildren();
  if (kind === 'newline') editor.textContent = '\n';
  if (kind === 'breaks') editor.innerHTML = '<p><br></p><p><br></p>';
  if (kind === 'empty-mention') editor.innerHTML = '<span contenteditable="false"></span>';
  const connector = new DomConnector(document, () => {});
  const snapshot = connector.read();
  expect(snapshot.draft !== '' || snapshot.draftIssue !== null).toBe(true);
});

test('a native empty paragraph placeholder remains an empty composer', () => {
  const editor = fixture(); editor.innerHTML = '<p><br></p>';
  const connector = new DomConnector(document, () => {});
  expect(connector.read()).toMatchObject({ draft: '', draftIssue: null });
});

test.each(Object.entries(emptyComposers))('live empty composer %s selects maker through the validated snapshot', (_name, markup) => {
  vi.useFakeTimers(); const editor = modernFixture();
  editor.dataset.testid = 'conversation-compose-box-input'; editor.dataset.lexicalEditor = 'true'; editor.innerHTML = markup;
  // Frameworks can retain empty Text nodes alongside the paragraph.
  editor.prepend(document.createTextNode('')); editor.append(document.createTextNode(''));
  const connector = new DomConnector(document, () => {});
  connector.read(); vi.advanceTimersByTime(600);
  const snapshot = snapshotSchema.parse(connector.read());
  expect(composerProvablyEmpty(editor, false)).toBe(true);
  expect(readDraft(editor)).toBe('');
  expect(snapshot).toMatchObject({ conversationOpen: true, ready: true, draft: '', draftIssue: null, composing: false });
  expect(stickerRoute(snapshot, false)).toBe('maker');
  expect(stickerRoute(snapshot, true, true)).toBe('maker');
  expect(stickerRoute(snapshot, true)).toBe('picker');
  expect(composerProvablyEmpty(editor, true)).toBe(false);
});

test.each([
  '<p><span data-lexical-text="true">\u200bDraft\ufeff</span><br></p>',
  '<p> </p>', '<p>\n</p>', '<p>\u00a0</p>', '<p>\u200c</p>',
  '<p><br><br></p>', '<p><br></p><p><br></p>',
  '<div><span><p></p></span><span><p></p></span></div>', '<p></p><span><br></span>',
  '<p><span data-lexical-text="true" contenteditable="false">Real text</span></p>',
  '<span data-lexical-placeholder="true">Real editable text</span>',
  '<span contenteditable="false" data-mention="true"></span>',
  '<span data-lexical-placeholder="true" contenteditable="false"><img></span>',
  '<span data-placeholder="true" contenteditable="false" data-mention="true"></span>',
  '<img alt="">', '<svg></svg>', '<embed>', '<span data-plain-text="🙂"></span>'
])('user content or uncertain markup selects picker: %s', markup => {
  vi.useFakeTimers(); const editor = fixture(); editor.innerHTML = markup;
  const connector = new DomConnector(document, () => {});
  connector.read(); vi.advanceTimersByTime(600);
  const snapshot = snapshotSchema.parse(connector.read());
  expect(composerProvablyEmpty(editor, false)).toBe(false);
  expect(snapshot.draft !== '' || snapshot.draftIssue !== null).toBe(true);
  expect(stickerRoute(snapshot, false)).toBe('picker');
});

test.each([
  'Temporarily banned', 'Your account is restricted', 'We detected unusual activity',
  'Banned from using WhatsApp', 'Tu cuenta suspendida', 'Tu cuenta está restringida',
  'Sua conta banida', 'Sua conta restrita',
  'Your account was suspended.', 'Your account has been banned.',
  'Your account is temporarily blocked.', 'YOUR ACCOUNT IS RESTRICTED.',
  'Tu cuenta está suspendida.', 'Tu cuenta fue baneada.',
  'Tu cuenta ha sido suspendida.', 'Tu cuenta ha sido restringida.',
  'Tu cuenta ha sido bloqueada.', 'TU CUENTA ESTÁ RESTRINGIDA.',
  'Sua conta está restrita.', 'Sua conta foi banida.',
  'Sua conta está suspensa.', 'Sua conta foi temporariamente bloqueada.',
  'SUA CONTA ESTÁ RESTRITA.'
])('visible account notices report only a structural reason (%s)', async text => {
  vi.useFakeTimers(); fixture();
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event));
  connector.start();
  try {
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = `<span>${text}</span><span>PRIVATE-ACCOUNT-DETAILS</span>`;
    dialog.getBoundingClientRect = () => ({ width: 200, height: 80 } as DOMRect);
    document.body.append(dialog); await vi.advanceTimersByTimeAsync(350);
    const safety = events.filter(e => e.type === 'accountSafety');
    expect(safety).toEqual([{ type: 'accountSafety', reason: null }, { type: 'accountSafety', reason: 'account-warning' }]);
    expect(JSON.stringify(safety)).not.toContain('PRIVATE-ACCOUNT-DETAILS');
    dialog.remove(); await vi.advanceTimersByTimeAsync(350);
    expect(events.at(-1)?.type === 'accountSafety' ? events.at(-1) : events.filter(e => e.type === 'accountSafety').at(-1)).toEqual({ type: 'accountSafety', reason: null });
  } finally { connector.stop(); }
});

test.each([
  'Your account has been banned.', 'Tu cuenta ha sido suspendida.', 'Sua conta foi temporariamente bloqueada.'
])('account warning sentences require visible account UI, not chat text (%s)', text => {
  fixture();
  const message = document.querySelector('[data-id]')!;
  message.innerHTML = `<span class="selectable-text copyable-text">${text}</span><div role="alert">${text}</div>`;
  const chatAlert = message.querySelector<HTMLElement>('[role="alert"]')!;
  chatAlert.getBoundingClientRect = () => ({ width: 200, height: 80 } as DOMRect);
  expect(accountSafetyReason(document)).toBeNull();
  const banner = document.createElement('div'); banner.setAttribute('role', 'banner');
  banner.getBoundingClientRect = chatAlert.getBoundingClientRect;
  document.body.append(banner); banner.append(message);
  expect(accountSafetyReason(document)).toBeNull();
  const notice = document.createElement('span'); notice.textContent = text; banner.append(notice);
  expect(accountSafetyReason(document)).toBe('account-warning');
  notice.style.display = 'none';
  expect(accountSafetyReason(document)).toBeNull();
  notice.style.display = ''; banner.style.visibility = 'hidden';
  expect(accountSafetyReason(document)).toBeNull();
});

test.each(['qrcode', 'link-device', 'logged-out'])('visible %s screen emits a logout signal without QR data', async testid => {
  vi.useFakeTimers(); fixture(); const events: RemoteEvent[] = [];
  const connector = new DomConnector(document, event => events.push(event)); connector.start();
  try {
    const screen = document.createElement('div'); screen.dataset.testid = testid;
    screen.dataset.ref = 'PRIVATE-QR-DATA'; screen.append(document.createElement('canvas'));
    screen.getBoundingClientRect = () => ({ width: 200, height: 200 } as DOMRect);
    document.body.append(screen); await vi.advanceTimersByTimeAsync(350);
    expect(events.filter(e => e.type === 'accountSafety')).toEqual([{ type: 'accountSafety', reason: null }, { type: 'accountSafety', reason: 'logged-out' }]);
    screen.style.display = 'none'; await vi.advanceTimersByTimeAsync(350);
    expect(events.filter(e => e.type === 'accountSafety').at(-1)).toEqual({ type: 'accountSafety', reason: null });
  } finally { connector.stop(); }
});

test('chat text, composer text, hidden notices and ordinary dialogs do not report account warnings', async () => {
  vi.useFakeTimers(); const editor = fixture(); editor.textContent = 'temporarily banned';
  document.querySelector('[data-id]')!.innerHTML = '<div role="alert">Account is restricted</div>';
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event));
  const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = '<span style="display:none">banned from using WhatsApp</span><span>Log out?</span>';
  dialog.getBoundingClientRect = () => ({ width: 200, height: 80 } as DOMRect); document.body.append(dialog);
  const qr = document.createElement('div'); qr.dataset.testid = 'qrcode'; qr.style.display = 'none';
  qr.getBoundingClientRect = dialog.getBoundingClientRect; document.body.append(qr);
  connector.start();
  try {
    await vi.advanceTimersByTimeAsync(700);
    expect(events.filter(e => e.type === 'accountSafety')).toEqual([{ type: 'accountSafety', reason: null }]);
    dialog.innerHTML = 'temporarily banned'; dialog.style.visibility = 'hidden';
    await vi.advanceTimersByTimeAsync(350);
    expect(events.filter(e => e.type === 'accountSafety')).toHaveLength(1);
  } finally { connector.stop(); }
});

test('main snapshot refresh reads the current composer and returns the requested nonce', () => {
  vi.useFakeTimers(); const editor = fixture(), events: RemoteEvent[] = [];
  const connector = new DomConnector(document, event => events.push(event)); connector.start();
  try {
    vi.advanceTimersByTime(600); editor.textContent = 'Fresh draft';
    connector['dismissedKey'] = suggestionKey(connector.read());
    connector.command({ type: 'snapshot', nonce: 'main-refresh' });
    expect(events.at(-1)).toMatchObject({ type: 'snapshot', nonce: 'main-refresh', snapshot: { draft: 'Fresh draft', ready: true } });
    expect(connector['dismissedKey']).toBeUndefined();
  } finally { connector.stop(); }
});

test.each([false, true])('accepting/replacing acknowledges only after insertion, before edit activity (replace=%s)', async replace => {
  vi.useFakeTimers(); const editor = fixture(), events: RemoteEvent[] = [];
  editor.textContent = replace ? 'Original' : ''; editor.tabIndex = 0;
  let insertionReturned = false;
  const connector = new DomConnector(document, event => {
    if (event.type === 'applied') { expect(insertionReturned).toBe(true); expect(editor.textContent).toBe('Result'); }
    events.push(event);
  }); connector.start();
  const insert = vi.fn(() => { editor.textContent = 'Result'; insertionReturned = true; return true; }); document.execCommand = insert;
  try {
    vi.advanceTimersByTime(600); editor.focus();
    const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    const key = suggestionKey(connector.read()); events.length = 0;
    connector.command({ type: 'suggestion', key, text: 'Result', replace, id: 'main-owned-id' });
    if (replace) await vi.advanceTimersByTimeAsync(50); else connector['acceptSuggestion']();
    const applied = events.findIndex(e => e.type === 'applied');
    expect(events[applied]).toEqual({ type: 'applied', key, suggestionId: 'main-owned-id' });
    expect(events[applied + 1]).toEqual({ type: 'activity', editing: true }); expect(insert).toHaveBeenCalledOnce();
  } finally { connector.stop(); }
});

describe.each(['returns false', 'throws'])('native insertion %s', outcome => {
  test.each([false, true])('failed native insertion reports its main-owned application and keeps Try again visible (replace=%s)', async replace => {
    vi.useFakeTimers(); const editor = fixture(), events: RemoteEvent[] = [];
    editor.textContent = replace ? 'Original' : ''; editor.tabIndex = 0;
    const connector = new DomConnector(document, event => events.push(event)); connector.start();
    document.execCommand = vi.fn(() => { if (outcome === 'throws') throw new Error('Native editor unavailable'); return false; });
    try {
      vi.advanceTimersByTime(600); editor.focus();
      const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
      document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
      const key = suggestionKey(connector.read()); events.length = 0;
      connector.command({ type: 'suggestion', key, text: 'Result', replace, id: 'main-owned-id' });
      if (replace) await vi.advanceTimersByTimeAsync(50); else connector['acceptSuggestion']();
      expect(events.filter(e => e.type === 'applied')).toEqual([
        { type: 'applied', key, suggestionId: 'main-owned-id', success: false }
      ]);
      expect(editor.textContent).toBe(replace ? 'Original' : '');
      expect(events.at(-1)).toMatchObject({ type: 'snapshot' });
      const currentKey = suggestionKey(connector.read()); expect(currentKey).toBe(key);
      connector.command({ type: 'notice', text: 'Could not insert the suggestion. Try again.', retryKey: currentKey });
      const popup = connector['popup'];
      expect(popup.textContent).toContain('Try again');
      expect([...popup.querySelectorAll('button')].some(button => button.textContent === 'Try again')).toBe(true);
      await vi.advanceTimersByTimeAsync(350);
      expect(document.execCommand).toHaveBeenCalledOnce();
      expect(events.filter(e => e.type === 'applied')).toHaveLength(1);
      expect(popup.hidden).toBe(false);
      const selection = document.getSelection()!;
      expect(selection.isCollapsed).toBe(true); expect(caretAtEnd(editor)).toBe(true);
      connector['beforeInput']({ isTrusted: true, target: editor } as unknown as Event);
      const typing = selection.getRangeAt(0); typing.insertNode(document.createTextNode('!'));
      expect(editor.textContent).toBe(replace ? 'Original!' : '!');
    } finally { connector.stop(); }
  });
});

test.each(['Tab', 'accept', 'queued offer'])('exact draft key rejects a cached suffix after trailing whitespace via %s', action => {
  vi.useFakeTimers(); const editor = fixture(); editor.textContent = 'Thank'; editor.tabIndex = 0;
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event)); connector.start();
  const insert = vi.fn(() => true); document.execCommand = insert;
  try {
    vi.advanceTimersByTime(600); editor.focus();
    const command = { type: 'suggestion' as const, key: suggestionKey(connector.read()), text: 's!', replace: false, id: 'cached-suffix' };
    if (action !== 'queued offer') connector.command(command);
    editor.textContent = 'Thank ';
    const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    if (action === 'Tab') connector['keydown']({ isTrusted: true, key: 'Tab', target: editor, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() } as unknown as KeyboardEvent);
    if (action === 'accept') connector['acceptSuggestion']();
    if (action === 'queued offer') connector.command(command);
    expect(insert).not.toHaveBeenCalled(); expect(events.some(e => e.type === 'applied')).toBe(false);
    expect(editor.textContent).toBe('Thank ');
  } finally { connector.stop(); }
});


// Capture the listener installed on the actual emitted button, then supply the
// trusted click shape used by the desktop fixture; jsdom clicks are untrusted.
function retryClicks() {
  const listeners = new Map<EventTarget, EventListener>();
  const add = HTMLButtonElement.prototype.addEventListener;
  const spy = vi.spyOn(HTMLButtonElement.prototype, 'addEventListener').mockImplementation(function (this: HTMLButtonElement, type, listener, options) {
    if (type === 'click' && typeof listener === 'function') listeners.set(this, listener as EventListener);
    return add.call(this, type, listener, options);
  });
  return {
    click(connector: DomConnector, label = 'Try again') {
      const button = [...connector['popup'].querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label);
      expect(connector['popup'].hidden).toBe(false); expect(button).toBeDefined();
      const listener = listeners.get(button!)!; expect(listener).toBeDefined();
      listener.call(button!, { isTrusted: true } as Event);
    },
    trigger(connector: DomConnector) {
      const button = connector['button'], listener = listeners.get(button)!;
      expect(listener).toBeDefined(); listener.call(button, { isTrusted: true } as Event);
    },
    stop: () => spy.mockRestore()
  };
}
function integratedAssistant(generator: typeof generate, identify?: (snapshot: Snapshot) => string) {
  const editor = fixture(); editor.tabIndex = 0;
  const state = initialState(); state.global.suggestions = true; state.global.shareContext = true;
  const store = { state, update: (change: (state: State) => void) => change(state) } as Store;
  const events: RemoteEvent[] = [];
  let assistant!: Assistant;
  const connector = new DomConnector(document, event => {
    events.push(event);
    if (event.type === 'snapshot') assistant.receive(identify ? { ...event.snapshot, settingsId: identify(event.snapshot) } : event.snapshot, false, event.nonce);
    if (event.type === 'activity') assistant.activity(event.editing);
    if (event.type === 'applied') assistant.applied(event);
    if (event.type === 'request') void assistant.request(event.instruction, false, event);
    if (event.type === 'dismiss') assistant.dismiss(event);
    if (event.type === 'displayAck') assistant.displayAck(event);
  });
  assistant = new Assistant(store, { get: () => 'synthetic' } as unknown as Vault, { send: c => connector.command(c), focus() {} }, () => {}, false, generator);
  connector.start();
  return { editor, state, assistant, connector, events, stop() { assistant.cancel(true); connector.stop(); } };
}
function focusEnd(editor: HTMLElement) {
  editor.focus(); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
}

test.each(['continuation', 'refine', 'translate'] as const)('compatible history republishes the actual %s Try again control (C2/D2)', async operation => {
  vi.useFakeTimers(); const clicks = retryClicks();
  const generator = vi.fn<typeof generate>().mockRejectedValueOnce(new ProviderError('Rejected')).mockResolvedValue(' Recovered');
  const app = integratedAssistant(generator);
  document.execCommand = vi.fn(() => true);
  try {
    await vi.advanceTimersByTimeAsync(600); focusEnd(app.editor); app.connector['refresh']();
    if (operation === 'continuation') await vi.advanceTimersByTimeAsync(1000);
    else await app.assistant.request('Original instruction', false, operation === 'translate' ? { operation } : undefined);
    expect(app.connector['popup'].hidden).toBe(false);
    const old = suggestionKey(app.connector.read());
    document.querySelector('#main [data-id]')!.insertAdjacentHTML('beforebegin', '<div data-id="false_123@c.us_older"><span class="selectable-text copyable-text">Older history</span></div>');
    app.connector['refresh'](); expect(suggestionKey(app.connector.read())).not.toBe(old);
    expect(app.connector['popup'].textContent).toContain('Rejected'); clicks.click(app.connector);
    await vi.advanceTimersByTimeAsync(operation === 'continuation' ? 0 : 50);
    expect(generator).toHaveBeenCalledTimes(2);
    expect(generator.mock.calls[1][0].reason).toBe('retry');
    expect(generator.mock.calls[1][0].system).toBe(generator.mock.calls[0][0].system);
    expect(app.connector['popup'].hidden).toBe(true);
    expect(app.events.filter(e => e.type === 'request').at(-1)).toMatchObject({ operation: 'retry', key: suggestionKey(app.assistant.snapshot) });
  } finally { app.stop(); clicks.stop(); }
});

test.each(['Try again', 'backoff'])('activity then whitespace snapshot keeps usable continuation %s (C3)', async recovery => {
  vi.useFakeTimers(); const clicks = retryClicks();
  const generator = vi.fn<typeof generate>().mockRejectedValueOnce(new ProviderError('Interrupted', recovery === 'backoff')).mockResolvedValue('for coming');
  const app = integratedAssistant(generator);
  try {
    app.editor.textContent = 'Thanks'; await vi.advanceTimersByTimeAsync(600); focusEnd(app.editor); app.connector['refresh']();
    await vi.advanceTimersByTimeAsync(1000);
    app.connector['beforeInput']({ isTrusted: true, target: app.editor } as unknown as Event);
    expect(app.connector['ghost'].textContent).toBe(''); expect(app.connector['popup'].hidden).toBe(true);
    app.editor.textContent = 'Thanks '; focusEnd(app.editor); app.connector['refresh']();
    if (recovery === 'Try again') clicks.click(app.connector);
    await vi.advanceTimersByTimeAsync(recovery === 'backoff' ? 2000 : 0);
    expect(generator).toHaveBeenCalledTimes(2); expect(JSON.parse(generator.mock.calls[1][0].input).draft).toBe('Thanks ');
    expect(app.connector['ghost'].textContent).toBe('Thanks for coming'); expect(app.connector['popup'].hidden).toBe(true);
  } finally { app.stop(); clicks.stop(); }
});

test.each(['settings', 'cancel', 'dismiss', 'incompatible draft'] as const)('%s removes request-bound notices with their live replay (D3)', async action => {
  vi.useFakeTimers(); const generator = vi.fn<typeof generate>().mockRejectedValue(new ProviderError('Rejected'));
  const app = integratedAssistant(generator);
  try {
    await vi.advanceTimersByTimeAsync(600); focusEnd(app.editor); app.connector['refresh'](); await vi.advanceTimersByTimeAsync(1000);
    expect(app.connector['popup'].hidden).toBe(false); expect(app.connector['popup'].textContent).toContain('Try again');
    if (action === 'settings') { app.state.global.tone = 'friendly'; app.assistant.reconfigure(); }
    else if (action === 'cancel') app.assistant.cancel();
    else if (action === 'dismiss') app.connector['dismissPopup']();
    else { app.editor.textContent = 'Different'; focusEnd(app.editor); app.connector['refresh'](); }
    expect(app.connector['popup'].hidden).toBe(true);
    if (action !== 'incompatible draft') { await vi.advanceTimersByTimeAsync(3000); expect(generator).toHaveBeenCalledOnce(); }
  } finally { app.stop(); }
});

test('a compatible history key republishes the live offer without another request', async () => {
  vi.useFakeTimers(); const generator = vi.fn<typeof generate>().mockResolvedValue(' suffix');
  const app = integratedAssistant(generator);
  try {
    await vi.advanceTimersByTimeAsync(600); focusEnd(app.editor); app.connector['refresh'](); await vi.advanceTimersByTimeAsync(1000);
    document.querySelector('#main [data-id]')!.insertAdjacentHTML('beforebegin', '<div data-id="false_123@c.us_older"><span class="selectable-text copyable-text">History</span></div>');
    app.connector['refresh'](); expect(app.connector['ghost'].textContent).toBe('A draft suffix');
    expect(app.connector['suggestion']?.key).toBe(suggestionKey(app.connector.read())); expect(generator).toHaveBeenCalledOnce();
  } finally { app.stop(); }
});

test('failed replacement stops across polling, restores the caret and the actual Try again replays it (D1)', async () => {
  vi.useFakeTimers(); const clicks = retryClicks();
  const generator = vi.fn<typeof generate>().mockResolvedValue('Revised');
  const app = integratedAssistant(generator); app.state.global.suggestions = false;
  const insert = vi.fn(() => false); document.execCommand = insert;
  try {
    await vi.advanceTimersByTimeAsync(600); focusEnd(app.editor); app.connector['refresh']();
    await app.assistant.request('Make shorter'); await vi.advanceTimersByTimeAsync(400);
    expect(insert).toHaveBeenCalledOnce(); expect(app.connector['popup'].hidden).toBe(false);
    expect(document.getSelection()!.isCollapsed).toBe(true); expect(caretAtEnd(app.editor)).toBe(true);
    insert.mockImplementation(() => { app.editor.textContent = 'Revised'; return true; });
    clicks.click(app.connector); await vi.advanceTimersByTimeAsync(50);
    expect(generator).toHaveBeenCalledTimes(2); expect(insert).toHaveBeenCalledTimes(2);
    expect(app.editor.textContent).toBe('Revised'); expect(app.connector['popup'].hidden).toBe(true);
  } finally { app.stop(); clicks.stop(); }
});


test.each(['caret', 'selection'])('failed replacement restores the original %s for the next native edit', async mode => {
  vi.useFakeTimers(); const editor = fixture(); editor.textContent = 'Original'; editor.tabIndex = 0;
  const connector = new DomConnector(document, () => {}); connector.start();
  const insert = vi.fn(() => false); document.execCommand = insert;
  try {
    await vi.advanceTimersByTimeAsync(600); editor.focus();
    const original = document.createRange(); original.setStart(editor.firstChild!, 2); original.setEnd(editor.firstChild!, mode === 'caret' ? 2 : 5);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(original);
    connector.command({ type: 'suggestion', key: suggestionKey(connector.read()), text: 'Revised', replace: true, id: 'replacement' });
    await vi.advanceTimersByTimeAsync(400);
    expect(insert).toHaveBeenCalledOnce(); expect(selection.anchorOffset).toBe(2);
    expect(selection.toString()).toBe(mode === 'caret' ? '' : 'igi');
    connector['beforeInput']({ isTrusted: true, target: editor } as unknown as Event);
    const typing = selection.getRangeAt(0); typing.deleteContents(); typing.insertNode(document.createTextNode('!'));
    expect(editor.textContent).toBe(mode === 'caret' ? 'Or!iginal' : 'Or!nal');
  } finally { connector.stop(); }
});


test('the reported Spanish sequence with opaque consecutive bubbles displays the final reply and revisits reuse it', async () => {
  vi.useFakeTimers(); const generator = vi.fn<typeof generate>().mockResolvedValue('Un precio tremendo 😂');
  const app = integratedAssistant(generator, () => 'persisted-chat');
  try {
    const main = document.querySelector<HTMLElement>('#main')!;
    main.getBoundingClientRect = () => ({ left: 0, right: 800, width: 800, height: 600 } as DOMRect);
    main.querySelector('header')!.innerHTML = '<span data-testid="conversation-info-header-chat-title">A friend</span>';
    const selected = document.createElement('div'); selected.id = 'pane-side'; selected.innerHTML = '<div aria-selected="true">A friend</div>'; document.body.prepend(selected);
    main.querySelector('[data-id]')!.remove(); app.editor.textContent = '';
    const sequence: [string, boolean][] = [
      ['Perfecto', true], ['VOy a decirle...', true], ['Eso al Jippitty 😂', false], ['jajaj que se gane el sueldo', true],
      ['200 😳', false], ['Caro el asistente pero menos que uno orgánico', true],
      ['Que se haga un mameluco o presta el 🍑 al menos 😂', false], ['🫢', false], ['Por ese precio', false]
    ];
    for (const [index, [text, outgoing]] of sequence.entries()) {
      const id = `OPAQUE_${index}`, row = document.createElement('div'); row.dataset.id = id; row.dataset.testid = `conv-msg-${id}`;
      const bubble = document.createElement('div'); bubble.dataset.testid = 'msg-container';
      if (index === 0 || sequence[index - 1][1] !== outgoing) bubble.innerHTML = `<span data-icon="tail-${outgoing ? 'out' : 'in'}"></span>`;
      if (text === '🫢') bubble.insertAdjacentHTML('beforeend', '<img alt="🫢">');
      else { const body = document.createElement('span'); body.dataset.testid = 'msg-text'; body.textContent = text; bubble.append(body); }
      bubble.getBoundingClientRect = () => ({ left: outgoing ? 510 : 70, right: outgoing ? 730 : 290, width: 220, height: 40 } as DOMRect);
      row.append(bubble); main.insertBefore(row, main.querySelector('footer')); app.connector['refresh']();
      await vi.advanceTimersByTimeAsync(1600);
    }
    const last = app.connector.read().messages.at(-1)!;
    expect(last).toMatchObject({ text: 'Por ese precio', outgoing: false, directionFallback: true });
    expect(app.connector.read().messages.at(-2)!.text).toBe('🫢');
    expect(app.connector['ghost'].textContent).toBe('Un precio tremendo 😂');
    expect(JSON.parse(generator.mock.calls.at(-1)![0].input).context.at(-1).text).toBe('Por ese precio');
    expect(generator).toHaveBeenCalledTimes(5);
    // The test boundary resolves the same persistent identity on revisits.
    const snapshot = app.connector.read(), requests = generator.mock.calls.length;
    app.assistant.receive({ ...snapshot, name: 'Other chat', settingsId: 'other-chat', messages: [] });
    app.assistant.receive({ ...snapshot, settingsId: 'persisted-chat' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(app.connector['ghost'].textContent).toBe('Un precio tremendo 😂'); expect(generator).toHaveBeenCalledTimes(requests);
    expect(app.events.some(e => e.type === 'displayAck' && e.reason === 'displayed')).toBe(true);
  } finally { app.stop(); }
});

test('a transient tail/key rejection recovers a cached suggestion without another provider request', async () => {
  vi.useFakeTimers(); let finish!: (text: string) => void;
  const generator = vi.fn<typeof generate>().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const app = integratedAssistant(generator);
  try {
    modernFixture(); app.editor = document.querySelector<HTMLElement>('[role="textbox"]')!;
    app.editor.textContent = ''; const row = document.querySelector<HTMLElement>('[data-id]')!;
    row.insertAdjacentHTML('beforeend', '<span data-icon="tail-in"></span>'); app.connector['refresh']();
    await vi.advanceTimersByTimeAsync(2000);
    // Reproduce completion ahead of the normal observer/poll refresh.
    app.connector['observer']!.disconnect();
    const tail = row.querySelector('[data-icon="tail-in"]')!; tail.remove(); finish('Recovered ghost');
    await Promise.resolve(); // completion sees the temporary key before polling
    row.append(tail); await vi.advanceTimersByTimeAsync(400);
    expect(app.events.some(e => e.type === 'displayAck' && e.reason === 'key')).toBe(true);
    expect(app.connector['ghost'].textContent).toBe('Recovered ghost'); expect(generator).toHaveBeenCalledOnce();
  } finally { app.stop(); }
});

test('dismissal after a new bubble mounts carries the old visible offer, leaving the new suggestion eligible', async () => {
  vi.useFakeTimers(); const generator = vi.fn<typeof generate>().mockResolvedValue('Reply'); const app = integratedAssistant(generator);
  try {
    app.editor.textContent = ''; app.connector['refresh'](); await vi.advanceTimersByTimeAsync(2000);
    const old = app.connector['suggestion']!;
    const incoming = document.createElement('div'); incoming.dataset.id = 'false_123@c.us_new'; incoming.innerHTML = '<span data-testid="msg-text">New question</span>';
    document.querySelector('#main')!.insertBefore(incoming, document.querySelector('footer'));
    app.connector['dismissPopup'](); app.connector['refresh'](); await vi.advanceTimersByTimeAsync(1000);
    expect(app.events.filter(e => e.type === 'dismiss').at(-1)).toMatchObject({ suggestionId: old.id, key: old.key });
    expect(app.connector['ghost'].textContent).toBe('Reply'); expect(generator).toHaveBeenCalledTimes(2);
  } finally { app.stop(); }
});


test.each(['Escape', 'trigger'] as const)('dismissing a pending empty-composer refinement via %s cancels its request and suppresses replay', async source => {
  vi.useFakeTimers(); const clicks = retryClicks(); let finish!: (text: string) => void;
  const generator = vi.fn<typeof generate>().mockResolvedValueOnce('Original reply')
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const app = integratedAssistant(generator);
  try {
    app.editor.textContent = ''; app.connector['refresh'](); await vi.advanceTimersByTimeAsync(2000);
    const original = app.connector['suggestion']!, context = app.assistant['emptyKey']();
    const work = app.assistant.request('Warmer', false, { suggestionId: original.id, key: original.key });
    expect(app.connector['suggestion']).toBeUndefined();
    expect(app.connector['popup'].hidden).toBe(true); expect(app.connector['loadingStatus'].textContent).toBe('Refining');
    const requestId = app.connector['pending']!.requestId;
    if (source === 'Escape') app.connector['keydown']({ isTrusted: true, key: 'Escape', target: app.editor,
      composedPath: () => [app.editor], preventDefault() {}, stopImmediatePropagation() {} } as unknown as KeyboardEvent);
    else {
      app.connector['button'].dispatchEvent(new Event('click')); // untrusted events must leave work live
      expect(generator.mock.calls[1][0].signal?.aborted).toBe(false);
      clicks.trigger(app.connector);
    }
    expect(app.events.filter(e => e.type === 'dismiss').at(-1)).toEqual({ type: 'dismiss', requestId });
    expect(generator.mock.calls[1][0].signal?.aborted).toBe(true);
    expect(app.assistant['live']).toBeUndefined(); expect(app.assistant['cache'].get(context!)).toEqual({ dismissed: true });
    expect(app.connector['popup'].hidden).toBe(true);
    finish('Late revision'); await work;
    // A result queued before main received the dismissal must also stay hidden.
    app.connector.command({ type: 'suggestion', id: '00000000-0000-4000-8000-000000000004', requestId,
      key: original.key, text: 'Queued revision', replace: true });
    app.assistant.refresh(); await vi.advanceTimersByTimeAsync(3000);
    expect(app.connector['ghost'].textContent).toBe(''); expect(generator).toHaveBeenCalledTimes(2);
  } finally { app.stop(); clicks.stop(); }
});

test('Escape during automatic suggestion dots cancels the request and suppresses a revisit', async () => {
  vi.useFakeTimers(); let finish!: (text: string) => void;
  const generator = vi.fn<typeof generate>().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const app = integratedAssistant(generator);
  try {
    app.editor.textContent = ''; app.connector['refresh'](); await vi.advanceTimersByTimeAsync(2000);
    // Automatic dots are visual only; screen readers hear only requests the user made.
    expect(app.connector['popup'].hidden).toBe(true); expect(app.connector['loadingStatus'].textContent).toBe('');
    const requestId = app.connector['pending']!.requestId, context = app.assistant['emptyKey']();
    app.connector['keydown']({ isTrusted: true, key: 'Escape', target: app.editor, composedPath: () => [app.editor],
      preventDefault() {}, stopImmediatePropagation() {} } as unknown as KeyboardEvent);
    expect(app.events.filter(e => e.type === 'dismiss').at(-1)).toEqual({ type: 'dismiss', requestId });
    expect(generator.mock.calls[0][0].signal?.aborted).toBe(true); expect(app.assistant['inFlight'].size).toBe(0);
    expect(app.assistant['cache'].get(context!)).toEqual({ dismissed: true });
    finish('Late reply'); await vi.advanceTimersByTimeAsync(0);
    app.assistant.refresh(); await vi.advanceTimersByTimeAsync(3000);
    expect(app.connector['ghost'].textContent).toBe(''); expect(generator).toHaveBeenCalledOnce();
  } finally { app.stop(); }
});

test('closing a refinement failure notice dismisses its request even when an older ghost is restored', async () => {
  vi.useFakeTimers(); const clicks = retryClicks();
  const generator = vi.fn<typeof generate>().mockResolvedValueOnce('Original reply').mockRejectedValueOnce(new ProviderError('Rejected'));
  const app = integratedAssistant(generator);
  try {
    app.editor.textContent = ''; app.connector['refresh'](); await vi.advanceTimersByTimeAsync(2000);
    const original = app.connector['suggestion']!, context = app.assistant['emptyKey']();
    await app.assistant.request('Warmer', false, { suggestionId: original.id, key: original.key });
    expect(app.connector['ghost'].textContent).toBe('Original reply');
    expect(app.connector['popup'].textContent).toContain('Rejected');
    const requestId = app.connector['popupRequest']!.id;
    clicks.click(app.connector, 'Close reply assistance');
    expect(app.events.filter(e => e.type === 'dismiss').at(-1)).toEqual({ type: 'dismiss', requestId });
    expect(app.assistant['live']).toBeUndefined(); expect(app.assistant['cache'].get(context!)).toEqual({ dismissed: true });
    app.assistant.refresh(); await vi.advanceTimersByTimeAsync(3000);
    expect(app.connector['ghost'].textContent).toBe(''); expect(app.connector['popup'].hidden).toBe(true);
    expect(generator).toHaveBeenCalledTimes(2);
  } finally { app.stop(); clicks.stop(); }
});

test('an old-key Escape cancels the same rekeyed offer and rejects its queued display after snapshot recovery', async () => {
  vi.useFakeTimers(); const generator = vi.fn<typeof generate>().mockResolvedValue('Reply'); const app = integratedAssistant(generator);
  try {
    app.editor.textContent = ''; app.connector['refresh'](); await vi.advanceTimersByTimeAsync(2000);
    const original = app.connector['suggestion']!, context = app.assistant['emptyKey']();
    app.connector['observer']!.disconnect(); clearInterval(app.connector['timer']);
    const queued: RemoteCommand[] = [], deliver = app.connector.command.bind(app.connector);
    const spy = vi.spyOn(app.connector, 'command').mockImplementation(command => {
      if (command.type === 'suggestion') queued.push(command); else deliver(command);
    });
    document.querySelector('#main [data-id]')!.insertAdjacentHTML('beforebegin', '<div data-id="false_123@c.us_older"><span data-testid="msg-text">History</span></div>');
    app.assistant.receive(app.connector.read());
    expect(queued.at(-1)).toMatchObject({ id: original.id });
    expect(app.assistant['live']!.offer!.key).not.toBe(original.key);
    app.connector['keydown']({ isTrusted: true, key: 'Escape', target: app.editor, composedPath: () => [app.editor],
      preventDefault() {}, stopImmediatePropagation() {} } as unknown as KeyboardEvent);
    expect(app.assistant['live']).toBeUndefined(); expect(app.assistant['cache'].get(context!)).toEqual({ dismissed: true });
    app.connector.command({ type: 'snapshot', nonce: 'test-recovery' });
    for (const command of queued) deliver(command);
    expect(app.connector['ghost'].textContent).toBe('');
    expect(app.events.some(e => e.type === 'displayAck' && e.suggestionId === original.id && e.reason === 'dismissed')).toBe(true);
    spy.mockRestore(); app.assistant.refresh(); await vi.advanceTimersByTimeAsync(3000);
    expect(generator).toHaveBeenCalledOnce(); expect(app.connector['ghost'].textContent).toBe('');
  } finally { app.stop(); }
});

test('closing the refinement popup dismisses the ghost offer', async () => {
  vi.useFakeTimers(); const clicks = retryClicks(); const generator = vi.fn<typeof generate>().mockResolvedValue('Reply');
  const app = integratedAssistant(generator);
  try {
    app.editor.textContent = ''; app.connector['refresh'](); await vi.advanceTimersByTimeAsync(2000);
    const original = app.connector['suggestion']!; app.connector['openPopup'](); clicks.click(app.connector, 'Close reply assistance');
    expect(app.events.filter(e => e.type === 'dismiss').at(-1)).toMatchObject({ suggestionId: original.id, key: original.key });
    expect(app.assistant['live']).toBeUndefined(); expect(app.connector['ghost'].textContent).toBe('');
    app.assistant.refresh(); await vi.advanceTimersByTimeAsync(3000); expect(generator).toHaveBeenCalledOnce();
  } finally { app.stop(); clicks.stop(); }
});

test('dismissal of an old visible offer preserves a newer offer already queued for a new message', async () => {
  vi.useFakeTimers(); const generator = vi.fn<typeof generate>().mockResolvedValueOnce('Old reply').mockResolvedValueOnce('New reply');
  const app = integratedAssistant(generator);
  try {
    app.editor.textContent = ''; app.connector['refresh'](); await vi.advanceTimersByTimeAsync(2000);
    const original = app.connector['suggestion']!, oldContext = app.assistant['emptyKey']();
    app.connector['observer']!.disconnect(); clearInterval(app.connector['timer']);
    const queued: RemoteCommand[] = [], deliver = app.connector.command.bind(app.connector);
    const spy = vi.spyOn(app.connector, 'command').mockImplementation(command => { queued.push(command); });
    document.querySelector('#main footer')!.insertAdjacentHTML('beforebegin', '<div data-id="false_123@c.us_new"><span data-testid="msg-text">New question</span></div>');
    app.assistant.receive(app.connector.read()); await vi.advanceTimersByTimeAsync(1000);
    const newer = app.assistant['live']!.offer!, beforeDismiss = queued.length;
    expect(newer.id).not.toBe(original.id); expect(app.connector['suggestion']!.id).toBe(original.id);
    app.connector['dismissPopup']();
    expect(app.assistant['live']!.offer!.id).toBe(newer.id); expect(queued.length).toBe(beforeDismiss);
    expect(app.assistant['cache'].get(oldContext!)).toEqual({ dismissed: true });
    expect(app.assistant['cache'].get(app.assistant['emptyKey']()!)).toEqual({ text: 'New reply' });
    spy.mockRestore(); for (const command of queued) deliver(command);
    expect(app.connector['ghost'].textContent).toBe('New reply'); expect(generator).toHaveBeenCalledTimes(2);
  } finally { app.stop(); }
});


describe('composer loading dots', () => {
  test.each(['user', 'auto'] as const)('Escape cancels %s dots and typing cancels either origin', async origin => {
    vi.useFakeTimers(); const editor = fixture(), events: RemoteEvent[] = [];
    const connector = new DomConnector(document, event => events.push(event)); connector.start();
    try {
      await vi.advanceTimersByTimeAsync(600); const key = suggestionKey(connector.read());
      connector.command({ type: 'thinking', origin, key, requestId: 'escape' });
      connector['keydown']({ isTrusted: true, key: 'Escape', target: editor, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() } as unknown as KeyboardEvent);
      expect(events).toContainEqual({ type: 'dismiss', requestId: 'escape' });
      expect(connector['pending']).toBeUndefined(); expect(connector['ghost'].textContent).toBe('');
      connector.command({ type: 'thinking', origin, key, requestId: 'typing' });
      connector['beforeInput']({ isTrusted: true, target: editor } as unknown as Event);
      expect(connector['pending']).toBeUndefined(); expect(connector['ghost'].textContent).toBe('');
    } finally { connector.stop(); }
  });

  test.each(['user', 'auto'] as const)('star and tooltip handle %s dots in an empty composer', async origin => {
    vi.useFakeTimers(); const clicks = retryClicks(); fixture().textContent = '';
    const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event)); connector.start();
    try {
      await vi.advanceTimersByTimeAsync(600);
      connector.command({ type: 'thinking', origin, key: suggestionKey(connector.read()), requestId: 'empty' });
      expect(connector['button'].title).toBe(origin === 'user' ? 'Cancel' : 'Suggest reply');
      expect(connector['button'].getAttribute('aria-label')).toBe(connector['button'].title);
      expect(connector['button'].getAttribute('aria-haspopup')).toBe('false');
      const start = events.length; clicks.trigger(connector);
      expect(connector['popup'].hidden).toBe(true);
      if (origin === 'auto') {
        expect(connector['pending']?.requestId).toBe('empty'); expect(events.slice(start)).toEqual([]);
        expect(connector['ghost'].querySelector('.dots')).not.toBeNull();
      } else {
        expect(connector['pending']).toBeUndefined();
        expect(events.slice(start).filter(event => event.type === 'dismiss')).toEqual([{ type: 'dismiss', requestId: 'empty' }]);
        expect(events.slice(start).some(event => event.type === 'request')).toBe(false);
      }
    } finally { connector.stop(); clicks.stop(); }
  });

  test.each(['user', 'auto'] as const)('one star click during %s draft dots handles the live continuation', async origin => {
    vi.useFakeTimers(); const clicks = retryClicks();
    const generator = vi.fn<typeof generate>().mockImplementation(() => new Promise(() => {}));
    const app = integratedAssistant(generator);
    try {
      await vi.advanceTimersByTimeAsync(600); focusEnd(app.editor); app.connector['refresh']();
      await vi.advanceTimersByTimeAsync(1000);
      if (origin === 'user') void app.assistant.request('Make it warmer');
      expect(app.connector['pending']?.origin).toBe(origin);
      const id = app.connector['pending']!.requestId;
      expect(app.connector['button'].title).toBe(origin === 'auto' ? 'Refine draft' : 'Cancel');
      expect(app.connector['button'].getAttribute('aria-label')).toBe(app.connector['button'].title);
      expect(app.connector['button'].getAttribute('aria-haspopup')).toBe(origin === 'auto' ? 'dialog' : 'false');
      clicks.trigger(app.connector);
      expect(app.connector['pending']).toBeUndefined(); expect(app.connector['ghost'].textContent).toBe('');
      expect(generator.mock.calls.at(-1)![0].signal?.aborted).toBe(true);
      expect(app.events).toContainEqual({ type: 'dismiss', requestId: id });
      expect(app.editor.textContent).toBe('A draft');
      expect(app.connector['popup'].hidden).toBe(origin === 'user');
      if (origin === 'auto') {
        expect(app.connector['popup'].textContent).toContain('Refine draft');
        await vi.advanceTimersByTimeAsync(2000);
        expect(generator).toHaveBeenCalledOnce();
      }
    } finally { app.stop(); clicks.stop(); }
  });

  test('near-edge dots have no wrapping width and their gap belongs to the first period', async () => {
    vi.useFakeTimers(); const editor = fixture(); editor.textContent = 'A draft nearly filling the line';
    const connector = new DomConnector(document, () => {}); connector.start();
    try {
      await vi.advanceTimersByTimeAsync(600);
      connector.command({ type: 'thinking', origin: 'auto', key: suggestionKey(connector.read()), requestId: 'edge' });
      const dots = connector['ghost'].querySelector<HTMLElement>('.dots')!;
      // jsdom does not lay out lines; verify the zero-width/non-wrapping contract
      // that leaves the prefix's final word in its original position.
      const style = document.createElement('style');
      // The host has a closed shadow root, so copy the actual shared stylesheet.
      style.textContent = composerStyle; document.head.append(style);
      const clone = dots.cloneNode(true) as HTMLElement; document.body.append(clone);
      try {
        expect(getComputedStyle(clone).display).toBe('inline-block'); expect(getComputedStyle(clone).width).toBe('0px');
        expect(getComputedStyle(clone).whiteSpace).toBe('nowrap'); expect(getComputedStyle(clone).marginLeft).not.toBe('0.18em');
        expect(getComputedStyle(clone.firstElementChild!).marginLeft).toBe('0.18em');
        expect(connector['ghost'].firstElementChild?.textContent).toBe(editor.textContent);
      } finally { clone.remove(); style.remove(); }
    } finally { connector.stop(); }
  });
  test.each([
    ['fits', 470, 218, false],
    ['full line', 510, 218, true],
    ['no right padding', 520, 218, true],
    ['caret scrolled above', 470, 190, true],
    ['caret scrolled below', 470, 242, true]
  ] as const)('%s selects visible inline or fallback dots after layout', async (_kind, right, top, clipped) => {
    vi.useFakeTimers(); const editor = fixture();
    editor.textContent = _kind.startsWith('caret scrolled') ? 'A long draft\n'.repeat(20) + 'Last line' : 'Near the edge';
    const connector = new DomConnector(document, () => {}); connector.start();
    try {
      await vi.advanceTimersByTimeAsync(600);
      connector.command({ type: 'thinking', origin: 'auto', key: suggestionKey(connector.read()), requestId: 'geometry' });
      const ghost = connector['ghost'], dots = ghost.querySelector<HTMLElement>('.dots')!, fallback = connector['fallbackDots']!;
      ghost.getBoundingClientRect = () => ({ left: 0, right: 500, top: 200, bottom: 240 } as DOMRect);
      connector['button'].getBoundingClientRect = () => ({ left: 470, top: 171, height: 28 } as DOMRect);
      for (const period of dots.children) period.getBoundingClientRect = () => ({ left: right - 20, right, top, bottom: top + 14 } as DOMRect);
      if (_kind.startsWith('caret scrolled')) editor.scrollTop = 100;
      editor.dispatchEvent(new Event('scroll'));
      expect(ghost.scrollTop).toBe(editor.scrollTop);
      expect(dots.style.visibility).toBe(clipped ? 'hidden' : 'visible'); expect(fallback.hidden).toBe(!clipped);
      expect(fallback.getAttribute('aria-hidden')).toBe('true');
      if (clipped) { expect(fallback.style.left).toBe('464px'); expect(fallback.style.top).toBe('185px'); }
      const visible = (element: Element) => [...element.children].filter(period => (period as HTMLElement).style.opacity === '1').length;
      expect(visible(dots)).toBe(1); expect(visible(fallback)).toBe(1);
      await vi.advanceTimersByTimeAsync(400); expect(visible(fallback)).toBe(2);
      expect(connector['loadingStatus'].textContent).toBe('');
      connector.command({ type: 'clear' }); expect(fallback.isConnected).toBe(false); expect(connector['fallbackDots']).toBeUndefined();
    } finally { connector.stop(); }
  });

  test('dots return inline when resize, scroll or input restores space', async () => {
    vi.useFakeTimers(); const editor = fixture(); const connector = new DomConnector(document, () => {}); connector.start();
    try {
      await vi.advanceTimersByTimeAsync(600);
      connector.command({ type: 'thinking', origin: 'user', key: suggestionKey(connector.read()), requestId: 'transition' });
      const dots = connector['ghost'].querySelector<HTMLElement>('.dots')!, fallback = connector['fallbackDots']!;
      connector['ghost'].getBoundingClientRect = () => ({ left: 0, right: 500, top: 200, bottom: 240 } as DOMRect);
      let right = 520;
      for (const period of dots.children) period.getBoundingClientRect = () => ({ left: 460, right, top: 218, bottom: 232 } as DOMRect);
      for (const event of ['resize', 'scroll', 'input']) {
        right = 520; editor.dispatchEvent(new Event('scroll')); expect(fallback.hidden).toBe(false);
        right = 480;
        if (event === 'resize') window.dispatchEvent(new Event(event)); else editor.dispatchEvent(new Event(event));
        expect(fallback.hidden).toBe(true); expect(dots.style.visibility).toBe('visible');
      }
      expect(connector['pending']?.requestId).toBe('transition');
    } finally { connector.stop(); }
  });

  test('fallback dots respect reduced motion without another announcement', async () => {
    vi.useFakeTimers(); vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    fixture(); const connector = new DomConnector(document, () => {}); connector.start();
    try {
      await vi.advanceTimersByTimeAsync(600);
      connector.command({ type: 'refining', origin: 'user', key: suggestionKey(connector.read()), requestId: 'fallback-reduced' });
      const dots = connector['ghost'].querySelector('.dots')!, fallback = connector['fallbackDots']!;
      connector['ghost'].getBoundingClientRect = () => ({ left: 0, right: 500, top: 200, bottom: 240 } as DOMRect);
      for (const period of dots.children) period.getBoundingClientRect = () => ({ left: 490, right: 510, top: 218, bottom: 232 } as DOMRect);
      const status = vi.spyOn(connector['loadingStatus'], 'textContent', 'set');
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(400); expect(fallback.hidden).toBe(false);
        expect([...fallback.children].map(period => (period as HTMLElement).style.opacity)).toEqual(['1', '1', '1']);
      }
      expect(status).not.toHaveBeenCalled(); status.mockRestore();
    } finally { connector.stop(); }
  });

  test.each([
    ['empty suggestion', '', 'thinking', false],
    ['continuation', 'Hello', 'thinking', true],
    ['trailing space', 'Hello ', 'thinking', false],
    ['trailing newline', 'Hello\n', 'thinking', false],
    ['draft refinement', 'Hello', 'refining', true],
    ['shown suggestion refinement', '', 'refining', false]
  ] as const)('%s uses the ghost overlay at the result position', async (_kind, draft, type, gap) => {
    vi.useFakeTimers(); const editor = fixture(); editor.textContent = draft;
    // Native contenteditables retain a terminal BR after a user-authored newline.
    if (draft.endsWith('\n')) editor.append(document.createElement('br'));
    editor.setAttribute('aria-placeholder', 'Type a message');
    const placeholder = document.createElement('div'); placeholder.textContent = 'Type a message'; placeholder.setAttribute('aria-hidden', 'true'); editor.parentElement!.append(placeholder);
    const connector = new DomConnector(document, () => {}); connector.start();
    try {
      await vi.advanceTimersByTimeAsync(600); const key = suggestionKey(connector.read());
      if (!draft && type === 'refining') connector.command({ type: 'suggestion', key, text: 'Old suggestion', replace: false });
      const pending = { type, origin: 'user' as const, key, requestId: '00000000-0000-4000-8000-000000000003' };
      connector.command(pending);
      const ghost = connector['ghost'], dots = ghost.querySelector('.dots')!;
      const visibleDots = () => [...dots.querySelectorAll('i')].filter(period => period.style.opacity === '1').map(period => period.textContent).join('');
      expect(ghost.classList.contains('loading')).toBe(true); expect(ghost.getAttribute('aria-hidden')).toBe('true');
      expect(ghost.firstElementChild?.textContent).toBe(draft); expect((ghost.firstElementChild as HTMLElement).style.visibility).toBe('hidden');
      expect(dots.classList.contains('gap')).toBe(gap); expect(visibleDots()).toBe('.');
      expect(placeholder.style.visibility).toBe(draft ? '' : 'hidden');
      expect(connector['popup'].hidden).toBe(true); expect(connector['suggestion']).toBeUndefined();
      expect(connector['button'].title).toBe('Cancel'); expect(connector['button'].getAttribute('aria-label')).toBe('Cancel');
      expect(connector['button'].getAttribute('aria-haspopup')).toBe('false'); expect(connector['button'].textContent).toBe('✦');
      const status = connector['loadingStatus'];
      expect(status.getAttribute('role')).toBe('status'); expect(status.className).toBe('sr-status');
      expect(status.textContent).toBe(type === 'thinking' ? 'Suggesting a reply' : 'Refining');
      const announce = vi.spyOn(status, 'textContent', 'set');
      await vi.advanceTimersByTimeAsync(399); expect(visibleDots()).toBe('.');
      connector.command(pending); // Republished live state must not restart or announce again.
      for (const [delay, text] of [[1, '..'], [400, '...'], [400, '.'], [400, '..']] as const) {
        await vi.advanceTimersByTimeAsync(delay);
        expect(visibleDots()).toBe(text);
      }
      expect(announce).not.toHaveBeenCalled(); announce.mockRestore();
      expect(editor.textContent).toBe(draft);
      connector.command({ type: 'clear' }); expect(placeholder.style.visibility).toBe('');
      expect(status.textContent).toBe(''); expect(ghost.textContent).toBe(''); expect(connector['dotsTimer']).toBeUndefined();
      expect(connector['button'].title).toBe(draft.trim() ? 'Refine draft' : 'Suggest reply');
    } finally { connector.stop(); }
  });

  test('reduced motion keeps three static dots', async () => {
    vi.useFakeTimers(); vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    fixture().textContent = ''; const connector = new DomConnector(document, () => {}); connector.start();
    try {
      await vi.advanceTimersByTimeAsync(600);
      connector.command({ type: 'thinking', origin: 'user', key: suggestionKey(connector.read()), requestId: 'reduced' });
      for (let i = 0; i < 4; i++) {
        expect(connector['ghost'].textContent).toBe('...');
        expect([...connector['ghost'].querySelectorAll('i')].map(period => period.style.opacity)).toEqual(['1', '1', '1']);
        await vi.advanceTimersByTimeAsync(400);
      }
    } finally { connector.stop(); }
  });

  test.each(['user', 'auto'] as const)('%s dots retain focus-independent work and synchronize composer scroll', async origin => {
    vi.useFakeTimers(); const editor = fixture(); editor.tabIndex = 0;
    const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event)); connector.start();
    try {
      await vi.advanceTimersByTimeAsync(600);
      connector.command({ type: 'thinking', origin, key: suggestionKey(connector.read()), requestId: 'scroll' });
      const ghost = connector['ghost'];
      ghost.getBoundingClientRect = () => ({ top: 200, bottom: 240 } as DOMRect);
      ghost.lastElementChild!.getBoundingClientRect = () => ({ top: 220 } as DOMRect);
      editor.scrollTop = 15; editor.scrollLeft = 7; editor.dispatchEvent(new Event('scroll'));
      expect(ghost.scrollTop).toBe(15); expect(ghost.scrollLeft).toBe(7);
      editor.focus(); editor.blur(); connector['refresh']();
      connector['pointer']({ isTrusted: true, composedPath: () => [document.body] } as unknown as Event);
      connector['activity']({ isTrusted: true } as Event);
      expect(connector['pending']?.requestId).toBe('scroll'); expect(events.some(e => e.type === 'dismiss')).toBe(false);
      ghost.lastElementChild!.getBoundingClientRect = () => ({ top: 270 } as DOMRect);
      editor.dispatchEvent(new Event('scroll')); expect(ghost.scrollTop).toBe(15); expect(editor.scrollTop).toBe(15);
    } finally { connector.stop(); }
  });

  test('Tab and Shift+Tab keep ordinary navigation while dots run', async () => {
    vi.useFakeTimers(); const editor = fixture(); editor.textContent = '';
    const connector = new DomConnector(document, () => {}); connector.start();
    try {
      await vi.advanceTimersByTimeAsync(600);
      connector.command({ type: 'thinking', origin: 'user', key: suggestionKey(connector.read()), requestId: 'tab' });
      for (const shiftKey of [false, true]) {
        const event = { isTrusted: true, key: 'Tab', target: editor, shiftKey, composedPath: () => [editor], preventDefault: vi.fn() };
        connector['keydown'](event as unknown as KeyboardEvent); expect(event.preventDefault).not.toHaveBeenCalled();
      }
      expect(connector['pending']?.requestId).toBe('tab');
    } finally { connector.stop(); }
  });

  test.each((['user', 'auto'] as const).flatMap(origin => (['typing', 'IME', 'sending', 'send button'] as const).map(action => [origin, action] as const)))('%s dots: %s cancels and rejects queued responses', async (origin, action) => {
    vi.useFakeTimers(); const editor = fixture(), connector = new DomConnector(document, () => {}); connector.start();
    try {
      await vi.advanceTimersByTimeAsync(600); const key = suggestionKey(connector.read());
      connector.command({ type: origin === 'user' ? 'refining' : 'thinking', origin, key, requestId: 'cancel' });
      if (action === 'typing') connector['beforeInput']({ isTrusted: true, target: editor } as unknown as Event);
      if (action === 'IME') editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      if (action === 'sending') connector['keydown']({ isTrusted: true, key: 'Enter', target: editor } as unknown as KeyboardEvent);
      if (action === 'send button') {
        const send = document.createElement('button'), icon = document.createElement('span'); icon.dataset.icon = 'send'; send.append(icon); editor.parentElement!.append(send);
        connector['pointer']({ isTrusted: true, target: icon, composedPath: () => [icon, send] } as unknown as Event);
      }
      expect(connector['pending']).toBeUndefined(); expect(connector['ghost'].textContent).toBe('');
      expect(connector['fallbackDots']).toBeUndefined();
      connector.command({ type: 'suggestion', key, text: 'Queued stale reply', replace: true, requestId: 'cancel' });
      expect(connector['ghost'].textContent).toBe(''); expect(editor.textContent).toBe('A draft');
    } finally { connector.stop(); }
  });

  test('one click from an owner-last composer uses an explicit request and errors retry with dots', async () => {
    vi.useFakeTimers(); const clicks = retryClicks(); let finish!: (text: string) => void;
    const generator = vi.fn<typeof generate>().mockRejectedValueOnce(new ProviderError('Network unavailable'))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const app = integratedAssistant(generator);
    try {
      app.editor.textContent = ''; document.querySelector<HTMLElement>('#main [data-id]')!.dataset.id = 'true_123@c.us_own';
      app.connector['refresh'](); await vi.advanceTimersByTimeAsync(2000);
      expect(generator).not.toHaveBeenCalled(); clicks.trigger(app.connector); await vi.advanceTimersByTimeAsync(0);
      expect(generator.mock.calls[0][0].reason).toBe('explicit suggest');
      expect(app.connector['ghost'].textContent).toBe(''); expect(app.connector['popup'].textContent).toContain('Try again');
      expect(app.connector['fallbackDots']).toBeUndefined();
      clicks.click(app.connector);
      expect(app.connector['ghost'].querySelector('.dots')?.textContent).toBe('...'); expect(app.connector['popup'].hidden).toBe(true);
      expect(generator.mock.calls[1][0].reason).toBe('retry');
      finish('Explicit reply'); await vi.advanceTimersByTimeAsync(0);
      expect(app.connector['ghost'].textContent).toBe('Explicit reply'); expect(app.editor.textContent).toBe('');
      expect(app.connector['fallbackDots']).toBeUndefined();
    } finally { app.stop(); clicks.stop(); }
  });
});

test('automatic dots are not announced and a star click returns focus to the empty composer', async () => {
  vi.useFakeTimers(); const editor = fixture(); editor.textContent = ''; const clicks = retryClicks();
  const connector = new DomConnector(document, () => {}); connector.start();
  try {
    await vi.advanceTimersByTimeAsync(600); const key = suggestionKey(connector.read());
    connector.command({ type: 'thinking', origin: 'auto', key, requestId: '00000000-0000-4000-8000-0000000000a1' });
    expect(connector['pending']?.origin).toBe('auto'); expect(connector['loadingStatus'].textContent).toBe('');
    connector['button'].focus(); clicks.trigger(connector);
    expect(connector['pending']?.requestId).toBe('00000000-0000-4000-8000-0000000000a1');
    expect(document.activeElement).toBe(editor);
    connector.command({ type: 'thinking', origin: 'user', key, requestId: '00000000-0000-4000-8000-0000000000a2' });
    expect(connector['loadingStatus'].textContent).toBe('Suggesting a reply');
  } finally { connector.stop(); clicks.stop(); }
});

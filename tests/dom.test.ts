// @vitest-environment jsdom
import { test, expect, vi, afterEach } from 'vitest';
import { DomConnector, peerFromMessageId, caretAtEnd, readDraft } from '../src/connector/dom';
import { snapshotSchema } from '../src/shared/model';
import { snapshotKey, suggestionKey } from '../src/core/suggestions';
import type { RemoteEvent } from '../src/shared/connector';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });
function fixture() {
  document.body.innerHTML = '<div id="main"><header><span title="A friend">A friend</span></header><div data-id="false_123@c.us_one"><span class="selectable-text copyable-text">Hi</span></div><footer><div contenteditable="true" role="textbox">A draft</div></footer></div>';
  const editor = document.querySelector<HTMLElement>('[role=textbox]')!;
  editor.getBoundingClientRect = () => ({ height: 40, width: 500, x: 0, y: 200, top: 200, bottom: 240, left: 0, right: 500, toJSON() {} });
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
function modernFixture() {
  const editor = fixture();
  document.querySelector('#main header')!.innerHTML = '<button title="Profile details"></button><span data-testid="conversation-info-header-chat-title">A friend</span>';
  const side = document.createElement('div'); side.id = 'pane-side'; side.innerHTML = '<div aria-selected="true">A friend</div>'; document.body.prepend(side);
  const message = document.querySelector<HTMLElement>('#main [data-id]')!;
  message.dataset.id = 'ABC123456'; message.dataset.testid = 'conv-msg-ABC123456';
  return editor;
}
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
test.each([['image-thumb', 'image'], ['sticker-container', 'sticker'], ['ptt-status', 'audio'], ['video-thumb', 'video']])('observes %s without reading attachment contents', (testid, attachment) => {
  modernFixture(); const node = document.querySelector('#main [data-id]')!;
  node.innerHTML = `<span data-testid="${testid}"><img alt="Private content must not become a caption" src="data:image/png;base64,AA=="></span>`;
  const connector = new DomConnector(document, () => {});
  expect(connector.read().messages[0]).toEqual({ id: 'ABC123456', text: '', outgoing: null, attachment });
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
test.each(['menu', 'notice'])('replacing refinement with %s removes the hidden replacement so ordinary Tab cannot accept it', async replacement => {
  vi.useFakeTimers(); const editor = fixture(); editor.tabIndex = 0;
  const connector = new DomConnector(document, () => {}); connector.start();
  const insert = vi.fn(); document.execCommand = insert;
  try {
    await vi.advanceTimersByTimeAsync(600);
    connector.command({ type: 'suggestion', key: suggestionKey(connector.read()), text: 'Old refinement', replace: true });
    expect(connector['popup'].hidden).toBe(false);
    if (replacement === 'menu') connector['openPopup'](); else connector.command({ type: 'notice', text: 'An explanation' });
    connector['pointer']({ isTrusted: true, composedPath: () => [editor] } as unknown as Event);
    expect(connector['popup'].hidden).toBe(true);
    editor.focus(); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    const preventDefault = vi.fn();
    connector['keydown']({ isTrusted: true, key: 'Tab', target: editor, composedPath: () => [editor], preventDefault } as unknown as KeyboardEvent);
    expect(insert).not.toHaveBeenCalled(); expect(preventDefault).not.toHaveBeenCalled(); expect(editor.textContent).toBe('A draft');
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
  Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 100 } }); document.body.append(img); return img;
}
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

test('an empty assistance menu becomes suggestion refinement when the ghost reply arrives', async () => {
  vi.useFakeTimers(); const editor = fixture(); editor.textContent = '';
  const connector = new DomConnector(document, () => {}); connector.start();
  try {
    await vi.advanceTimersByTimeAsync(600); connector['openPopup']();
    expect(connector['popup'].getAttribute('aria-label')).toBe('Reply assistance');
    expect(connector['popup'].querySelector('input')).toBeNull();
    connector.command({ type: 'suggestion', key: suggestionKey(connector.read()), id: '00000000-0000-4000-8000-000000000001', text: 'The visible suggestion', replace: false });
    expect(connector['popup'].getAttribute('aria-label')).toBe('Refine suggestion');
    expect(connector['popup'].querySelectorAll('.action')).toHaveLength(4);
    expect(connector['ghost'].textContent).toBe('The visible suggestion');
    expect(editor.textContent).toBe('');
  } finally { connector.stop(); }
});
test('typing during pending refinement hides it and rejects a queued result', async () => {
  vi.useFakeTimers(); const editor = fixture();
  const connector = new DomConnector(document, () => {}); connector.start();
  try {
    await vi.advanceTimersByTimeAsync(600); const key = suggestionKey(connector.read());
    connector.command({ type: 'refining', key }); expect(connector['popup'].hidden).toBe(false);
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
    connector['openPopup']();
    expect(connector['popup'].getAttribute('aria-label')).toBe('Refine suggestion');
    connector['pointer']({ isTrusted: true, composedPath: () => [editor] } as unknown as Event);
    expect(connector['popup'].hidden).toBe(true); expect(connector['ghost'].textContent).toBe('A revised reply');
    expect(editor.textContent).toBe('');
  } finally { connector.stop(); }
});

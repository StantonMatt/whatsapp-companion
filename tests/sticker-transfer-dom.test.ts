// @vitest-environment jsdom
import { test, expect, vi, afterEach } from 'vitest';
import { StickerTransferConnector } from '../src/connector/sticker-transfer';
import { emptySnapshot } from '../src/shared/model';
import { STICKER_DRAG_TYPE } from '../src/shared/sticker-transfer';
import type { RemoteEvent } from '../src/shared/connector';
const id = 'a'.repeat(64), source = 'data:image/webp;base64,UklGRg==';
const target = { chatId: '123@c.us', name: 'A friend', revision: '1' };
const ticket = { id, nonce: 'nonce', target };
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); document.querySelector('#companion-sticker-drop')?.remove(); });
function setup(authorize: (nonce: string) => Promise<boolean> = async () => true) {
  vi.useFakeTimers();
  document.body.innerHTML = `<div id="main"><header></header><footer><div contenteditable="true">keep my draft</div></footer></div><ul data-testid="expressions-panel"><div role="button" aria-label="Send sticker"><div data-testid="sticker-item"><img src="${source}"></div></div></ul>`;
  for (const el of document.querySelectorAll<HTMLElement>('*')) { el.checkVisibility = () => true; el.getBoundingClientRect = () => ({ width: 100, height: 100, top: 0, bottom: 100, left: 0, right: 100 } as DOMRect); }
  const image = document.querySelector('img')!;
  Object.defineProperty(image, 'naturalWidth', { value: 100 }); Object.defineProperty(image, 'complete', { value: true }); image.scrollIntoView = vi.fn();
  const button = image.closest<HTMLElement>('[role=button]')!, click = vi.fn(); button.addEventListener('click', click);
  const snapshot = { ...emptySnapshot, ...target, ready: true };
  const events: RemoteEvent[] = [];
  const connector = new StickerTransferConnector(document, () => snapshot, new Map([[source, id]]), e => events.push(e), authorize);
  return { image, button, snapshot, events, click, connector };
}
test('preparation previews the original without a click; confirmation clicks exactly once and preserves draft', async () => {
  const { connector, events, click } = setup();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(100); await task;
    expect(events).toContainEqual({ type: 'stickerPrepared', nonce: ticket.nonce, found: true }); expect(click).not.toHaveBeenCalled();
    await connector.send(ticket, Date.now() + 5000); await connector.send(ticket, Date.now() + 5000);
    expect(click).toHaveBeenCalledTimes(1);
    expect(events.slice(-2)).toEqual([{ type: 'stickerSent', nonce: ticket.nonce, clicked: true }, { type: 'stickerSent', nonce: ticket.nonce, clicked: false }]);
    expect(document.querySelector('[contenteditable]')?.textContent).toBe('keep my draft');
  } finally { connector.stop(); }
});
test.each(['chat', 'source', 'button', 'hidden', 'cancel'])('a %s change after preview prevents a native send', async change => {
  const { connector, snapshot, image, button, click } = setup();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(100); await task;
    if (change === 'chat') snapshot.revision = '2';
    if (change === 'source') image.src = 'data:image/webp;base64,bmV3';
    if (change === 'button') button.replaceWith(button.cloneNode(true));
    if (change === 'hidden') button.checkVisibility = () => false;
    if (change === 'cancel') connector.cancel();
    await connector.send(ticket, Date.now() + 5000); expect(click).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});
test('synthetic page drop events cannot open a preview or send', () => {
  const { connector, events, click } = setup();
  try {
    connector.arm(ticket);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { types: [STICKER_DRAG_TYPE], getData: () => ticket.nonce } });
    document.querySelector('footer')!.dispatchEvent(drop);
    expect(events).toEqual([]); expect(click).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});
test.each(['main-cancel', 'remote-cancel', 'chat', 'expiry', 'channel-error'])('sticker activation fails closed for %s while checking main permission', async reason => {
  let approve!: (value: boolean) => void, reject!: (error: Error) => void;
  const { connector, snapshot, click, events } = setup(() => new Promise<boolean>((resolve, fail) => { approve = resolve; reject = fail; }));
  try {
    const preparation = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(100); await preparation;
    const sending = connector.send(ticket, Date.now() + 5000);
    if (reason === 'remote-cancel') connector.cancel();
    if (reason === 'chat') snapshot.revision = '2';
    if (reason === 'expiry') vi.setSystemTime(Date.now() + 5000);
    if (reason === 'channel-error') reject(new Error('IPC unavailable')); else approve(reason !== 'main-cancel');
    await sending;
    expect(click).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'stickerSent', nonce: ticket.nonce, clicked: false });
  } finally { connector.stop(); }
});

test('a virtualized picker can unmount images during scrolling without ending the search', async () => {
  const { connector, image, button, events, click } = setup();
  const picker = document.querySelector('[data-testid="expressions-panel"]')!;
  const viewport = document.createElement('div'); viewport.getBoundingClientRect = () => ({ top: 0, bottom: 150 } as DOMRect); viewport.style.overflowY = 'auto'; picker.append(viewport); viewport.append(button);
  Object.defineProperty(viewport, 'clientHeight', { value: 150 }); Object.defineProperty(viewport, 'scrollHeight', { value: 500 });
  let position = 0;
  Object.defineProperty(viewport, 'scrollTop', { get: () => position, set: value => {
    position = value;
    if (value > 0) { button.remove(); setTimeout(() => { image.src = source; viewport.append(button); }, 250); }
  } });
  image.src = 'data:image/webp;base64,b3RoZXI=';
  connector['verified'].set(image.src, 'b'.repeat(64));
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(700); await task;
    expect(events).toContainEqual({ type: 'stickerPrepared', nonce: ticket.nonce, found: true }); expect(click).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});
test('expired send commands cannot activate even the correctly prepared original', async () => {
  const { connector, click, events } = setup();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(100); await task;
    await connector.send(ticket, Date.now() - 1);
    expect(click).not.toHaveBeenCalled(); expect(events.at(-1)).toEqual({ type: 'stickerSent', nonce: ticket.nonce, clicked: false });
  } finally { connector.stop(); }
});

test('a short initial sticker batch may grow before the full favorites grid is ready', async () => {
  const { connector, image, button, events } = setup();
  const picker = document.querySelector('[data-testid="expressions-panel"]')!;
  const viewport = document.createElement('div'); viewport.style.overflowY = 'auto';
  viewport.getBoundingClientRect = () => ({ top: 0, bottom: 150 } as DOMRect);
  picker.append(viewport); viewport.append(button);
  let expanded = false, position = 0;
  Object.defineProperty(viewport, 'clientHeight', { value: 150 });
  Object.defineProperty(viewport, 'scrollHeight', { get: () => expanded ? 500 : 150 });
  Object.defineProperty(viewport, 'scrollTop', { get: () => position, set: value => { position = value; if (value > 0) image.src = source; } });
  image.src = 'data:image/webp;base64,b3RoZXI='; connector['verified'].set(image.src, 'b'.repeat(64));
  setTimeout(() => { expanded = true; }, 1500);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(4000); await task;
    expect(events).toContainEqual({ type: 'stickerPrepared', nonce: ticket.nonce, found: true });
  } finally { connector.stop(); }
});

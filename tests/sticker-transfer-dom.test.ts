// @vitest-environment jsdom
import { test, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { StickerTransferConnector } from '../src/connector/sticker-transfer';
import { stickerImageState } from '../src/connector/sticker-image-state';
import { emptySnapshot } from '../src/shared/model';
import type { RemoteEvent } from '../src/shared/connector';
const id = 'a'.repeat(64), source = 'data:image/webp;base64,UklGRg==';
const target = { chatId: '123@c.us', name: 'A friend', revision: '1' };
const ticket = { id, nonce: 'nonce', target };
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });
function setup(authorize: (nonce: string) => Promise<boolean> = async () => true) {
  vi.useFakeTimers();
  document.body.innerHTML = `<div id="main"><header></header><footer><div contenteditable="true">keep my draft</div></footer></div><ul data-testid="expressions-panel"><div role="list"><div role="button" aria-label="Send sticker"><div data-testid="sticker-item"><img src="${source}"></div></div></div></ul>`;
  for (const el of document.querySelectorAll<HTMLElement>('*')) { el.checkVisibility = () => true; el.getBoundingClientRect = () => ({ width: 100, height: 100, top: 0, bottom: 100, left: 0, right: 100 } as DOMRect); }
  const image = document.querySelector('img')!;
  Object.defineProperty(image, 'naturalWidth', { value: 100, configurable: true }); Object.defineProperty(image, 'complete', { value: true, configurable: true }); image.scrollIntoView = vi.fn();
  const button = image.closest<HTMLElement>('[role=button]')!, click = vi.fn(); button.addEventListener('click', click);
  const snapshot = { ...emptySnapshot, ...target, ready: true };
  const events: RemoteEvent[] = [];
  const connector = new StickerTransferConnector(document, () => snapshot, new Map([[source, id]]), e => events.push(e), authorize);
  return { image, button, snapshot, events, click, connector };
}
test('lookup finds the original without clicking; the click-authorized command activates it once and preserves draft', async () => {
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
test.each(['chat', 'source', 'button', 'hidden', 'pending', 'broken', 'error', 'cancel'])('a %s change after lookup prevents a native send', async change => {
  const { connector, snapshot, image, button, click } = setup();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(100); await task;
    if (change === 'chat') snapshot.revision = '2';
    if (change === 'source') image.src = 'data:image/webp;base64,bmV3';
    if (change === 'button') button.replaceWith(button.cloneNode(true));
    if (change === 'hidden') button.checkVisibility = () => false;
    if (change === 'pending') Object.defineProperty(image, 'complete', { value: false });
    if (change === 'broken') Object.defineProperty(image, 'naturalWidth', { value: 0 });
    if (change === 'error') image.dispatchEvent(new Event('error'));
    if (change === 'cancel') connector.cancel();
    await connector.send(ticket, Date.now() + 5000); expect(click).not.toHaveBeenCalled();
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

test.each(['pending', 'broken', 'error'])('lookup matches a ready original while an unrelated image is %s', async state => {
  const { connector, button, events, click } = setup();
  const unrelated = button.cloneNode(true) as HTMLElement;
  const image = unrelated.querySelector('img')!;
  image.src = 'data:image/webp;base64,b3RoZXI=';
  Object.defineProperties(image, { complete: { value: state === 'broken' }, naturalWidth: { value: 0 } });
  image.checkVisibility = () => true; image.getBoundingClientRect = button.getBoundingClientRect;
  unrelated.checkVisibility = () => true; unrelated.getBoundingClientRect = button.getBoundingClientRect;
  // Put it first so neither matching nor checking image readiness can stop at it.
  button.before(unrelated);
  try {
    const task = connector.prepare(ticket);
    if (state === 'error') {
      // Observe it while incomplete, then fail before the matching poll.
      expect(stickerImageState(image)).toBe('pending'); image.dispatchEvent(new Event('error'));
    }
    await vi.advanceTimersByTimeAsync(100); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
    expect(click).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});

test.each(['broken', 'error', 'unsupported'])('a %s image does not prevent scrolling and early category exhaustion', async state => {
  const { connector, image, button, events } = setup();
  image.src = state === 'unsupported' ? 'https://example.invalid/sticker.webp' : 'data:image/webp;base64,b3RoZXI=';
  if (state !== 'unsupported') Object.defineProperty(image, 'naturalWidth', { value: 0 });
  if (state === 'error') Object.defineProperty(image, 'complete', { value: false, configurable: true });
  const viewport = document.createElement('div'); viewport.style.overflowY = 'auto';
  viewport.getBoundingClientRect = () => ({ top: 0, bottom: 150 } as DOMRect);
  document.querySelector('[data-testid="expressions-panel"]')!.append(viewport); viewport.append(button);
  Object.defineProperty(viewport, 'clientHeight', { value: 150 }); Object.defineProperty(viewport, 'scrollHeight', { value: 360 });
  let position = 0;
  Object.defineProperty(viewport, 'scrollTop', { get: () => position, set: value => { position = Math.min(210, value); } });
  const examined: number[] = [];
  categoryTabs(() => { examined.push(position); position = 0; });
  try {
    const task = connector.prepare(ticket);
    await vi.advanceTimersByTimeAsync(100);
    if (state === 'error') {
      expect(position).toBe(0); expect(events).toEqual([]);
      image.dispatchEvent(new Event('error'));
    }
    await vi.advanceTimersByTimeAsync(10_200); await task;
    expect(examined).toEqual([210, 210]); expect(position).toBe(210);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
  } finally { connector.stop(); }
});

test('a relevant image loading at the end prevents early missing until it becomes ready', async () => {
  const { connector, image, events } = setup();
  Object.defineProperty(image, 'complete', { value: false, configurable: true });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(8000);
    expect(events).toEqual([]);
    Object.defineProperty(image, 'complete', { value: true, configurable: true });
    await vi.advanceTimersByTimeAsync(100); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
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

function categoryTabs(onSelect: (category: string) => void = () => {}) {
  return ['panel-starred', 'panel-recent'].map(category => {
    const tab = document.createElement('button'); tab.dataset.testid = category;
    tab.checkVisibility = () => true; tab.getBoundingClientRect = document.querySelector('img')?.getBoundingClientRect ?? (() => ({ width: 100 } as DOMRect));
    tab.addEventListener('click', () => onSelect(category));
    document.querySelector('[data-testid="expressions-panel"]')!.append(tab);
    return tab;
  });
}

test('all empty categories report missing after their short settle windows instead of the deadline', async () => {
  const { connector, button, events, click } = setup();
  const selected: string[] = []; categoryTabs(category => selected.push(category)); button.remove();
  try {
    const task = connector.prepare(ticket);
    await vi.advanceTimersByTimeAsync(7000);
    expect(selected).toEqual(['panel-starred', 'panel-recent']); expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(100); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
    expect(click).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});

test('the hidden-sticker desktop fixture reports missing within eight seconds', async () => {
  const { connector, events } = setup();
  const fixture = readFileSync('tests/fixtures/whatsapp.html', 'utf8');
  document.body.innerHTML = fixture;
  // Run the fixture's own picker path, including fixtureHideSticker, without
  // Electron. JSDOM needs visibility/geometry stubs for the native DOM adapter.
  const script = fixture.match(/<script>([\s\S]*?)<\/script>/)![1];
  window.eval(`let peer = '123456@c.us';\n${script.slice(script.indexOf('window.fixtureStickerSent=[];'))}`);
  Object.assign(window, { fixtureStickerSource: source, fixtureHideSticker: true });
  const show = () => {
    for (const el of document.querySelectorAll<HTMLElement>('*')) {
      el.checkVisibility = () => true;
      el.getBoundingClientRect = () => ({ width: 100, height: 100, top: 0, bottom: 100 } as DOMRect);
    }
  };
  show();
  const trigger = document.querySelector<HTMLElement>('[aria-label="Emojis, GIFs, Stickers"]')!;
  trigger.addEventListener('click', show);
  const started = Date.now(), activated: number[] = [];
  let elapsed = 0;
  trigger.addEventListener('click', () => {
    for (const tab of document.querySelectorAll<HTMLElement>('[data-testid="panel-starred"], [data-testid="panel-recent"]')) tab.addEventListener('click', () => activated.push(Date.now() - started));
  });
  try {
    const task = connector.prepare(ticket).then(() => { elapsed = Date.now() - started; });
    await vi.advanceTimersByTimeAsync(7000);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(100); await task;
    expect(activated).toEqual([2100, 4600]);
    expect(elapsed).toBe(7100);
    expect(elapsed).toBeLessThan(8000);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
  } finally { connector.stop(); }
});

test('every scrolling category reaches its end and settles before an early missing result', async () => {
  const { connector, image, button, events } = setup();
  image.src = 'data:image/webp;base64,b3RoZXI='; connector['verified'].set(image.src, 'b'.repeat(64));
  const viewport = document.createElement('div'); viewport.style.overflowY = 'auto';
  viewport.getBoundingClientRect = () => ({ top: 0, bottom: 150 } as DOMRect);
  document.querySelector('[data-testid="expressions-panel"]')!.append(viewport); viewport.append(button);
  Object.defineProperty(viewport, 'clientHeight', { value: 150 }); Object.defineProperty(viewport, 'scrollHeight', { value: 360 });
  let position = 0;
  Object.defineProperty(viewport, 'scrollTop', { get: () => position, set: value => { position = Math.min(210, value); } });
  const examined: number[] = [];
  categoryTabs(() => { examined.push(position); position = 0; });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(10_200); await task;
    expect(examined).toEqual([210, 210]); expect(position).toBe(210);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
  } finally { connector.stop(); }
});

test('Favorites can expand after switching from an already exhausted pack', async () => {
  const { connector, image, button, events } = setup();
  const viewport = document.createElement('div'); viewport.style.overflowY = 'auto';
  viewport.getBoundingClientRect = () => ({ top: 0, bottom: 150 } as DOMRect);
  document.querySelector('[data-testid="expressions-panel"]')!.append(viewport); viewport.append(button);
  let expanded = false, position = 0;
  Object.defineProperty(viewport, 'clientHeight', { value: 150 });
  Object.defineProperty(viewport, 'scrollHeight', { get: () => expanded ? 500 : 150 });
  Object.defineProperty(viewport, 'scrollTop', { get: () => position, set: value => { position = value; if (value > 0) image.src = source; } });
  image.src = 'data:image/webp;base64,b3RoZXI='; connector['verified'].set(image.src, 'b'.repeat(64));
  const selected: string[] = [];
  categoryTabs(category => { selected.push(category); if (category === 'panel-starred') setTimeout(() => { expanded = true; }, 1500); });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(3500);
    expect(selected).toEqual(['panel-starred']); expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
  } finally { connector.stop(); }
});

test.each([false, true])('pending image loads prevent early missing and scrolling until ready (match=%s)', async found => {
  const { connector, image, button, events } = setup();
  const viewport = document.createElement('div'); viewport.style.overflowY = 'auto';
  viewport.getBoundingClientRect = () => ({ top: 0, bottom: 150 } as DOMRect);
  document.querySelector('[data-testid="expressions-panel"]')!.append(viewport); viewport.append(button);
  Object.defineProperty(viewport, 'clientHeight', { value: 150 }); Object.defineProperty(viewport, 'scrollHeight', { value: 360 });
  let loaded = false, position = 0;
  Object.defineProperty(image, 'complete', { get: () => loaded, configurable: true });
  Object.defineProperty(viewport, 'scrollTop', { get: () => position, set: value => { position = Math.min(210, value); } });
  image.src = 'data:image/webp;base64,b3RoZXI='; connector['verified'].set(image.src, 'b'.repeat(64));
  setTimeout(() => { loaded = true; if (found) image.src = source; }, 8000);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(7900);
    expect(events).toEqual([]); expect(position).toBe(0);
    await vi.advanceTimersByTimeAsync(300);
    if (!found) expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found }]);
  } finally { connector.stop(); }
});

test('an image starting to load at the end restarts the settle window once ready', async () => {
  const { connector, image, events } = setup();
  image.src = 'data:image/webp;base64,b3RoZXI='; connector['verified'].set(image.src, 'b'.repeat(64));
  let loaded = true;
  Object.defineProperty(image, 'complete', { get: () => loaded });
  setTimeout(() => { loaded = false; }, 1500);
  setTimeout(() => { loaded = true; }, 8000);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(9900);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(200); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
  } finally { connector.stop(); }
});

test('images that never finish loading remain bounded by the one-minute deadline', async () => {
  const { connector, image, events } = setup();
  Object.defineProperty(image, 'complete', { value: false });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(59_900);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(200); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
  } finally { connector.stop(); }
});

test.each([false, true])('the one-minute deadline still bounds an endlessly growing picker (at end=%s)', async atEnd => {
  const { connector, image, button, events } = setup();
  image.src = 'data:image/webp;base64,b3RoZXI='; connector['verified'].set(image.src, 'b'.repeat(64));
  const viewport = document.createElement('div'); viewport.style.overflowY = 'auto';
  viewport.getBoundingClientRect = () => ({ top: 0, bottom: 150 } as DOMRect);
  document.querySelector('[data-testid="expressions-panel"]')!.append(viewport); viewport.append(button);
  let height = 300;
  Object.defineProperty(viewport, 'clientHeight', { value: 150 }); Object.defineProperty(viewport, 'scrollHeight', { get: () => height });
  if (atEnd) Object.defineProperty(viewport, 'scrollTop', { get: () => height - 150, set: () => {} });
  const growth = setInterval(() => { height += 150; }, 250);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(59_900);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(200); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
  } finally { clearInterval(growth); connector.stop(); }
});

function ownedPicker(delay = 0) {
  const context = setup();
  const panel = document.querySelector<HTMLElement>('[data-testid="expressions-panel"]')!;
  panel.remove();
  const trigger = document.createElement('button');
  trigger.setAttribute('aria-label', 'Emojis, GIFs, Stickers');
  trigger.checkVisibility = () => true;
  trigger.getBoundingClientRect = context.button.getBoundingClientRect;
  const toggle = vi.fn(() => {
    if (panel.isConnected) panel.remove();
    else if (delay) setTimeout(() => document.body.append(panel), delay);
    else document.body.append(panel);
  });
  trigger.addEventListener('click', toggle); document.querySelector('footer')!.append(trigger);
  return { ...context, panel, toggle };
}
test.each(['cancel', 'send', 'unavailable'])('a picker opened for lookup closes after %s', async outcome => {
  const { connector, panel, toggle, click, snapshot } = ownedPicker();
  try {
    const task = connector.prepare(ticket);
    if (outcome === 'unavailable') snapshot.revision = 'changed';
    await vi.advanceTimersByTimeAsync(100); await task;
    if (outcome === 'cancel') connector.cancel();
    if (outcome === 'send') await connector.send(ticket, Date.now() + 5000);
    expect(panel.isConnected).toBe(false); expect(toggle).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(outcome === 'send' ? 1 : 0);
  } finally { connector.stop(); }
});
test('cancelling during an asynchronous open closes the late picker without sending', async () => {
  const { connector, panel, toggle, click, events } = ownedPicker(150);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(50); connector.cancel();
    await vi.advanceTimersByTimeAsync(250); await task;
    expect(panel.isConnected).toBe(false); expect(toggle).toHaveBeenCalledTimes(2);
    expect(click).not.toHaveBeenCalled(); expect(events).toEqual([]);
  } finally { connector.stop(); }
});
test('a newer lookup shares an opening picker without a stale cancellation closing it', async () => {
  const { connector, panel, toggle, events } = ownedPicker(150);
  try {
    const older = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(50);
    const newer = connector.prepare({ ...ticket, nonce: 'newer' });
    await vi.advanceTimersByTimeAsync(500); await Promise.all([older, newer]);
    expect(panel.isConnected).toBe(true); expect(toggle).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: 'newer', found: true }]);
    connector.cancel(); expect(panel.isConnected).toBe(false);
  } finally { connector.stop(); }
});
test('cancelling preserves a picker already opened by the user', async () => {
  const { connector, click } = setup();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(100); await task;
    connector.cancel(); expect(document.querySelector('[data-testid="expressions-panel"]')).not.toBeNull();
    expect(click).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});

test.each([false, true])('a picker mounting after two seconds is tracked even when cancelled=%s', async cancelled => {
  const { connector, panel, toggle, click, events } = ownedPicker(2200);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(2050);
    expect(events).toEqual([]);
    if (cancelled) connector.cancel();
    await vi.advanceTimersByTimeAsync(350); await task;
    expect(events).toEqual(cancelled ? [] : [{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
    expect(panel.isConnected).toBe(!cancelled); expect(click).not.toHaveBeenCalled();
    connector.cancel(); expect(panel.isConnected).toBe(false); expect(toggle).toHaveBeenCalledTimes(2);
  } finally { connector.stop(); }
});
test('a shared opening uses the latest lookup deadline and emits only the current result', async () => {
  const { connector, panel, toggle, events } = ownedPicker(61_000);
  try {
    const older = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(2000);
    const newer = connector.prepare({ ...ticket, nonce: 'newer' });
    await vi.advanceTimersByTimeAsync(59_100); await Promise.all([older, newer]);
    expect(panel.isConnected).toBe(true); expect(toggle).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: 'newer', found: true }]);
  } finally { connector.stop(); }
});
test('a picker that never mounts stops waiting at the lookup deadline', async () => {
  const { connector, events } = ownedPicker(0);
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Emojis, GIFs, Stickers"]')!;
  trigger.click = vi.fn();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(60_100); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
  } finally { connector.stop(); }
});

test('lookup alone cannot activate a sticker when main denies the click ticket', async () => {
  const authorize = vi.fn(async () => false), { connector, click, events } = setup(authorize);
  try {
    const lookup = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(100); await lookup;
    expect(authorize).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled();
    await connector.send(ticket, Date.now() + 5000);
    expect(authorize).toHaveBeenCalledExactlyOnceWith(ticket.nonce);
    expect(click).not.toHaveBeenCalled(); expect(events.at(-1)).toMatchObject({ type: 'stickerSent', clicked: false });
  } finally { connector.stop(); }
});
test('duplicate dispatch while authorization is pending does not click or publish a competing result', async () => {
  let approve!: (value: boolean) => void;
  const authorize = vi.fn(() => new Promise<boolean>(resolve => { approve = resolve; }));
  const { connector, events, click } = setup(authorize);
  try {
    const lookup = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(100); await lookup;
    const first = connector.send(ticket, Date.now() + 5000);
    await connector.send(ticket, Date.now() + 5000);
    expect(authorize).toHaveBeenCalledTimes(1); expect(events).toHaveLength(1);
    approve(true); await first;
    expect(click).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }, { type: 'stickerSent', nonce: ticket.nonce, clicked: true }]);
  } finally { connector.stop(); }
});
test.each(['send', 'missing'])('a user-opened picker remains open after %s', async outcome => {
  const { connector, button, click, events } = setup();
  try {
    if (outcome === 'missing') button.remove();
    const lookup = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(outcome === 'missing' ? 6100 : 100); await lookup;
    if (outcome === 'send') await connector.send(ticket, Date.now() + 5000);
    expect(document.querySelector('[data-testid="expressions-panel"]')).not.toBeNull();
    expect(click).toHaveBeenCalledTimes(outcome === 'send' ? 1 : 0);
    if (outcome === 'missing') expect(events.at(-1)).toMatchObject({ type: 'stickerPrepared', found: false });
  } finally { connector.stop(); }
});


// A small viewport reproduces large/virtualized native collections without
// mounting thousands of images. The setter controls virtual rows and stalls.
function lookupGrid(button: HTMLElement, height: number, onScroll: (position: number) => void = () => {}, stuck = false, initialPosition = 0) {
  const viewport = document.createElement('div'); viewport.style.overflowY = 'auto';
  viewport.getBoundingClientRect = () => ({ top: 0, bottom: 150 } as DOMRect);
  document.querySelector('[data-testid="expressions-panel"]')!.append(viewport); viewport.append(button);
  Object.defineProperties(viewport, { clientHeight: { value: 150 }, scrollHeight: { value: height } });
  let position = initialPosition;
  const advances = vi.fn((value: number) => { if (!stuck) position = Math.min(height - 150, value); onScroll(position); });
  Object.defineProperty(viewport, 'scrollTop', { get: () => position, set: advances });
  return { viewport, advances };
}
function unrelatedOriginal(connector: StickerTransferConnector, image: HTMLImageElement) {
  image.src = 'data:image/webp;base64,b3RoZXI=';
  connector['verified'].set(image.src, 'b'.repeat(64));
}

test.each(['cap', 'stalled'])('a %s pack yields to Favorites instead of consuming the minute', async mode => {
  const { connector, image, button, events, click } = setup(); unrelatedOriginal(connector, image);
  const { advances } = lookupGrid(button, 6000, () => {}, mode === 'stalled');
  const selected: string[] = [];
  categoryTabs(category => { selected.push(category); image.src = source; });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(18_000); await task;
    expect(selected).toEqual(['panel-starred']);
    expect(advances).toHaveBeenCalledTimes(mode === 'cap' ? 40 : 1);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
    expect(click).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});

test('Recent is searched after a capped pack and exhausted Favorites', async () => {
  const { connector, image, button, events } = setup(); unrelatedOriginal(connector, image);
  const { viewport, advances } = lookupGrid(button, 6000);
  const selected: string[] = [];
  categoryTabs(category => { selected.push(category); viewport.remove(); document.querySelector('[data-testid="expressions-panel"]')!.append(button); if (category === 'panel-recent') image.src = source; });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(20_000); await task;
    expect(advances).toHaveBeenCalledTimes(40); expect(selected).toEqual(['panel-starred', 'panel-recent']);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
  } finally { connector.stop(); }
});

test.each(['pending image', 'empty virtual row'])('a permanent %s cannot prevent later categories from being searched', async state => {
  const { connector, image, button, events } = setup(); unrelatedOriginal(connector, image);
  const { advances, viewport } = lookupGrid(button, 6000);
  if (state === 'pending image') Object.defineProperty(image, 'complete', { value: false, configurable: true });
  else button.remove();
  const selected: string[] = [];
  categoryTabs(category => {
    selected.push(category); viewport.append(button); image.src = source;
    Object.defineProperty(image, 'complete', { value: true, configurable: true });
  });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(20_600); await task;
    expect(advances).toHaveBeenCalled(); expect(selected).toEqual(['panel-starred']);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
  } finally { connector.stop(); }
});

test.each(['pending image', 'empty virtual row'])('bounded waits skip a permanent %s and inspect the next mounted row', async state => {
  const { connector, image, button, events } = setup(); unrelatedOriginal(connector, image);
  const { viewport, advances } = lookupGrid(button, 360, position => {
    if (position > 0) {
      viewport.append(button); image.src = source;
      Object.defineProperty(image, 'complete', { value: true, configurable: true });
    }
  });
  if (state === 'pending image') Object.defineProperty(image, 'complete', { value: false, configurable: true });
  else button.remove();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(15_000); await task;
    expect(advances).toHaveBeenCalledOnce();
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
  } finally { connector.stop(); }
});

test('a user-opened picker resets a pending scrolled row before searching earlier unmounted rows', async () => {
  const { connector, image, button, events } = setup(); unrelatedOriginal(connector, image);
  Object.defineProperty(image, 'complete', { value: false, configurable: true });
  const { advances } = lookupGrid(button, 6000, position => {
    if (position === 0) { image.src = source; Object.defineProperty(image, 'complete', { value: true, configurable: true }); }
  }, false, 3000);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(600); await task;
    expect(advances).toHaveBeenCalledExactlyOnceWith(0);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
    connector.cancel(); expect(document.querySelector('[data-testid="expressions-panel"]')).not.toBeNull();
  } finally { connector.stop(); }
});

test('currently mounted ready originals are matched before resetting a user-scrolled picker', async () => {
  const { connector, button, events } = setup(); const { advances } = lookupGrid(button, 6000, () => {}, false, 3000);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(100); await task;
    expect(advances).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
  } finally { connector.stop(); }
});

test.each(['busy panel', 'busy region', 'progressbar', 'spinner icon', 'loading indicator', 'skeleton', 'absent container'])('Favorites mounting after three seconds with %s is not mistaken for empty', async loadingState => {
  const { connector, image, button, events } = setup(); unrelatedOriginal(connector, image);
  const panel = document.querySelector<HTMLElement>('[data-testid="expressions-panel"]')!;
  const content = panel.querySelector<HTMLElement>('[role="list"]')!;
  const selected: string[] = [];
  categoryTabs(category => {
    selected.push(category); button.remove();
    if (category === 'panel-starred') {
      const loading = document.createElement('div');
      loading.checkVisibility = () => true; loading.getBoundingClientRect = () => ({ width: 100 } as DOMRect);
      if (loadingState === 'busy panel') panel.setAttribute('aria-busy', 'true');
      if (loadingState === 'busy region') loading.setAttribute('aria-busy', 'true');
      if (loadingState === 'progressbar') loading.setAttribute('role', 'progressbar');
      if (loadingState === 'spinner icon') loading.dataset.icon = 'spinner';
      if (loadingState === 'loading indicator') loading.dataset.testid = 'sticker-loading';
      if (loadingState === 'skeleton') loading.dataset.testid = 'sticker-skeleton';
      if (loadingState === 'absent container') content.remove();
      else panel.append(loading);
      setTimeout(() => { loading.remove(); panel.removeAttribute('aria-busy'); image.src = source; panel.append(content); content.append(button); }, 3000);
    }
  });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(5200); await task;
    expect(selected).toEqual(['panel-starred']);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
  } finally { connector.stop(); }
});

test('a category whose content never mounts cannot prove an early miss', async () => {
  const { connector, button, events } = setup();
  button.remove(); document.querySelector('[role="list"]')!.remove();
  categoryTabs();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(59_900);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(200); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
  } finally { connector.stop(); }
});

test('hidden loading markers do not hold a rendered empty category open', async () => {
  const { connector, button, events } = setup(); button.remove(); categoryTabs();
  const loading = document.createElement('div'); loading.dataset.testid = 'sticker-skeleton';
  loading.checkVisibility = () => false; loading.getBoundingClientRect = () => ({ width: 100 } as DOMRect);
  document.querySelector('[data-testid="expressions-panel"]')!.append(loading);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(7100); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
  } finally { connector.stop(); }
});

test('replacing the empty content container restarts its settle window', async () => {
  const { connector, button, events } = setup(); button.remove();
  const content = document.querySelector<HTMLElement>('[role="list"]')!;
  setTimeout(() => {
    const replacement = content.cloneNode() as HTMLElement;
    replacement.checkVisibility = content.checkVisibility; replacement.getBoundingClientRect = content.getBoundingClientRect;
    content.replaceWith(replacement);
  }, 1500);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(3400);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(100); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
  } finally { connector.stop(); }
});

test.each(['cap', 'stalled', 'pending'])('a %s category never proves an early miss, and owned pickers close at the deadline', async mode => {
  const { connector, panel, image, button, events } = ownedPicker(); unrelatedOriginal(connector, image);
  // ownedPicker has detached its panel; mount just long enough to build the grid.
  document.body.append(panel);
  const { viewport } = lookupGrid(button, 6000, () => {}, mode === 'stalled');
  if (mode === 'pending') Object.defineProperty(image, 'complete', { value: false, configurable: true });
  const selected: string[] = [];
  categoryTabs(category => { selected.push(category); viewport.remove(); panel.append(button); Object.defineProperty(image, 'complete', { value: true, configurable: true }); });
  panel.remove();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(59_900);
    expect(selected).toEqual(['panel-starred', 'panel-recent']); expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(200); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
    expect(panel.isConnected).toBe(false);
  } finally { connector.stop(); }
});


test('a slow picker opening still reserves a search slice for Favorites and Recent', async () => {
  const { connector, panel, image, button, events } = ownedPicker(45_000); unrelatedOriginal(connector, image);
  document.body.append(panel); const { viewport } = lookupGrid(button, 6000);
  const selected: string[] = [];
  categoryTabs(category => {
    selected.push(category); viewport.remove(); panel.append(button);
    if (category === 'panel-recent') image.src = source;
  });
  panel.remove();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(53_000); await task;
    expect(selected).toEqual(['panel-starred', 'panel-recent']);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
  } finally { connector.stop(); }
});


test('an explicitly loading empty category stays open beyond the initial mount grace', async () => {
  const { connector, image, button, events } = setup();
  const panel = document.querySelector('[data-testid="expressions-panel"]')!;
  button.remove(); const loading = document.createElement('div'); loading.setAttribute('aria-busy', 'true');
  loading.checkVisibility = () => true; loading.getBoundingClientRect = () => ({ width: 100 } as DOMRect); panel.append(loading);
  setTimeout(() => { loading.remove(); panel.append(button); }, 7000);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(6500);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(600); await task;
    expect(image.scrollIntoView).toHaveBeenCalled();
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
  } finally { connector.stop(); }
});

test.each(['mount grace', 'pending row', 'incomplete remainder'])('cancelling during %s closes only the owned picker', async phase => {
  const { connector, panel, image, button, events, click } = ownedPicker(); unrelatedOriginal(connector, image);
  if (phase === 'mount grace') { button.remove(); panel.setAttribute('aria-busy', 'true'); }
  if (phase === 'pending row') Object.defineProperty(image, 'complete', { value: false });
  if (phase === 'incomplete remainder') {
    document.body.append(panel); lookupGrid(button, 6000, () => {}, true); panel.remove();
  }
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(phase === 'incomplete remainder' ? 2000 : 1000);
    expect(events).toEqual([]); expect(panel.isConnected).toBe(true);
    connector.cancel(); await task;
    expect(panel.isConnected).toBe(false); expect(events).toEqual([]); expect(click).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});

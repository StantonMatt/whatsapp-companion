// @vitest-environment jsdom
import { test, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { StickerTransferConnector } from '../src/connector/sticker-transfer';
import { stickerImageState } from '../src/connector/sticker-image-state';
import { emptySnapshot } from '../src/shared/model';
import type { RemoteEvent } from '../src/shared/connector';
import { stickerLookupDiagnosticsSchema } from '../src/shared/sticker-transfer';
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
  button.addEventListener('click', () => { const row = document.createElement('div'); row.dataset.id = 'true_123@c.us_new'; row.innerHTML = '<div data-testid="sticker-container"></div>'; document.querySelector('#main')!.append(row); });
  const snapshot = { ...emptySnapshot, ...target, conversationOpen: true, ready: true, atBottom: true };
  const events: RemoteEvent[] = [];
  const diagnosticEvents: RemoteEvent[] = [];
  const connector = new StickerTransferConnector(document, () => snapshot, new Map([[source, id]]), e => { diagnosticEvents.push(e); const { diagnostics: _diagnostics, ...event } = e as RemoteEvent & { diagnostics?: unknown }; events.push(event as RemoteEvent); }, authorize);
  return { image, button, snapshot, events, diagnosticEvents, click, connector };
}
test('lookup finds the original without clicking; the click-authorized command activates it once and preserves draft', async () => {
  const { connector, events, click } = setup();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(100); await task;
    expect(events).toContainEqual({ type: 'stickerPrepared', nonce: ticket.nonce, found: true }); expect(click).not.toHaveBeenCalled();
    await connector.send(ticket, Date.now() + 5000); await connector.send(ticket, Date.now() + 5000);
    expect(click).toHaveBeenCalledTimes(1);
    expect(events.slice(-2)).toEqual([{ type: 'stickerSent', nonce: ticket.nonce, clicked: true, confirmed: true }, { type: 'stickerSent', nonce: ticket.nonce, clicked: false, confirmed: false }]);
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
    expect(events.at(-1)).toEqual({ type: 'stickerSent', nonce: ticket.nonce, clicked: false, confirmed: false });
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
    expect(click).not.toHaveBeenCalled(); expect(events.at(-1)).toEqual({ type: 'stickerSent', nonce: ticket.nonce, clicked: false, confirmed: false });
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
    expect(examined).toEqual([0, 210, 210, 210]); expect(position).toBe(210);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
  } finally { connector.stop(); }
});

test('a relevant image loading at the end prevents early missing until it becomes ready', async () => {
  const { connector, image, events } = setup();
  Object.defineProperty(image, 'complete', { value: false, configurable: true });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(1500);
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

function categoryTabs(onSelect: (category: string) => void = () => {}, categories = ['panel-starred', 'panel-recent']) {
  return categories.map(category => {
    const tab = document.createElement('button'); tab.dataset.testid = category;
    tab.checkVisibility = () => true; tab.getBoundingClientRect = document.querySelector('img')?.getBoundingClientRect ?? (() => ({ width: 100 } as DOMRect));
    tab.addEventListener('click', () => onSelect(category));
    document.querySelector('[data-testid="expressions-panel"]')!.append(tab);
    return tab;
  });
}

test('Favorites, Recent and the initially selected pack are searched in that order, with immediate ready-image checks', async () => {
  const { connector, image, button, events, click } = setup();
  const content = button.parentElement!;
  button.remove();
  const started = Date.now(), selected: { category: string; elapsed: number }[] = [];
  const tabs = categoryTabs(category => {
    selected.push({ category, elapsed: Date.now() - started });
    if (category === 'panel-pack') content.append(button);
  }, ['panel-starred', 'panel-recent', 'panel-pack']);
  tabs[2].setAttribute('aria-selected', 'true');
  let elapsed = 0;
  try {
    const task = connector.prepare(ticket).then(() => { elapsed = Date.now() - started; });
    await vi.advanceTimersByTimeAsync(1700); await task;
    expect(selected).toEqual([
      { category: 'panel-starred', elapsed: 0 },
      { category: 'panel-recent', elapsed: 800 },
      { category: 'panel-pack', elapsed: 1600 }
    ]);
    expect(elapsed).toBe(1600);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
    expect(image.scrollIntoView).toHaveBeenCalledOnce(); expect(click).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});

test('already-mounted ready Favorites are checked immediately even while the category reports loading', async () => {
  const { connector, image, events, click } = setup(); unrelatedOriginal(connector, image);
  categoryTabs(category => {
    if (category === 'panel-starred') {
      image.src = source;
      document.querySelector('[data-testid="expressions-panel"]')!.setAttribute('aria-busy', 'true');
    }
  });
  const started = Date.now();
  try {
    await connector.prepare(ticket);
    expect(Date.now() - started).toBe(0);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
    expect(click).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});

test.each(['recent', 'open-pack', 'late-favorites'] as const)('churning Favorites cannot hide an original in %s', async destination => {
  const { connector, image, button, events, diagnosticEvents, click } = setup(); unrelatedOriginal(connector, image);
  const content = button.parentElement!;
  const started = Date.now(), selected: { category: string; elapsed: number }[] = [];
  let active = 'panel-pack';
  let replacement = image;
  const render = () => {
    const next = image.cloneNode() as HTMLImageElement;
    next.checkVisibility = image.checkVisibility; next.getBoundingClientRect = image.getBoundingClientRect;
    next.scrollIntoView = vi.fn();
    Object.defineProperties(next, { complete: { value: true }, naturalWidth: { value: 100 } });
    next.src = (active === 'panel-recent' && destination === 'recent') || (active === 'panel-pack' && destination === 'open-pack') ||
      (active === 'panel-starred' && destination === 'late-favorites' && Date.now() - started >= 5000) ? source : image.src;
    replacement.replaceWith(next); replacement = next;
  };
  const tabs = categoryTabs(category => { active = category; selected.push({ category, elapsed: Date.now() - started }); render(); }, ['panel-starred', 'panel-recent', 'panel-pack']);
  tabs[2].setAttribute('aria-selected', 'true');
  // Replace ready nodes every 500 ms without a loading marker. This resets
  // Favorites' quiet window on every visit, including after the first pass.
  const churn = setInterval(() => { if (active === 'panel-starred') render(); }, 500);
  try {
    const task = connector.prepare(ticket);
    await vi.advanceTimersByTimeAsync(destination === 'late-favorites' ? 14_900 : 4100); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
    const result = diagnosticEvents.at(-1) as Extract<RemoteEvent, { type: 'stickerPrepared' }>;
    expect(result.diagnostics?.totalMs).toBeLessThanOrEqual(destination === 'late-favorites' ? 15_000 : 4000);
    expect(selected[0]).toEqual({ category: 'panel-starred', elapsed: 0 });
    expect(selected[1]).toEqual({ category: 'panel-recent', elapsed: 2000 });
    if (destination !== 'recent') {
      expect(selected[2]).toEqual({ category: 'panel-pack', elapsed: 3500 });
      if (destination === 'late-favorites') expect(selected[3]).toEqual({ category: 'panel-starred', elapsed: 5000 });
    }
    expect(content.contains(replacement)).toBe(true); expect(click).not.toHaveBeenCalled();
  } finally { clearInterval(churn); connector.stop(); }
});

test('all loaded categories with no original settle during the first pass', async () => {
  const { connector, image, events, diagnosticEvents } = setup(); unrelatedOriginal(connector, image);
  const selected: string[] = [];
  const tabs = categoryTabs(category => selected.push(category), ['panel-starred', 'panel-recent', 'panel-pack']);
  tabs[2].setAttribute('aria-selected', 'true');
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(4600); await task;
    expect(selected).toEqual(['panel-starred', 'panel-recent', 'panel-pack']);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
    const result = diagnosticEvents.at(-1) as Extract<RemoteEvent, { type: 'stickerPrepared' }>;
    expect(result.diagnostics?.totalMs).toBe(4500);
    expect(result.diagnostics?.categories.filter(entry => entry.name !== 'current').every(entry => entry.settledMs !== null)).toBe(true);
  } finally { connector.stop(); }
});

test.each([true, false])('categories that finish their quiet window exactly at the slice boundary settle (populated=%s)', async populated => {
  const { connector, image, button, events, diagnosticEvents } = setup(); unrelatedOriginal(connector, image);
  const content = button.parentElement!, panel = document.querySelector('[data-testid="expressions-panel"]')!;
  const selected: string[] = [];
  categoryTabs(category => {
    selected.push(category); button.remove(); panel.setAttribute('aria-busy', 'true');
    setTimeout(() => {
      panel.removeAttribute('aria-busy');
      if (populated) content.append(button);
    }, populated ? 500 : 1200);
  });
  try {
    const task = connector.prepare(ticket);
    await vi.advanceTimersByTimeAsync(3999); expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await task;
    expect(selected).toEqual(['panel-starred', 'panel-recent']);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
    const result = diagnosticEvents.at(-1) as Extract<RemoteEvent, { type: 'stickerPrepared' }>;
    expect(result.diagnostics?.totalMs).toBe(4000);
    expect(result.diagnostics?.categories.filter(entry => entry.name !== 'current').map(entry => entry.settledMs)).toEqual([2000, 4000]);
  } finally { connector.stop(); }
});

test.each(['unchanged', 'replacement', 'loading'] as const)('a continuously active category keeps settling across slices while respecting %s content', async change => {
  const { connector, image, button, events, diagnosticEvents } = setup(); unrelatedOriginal(connector, image);
  const content = button.parentElement!, panel = document.querySelector('[data-testid="expressions-panel"]')!;
  const selected: string[] = [];
  categoryTabs(category => {
    selected.push(category); button.remove(); panel.setAttribute('aria-busy', 'true');
    setTimeout(() => { content.append(button); panel.removeAttribute('aria-busy'); }, 600);
  }, ['panel-starred']);
  if (change === 'replacement') setTimeout(() => {
    const replacement = image.cloneNode() as HTMLImageElement;
    replacement.checkVisibility = image.checkVisibility; replacement.getBoundingClientRect = image.getBoundingClientRect;
    Object.defineProperties(replacement, { complete: { value: true }, naturalWidth: { value: 100 } });
    image.replaceWith(replacement);
  }, 2050);
  if (change === 'loading') {
    setTimeout(() => panel.setAttribute('aria-busy', 'true'), 2050);
    setTimeout(() => panel.removeAttribute('aria-busy'), 2250);
  }
  const expected = change === 'unchanged' ? 2100 : change === 'replacement' ? 3600 : 3800;
  try {
    const task = connector.prepare(ticket);
    await vi.advanceTimersByTimeAsync(expected - 1); expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await task;
    expect(selected).toEqual(['panel-starred']);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
    const result = diagnosticEvents.at(-1) as Extract<RemoteEvent, { type: 'stickerPrepared' }>;
    expect(result.diagnostics?.totalMs).toBe(expected);
  } finally { connector.stop(); }
});

test('every category keeps loading but the total 15-second cap reports missing and closes the owned picker', async () => {
  const { connector, panel, button, events, click } = ownedPicker();
  document.body.append(panel); button.remove();
  const started = Date.now(), selected: { category: string; elapsed: number }[] = [];
  const tabs = categoryTabs(category => selected.push({ category, elapsed: Date.now() - started }), ['panel-starred', 'panel-recent', 'panel-pack']);
  tabs[2].setAttribute('aria-selected', 'true');
  panel.setAttribute('aria-busy', 'true'); panel.remove();
  let elapsed = 0;
  try {
    const task = connector.prepare(ticket).then(() => { elapsed = Date.now() - started; });
    await vi.advanceTimersByTimeAsync(14_900);
    expect(events).toEqual([]); expect(panel.isConnected).toBe(true);
    expect(selected.slice(0, 3)).toEqual([
      { category: 'panel-starred', elapsed: 0 },
      { category: 'panel-recent', elapsed: 2000 },
      { category: 'panel-pack', elapsed: 4000 }
    ]);
    await vi.advanceTimersByTimeAsync(100); await task;
    expect(elapsed).toBeLessThanOrEqual(15_000);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
    expect(panel.isConnected).toBe(false); expect(click).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(selected.length).toBeGreaterThanOrEqual(3); expect(events).toHaveLength(1);
  } finally { connector.stop(); }
});

test('a picker opening at the total deadline cannot activate the remaining category tabs', async () => {
  const { connector, panel, events, click } = ownedPicker(14_800);
  document.body.append(panel);
  const selected: string[] = [];
  categoryTabs(category => selected.push(category));
  const stickerTab = document.createElement('button'); stickerTab.dataset.testid = 'expressions-btn-sticker'; panel.append(stickerTab);
  panel.remove();
  const started = Date.now();
  let elapsed = 0;
  try {
    const task = connector.prepare(ticket).then(() => { elapsed = Date.now() - started; });
    await vi.advanceTimersByTimeAsync(15_000); await task;
    expect(elapsed).toBeLessThanOrEqual(15_000);
    expect(selected).toEqual([]); expect(click).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
    expect(panel.isConnected).toBe(false);
  } finally { connector.stop(); }
});

test('all empty categories report missing after their short settle windows instead of the deadline', async () => {
  const { connector, button, events, click } = setup();
  const selected: string[] = []; categoryTabs(category => selected.push(category)).forEach(tab => tab.setAttribute('aria-selected', 'true')); button.remove();
  try {
    const task = connector.prepare(ticket);
    await vi.advanceTimersByTimeAsync(3000); await task;
    expect(selected).toEqual(['panel-starred', 'panel-recent']);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
    expect(click).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});

test('the hidden-sticker desktop fixture reports missing within three seconds', async () => {
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
    await vi.advanceTimersByTimeAsync(3400); await task;
    expect(activated).toEqual([0, 1400]);
    expect(elapsed).toBe(2800);
    expect(elapsed).toBeLessThanOrEqual(3000);
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
    expect(examined).toEqual([0, 210, 210, 210]); expect(position).toBe(210);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
  } finally { connector.stop(); }
});

test('Favorites can expand during its quiet window after switching from the open pack', async () => {
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
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(500);
    expect(selected).toEqual(['panel-starred']); expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1600); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
  } finally { connector.stop(); }
});

test('switching to Favorites cannot reuse an empty list before delayed rows mount', async () => {
  const { connector, button, events } = setup();
  const content = button.parentElement!; button.remove();
  categoryTabs(category => {
    if (category === 'panel-starred') {
      content.setAttribute('aria-busy', 'true');
      setTimeout(() => { content.removeAttribute('aria-busy'); content.append(button); }, 1400);
    }
  });
  try {
    const task = connector.prepare(ticket);
    await vi.advanceTimersByTimeAsync(1300);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(200); await task;
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
  setTimeout(() => { loaded = true; if (found) image.src = source; }, 600);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(500);
    expect(events).toEqual([]); expect(position).toBe(0);
    await vi.advanceTimersByTimeAsync(300);
    if (!found) expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(5300); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found }]);
  } finally { connector.stop(); }
});

test('an image starting to load at the end restarts the settle window once ready', async () => {
  const { connector, image, events } = setup();
  image.src = 'data:image/webp;base64,b3RoZXI='; connector['verified'].set(image.src, 'b'.repeat(64));
  let loaded = true;
  Object.defineProperty(image, 'complete', { get: () => loaded });
  setTimeout(() => { loaded = false; }, 400);
  setTimeout(() => { loaded = true; }, 700);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(1400);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(4700); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
  } finally { connector.stop(); }
});

test('images that never finish loading remain bounded by the 15-second deadline', async () => {
  const { connector, image, events } = setup();
  Object.defineProperty(image, 'complete', { value: false });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(14_900);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(200); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
  } finally { connector.stop(); }
});

test.each([false, true])('the 15-second deadline still bounds an endlessly growing picker (at end=%s)', async atEnd => {
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
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(14_900);
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
  const { connector, panel, toggle, events } = ownedPicker(7000);
  try {
    const older = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(2000);
    const newer = connector.prepare({ ...ticket, nonce: 'newer' });
    await vi.advanceTimersByTimeAsync(5100); await Promise.all([older, newer]);
    expect(panel.isConnected).toBe(true); expect(toggle).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: 'newer', found: true }]);
  } finally { connector.stop(); }
});
test('a picker that never mounts stops waiting at the lookup deadline', async () => {
  const { connector, events } = ownedPicker(0);
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Emojis, GIFs, Stickers"]')!;
  trigger.click = vi.fn();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(15_100); await task;
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
    expect(click).not.toHaveBeenCalled(); expect(events.at(-1)).toMatchObject({ type: 'stickerSent', clicked: false, confirmed: false });
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
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }, { type: 'stickerClicked', nonce: ticket.nonce }, { type: 'stickerSent', nonce: ticket.nonce, clicked: true, confirmed: true }]);
  } finally { connector.stop(); }
});
test.each(['send', 'missing'])('a user-opened picker remains open after %s', async outcome => {
  const { connector, button, click, events } = setup();
  try {
    if (outcome === 'missing') button.remove();
    const lookup = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(outcome === 'missing' ? 15_100 : 100); await lookup;
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

test('round-robin visits resume a long virtual Favorites grid after searching Recent', async () => {
  const { connector, image, button, events } = setup(); unrelatedOriginal(connector, image);
  const panel = document.querySelector('[data-testid="expressions-panel"]')!;
  const content = button.parentElement!;
  let active = 'panel-pack';
  const { viewport, advances } = lookupGrid(button, 1200, position => {
    image.src = active === 'panel-starred' && position >= 900 ? source : 'data:image/webp;base64,b3RoZXI=';
  });
  const selected: string[] = [];
  categoryTabs(category => {
    active = category; selected.push(category);
    if (category === 'panel-starred') { panel.append(viewport); viewport.append(button); advances(0); }
    else { viewport.remove(); content.append(button); image.src = 'data:image/webp;base64,b3RoZXI='; }
  });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(7000); await task;
    expect(selected.slice(0, 3)).toEqual(['panel-starred', 'panel-recent', 'panel-starred']);
    expect(selected.slice(3).every(category => category === 'panel-starred')).toBe(true);
    expect(advances.mock.calls.some(([position]) => position >= 900)).toBe(true);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
  } finally { connector.stop(); }
});

test('a very late picker opening reserves time for an unsearched Recent category', async () => {
  const { connector, panel, image, events } = ownedPicker(14_000); unrelatedOriginal(connector, image);
  document.body.append(panel);
  const started = Date.now(), selected: { category: string; elapsed: number }[] = [];
  categoryTabs(category => {
    selected.push({ category, elapsed: Date.now() - started });
    if (category === 'panel-starred') panel.setAttribute('aria-busy', 'true');
    else { panel.removeAttribute('aria-busy'); image.src = source; }
  });
  panel.remove();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(14_900); await task;
    expect(selected).toEqual([{ category: 'panel-starred', elapsed: 14_000 }, { category: 'panel-recent', elapsed: 14_500 }]);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
  } finally { connector.stop(); }
});

test.each(['cap', 'stalled'])('Favorites is searched before a %s open pack', async mode => {
  const { connector, image, button, events, click } = setup(); unrelatedOriginal(connector, image);
  const { advances } = lookupGrid(button, 6000, () => {}, mode === 'stalled');
  const selected: string[] = [];
  categoryTabs(category => { selected.push(category); image.src = source; });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(100); await task;
    expect(selected).toEqual(['panel-starred']);
    expect(advances).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
    expect(click).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});

test('Recent is searched after exhausted Favorites without scanning the initial pack first', async () => {
  const { connector, image, button, events } = setup(); unrelatedOriginal(connector, image);
  const { viewport, advances } = lookupGrid(button, 6000);
  const selected: string[] = [];
  categoryTabs(category => { selected.push(category); viewport.remove(); document.querySelector('[data-testid="expressions-panel"]')!.append(button); if (category === 'panel-recent') image.src = source; });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(1600); await task;
    expect(advances).not.toHaveBeenCalled(); expect(selected).toEqual(['panel-starred', 'panel-recent']);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
  } finally { connector.stop(); }
});

test.each(['pending image', 'empty virtual row'])('a permanent %s in Favorites cannot prevent Recent from being searched', async state => {
  const { connector, image, button, events } = setup(); unrelatedOriginal(connector, image);
  const { advances, viewport } = lookupGrid(button, 6000);
  if (state === 'pending image') Object.defineProperty(image, 'complete', { value: false, configurable: true });
  else button.remove();
  const selected: string[] = [];
  categoryTabs(category => {
    selected.push(category);
    if (category !== 'panel-recent') return;
    viewport.append(button); image.src = source;
    Object.defineProperty(image, 'complete', { value: true, configurable: true });
  });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(4100); await task;
    expect(advances).toHaveBeenCalled(); expect(selected).toEqual(['panel-starred', 'panel-recent']);
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

test.each(['busy panel', 'busy region', 'progressbar', 'spinner icon', 'loading indicator', 'skeleton', 'absent container'])('Favorites mounting within the loading grace with %s is not mistaken for empty', async loadingState => {
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
      setTimeout(() => { loading.remove(); panel.removeAttribute('aria-busy'); image.src = source; panel.append(content); content.append(button); }, 1400);
    }
  });
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(1500); await task;
    expect(selected).toEqual(['panel-starred']);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
  } finally { connector.stop(); }
});

test('a category whose content never mounts cannot prove an early miss', async () => {
  const { connector, button, events } = setup();
  button.remove(); document.querySelector('[role="list"]')!.remove();
  categoryTabs();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(14_900);
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
  }, 600);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(1300);
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
  categoryTabs(category => {
    selected.push(category);
    if (category === 'panel-recent') { viewport.remove(); panel.append(button); Object.defineProperty(image, 'complete', { value: true, configurable: true }); }
    else { panel.append(viewport); viewport.append(button); if (mode === 'pending') Object.defineProperty(image, 'complete', { value: false, configurable: true }); }
  });
  panel.remove();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(14_900);
    expect(selected).toContain('panel-starred'); expect(selected).toContain('panel-recent'); expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(200); await task;
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: false }]);
    expect(panel.isConnected).toBe(false);
  } finally { connector.stop(); }
});


test('a slow picker opening still reserves a search slice for Favorites and Recent', async () => {
  const { connector, panel, image, button, events } = ownedPicker(4500); unrelatedOriginal(connector, image);
  document.body.append(panel); const { viewport } = lookupGrid(button, 6000);
  const selected: string[] = [];
  categoryTabs(category => {
    selected.push(category); viewport.remove(); panel.append(button);
    if (category === 'panel-recent') image.src = source;
  });
  panel.remove();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(14_900); await task;
    expect(selected).toEqual(['panel-starred', 'panel-recent']);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
  } finally { connector.stop(); }
});

test.each(['recent', 'open-pack'] as const)('a picker opening at 14 seconds reserves the remaining first-pass time for %s despite requeues', async destination => {
  const { connector, panel, image, events, click } = ownedPicker(14_000); unrelatedOriginal(connector, image);
  document.body.append(panel); panel.setAttribute('aria-busy', 'true');
  const started = Date.now(), selected: { category: string; elapsed: number }[] = [];
  const categories = destination === 'recent' ? ['panel-starred', 'panel-recent'] : ['panel-starred', 'panel-recent', 'panel-pack'];
  let active = 'panel-pack';
  const tabs = categoryTabs(category => {
    active = category; selected.push({ category, elapsed: Date.now() - started });
    image.src = 'data:image/webp;base64,b3RoZXI=';
    const wanted = destination === 'recent' ? 'panel-recent' : 'panel-pack';
    if (category === wanted) setTimeout(() => { if (active === wanted) image.src = source; }, destination === 'recent' ? 300 : 200);
  }, categories);
  if (destination === 'open-pack') tabs[2].setAttribute('aria-selected', 'true');
  panel.remove();
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(15_000); await task;
    expect(selected).toEqual(destination === 'recent' ? [
      { category: 'panel-starred', elapsed: 14_000 }, { category: 'panel-recent', elapsed: 14_500 }
    ] : [
      { category: 'panel-starred', elapsed: 14_000 }, { category: 'panel-recent', elapsed: 14_333 }, { category: 'panel-pack', elapsed: 14_666 }
    ]);
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
    expect(click).not.toHaveBeenCalled();
  } finally { connector.stop(); }
});

test('synchronous DOM reads crossing the lookup cap produce bounded diagnostic offsets', async () => {
  const { connector, image, diagnosticEvents } = setup(); unrelatedOriginal(connector, image);
  categoryTabs(() => { image.src = source; }, ['panel-starred']);
  const started = Date.now();
  // The ready-image diagnostic read can finish after the deadline even when
  // the immediately preceding match was found within the lookup budget.
  let readyReads = 0;
  Object.defineProperty(image, 'complete', { configurable: true, get: () => {
    if (image.src === source && ++readyReads === 3) vi.setSystemTime(started + 15_010);
    return true;
  } });
  try {
    await connector.prepare(ticket);
    const result = diagnosticEvents.at(-1) as Extract<RemoteEvent, { type: 'stickerPrepared' }>;
    expect(result.found).toBe(true);
    expect(result.diagnostics?.categories.find(entry => entry.name === 'favorites')?.firstImageMs).toBe(15_000);
    expect(stickerLookupDiagnosticsSchema.safeParse(result.diagnostics).success).toBe(true);
  } finally { connector.stop(); }
});


test('a late ready original remains discoverable within the total budget after the mount grace', async () => {
  const { connector, image, button, events } = setup();
  const panel = document.querySelector('[data-testid="expressions-panel"]')!;
  button.remove(); const loading = document.createElement('div'); loading.setAttribute('aria-busy', 'true');
  loading.checkVisibility = () => true; loading.getBoundingClientRect = () => ({ width: 100 } as DOMRect); panel.append(loading);
  setTimeout(() => { loading.remove(); panel.append(button); }, 5000);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(4900);
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


test.each(['no-selected-control', 'ambiguous-selected-controls'] as const)('ready originals in the visible pack are checked before switching categories with %s', async selection => {
  const { connector, image, events, click } = setup();
  const selected = vi.fn();
  const tabs = categoryTabs(category => { selected(category); image.remove(); }, ['panel-starred', 'panel-recent', 'panel-pack', 'another-pack']);
  if (selection === 'ambiguous-selected-controls') for (const tab of tabs.slice(2)) tab.setAttribute('aria-selected', 'true');
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(100); await task;
    expect(selected).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'stickerPrepared', nonce: ticket.nonce, found: true }]);
    await connector.send(ticket, Date.now() + 5000); expect(click).toHaveBeenCalledOnce();
  } finally { connector.stop(); }
});

test.each(['no-selected-control', 'ambiguous-selected-controls'] as const)('initial pack pending original becomes ready before leaving %s', async controls => {
  const { connector, image, events } = setup();
  Object.defineProperty(image, 'complete', { value: false, configurable: true });
  const switches: string[] = [];
  categoryTabs(category => { switches.push(category); image.src = 'data:image/webp;base64,bWlzc2luZw=='; });
  if (controls === 'ambiguous-selected-controls') {
    const panel = document.querySelector('[data-testid="expressions-panel"]')!;
    panel.insertAdjacentHTML('beforeend', '<button role="tab" aria-selected="true">Pack one</button><button role="tab" aria-selected="true">Pack two</button>');
    for (const tab of panel.querySelectorAll<HTMLElement>('[role="tab"]')) { tab.checkVisibility = () => true; tab.getBoundingClientRect = () => ({ width: 100 } as DOMRect); }
  }
  setTimeout(() => Object.defineProperty(image, 'complete', { value: true, configurable: true }), 600);
  try {
    const task = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(700); await task;
    expect(events.at(-1)).toMatchObject({ type: 'stickerPrepared', found: true }); expect(switches).toEqual([]);
  } finally { connector.stop(); }
});

test.each(['new', 'old-alias-remount', 'incoming', 'quoted', 'chat-change'] as const)('picker confirmation reports %s explicitly after native activation', async result => {
  const { connector, button, events, snapshot, click } = setup();
  const old = document.createElement('div'); old.dataset.id = 'true_123@c.us_old'; old.dataset.testid = 'conv-msg-OLD';
  old.innerHTML = '<span aria-label="You:"></span><div data-testid="sticker-container"></div>'; document.querySelector('#main')!.append(old);
  button.addEventListener('click', () => {
    document.querySelector('[data-id="true_123@c.us_new"]')?.remove();
    if (result === 'chat-change') { snapshot.chatId = '456@c.us'; return; }
    setTimeout(() => {
      const row = document.createElement('div');
      row.dataset.id = result === 'incoming' ? 'false_123@c.us_new' : 'true_123@c.us_new';
      row.innerHTML = '<div data-testid="sticker-container"></div>';
      if (result === 'quoted') row.innerHTML = '<div data-testid="quoted-message">' + row.innerHTML + '</div>';
      if (result === 'old-alias-remount') { delete row.dataset.id; row.dataset.testid = 'conv-msg-OLD'; row.innerHTML = old.innerHTML; old.remove(); }
      document.querySelector('#main')!.append(row);
    }, 500);
  });
  try {
    const preparation = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(100); await preparation;
    const sending = connector.send(ticket, Date.now() + 5000); await vi.advanceTimersByTimeAsync(4200); await sending;
    expect(click).toHaveBeenCalledOnce(); expect(events).toContainEqual({ type: 'stickerClicked', nonce: ticket.nonce });
    expect(events.at(-1)).toMatchObject({ type: 'stickerSent', clicked: true, confirmed: result === 'new', ...(result !== 'new' ? { reason: 'unconfirmed', detail: 'confirm-timeout' } : {}) });
    expect(document.querySelector('[contenteditable]')!.textContent).toBe('keep my draft');
  } finally { connector.stop(); }
});


test('picker opening cannot forget the aliases of a virtualized old message', async () => {
  const { connector, button, events } = setup();
  const old = document.createElement('div'); old.dataset.id = 'true_123@c.us_old'; old.dataset.testid = 'conv-msg-OLD';
  old.innerHTML = '<span aria-label="You:"></span><div data-testid="sticker-container"></div>'; document.querySelector('#main')!.append(old);
  button.addEventListener('click', () => {
    document.querySelector('[data-id="true_123@c.us_new"]')?.remove();
    delete old.dataset.id; document.querySelector('#main')!.append(old);
  });
  try {
    const preparation = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(100); await preparation;
    old.remove();
    const sending = connector.send(ticket, Date.now() + 5000); await vi.advanceTimersByTimeAsync(4200); await sending;
    expect(events.at(-1)).toMatchObject({ clicked: true, confirmed: false, reason: 'unconfirmed' });
  } finally { connector.stop(); }
});

test.each(['history-above', 'append', 'away-from-bottom', 'smooth-scroll', 'grouped', 'grouped-no-id', 'grouped-prepend'] as const)('picker confirmation requires the last outgoing sticker to follow the baseline: %s', async placement => {
  const s = setup();
  const main = document.querySelector('#main')!;
  const baseline = document.createElement('div'); baseline.dataset.id = 'false_123@c.us_baseline'; main.append(baseline);
  if (placement.startsWith('grouped')) {
    baseline.dataset.id = 'grouped-stic-existing'; baseline.dataset.testid = 'conv-msg-GROUP';
    baseline.innerHTML = '<span aria-label="You:"></span><div data-testid="grouped-sticker-item"><div data-testid="sticker-container"></div></div>';
  }
  // Override the fixture's immediate append to simulate mounting a history row.
  s.button.addEventListener('click', () => {
    const row = document.querySelector('[data-id="true_123@c.us_new"]')!;
    row.remove();
    setTimeout(() => {
      if (placement === 'history-above') main.insertBefore(row, baseline);
      else if (placement.startsWith('grouped')) {
        row.setAttribute('data-testid', 'grouped-sticker-item');
        if (placement === 'grouped-no-id') row.removeAttribute('data-id');
        placement === 'grouped-prepend' ? baseline.prepend(row) : baseline.append(row);
      } else main.append(row);
      if (placement === 'away-from-bottom' || placement === 'smooth-scroll') {
        const viewport = document.createElement('div'); viewport.style.overflowY = 'auto'; main.append(viewport); viewport.append(baseline, row);
        Object.defineProperties(viewport, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 }, scrollTop: { value: placement === 'smooth-scroll' ? 705 : 0 } });
        s.snapshot.atBottom = false;
      }
    }, 400);
  });
  try {
    await s.connector.prepare(ticket);
    const task = s.connector.send(ticket, Date.now() + 5000); await vi.advanceTimersByTimeAsync(4200); await task;
    expect(s.events.at(-1)).toMatchObject({ clicked: true, confirmed: !['history-above', 'grouped-prepend'].includes(placement) });
  } finally { s.connector.stop(); }
});

test.each(['new-row', 'promoted-single', 'existing-group'] as const)('picker confirms the desktop fixture shape: %s', async shape => {
  const s = setup();
  const messages = document.createElement('div'); messages.className = 'messages'; document.querySelector('#main')!.append(messages);
  const fixture = readFileSync('tests/fixtures/whatsapp.html', 'utf8');
  const script = fixture.slice(fixture.indexOf('function appendSticker('), fixture.indexOf('// Single-frame animated WebP'));
  const append = window.eval(`(() => { let peer = '123@c.us', sequence = 0; ${script}; return appendSticker; })()`) as (source: string) => void;
  if (shape !== 'new-row') append(source);
  if (shape === 'existing-group') append(source);
  const previousRow = messages.lastElementChild;
  s.button.addEventListener('click', () => {
    document.querySelector('[data-id="true_123@c.us_new"]')!.remove();
    append(source);
  });
  try {
    await s.connector.prepare(ticket);
    await s.connector.send(ticket, Date.now() + 5000);
    expect(s.events.at(-1)).toMatchObject({ clicked: true, confirmed: true });
    expect(messages.querySelectorAll('[role="row"]')).toHaveLength(1);
    expect(messages.querySelectorAll('[data-testid="grouped-sticker-item"]')).toHaveLength(shape === 'new-row' ? 0 : shape === 'promoted-single' ? 2 : 3);
    if (previousRow) expect(messages.lastElementChild).toBe(previousRow);
  } finally { s.connector.stop(); }
});

test.each(['sticker', 'text'] as const)('only the last outgoing sticker can confirm, even with later outgoing %s', async laterContent => {
  const s = setup();
  const main = document.querySelector('#main')!;
  const old = document.createElement('div'); old.dataset.id = 'true_123@c.us_old';
  old.innerHTML = '<div data-testid="sticker-container"></div>'; main.append(old);
  s.button.addEventListener('click', () => {
    if (laterContent === 'text') {
      const text = document.createElement('div'); text.dataset.id = 'true_123@c.us_later-text'; text.textContent = 'later text'; main.append(text);
    } else {
      // A previously known sticker remounts after the candidate.
      main.append(old);
    }
  });
  try {
    await s.connector.prepare(ticket);
    const task = s.connector.send(ticket, Date.now() + 5000); await vi.advanceTimersByTimeAsync(4200); await task;
    expect(s.events.at(-1)).toMatchObject({ clicked: true, confirmed: laterContent === 'text' });
  } finally { s.connector.stop(); }
});

test.each([3000, 5000, 8000, -1])('cold fixture picker loads at %s ms without a false missing result', async delay => {
  const { connector, events, diagnosticEvents, click } = setup();
  const fixture = readFileSync('tests/fixtures/whatsapp.html', 'utf8');
  document.body.innerHTML = fixture;
  const script = fixture.match(/<script>([\s\S]*?)<\/script>/)![1];
  window.eval(`let peer = '123456@c.us';\n${script.slice(script.indexOf('window.fixtureStickerSent=[];'))}`);
  Object.assign(window, { fixtureStickerSource: source, fixtureHideSticker: false, fixtureColdPickerDelay: delay, fixturePickerCache: {} });
  const show = () => {
    for (const element of document.querySelectorAll<HTMLElement>('*')) {
      element.checkVisibility = () => true;
      element.getBoundingClientRect = () => ({ width: 100, height: 100, top: 0, bottom: 100 } as DOMRect);
    }
    for (const image of document.querySelectorAll('img')) {
      Object.defineProperties(image, { complete: { value: true, configurable: true }, naturalWidth: { value: 100, configurable: true } });
      image.scrollIntoView = vi.fn();
    }
  };
  show();
  document.querySelector('[aria-label="Emojis, GIFs, Stickers"]')!.addEventListener('click', () => {
    // Category activation may mount rows synchronously at a slice boundary,
    // before the MutationObserver can install JSDOM's visibility stubs.
    for (const tab of document.querySelectorAll('[data-testid="panel-starred"], [data-testid="panel-recent"]')) tab.addEventListener('click', show);
  });
  const observer = new MutationObserver(show); observer.observe(document.body, { childList: true, subtree: true });
  const started = Date.now();
  try {
    const task = connector.prepare(ticket);
    await vi.advanceTimersByTimeAsync(delay < 0 ? 14_900 : delay - 100);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(200); await task;
    expect(events.at(-1)).toMatchObject({ type: 'stickerPrepared', found: delay > 0 });
    const result = diagnosticEvents.at(-1) as Extract<RemoteEvent, { type: 'stickerPrepared' }>;
    expect(result.diagnostics?.totalMs).toBeGreaterThanOrEqual(delay < 0 ? 15_000 : delay);
    expect(result.diagnostics?.totalMs).toBeLessThanOrEqual(15_000);
    expect(result.diagnostics?.categories.some(entry => entry.loadingSeen)).toBe(true);
    if (delay < 0) expect(result.diagnostics?.totalMs).toBe(15_000);
    else expect(result.diagnostics?.categories.some(entry => entry.found && entry.firstImageMs !== null)).toBe(true);
    expect(click).not.toHaveBeenCalled();
  } finally { observer.disconnect(); connector.stop(); Object.assign(window, { fixtureColdPickerDelay: 0, fixturePickerCache: {} }); }
});

test('a fresh animated search after a miss finds the now-loaded original', async () => {
  const { connector, image, button, events } = setup();
  const content = button.parentElement!;
  button.remove(); categoryTabs();
  try {
    const first = connector.prepare(ticket); await vi.advanceTimersByTimeAsync(1700); await first;
    expect(events.at(-1)).toMatchObject({ type: 'stickerPrepared', found: false });
    content.append(button);
    await connector.prepare({ ...ticket, nonce: 'retry' });
    expect(events.at(-1)).toMatchObject({ type: 'stickerPrepared', nonce: 'retry', found: true });
    expect(image.scrollIntoView).toHaveBeenCalledOnce();
  } finally { connector.stop(); }
});

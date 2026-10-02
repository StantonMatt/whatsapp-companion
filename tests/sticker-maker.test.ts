// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Conversations } from '../src/main/conversations';
import type { Store } from '../src/main/store';
import { initialState } from '../src/shared/model';
import { storedSticker } from '../src/main/sticker-bytes';
import { StickerTransfer } from '../src/core/sticker-transfer';
import { actionSchema, emptySnapshot } from '../src/shared/model';
import { DomConnector, readDraft } from '../src/connector/dom';
import { StickerTransferConnector } from '../src/connector/sticker-transfer';
import type { RemoteEvent } from '../src/shared/connector';
import { STICKER_MAKER_PREPARATION_MS, STICKER_MAKER_CONFIRMATION_MS, type StickerAuthorization } from '../src/shared/sticker-transfer';
import { emptyComposers } from './fixtures/empty-composers';

function webp(animated = false) {
  const chunk = Buffer.alloc(8 + (animated ? 6 : 4));
  chunk.write(animated ? 'ANIM' : 'VP8 ', 0); chunk.writeUInt32LE(chunk.length - 8, 4);
  const bytes = Buffer.alloc(12 + chunk.length); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WEBP', 8); chunk.copy(bytes, 12);
  return { bytes, image: 'data:image/webp;base64,' + bytes.toString('base64'), id: createHash('sha256').update(bytes).digest('hex') };
}
const nonce = '550e8400-e29b-41d4-a716-446655440000';
const snapshot = { ...emptySnapshot, chatId: '123@c.us', settingsId: '123@c.us', name: 'A friend', revision: '1', conversationOpen: true, ready: true, draft: '', composerEmpty: true, atBottom: true };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('main walks RIFF chunks for animation and rejects mismatched, oversized and malformed bytes', () => {
  for (const animated of [false, true]) { const sticker = webp(animated); expect(storedSticker(sticker.image, sticker.id).animated).toBe(animated); }
  const staticSticker = webp(); staticSticker.bytes.write('ANIM', 20);
  const embedded = { image: 'data:image/webp;base64,' + staticSticker.bytes.toString('base64'), id: createHash('sha256').update(staticSticker.bytes).digest('hex') };
  expect(storedSticker(embedded.image, embedded.id).animated).toBe(false);
  expect(() => storedSticker(webp().image, 'a'.repeat(64))).toThrow('hash');
  expect(() => storedSticker('data:image/webp;base64,' + Buffer.alloc(1024 * 1024 + 1).toString('base64'), 'a'.repeat(64))).toThrow();
  const bad = webp(); bad.bytes.writeUInt32LE(1000, 16);
  expect(() => storedSticker('data:image/webp;base64,' + bad.bytes.toString('base64'), createHash('sha256').update(bad.bytes).digest('hex'))).toThrow('chunk');
});
test('still is an explicit true-only validated action', () => {
  const action = { type: 'sendSticker', id: webp(true).id, nonce, destinationToken: '1' };
  expect(actionSchema.safeParse({ ...action, still: true }).success).toBe(true);
  expect(actionSchema.safeParse({ ...action, still: false }).success).toBe(false);
});
function makerTransfer() {
  const engine = new StickerTransfer(); const destination = engine.destinationToken(snapshot);
  engine.begin(webp().id, nonce, destination, snapshot, 0, 'maker', false);
  return { engine, destination };
}
test('maker disclosure and final Send permissions are separate and one-use; preparation is cancellable until authorized', () => {
  const { engine, destination } = makerTransfer();
  expect(engine.send).toMatchObject({ route: 'maker', animated: false, state: 'preparing' });
  expect(engine.authorize(nonce, snapshot, 1)).toBe(false);
  expect(engine.disclose(nonce, snapshot, 1)).toBe(true);
  expect(engine.disclose(nonce, snapshot, 2)).toBe(false);
  const editor = { ...snapshot, revision: '2', ready: false, draft: '', stickerPreparation: nonce };
  expect(engine.observe(editor, 3)).toBe(false);
  expect(engine.destinationToken(editor)).toBe(destination);
  expect(engine.authorize(nonce, editor, 4)).toBe(true);
  expect(engine.authorize(nonce, editor, 5)).toBe(false);
  expect(engine.send?.state).toBe('sending'); expect(engine.cancel()).toBe(false);
  engine.clicked(nonce); expect(engine.send?.state).toBe('sending'); expect(engine.cancel()).toBe(false);
  engine.result(nonce, true, true); expect(engine.send).toMatchObject({ state: 'sent' }); expect(engine.send?.reason).toBeUndefined();
});
test.each(['missing-marker', 'wrong-marker', 'chat', 'scope', 'name', 'composing'])('preparation cannot preserve continuity through %s', change => {
  const { engine } = makerTransfer(); engine.disclose(nonce, snapshot, 1);
  const editor = { ...snapshot, revision: '2', ready: false, stickerPreparation: nonce };
  if (change === 'missing-marker') delete (editor as Partial<typeof editor>).stickerPreparation;
  if (change === 'wrong-marker') editor.stickerPreparation = 'wrong';
  if (change === 'chat') editor.chatId = '456@c.us';
  if (change === 'scope') editor.settingsId = '456@c.us';
  if (change === 'name') editor.name = 'B';
  if (change === 'composing') editor.composing = true;
  expect(engine.observe(editor, 2)).toBe(true); expect(engine.send).toMatchObject(change === 'composing' ? { state: 'failed', reason: 'draft', detail: 'draft-appeared' } : { state: 'cancelled', reason: 'chat-changed' });
  expect(engine.authorize(nonce, editor, 3)).toBe(false);
});
test('preparing timeout reports editor-unavailable and cancellation revokes both permissions', () => {
  const { engine } = makerTransfer(); expect(engine.timeout(nonce)).toBe(true); expect(engine.send).toMatchObject({ state: 'failed', reason: 'editor-unavailable' });
  const next = makerTransfer().engine; next.disclose(nonce, snapshot, 1);
  const editor = { ...snapshot, revision: '2', ready: false, stickerPreparation: nonce };
  expect(next.cancel()).toBe(true); expect(next.authorize(nonce, editor, 2)).toBe(false); next.clicked(nonce);
  expect(next.send?.state).toBe('cancelled'); expect(next.authorize(nonce, editor, 3)).toBe(false);
});
test('maker unconfirmed result consumes the ticket and requires a new click', () => {
  const { engine } = makerTransfer(); engine.disclose(nonce, snapshot, 1);
  engine.authorize(nonce, { ...snapshot, stickerPreparation: nonce }, 2); engine.clicked(nonce);
  engine.result(nonce, true, false); expect(engine.send).toMatchObject({ state: 'failed', reason: 'unconfirmed' });
  expect(() => engine.begin(webp().id, nonce, engine.destinationToken(snapshot), snapshot, 3, 'maker', false)).toThrow('already');
});

const makerLocales = {
  en: { attach: 'Attach', sticker: 'New sticker', send: 'Send 1 selected', close: 'Close', cancel: 'Cancel', discard: 'Discard' },
  es: { attach: 'Adjuntar', sticker: 'Nuevo sticker', send: 'Enviar (Intro)', close: 'Cerrar', cancel: 'Cancelar', discard: 'Descartar' },
  'es-pegatina': { attach: 'Adjuntar', sticker: 'Nueva pegatina', send: 'Enviar 1 seleccionado', close: 'Cerrar', cancel: 'Cancelar', discard: 'Descartar' },
  pt: { attach: 'Anexar', sticker: 'Nova figurinha', send: 'Enviar 1 selecionado', close: 'Fechar', cancel: 'Cancelar', discard: 'Descartar' }
};
function setup(options: { locale?: keyof typeof makerLocales; sendLabel?: string; iconControls?: boolean; nestedClose?: boolean; zeroWidthCanvas?: boolean; hiddenCanvas?: boolean; noEditor?: boolean; noNativeMarker?: boolean; noSend?: boolean; unconfirmed?: boolean; caption?: boolean; animated?: boolean; delay?: number; spinner?: number; discardDelay?: number; retainAfterSend?: boolean; authorize?: (request: StickerAuthorization) => Promise<boolean>; clearOnDiscard?: boolean; typedAfterSend?: string; thumbnailDelay?: number; delayedControl?: 'send' | 'close' | 'marker' } = {}) {
  vi.useFakeTimers();
  vi.stubGlobal('crypto', { subtle: { digest: async (_algorithm: string, bytes: Uint8Array) => createHash('sha256').update(bytes).digest() } });
  // jsdom does not implement native file transfer. Keep its File implementation
  // and expose only the file-list assignment seam; all DOM routes are real.
  vi.stubGlobal('DataTransfer', class { files: File[] = []; items = { add: (file: File) => { this.files.push(file); } }; });
  const labels = makerLocales[options.locale ?? 'en'];
  const sticker = webp(options.animated), ticket = { id: sticker.id, nonce, route: 'maker' as const, target: { chatId: snapshot.chatId, name: snapshot.name, revision: snapshot.revision } };
  const current = { ...snapshot };
  document.body.innerHTML = '<div id="pane-side"><button aria-selected="true">A friend</button></div><div id="main"><header>A friend</header><div data-id="false_123@c.us_a">history</div><footer><button aria-label="Attach">+</button><div contenteditable="true" role="textbox"></div></footer></div><input type="file" accept="image/*,video/*"><input type="file" accept="image/*"><input id="unrelated-image" type="file" accept="image/*"><div id="unrelated-menu" role="menu" hidden></div>';
  const show = (root: ParentNode) => { for (const el of [...(root instanceof HTMLElement ? [root] : []), ...root.querySelectorAll<HTMLElement>('*')]) { el.checkVisibility = () => true; el.getBoundingClientRect = () => ({ width: 100, height: 100 } as DOMRect); } };
  show(document);
  document.querySelector<HTMLElement>('#unrelated-menu')!.checkVisibility = () => false;
  const input = document.querySelector<HTMLInputElement>('input[accept="image/*"]')!, decoy = document.querySelector<HTMLInputElement>('input[accept="image/*,video/*"]')!;
  Object.defineProperty(input, 'files', { value: [], writable: true });
  const decoyEvents = vi.fn(); decoy.addEventListener('change', decoyEvents);
  const unrelatedInput = document.querySelector<HTMLInputElement>('#unrelated-image')!, unrelatedEvents = vi.fn(); unrelatedInput.addEventListener('change', unrelatedEvents);
  const clicks = vi.fn(), assignments = vi.fn(), inputEvents = vi.fn(), closes = vi.fn(), discards = vi.fn(), cancels = vi.fn(); input.addEventListener('input', inputEvents);
  let composer = document.querySelector<HTMLElement>('[contenteditable]')!;
  const footer = composer.parentElement!;
  const attach = document.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!;
  attach.setAttribute('aria-label', options.iconControls ? '…' : labels.attach);
  if (options.iconControls) attach.innerHTML = '<span data-icon="ic-attach-file"></span>';
  attach.onclick = () => {
    const old = document.querySelector('#maker-menu'); if (old) { old.remove(); return; }
    const menu = document.createElement('div'); menu.id = 'maker-menu'; menu.setAttribute('role', 'menu'); menu.innerHTML = '<button role="menuitem" aria-label="Photos & videos">Photos & videos</button><button role="menuitem" aria-label="New sticker">New sticker</button>';
    const item = menu.querySelector<HTMLElement>('[aria-label="New sticker"]')!;
    item.setAttribute('aria-label', options.iconControls ? '…' : labels.sticker); item.textContent = labels.sticker;
    if (options.iconControls) item.innerHTML = '<span data-icon="sticker"></span>';
    item.onclick = () => { if (input.isConnected) input.click(); menu.remove(); }; document.body.append(menu); show(menu);
  };
  let mountEditor = () => {};
  input.addEventListener('change', () => {
    assignments();
    const open = () => {
      current.revision = '2'; current.ready = false; current.draft = '';
      const layer = document.createElement('div'); layer.id = 'editor';
      // Close's first common ancestor with the canvas excludes Send, as in the
      // real snapshot. The marker is a div containing media, not a canvas tag.
      layer.innerHTML = '<div class="editor-content"><div class="editor-toolbar"><div><button aria-label="Close">×</button></div><div data-testid="crop-rotate-button"><button aria-label="Crop and rotate">Crop</button></div></div><div><div data-testid="media-editor-canvas"><canvas></canvas></div></div></div><div class="editor-bottom"><div role="button" aria-label="Remove attachment"><span data-icon="x-alt">×</span></div>' + (options.noSend ? '' : '<div role="button" aria-label="Send">Send</div>') + '</div>' + (options.caption ? '<textarea>keep my draft</textarea>' : '');
      const thumbnail = document.createElement('img'); thumbnail.src = options.thumbnailDelay !== undefined ? 'data:image/png;base64,cmVlbmNvZGVk' : sticker.image;
      if (options.thumbnailDelay === undefined) layer.querySelector('.editor-bottom')!.prepend(thumbnail);
      else setTimeout(() => layer.querySelector('.editor-bottom')!.prepend(thumbnail), options.thumbnailDelay);
      if (options.noNativeMarker) layer.querySelector('[data-testid="crop-rotate-button"]')!.remove();
      const restore = () => {
        layer.remove();
        footer.append(composer); current.draft = composer.textContent!; current.revision = '3'; current.ready = true;
      };
      const close = layer.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
      close.setAttribute('aria-label', options.iconControls ? '…' : labels.close);
      if (options.iconControls) close.innerHTML = '<span data-icon="x-viewer"></span>';
      const send = layer.querySelector<HTMLElement>('[aria-label="Send"]');
      if (send) {
        send.setAttribute('aria-label', options.iconControls ? '…' : options.sendLabel ?? labels.send); send.textContent = options.sendLabel ?? labels.send;
        if (options.iconControls) send.innerHTML = '<span data-icon="send"></span>';
      }
      // A containing control must not inherit the native Close's name/icon.
      if (options.nestedClose) {
        close.parentElement!.setAttribute('role', 'button');
        if (!options.iconControls) close.textContent = labels.close;
      }
      close.onclick = () => {
        closes();
        const confirm = () => {
          const dialog = document.createElement('div'); dialog.id = 'discard-dialog'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', 'Discard?');
          dialog.innerHTML = '<h2>Discard?</h2><button>Cancel</button><div role="button" aria-label="Discard">Discard</div>';
          dialog.querySelector<HTMLElement>('button')!.textContent = labels.cancel;
          const discard = dialog.querySelector<HTMLElement>('[aria-label="Discard"]')!;
          discard.setAttribute('aria-label', labels.discard); discard.textContent = labels.discard;
          dialog.querySelector<HTMLElement>('button')!.onclick = () => { cancels(); dialog.remove(); };
          discard.onclick = () => { discards(); dialog.remove(); if (options.clearOnDiscard) composer.replaceChildren(); restore(); };
          document.body.append(dialog); show(dialog);
        };
        if (options.discardDelay) setTimeout(confirm, options.discardDelay); else confirm();
      };
      send?.addEventListener('click', () => {
        clicks(); composer.replaceChildren(); if (!options.retainAfterSend) restore(); if (options.typedAfterSend) composer.textContent = options.typedAfterSend;
        if (!options.unconfirmed) { const row = document.createElement('div'); row.dataset.id = 'true_123@c.us_new'; row.innerHTML = '<span aria-label="You:"></span><div data-testid="sticker-container"></div>'; document.querySelector('#main')!.append(row); }
      }); document.body.append(layer); show(layer);
      if (options.delayedControl) {
        const control = layer.querySelector<HTMLElement>(options.delayedControl === 'marker' ? '[data-testid="crop-rotate-button"]' : options.delayedControl === 'close' ? '[aria-label="Close"]' : '[role="button"][aria-label^="Send"]')!;
        const parent = control.parentElement!; control.remove(); setTimeout(() => parent.append(control), 250);
      }
      const canvas = layer.querySelector<HTMLElement>('[data-testid="media-editor-canvas"]')!;
      if (options.zeroWidthCanvas) canvas.getBoundingClientRect = () => ({ width: 0, height: 0 } as DOMRect);
      if (options.hiddenCanvas) canvas.checkVisibility = () => false;
      if (options.spinner !== undefined) {
        const spinner = document.createElement('div'); spinner.dataset.testid = 'loading-spinner'; layer.append(spinner); show(layer);
        if (options.spinner >= 0) setTimeout(() => spinner.remove(), options.spinner);
      }
    };
    mountEditor = open;
    if (options.noEditor) return;
    if (options.delay) setTimeout(open, options.delay); else open();
  });
  const dom = new DomConnector(document, () => {});
  const events: RemoteEvent[] = [], permissions: StickerAuthorization[] = [];
  const read = () => { const value = { ...current, draft: composer.isConnected ? readDraft(composer) : '', draftIssue: composer.isConnected ? dom.read().draftIssue : null }; const preparation = connector.preparation(value); if (preparation) value.stickerPreparation = preparation; return value; };
  const connector = new StickerTransferConnector(document, read, new Map(), event => { const { diagnostics: _diagnostics, ...result } = event as RemoteEvent & { diagnostics?: unknown }; events.push(result as RemoteEvent); }, async () => true, async request => { permissions.push(request); return options.authorize ? options.authorize(request) : true; });
  return { connector, ticket, sticker, mountEditor: () => mountEditor(), events, clicks, assignments, inputEvents, closes, discards, cancels, current, permissions, decoyEvents, unrelatedInput, unrelatedEvents, input, get composer() { return composer; } };
}
test('only the owned native sticker route prevents the file chooser default; user attach clicks remain normal', async () => {
  const s = setup();
  const prevented: boolean[] = [];
  s.input.addEventListener('click', event => prevented.push(event.defaultPrevented));
  const userAttach = () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!.click();
    document.querySelector<HTMLElement>('#maker-menu [aria-label="New sticker"]')!.click();
  };
  try {
    userAttach();
    expect(prevented).toEqual([false]);
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
    expect(prevented).toEqual([false, true]);
    expect(s.assignments).toHaveBeenCalledOnce(); expect(s.events.at(-1)).toMatchObject({ confirmed: true });
    userAttach();
    expect(prevented).toEqual([false, true, false]);
  } finally { s.connector.stop(); }
});

test('user file-input clicks are not prevented while the maker waits for disclosure approval', async () => {
  const s = setup({ authorize: async () => await new Promise<boolean>(() => {}) });
  const prevented: boolean[] = [];
  s.input.addEventListener('click', event => prevented.push(event.defaultPrevented));
  const unrelatedClick = vi.fn((event: Event) => event.defaultPrevented);
  s.unrelatedInput.addEventListener('click', unrelatedClick);
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    expect(s.permissions.map(p => p.phase)).toEqual(['disclose']);
    document.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!.click();
    document.querySelector<HTMLElement>('#maker-menu [aria-label="New sticker"]')!.click();
    s.unrelatedInput.click();
    expect(prevented).toEqual([true, false]); expect(unrelatedClick).toHaveReturnedWith(false);
    s.connector.cancel(); await task;
    expect(s.assignments).not.toHaveBeenCalled();
  } finally { s.connector.stop(); }
});

test.each(['cancelled', 'chat-changed', 'expired'] as const)('native sticker input clicks are not prevented after preparation is %s during route activation', async revoked => {
  const s = setup();
  const prevented: boolean[] = [];
  s.input.addEventListener('click', event => prevented.push(event.defaultPrevented));
  document.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!.addEventListener('click', () => {
    const item = document.querySelector<HTMLElement>('#maker-menu [aria-label="New sticker"]');
    if (item) item.onclick = () => {
      if (revoked === 'cancelled') s.connector.cancel();
      if (revoked === 'chat-changed') s.current.chatId = '456@c.us';
      if (revoked === 'expired') vi.setSystemTime(Date.now() + STICKER_MAKER_PREPARATION_MS);
      s.input.click(); document.querySelector('#maker-menu')?.remove();
    };
  });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
    expect(prevented).toEqual([false]); expect(s.permissions).toEqual([]);
    expect(s.assignments).not.toHaveBeenCalled();
  } finally { s.connector.stop(); }
});

test.each([false, true])('maker sends verified stored WebP (animated=%s with explicit still), requires empty composer and ignores photo input', async animated => {
  const s = setup({ animated });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.permissions.map(p => p.phase)).toEqual(['disclose', 'send']);
    expect(s.permissions[1].snapshot).toMatchObject({ stickerPreparation: nonce, revision: '2', ready: false });
    expect(s.input.files?.[0]).toMatchObject({ type: 'image/webp', name: 'sticker.webp', size: s.sticker.bytes.length });
    expect(s.assignments).toHaveBeenCalledOnce(); expect(s.inputEvents).toHaveBeenCalledOnce(); expect(s.decoyEvents).not.toHaveBeenCalled(); expect(s.clicks).toHaveBeenCalledOnce();
    expect(s.unrelatedEvents).not.toHaveBeenCalled(); expect(s.unrelatedInput.files?.length).toBe(0); expect(document.querySelector('#unrelated-menu')).not.toBeNull();
    expect(s.composer.textContent).toBe(''); expect(document.querySelector('#editor')).toBeNull();
    expect(s.events).toContainEqual({ type: 'stickerClicked', nonce }); expect(s.events.at(-1)).toEqual({ type: 'stickerSent', nonce, clicked: true, confirmed: true });
  } finally { s.connector.stop(); }
});
test.each(Object.entries(emptyComposers))('maker accepts live empty composer %s at every destructive step', async (_name, markup) => {
  const s = setup({ authorize: async request => request.phase === 'disclose' });
  s.composer.dataset.testid = 'conversation-compose-box-input'; s.composer.dataset.lexicalEditor = 'true'; s.composer.innerHTML = markup;
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.assignments).toHaveBeenCalledOnce(); expect(s.closes).toHaveBeenCalledOnce(); expect(s.discards).toHaveBeenCalledOnce();
    expect(s.clicks).not.toHaveBeenCalled(); expect(readDraft(s.composer)).toBe('');
    expect(document.querySelector('#editor, #discard-dialog')).toBeNull();
    expect(s.events.at(-1)).toMatchObject({ reason: 'editor-unavailable', detail: 'send-denied' });
  } finally { s.connector.stop(); }
});

test.each(['rewritten-thumbnail', 'canvas-only'] as const)('native route ownership supports %s without original byte evidence', async evidence => {
  const s = setup({ noEditor: true });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    s.mountEditor();
    const thumbnail = document.querySelector<HTMLImageElement>('#editor img')!;
    if (evidence === 'canvas-only') thumbnail.remove(); else thumbnail.src = 'data:image/png;base64,cmVuZGVyZWQ=';
    await vi.advanceTimersByTimeAsync(100); await task;
    expect(fetch).not.toHaveBeenCalled(); expect(s.clicks).toHaveBeenCalledOnce();
    expect(document.querySelector('#editor')).toBeNull(); expect(s.events.at(-1)).toMatchObject({ confirmed: true });
  } finally { s.connector.stop(); }
});

test.each(['rewritten-thumbnail', 'canvas-only'] as const)('cancel cleans %s editor mounted in the owned conversation before revocation', async evidence => {
  const s = setup({ noEditor: true, spinner: -1 });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    s.mountEditor();
    const thumbnail = document.querySelector<HTMLImageElement>('#editor img')!;
    if (evidence === 'canvas-only') thumbnail.remove(); else thumbnail.src = 'blob:native-rendered-thumbnail';
    s.connector.cancel(); await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.closes).toHaveBeenCalledOnce(); expect(s.discards).toHaveBeenCalledOnce(); expect(s.clicks).not.toHaveBeenCalled();
    expect(document.querySelector('#editor, #discard-dialog')).toBeNull(); expect(s.connector.preparation(s.current)).toBeUndefined();
  } finally { s.connector.stop(); }
});
test('real editor sibling branches are recognized without borrowing a composer or unrelated Send', async () => {
  const s = setup();
  const decoy = document.createElement('div'); decoy.setAttribute('role', 'button'); decoy.setAttribute('aria-label', 'Send');
  decoy.checkVisibility = () => true; decoy.getBoundingClientRect = () => ({ width: 100 } as DOMRect);
  const decoyClick = vi.fn(); decoy.onclick = decoyClick; document.querySelector('footer')!.append(decoy);
  document.body.append(decoy.cloneNode(true));
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.clicks).toHaveBeenCalledOnce(); expect(decoyClick).not.toHaveBeenCalled();
    expect(s.events.at(-1)).toMatchObject({ confirmed: true });
  } finally { s.connector.stop(); }
});
test.each([false, true])('nested Close control does not make editor recognition ambiguous (icon=%s)', async iconControls => {
  const s = setup({ nestedClose: true, iconControls });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(STICKER_MAKER_PREPARATION_MS + 1800); await task;
    expect(s.clicks).toHaveBeenCalledOnce(); expect(s.events.at(-1)).toMatchObject({ confirmed: true });
  } finally { s.connector.stop(); }
});

test('editor readiness does not depend on canvas marker pixel dimensions', async () => {
  const s = setup({ zeroWidthCanvas: true });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(STICKER_MAKER_PREPARATION_MS + 1800); await task;
    expect(s.clicks).toHaveBeenCalledOnce(); expect(s.events.at(-1)).toMatchObject({ confirmed: true });
  } finally { s.connector.stop(); }
});

test.each(Object.keys(makerLocales) as (keyof typeof makerLocales)[])('unrecognized editor is closed and discarded with %s labels without draft restoration', async locale => {
  const s = setup({ locale, hiddenCanvas: true, clearOnDiscard: true });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(STICKER_MAKER_PREPARATION_MS + 1800); await task;
    expect(s.permissions.map(p => p.phase)).toEqual(['disclose']); expect(s.clicks).not.toHaveBeenCalled();
    expect(s.closes).toHaveBeenCalledOnce(); expect(s.discards).toHaveBeenCalledOnce(); expect(s.cancels).not.toHaveBeenCalled();
    expect(document.querySelector('#editor, #discard-dialog')).toBeNull(); expect(readDraft(s.composer)).toBe(snapshot.draft);
    expect(s.events.at(-1)).toMatchObject({ clicked: false, reason: 'editor-unavailable', detail: 'editor-timeout' });
  } finally { s.connector.stop(); }
});

test.each(['Sender', 'Resend', 'EnviarMensagem'])('editor label %s cannot borrow the composer Send', async sendLabel => {
  const s = setup({ sendLabel });
  const composerSend = document.createElement('div'); composerSend.setAttribute('role', 'button'); composerSend.setAttribute('aria-label', 'Send 1 selected');
  composerSend.checkVisibility = () => true; composerSend.getBoundingClientRect = () => ({ width: 60 } as DOMRect);
  const click = vi.fn(); composerSend.onclick = click; document.querySelector('footer')!.append(composerSend);
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(STICKER_MAKER_PREPARATION_MS + 100); await task;
    expect(click).not.toHaveBeenCalled(); expect(s.clicks).not.toHaveBeenCalled(); expect(s.discards).toHaveBeenCalledOnce();
    expect(s.events.at(-1)).toMatchObject({ detail: 'editor-send-ambiguous' });
  } finally { s.connector.stop(); }
});

test('maker waits for the editor spinner to clear before requesting Send permission', async () => {
  const s = setup({ spinner: 1400 });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(1300);
    expect(s.permissions.map(p => p.phase)).toEqual(['disclose']); expect(s.clicks).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200); await task;
    expect(s.permissions.map(p => p.phase)).toEqual(['disclose', 'send']); expect(s.clicks).toHaveBeenCalledOnce();
    expect(s.events.at(-1)).toMatchObject({ confirmed: true });
  } finally { s.connector.stop(); }
});
test('a stuck editor spinner times out and is discarded without activating Send', async () => {
  const s = setup({ spinner: -1 });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(STICKER_MAKER_PREPARATION_MS + 100); await task;
    expect(s.permissions.map(p => p.phase)).toEqual(['disclose']); expect(s.clicks).not.toHaveBeenCalled();
    expect(s.discards).toHaveBeenCalledOnce(); expect(s.cancels).not.toHaveBeenCalled();
    expect(document.querySelector('#editor, #discard-dialog')).toBeNull();
    expect(s.events.at(-1)).toMatchObject({ detail: 'editor-timeout' });
  } finally { s.connector.stop(); }
});
test('a spinner that reappears during Send authorization prevents the click and discards the editor', async () => {
  let resolve!: (ok: boolean) => void;
  const s = setup({ authorize: async request => request.phase === 'disclose' || await new Promise<boolean>(r => { resolve = r; }) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const spinner = document.createElement('div'); spinner.dataset.testid = 'loading-spinner'; spinner.checkVisibility = () => true; spinner.getBoundingClientRect = () => ({ width: 40 } as DOMRect); document.querySelector('#editor')!.append(spinner);
    resolve(true); await task;
    expect(s.clicks).not.toHaveBeenCalled(); expect(s.discards).toHaveBeenCalledOnce(); expect(s.events.at(-1)).toMatchObject({ detail: 'editor-timeout' });
    expect(document.querySelector('#editor, #discard-dialog')).toBeNull();
  } finally { s.connector.stop(); }
});
test('cleanup ignores a pre-existing Discard dialog and verifies its own editor is removed', async () => {
  const s = setup({ authorize: async request => request.phase === 'disclose' });
  const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.innerHTML = '<button>Cancel</button><button>Discard</button>';
  const unrelated = vi.fn();
  for (const node of [dialog, ...dialog.querySelectorAll<HTMLElement>('*')]) { node.checkVisibility = () => true; node.getBoundingClientRect = () => ({ width: 100 } as DOMRect); node.onclick = unrelated; }
  document.body.append(dialog);
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
    expect(unrelated).not.toHaveBeenCalled(); expect(dialog.isConnected).toBe(true);
    expect(s.discards).toHaveBeenCalledOnce(); expect(s.cancels).not.toHaveBeenCalled(); expect(document.querySelector('#editor, #discard-dialog')).toBeNull();
  } finally { s.connector.stop(); }
});
test('cleanup reports a remaining editor instead of clicking Cancel when Discard is unavailable', async () => {
  let resolve!: (ok: boolean) => void;
  const s = setup({ authorize: async request => request.phase === 'disclose' || await new Promise<boolean>(r => { resolve = r; }) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    document.querySelector<HTMLElement>('#editor [aria-label="Close"]')!.addEventListener('click', () => document.querySelector('#discard-dialog [aria-label="Discard"]')!.remove());
    resolve(false); await vi.advanceTimersByTimeAsync(1100); await task;
    expect(s.events.at(-1)).toMatchObject({ clicked: false, detail: 'editor-cleanup-failed' });
    expect(s.cancels).not.toHaveBeenCalled(); expect(document.querySelector('#editor')).not.toBeNull(); expect(s.closes).toHaveBeenCalledOnce();
  } finally { s.connector.stop(); }
});
test.each(['denied', 'cancel', 'unconfirmed'] as const)('%s cleanup waits for Discard confirmation and never clicks Cancel or Escape', async exit => {
  const s = setup({ discardDelay: 150, unconfirmed: exit === 'unconfirmed', retainAfterSend: exit === 'unconfirmed', authorize: async request => request.phase === 'disclose' || (exit === 'unconfirmed' ? true : exit === 'denied' ? false : await new Promise<boolean>(() => {})) });
  const escape = vi.fn(); document.addEventListener('keydown', escape);
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    if (exit === 'cancel') s.connector.cancel();
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_CONFIRMATION_MS + 700); await task;
    expect(s.closes).toHaveBeenCalledOnce(); expect(s.discards).toHaveBeenCalledOnce(); expect(s.cancels).not.toHaveBeenCalled(); expect(escape).not.toHaveBeenCalled();
    expect(document.querySelector('#editor, #discard-dialog')).toBeNull(); expect(s.composer.textContent).toBe('');
    expect(s.clicks).toHaveBeenCalledTimes(exit === 'unconfirmed' ? 1 : 0);
  } finally { document.removeEventListener('keydown', escape); s.connector.stop(); }
});
test.each(['noEditor', 'noSend', 'caption'] as const)('maker fails closed for %s and closes only its overlay', async option => {
  const s = setup({ [option]: true });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(STICKER_MAKER_PREPARATION_MS + 100); await task;
    expect(s.clicks).not.toHaveBeenCalled(); expect(s.permissions.map(p => p.phase)).toEqual(['disclose']);
    expect(s.events.at(-1)).toMatchObject({ type: 'stickerSent', clicked: false, reason: 'editor-unavailable', detail: { noEditor: 'editor-timeout', noSend: 'editor-send-ambiguous', caption: 'caption-present' }[option] });
    expect(document.querySelector('#editor')).toBeNull(); expect(document.querySelector('#main')).not.toBeNull();
    expect(s.composer.textContent).toBe('');
  } finally { s.connector.stop(); }
});
test('a missing maker editor reports editor-unavailable within the five-second preparation budget', async () => {
  const s = setup({ noEditor: true });
  try {
    const started = Date.now(), task = s.connector.make(s.ticket, s.sticker.image);
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_PREPARATION_MS - 100);
    expect(s.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(100); await task;
    expect(Date.now() - started).toBeLessThanOrEqual(5000);
    expect(s.assignments).toHaveBeenCalledOnce(); expect(s.clicks).not.toHaveBeenCalled();
    expect(s.events.at(-1)).toEqual({ type: 'stickerSent', nonce, clicked: false, confirmed: false, reason: 'editor-unavailable', detail: 'editor-timeout' });
  } finally { s.connector.stop(); }
});
test('a clicked maker send without an outgoing sticker is unconfirmed with no retry', async () => {
  const s = setup({ unconfirmed: true });
  try {
    const started = Date.now(), task = s.connector.make(s.ticket, s.sticker.image);
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_CONFIRMATION_MS - 100);
    expect(s.events.some(e => e.type === 'stickerSent')).toBe(false);
    await vi.advanceTimersByTimeAsync(200); await task;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(s.clicks).toHaveBeenCalledOnce(); expect(s.events.at(-1)).toEqual({ type: 'stickerSent', nonce, clicked: true, confirmed: false, reason: 'unconfirmed', detail: 'confirm-timeout' });
  } finally { s.connector.stop(); }
});
test.each(['disclose', 'send'] as const)('denied %s authorization cannot activate editor Send', async phase => {
  const s = setup({ authorize: async request => request.phase !== phase });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.clicks).not.toHaveBeenCalled(); if (phase === 'disclose') expect(s.assignments).not.toHaveBeenCalled();
    expect(s.events.at(-1)).toMatchObject({ detail: phase + '-denied' });
    expect(document.querySelector('#editor')).toBeNull(); expect(document.querySelector('#maker-menu')).toBeNull();
  } finally { s.connector.stop(); }
});
test.each(['cancel', 'chat', 'row', 'root'])('a %s change while preparing revokes editor activation and closes the editor', async change => {
  let resolve!: (ok: boolean) => void;
  const s = setup({ authorize: async request => request.phase === 'disclose' || await new Promise<boolean>(r => { resolve = r; }) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    expect(document.querySelector('#editor')).not.toBeNull(); expect(s.clicks).not.toHaveBeenCalled();
    if (change === 'cancel') s.connector.cancel();
    if (change === 'chat') { s.current.chatId = '456@c.us'; s.current.name = 'B'; }
    if (change === 'composer') { document.querySelector('footer')!.append(s.composer.cloneNode(true)); s.current.revision = '4'; }
    if (change === 'row') document.querySelector('[aria-selected]')!.replaceWith(document.querySelector('[aria-selected]')!.cloneNode(true));
    if (change === 'root') document.querySelector('#main')!.replaceWith(document.querySelector('#main')!.cloneNode(true));
    resolve(true); await task;
    expect(s.clicks).not.toHaveBeenCalled(); expect(document.querySelector('#editor')).toBeNull();
    if (change !== 'cancel') expect(s.events.at(-1)).toEqual({ type: 'stickerCancelled', nonce, reason: 'chat-changed', detail: 'chat-changed' });
  } finally { s.connector.stop(); }
});
test('connector independently rejects a byte/hash mismatch before opening any UI or disclosing', async () => {
  const s = setup();
  try {
    const task = s.connector.make({ ...s.ticket, id: 'a'.repeat(64) }, s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.permissions).toEqual([]); expect(s.assignments).not.toHaveBeenCalled(); expect(s.clicks).not.toHaveBeenCalled(); expect(document.querySelector('#maker-menu')).toBeNull();
  } finally { s.connector.stop(); }
});
test('cancellation before mount permanently revokes ownership and leaves later editors untouched', async () => {
  const s = setup({ delay: 500 });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    expect(s.assignments).toHaveBeenCalledOnce(); expect(document.querySelector('#editor')).toBeNull();
    s.connector.cancel(); await vi.advanceTimersByTimeAsync(600); await task;
    expect(document.querySelector('#editor')).not.toBeNull(); expect(s.closes).not.toHaveBeenCalled(); expect(s.discards).not.toHaveBeenCalled(); expect(s.clicks).not.toHaveBeenCalled(); expect(s.events).toEqual([]);
    expect(s.connector.preparation(s.current)).toBeUndefined();
  } finally { s.connector.stop(); }
});
test('cancellation does not wait for an unresolved main authorization reply', async () => {
  const s = setup({ authorize: async request => request.phase === 'disclose' || await new Promise<boolean>(() => {}) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    s.connector.cancel(); await task;
    expect(document.querySelector('#editor')).toBeNull(); expect(s.clicks).not.toHaveBeenCalled();
  } finally { s.connector.stop(); }
});
test('an animated picker miss remains missing and cannot authorize disclosure or silently become a maker send', () => {
  const engine = new StickerTransfer(); engine.begin(webp(true).id, nonce, engine.destinationToken(snapshot), snapshot, 0, 'picker', true);
  engine.prepared(nonce, false, snapshot, 1);
  expect(engine.send).toMatchObject({ route: 'picker', animated: true, state: 'missing' }); expect(engine.disclose(nonce, snapshot, 2)).toBe(false);
});
test.each(['attach-missing', 'menu-missing', 'item-ambiguous', 'input-missing', 'input-ambiguous', 'existing-editor', 'attach-ambiguous', 'menu-preopen'])('maker refuses %s without assigning or sending', async failure => {
  const s = setup();
  try {
    const attach = document.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!;
    if (failure === 'attach-missing') attach.remove();
    if (failure === 'attach-ambiguous') attach.parentElement!.append(attach.cloneNode());
    if (failure === 'attach-ambiguous') { const clone = attach.parentElement!.lastElementChild as HTMLElement; clone.checkVisibility = () => true; clone.getBoundingClientRect = () => ({ width: 100 } as DOMRect); }
    if (failure === 'menu-preopen') { attach.setAttribute('aria-controls', 'unrelated-menu'); document.querySelector<HTMLElement>('#unrelated-menu')!.checkVisibility = () => true; }
    if (failure === 'menu-missing') attach.onclick = () => {};
    if (failure === 'item-ambiguous') attach.addEventListener('click', () => { const item = document.querySelector('[aria-label="New sticker"]'); if (!item) return; const clone = item.cloneNode(true) as HTMLElement; clone.checkVisibility = () => true; clone.getBoundingClientRect = () => ({ width: 100 } as DOMRect); item.parentElement!.append(clone); });
    if (failure === 'input-missing') s.input.remove();
    if (failure === 'input-ambiguous') attach.addEventListener('click', () => document.querySelector('[aria-label="New sticker"]')?.addEventListener('click', () => document.body.append(s.input.cloneNode())));
    if (failure === 'existing-editor') { const old = document.createElement('div'); old.id = 'user-editor'; old.innerHTML = '<canvas data-testid="media-editor-canvas"></canvas>'; document.body.append(old); old.querySelector<HTMLElement>('canvas')!.checkVisibility = () => true; old.querySelector<HTMLElement>('canvas')!.getBoundingClientRect = () => ({ width: 100 } as DOMRect); }
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(STICKER_MAKER_PREPARATION_MS + 100); await task;
    expect(s.assignments).not.toHaveBeenCalled(); expect(s.clicks).not.toHaveBeenCalled(); expect(s.events.at(-1)).toMatchObject({ type: 'stickerSent', reason: 'editor-unavailable', detail: ({ 'attach-missing': 'attach-not-found', 'menu-missing': 'item-not-found', 'input-missing': 'input-not-found', 'existing-editor': 'editor-preopen' } as Record<string, string>)[failure] ?? failure });
    expect(document.querySelector('#maker-menu')).toBeNull(); if (failure === 'existing-editor') expect(document.querySelector('#user-editor')).not.toBeNull();
  } finally { s.connector.stop(); }
});
test.each(['incoming', 'rerender', 'grouped', 'new-grouped-item'])('maker confirmation handles a %s sticker row', async kind => {
  const s = setup({ unconfirmed: true });
  try {
    const row = document.createElement('div'); row.dataset.id = 'true_123@c.us_old'; row.innerHTML = '<span aria-label="You:"></span><div data-testid="sticker-container"></div>'; document.querySelector('#main')!.append(row);
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    if (kind === 'incoming') { const incoming = row.cloneNode(true) as HTMLElement; incoming.dataset.id = 'false_123@c.us_new'; incoming.querySelector('[aria-label]')!.remove(); document.querySelector('#main')!.append(incoming); }
    if (kind === 'rerender') row.replaceWith(row.cloneNode(true));
    if (kind === 'new-grouped-item') { const item = document.createElement('div'); item.dataset.id = 'true_123@c.us_new-grouped'; item.innerHTML = '<div data-testid="sticker-container"></div>'; row.append(item); }
    if (kind === 'grouped') { const container = document.createElement('div'); container.dataset.testid = 'sticker-container'; row.append(container); }
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_CONFIRMATION_MS + 100); await task;
    expect(s.clicks).toHaveBeenCalledOnce(); expect(s.events.at(-1)).toMatchObject({ type: 'stickerSent', confirmed: kind === 'new-grouped-item' });
  } finally { s.connector.stop(); }
});
test('opaque conversation scope stays recognized from the same anchors during an owned composer transition', () => {
  const state = initialState();
  const conversations = new Conversations({ state, update: (fn: (value: typeof state) => void) => fn(state) } as unknown as Store);
  const opaque = { ...snapshot, chatId: null, messages: [{ id: 'ABC123456', outgoing: null, text: 'history' }] };
  const initial = { ...opaque, settingsId: conversations.identify(opaque) };
  const engine = new StickerTransfer(), destination = engine.destinationToken(initial);
  engine.begin(webp().id, nonce, destination, initial, 0, 'maker', false); engine.disclose(nonce, initial, 1);
  const editor = { ...opaque, revision: '2', ready: false, stickerPreparation: nonce };
  expect(conversations.identify(editor)).toBe(initial.settingsId); expect(engine.ownsPreparation(editor)).toBe(true);
  const recognized = { ...editor, settingsId: conversations.identify(editor) };
  expect(recognized.settingsId).toBe(initial.settingsId); expect(engine.observe(recognized, 2)).toBe(false); expect(engine.destinationToken(recognized)).toBe(destination); expect(engine.authorize(nonce, recognized, 3)).toBe(true);
});
test.each([true, false])('opaque maker continuity requires overlap with the original loaded messages (overlap=%s)', async overlap => {
  let resolve!: (ok: boolean) => void;
  const s = setup({ authorize: async request => request.phase === 'disclose' || await new Promise<boolean>(r => { resolve = r; }) });
  s.current.chatId = null as unknown as string; s.ticket.target.chatId = null as unknown as string;
  s.current.messages = [{ id: 'ABC123456', text: 'history', outgoing: null }];
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    if (!overlap) s.current.messages = [{ id: 'OTHER123456', text: 'history', outgoing: null }];
    resolve(true); await vi.advanceTimersByTimeAsync(STICKER_MAKER_CONFIRMATION_MS + 100); await task;
    expect(s.clicks).toHaveBeenCalledTimes(overlap ? 1 : 0);
    if (!overlap) expect(s.events.at(-1)).toMatchObject({ type: 'stickerCancelled', reason: 'chat-changed' });
  } finally { s.connector.stop(); }
});
test('the attach menu need not carry a role when its native menuitems identify the sticker route', async () => {
  const s = setup();
  const attach = document.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!;
  attach.addEventListener('click', () => document.querySelector('#maker-menu')?.removeAttribute('role'));
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.clicks).toHaveBeenCalledOnce(); expect(s.events.at(-1)).toMatchObject({ confirmed: true });
  } finally { s.connector.stop(); }
});
test.each(['replaced-send', 'extra-send', 'quoted-sticker'])('an %s while authorization is pending cannot create false confirmation', async change => {
  let resolve!: (ok: boolean) => void;
  const s = setup({ unconfirmed: true, authorize: async request => request.phase === 'disclose' || await new Promise<boolean>(r => { resolve = r; }) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const send = document.querySelector<HTMLElement>('#editor [aria-label="Send 1 selected"]')!;
    if (change !== 'quoted-sticker') { const replacement = send.cloneNode(true) as HTMLElement; replacement.checkVisibility = () => true; replacement.getBoundingClientRect = () => ({ width: 100 } as DOMRect); if (change === 'replaced-send') send.replaceWith(replacement); else send.parentElement!.append(replacement); }
    resolve(true); await vi.advanceTimersByTimeAsync(100);
    if (change === 'quoted-sticker') { const row = document.createElement('div'); row.dataset.id = 'false_123@c.us_quote'; row.innerHTML = '<div data-testid="quoted-message"><span aria-label="You:"></span><div data-testid="sticker-container"></div></div>'; document.querySelector('#main')!.append(row); }
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_CONFIRMATION_MS + 100); await task;
    expect(s.clicks).toHaveBeenCalledTimes(change === 'quoted-sticker' ? 1 : 0);
    expect(s.events.at(-1)).toMatchObject({ type: 'stickerSent', confirmed: false, reason: change === 'quoted-sticker' ? 'unconfirmed' : 'editor-unavailable' });
  } finally { s.connector.stop(); }
});
test('cancel closes both the owned editor and an attach menu retained behind it', async () => {
  const s = setup({ authorize: async request => request.phase === 'disclose' || await new Promise<boolean>(() => {}) });
  const attach = document.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!;
  attach.addEventListener('click', () => { const item = document.querySelector<HTMLButtonElement>('[aria-label="New sticker"]'); if (item) item.onclick = () => s.input.click(); });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    expect(document.querySelector('#editor')).not.toBeNull(); expect(document.querySelector('#maker-menu')).not.toBeNull();
    s.connector.cancel(); await task;
    expect(document.querySelector('#editor')).toBeNull(); expect(document.querySelector('#maker-menu')).toBeNull(); expect(s.clicks).not.toHaveBeenCalled();
  } finally { s.connector.stop(); }
});


test.each(['mounted', 'contained', 'moved-into-item', 'clicked'] as const)('maker selects a unique %s route input despite pre-mounted image decoys', async association => {
  const s = setup();
  const attach = document.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!;
  if (association === 'mounted') s.input.remove();
  attach.addEventListener('click', () => {
    const item = document.querySelector<HTMLElement>('#maker-menu [aria-label="New sticker"]');
    if (!item) return;
    if (association === 'contained') item.append(s.input);
    if (association !== 'clicked') item.onclick = () => {
      if (association === 'moved-into-item') item.append(s.input);
      // Retain the native input while closing its menu, without clicking it.
      if (association !== 'moved-into-item') document.body.append(s.input);
      else { const menu = item.parentElement!; document.body.append(item); menu.remove(); return; }
      document.querySelector('#maker-menu')!.remove();
    };
  });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.assignments).toHaveBeenCalledOnce(); expect(s.clicks).toHaveBeenCalledOnce();
    expect(s.unrelatedEvents).not.toHaveBeenCalled(); expect(s.unrelatedInput.files?.length).toBe(0);
    expect(s.events.at(-1)).toMatchObject({ confirmed: true });
  } finally { s.connector.stop(); }
});

test('an unassociated pre-mounted image input cannot receive bytes even when no route input mounts', async () => {
  const s = setup();
  const attach = document.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!;
  attach.addEventListener('click', () => {
    const item = document.querySelector<HTMLElement>('#maker-menu [aria-label="New sticker"]');
    if (item) item.onclick = () => document.querySelector('#maker-menu')!.remove();
  });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(5100); await task;
    expect(s.assignments).not.toHaveBeenCalled(); expect(s.unrelatedEvents).not.toHaveBeenCalled();
    expect(s.permissions).toEqual([]); expect(s.events.at(-1)).toMatchObject({ detail: 'input-not-found', clicked: false });
  } finally { s.connector.stop(); }
});

test.each(['image/*,video/*', '*'] as const)('a pre-mounted non-sticker input (%s) clicked by the route is never eligible or prevented', async accept => {
  const s = setup();
  const input = document.querySelector<HTMLInputElement>('input[accept="image/*,video/*"]')!;
  input.accept = accept;
  const inputClick = vi.fn((event: Event) => event.defaultPrevented);
  input.addEventListener('click', inputClick);
  document.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!.addEventListener('click', () => {
    const item = document.querySelector<HTMLElement>('#maker-menu [aria-label="New sticker"]');
    if (item) item.onclick = () => { input.click(); document.querySelector('#maker-menu')!.remove(); };
  });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(5100); await task;
    expect(inputClick).toHaveBeenCalledOnce(); expect(inputClick).toHaveReturnedWith(false);
    expect(s.assignments).not.toHaveBeenCalled(); expect(s.decoyEvents).not.toHaveBeenCalled();
    expect(s.permissions).toEqual([]); expect(s.events.at(-1)).toMatchObject({ detail: 'input-not-found' });
  } finally { s.connector.stop(); }
});

test('visible unrelated menus and Attach controls outside the composer do not block the route', async () => {
  const s = setup();
  const unrelated = document.querySelector<HTMLElement>('#unrelated-menu')!;
  unrelated.hidden = false; unrelated.checkVisibility = () => true;
  unrelated.innerHTML = '<button role="menuitem" aria-label="New sticker">New sticker</button>';
  const item = unrelated.firstElementChild as HTMLElement; item.checkVisibility = () => true; item.getBoundingClientRect = () => ({ width: 100 } as DOMRect); const decoyClick = vi.fn(); item.onclick = decoyClick;
  const attach = document.querySelector<HTMLElement>('[aria-label="Attach"]')!.cloneNode(true) as HTMLElement;
  attach.checkVisibility = () => true; attach.getBoundingClientRect = () => ({ width: 100 } as DOMRect); document.querySelector('header')!.append(attach);
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.clicks).toHaveBeenCalledOnce(); expect(decoyClick).not.toHaveBeenCalled(); expect(unrelated.isConnected).toBe(true);
    expect(s.events.at(-1)).toMatchObject({ confirmed: true });
  } finally { s.connector.stop(); }
});

test.each(['ambiguous', 'replaced', 'photos', 'unrelated'] as const)('disclosure approval revalidates route input when it becomes %s', async change => {
  let resolve!: (allowed: boolean) => void;
  const s = setup({ authorize: async request => request.phase !== 'disclose' || await new Promise<boolean>(r => { resolve = r; }) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    expect(s.permissions.map(p => p.phase)).toEqual(['disclose']);
    if (change === 'ambiguous') document.body.append(s.input.cloneNode());
    if (change === 'replaced') s.input.replaceWith(s.input.cloneNode());
    if (change === 'photos') s.input.accept = 'image/*,video/*';
    if (change === 'unrelated') s.unrelatedInput.accept = ' image/* ';
    resolve(true); await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.unrelatedEvents).not.toHaveBeenCalled();
    if (change === 'unrelated') { expect(s.assignments).toHaveBeenCalledOnce(); expect(s.events.at(-1)).toMatchObject({ confirmed: true }); }
    else { expect(s.assignments).not.toHaveBeenCalled(); expect(s.clicks).not.toHaveBeenCalled(); expect(s.events.at(-1)).toMatchObject({ detail: change === 'ambiguous' ? 'input-ambiguous' : 'input-changed' }); }
  } finally { s.connector.stop(); }
});

test('failure and cancellation details survive the main transfer status while successful sends have no detail', () => {
  const failed = makerTransfer().engine;
  failed.result(nonce, false, false, 'editor-unavailable', 'input-ambiguous');
  expect(failed.send).toMatchObject({ state: 'failed', detail: 'input-ambiguous' });
  const cancelled = makerTransfer().engine;
  cancelled.cancel('chat-changed', 'chat-changed');
  expect(cancelled.send).toMatchObject({ state: 'cancelled', detail: 'chat-changed' });
  const sent = makerTransfer().engine;
  sent.disclose(nonce, snapshot, 1); sent.authorize(nonce, { ...snapshot, stickerPreparation: nonce }, 2); sent.clicked(nonce);
  sent.result(nonce, true, true, undefined, 'confirm-timeout');
  expect(sent.send).toMatchObject({ state: 'sent' }); expect(sent.send?.detail).toBeUndefined();
});

test.each(['placeholder', 'virtualized', 'grouped-placeholder', 'testid-placeholder'] as const)('an existing %s rendering its old sticker cannot confirm maker Send', async kind => {
  const s = setup({ unconfirmed: true, authorize: async request => {
    // Editor layout can virtualize an old row before the pre-click baseline.
    if (kind === 'virtualized' && request.phase === 'send') document.querySelector('[data-id="true_123@c.us_old"]')?.remove();
    return true;
  } });
  const row = document.createElement('div'); row.dataset.id = 'true_123@c.us_old';
  if (kind === 'testid-placeholder') { delete row.dataset.id; row.dataset.testid = 'conv-msg-true_123@c.us_old'; }
  if (kind === 'grouped-placeholder') {
    row.innerHTML = '<div data-id="true_123@c.us_old-grouped"></div>';
  }
  document.querySelector('#main')!.append(row);
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    if (kind === 'virtualized') expect(row.isConnected).toBe(false);
    const rendered = kind === 'grouped-placeholder' ? row.firstElementChild! : row;
    rendered.innerHTML = '<span aria-label="You:"></span><div data-testid="sticker-container"></div>';
    if (kind === 'virtualized') document.querySelector('#main')!.append(row);
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_CONFIRMATION_MS + 100); await task;
    expect(s.clicks).toHaveBeenCalledOnce();
    expect(s.events.at(-1)).toMatchObject({ clicked: true, confirmed: false, detail: 'confirm-timeout' });
  } finally { s.connector.stop(); }
});

test('temporary absence of the editor canvas does not skip owned Close and Discard cleanup', async () => {
  const s = setup({ unconfirmed: true, retainAfterSend: true, clearOnDiscard: true });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    document.querySelector('[data-testid="media-editor-canvas"]')!.remove();
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_CONFIRMATION_MS + 100); await task;
    expect(s.closes).toHaveBeenCalledOnce(); expect(s.discards).toHaveBeenCalledOnce();
    expect(document.querySelector('#editor')).toBeNull(); expect(readDraft(s.composer)).toBe(snapshot.draft);
  } finally { s.connector.stop(); }
});


test.each(Object.keys(makerLocales) as (keyof typeof makerLocales)[])('maker sends and safely discards with %s native labels', async locale => {
  for (const allowed of [true, false]) {
    const s = setup({ locale, authorize: async request => request.phase === 'disclose' || allowed });
    try {
      const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
      expect(s.assignments).toHaveBeenCalledOnce();
      expect(s.clicks).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(s.discards).toHaveBeenCalledTimes(allowed ? 0 : 1); expect(s.cancels).not.toHaveBeenCalled();
      expect(document.querySelector('#editor, #discard-dialog')).toBeNull();
      expect(s.events.at(-1)).toMatchObject({ confirmed: allowed });
    } finally { s.connector.stop(); }
  }
});

test.each([true, false])('maker identifies scoped native icons when action labels are unavailable (Send=%s)', async allowed => {
  const s = setup({ iconControls: true, authorize: async request => request.phase === 'disclose' || allowed });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.assignments).toHaveBeenCalledOnce(); expect(s.clicks).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(s.closes).toHaveBeenCalledTimes(allowed ? 0 : 1); expect(s.discards).toHaveBeenCalledTimes(allowed ? 0 : 1);
    expect(s.events.at(-1)).toMatchObject(allowed ? { confirmed: true } : { detail: 'send-denied' });
  } finally { s.connector.stop(); }
});

test('maker never chooses a menu item from its position alone', async () => {
  const s = setup();
  document.querySelector<HTMLElement>('[aria-label="Attach"]')!.addEventListener('click', () => {
    const item = document.querySelector<HTMLElement>('[aria-label="New sticker"]')!;
    if (!item) return;
    item.setAttribute('aria-label', 'Unknown action'); item.textContent = 'Unknown action';
  });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(STICKER_MAKER_PREPARATION_MS + 100); await task;
    expect(s.assignments).not.toHaveBeenCalled(); expect(s.clicks).not.toHaveBeenCalled();
    expect(s.events.at(-1)).toMatchObject({ detail: 'item-not-found' });
  } finally { s.connector.stop(); }
});

test.each(['row-class', 'child-class', 'tail-icon', 'tail-testid', 'spanish-label', 'portuguese-label', 'list-row-class', 'list-tail-icon'] as const)('opaque outgoing %s confirms maker Send before delivery metadata appears', async marker => {
  const s = setup({ unconfirmed: true });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const row = document.createElement(marker.startsWith('list-') ? 'li' : 'div');
    if (marker.startsWith('list-')) row.dataset.testid = 'conv-msg-OPAQUE_NEW'; else row.dataset.id = 'OPAQUE_NEW';
    row.innerHTML = '<div data-testid="sticker-container"></div>';
    if (marker === 'row-class' || marker === 'list-row-class') row.className = 'message-out';
    if (marker === 'child-class') row.innerHTML += '<div class="message-out"></div>';
    if (marker === 'tail-icon' || marker === 'list-tail-icon') row.innerHTML += '<span data-icon="tail-out"></span>';
    if (marker === 'tail-testid') row.innerHTML += '<span data-testid="tail-out"></span>';
    if (marker === 'spanish-label') row.innerHTML += '<span aria-label="Tú:"></span>';
    if (marker === 'portuguese-label') row.innerHTML += '<span aria-label="Você:"></span>';
    document.querySelector('#main')!.append(row);
    await vi.advanceTimersByTimeAsync(500); await task;
    expect(s.events.at(-1)).toMatchObject({ clicked: true, confirmed: true });
  } finally { s.connector.stop(); }
});

test.each(['quoted-class', 'quoted-tail', 'old-class', 'old-tail'] as const)('%s cannot confirm an opaque sticker send', async marker => {
  const s = setup({ unconfirmed: true });
  const row = document.createElement('div'); row.dataset.id = 'OPAQUE_STICKER';
  if (marker.startsWith('old-')) document.querySelector('#main')!.append(row);
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const signal = marker.endsWith('class') ? '<div class="message-out"></div>' : '<span data-icon="tail-out"></span>';
    row.innerHTML = '<div data-testid="sticker-container"></div>' + (marker.startsWith('quoted-') ? '<div data-testid="quoted-message">' + signal + '</div>' : signal);
    document.querySelector('#main')!.append(row);
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_CONFIRMATION_MS + 100); await task;
    expect(s.events.at(-1)).toMatchObject({ clicked: true, confirmed: false, detail: 'confirm-timeout' });
  } finally { s.connector.stop(); }
});


test.each([
  ['en', 'Send 1 selected'], ['en', 'Send (Enter)'], ['es', 'Enviar 1 seleccionado'], ['es', 'Enviar (Enter)'], ['pt', 'Enviar 1 selecionado']
] as const)('%s desktop fixture supports %s and owned Close/Discard', async (locale, sendLabel) => {
  vi.useFakeTimers();
  vi.stubGlobal('crypto', { subtle: { digest: async (_algorithm: string, bytes: Uint8Array) => createHash('sha256').update(bytes).digest() } });
  vi.stubGlobal('DataTransfer', class { files: File[] = []; items = { add: (file: File) => { this.files.push(file); } }; });
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return webp().image; } });
  const visibility = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'checkVisibility');
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', { configurable: true, value: function (this: HTMLElement) { return !this.closest('[hidden]'); } });
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return { width: 100, height: 100, top: this.closest('footer') ? 200 : 10, bottom: this.closest('footer') ? 300 : 110 } as DOMRect; });
  try {
    for (const allowed of [true, false]) {
      const fixture = readFileSync('tests/fixtures/whatsapp.html', 'utf8');
      document.body.innerHTML = fixture;
      Object.assign(window, { fixtureStickerLocale: locale, fixtureStickerSendLabel: sendLabel, fixtureMakerDiscards: 0, fixtureMakerCancelDiscards: 0 });
      window.eval(fixture.match(/<script>([\s\S]*?)<\/script>/)![1]);
      for (const input of document.querySelectorAll<HTMLInputElement>('input[type="file"]')) Object.defineProperty(input, 'files', { value: [], writable: true });
      const dom = new DomConnector(document, () => {}), events: RemoteEvent[] = [];
      const read = () => { const value = dom.read(); const preparation = connector.preparation(value); if (preparation) value.stickerPreparation = preparation; return value; };
      dom.read(); await vi.advanceTimersByTimeAsync(500);
      const current = dom.read(), sticker = webp();
      const ticket = { id: sticker.id, nonce, route: 'maker' as const, target: { chatId: current.chatId, name: current.name, revision: current.revision } };
      const connector = new StickerTransferConnector(document, read, new Map(), event => { const { diagnostics: _diagnostics, ...result } = event as RemoteEvent & { diagnostics?: unknown }; events.push(result as RemoteEvent); }, async () => true, async request => request.phase === 'disclose' || allowed);
      try {
        const task = connector.make(ticket, sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
        expect(events.at(-1)).toMatchObject({ type: 'stickerSent', clicked: allowed, confirmed: allowed });
        expect(document.querySelector('#fixture-sticker-editor, #fixture-sticker-discard')).toBeNull();
        expect(window).toMatchObject({ fixtureMakerAssignments: 1, fixtureMakerDiscards: allowed ? 0 : 1, fixtureMakerCancelDiscards: 0 });
      } finally { connector.stop(); }
    }
  } finally { if (visibility) Object.defineProperty(HTMLElement.prototype, 'checkVisibility', visibility); else delete (HTMLElement.prototype as Partial<HTMLElement>).checkVisibility; geometry.mockRestore(); }
});

test('cancelled loading fixture maker discards its already mounted native editor and publishes teardown', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return webp().image; } });
  vi.stubGlobal('crypto', { subtle: { digest: async (_algorithm: string, bytes: Uint8Array) => createHash('sha256').update(bytes).digest() } });
  vi.stubGlobal('DataTransfer', class { files: File[] = []; items = { add: (file: File) => { this.files.push(file); } }; });
  const visibility = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'checkVisibility');
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', { configurable: true, value: function (this: HTMLElement) { return !this.closest('[hidden]'); } });
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return { width: 100, height: 100, top: this.closest('footer') ? 200 : 10, bottom: this.closest('footer') ? 300 : 110 } as DOMRect; });
  const fixture = readFileSync('tests/fixtures/whatsapp.html', 'utf8');
  document.body.innerHTML = fixture;
  window.eval(fixture.match(/<script>([\s\S]*?)<\/script>/)![1]);
  Object.assign(window, { fixtureStickerEditorDelay: 2000, fixtureMakerDiscards: 0 });
  for (const input of document.querySelectorAll<HTMLInputElement>('input[type="file"]')) Object.defineProperty(input, 'files', { value: [], writable: true });
  const events: RemoteEvent[] = [], permissions: StickerAuthorization[] = [];
  const dom = new DomConnector(document, event => { const { diagnostics: _diagnostics, ...result } = event as RemoteEvent & { diagnostics?: unknown }; events.push(result as RemoteEvent); }, async () => false, async request => {
    if (typeof request === 'string') return false;
    permissions.push(request); return request.phase === 'disclose';
  });
  try {
    dom.start(); await vi.advanceTimersByTimeAsync(700);
    const initial = dom.read(), sticker = webp();
    expect(initial).toMatchObject({ ready: true, draft: '' });
    events.length = 0;
    dom.command({ type: 'makeSticker', id: sticker.id, nonce, target: { chatId: initial.chatId, name: initial.name, revision: initial.revision }, route: 'maker', image: sticker.image });
    await vi.advanceTimersByTimeAsync(100);
    expect(window).toMatchObject({ fixtureMakerAssignments: 1 });
    expect(document.querySelector('#fixture-sticker-editor [data-testid="loading-spinner"]')).not.toBeNull();
    // The native shell mounted while the token was valid. Cancel before the
    // next periodic snapshot and before image readiness; cleanup still owns it.
    dom.command({ type: 'cancelSticker' });
    await vi.advanceTimersByTimeAsync(350);
    expect(dom.read()).toMatchObject({ ready: true, revision: initial.revision, draft: '' });
    expect(dom.read().stickerPreparation).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2200);
    expect(document.querySelector('#fixture-sticker-editor')).toBeNull();
    expect(document.querySelector('#fixture-sticker-discard')).toBeNull();
    expect(window).toMatchObject({ fixtureMakerDiscards: 1, fixtureMakerSent: [] });
    expect(permissions.map(request => request.phase)).toEqual(['disclose']);
    expect(events.some(event => event.type === 'stickerSent')).toBe(false);
    expect(dom.read()).toMatchObject({ ready: true, revision: initial.revision, draft: '' });
    expect(dom.read().stickerPreparation).toBeUndefined();
    expect(document.querySelector('#main footer [role="textbox"]')?.textContent).toBe('');
  } finally {
    dom.stop();
    if (visibility) Object.defineProperty(HTMLElement.prototype, 'checkVisibility', visibility); else delete (HTMLElement.prototype as Partial<HTMLElement>).checkVisibility;
    geometry.mockRestore();
  }
});

test.each(['text', 'newline', 'mention', 'image', 'embed', 'missing', 'composition'] as const)('maker refuses an initially unsafe %s composer before opening Attach', async kind => {
  const s = setup();
  if (kind === 'text') s.composer.textContent = 'draft';
  if (kind === 'newline') s.composer.textContent = '\n';
  if (kind === 'mention') s.composer.innerHTML = '<span contenteditable="false"></span>';
  if (kind === 'image') s.composer.innerHTML = '<img alt="">';
  if (kind === 'embed') s.composer.innerHTML = '<svg></svg>';
  if (kind === 'missing') s.composer.remove();
  if (kind === 'composition') s.current.composing = true;
  try {
    await s.connector.make(s.ticket, s.sticker.image);
    expect(s.assignments).not.toHaveBeenCalled(); expect(s.clicks).not.toHaveBeenCalled();
    expect(document.querySelector('#maker-menu, #editor')).toBeNull();
    expect(s.events.at(-1)).toMatchObject({ clicked: false, confirmed: false, reason: 'draft', detail: 'draft-present' });
  } finally { s.connector.stop(); }
});

test.each(['file', 'send', 'close', 'discard'] as const)('a draft appearing before %s stops automation without destructive cleanup', async step => {
  let approve!: (value: boolean) => void;
  const s = setup({ discardDelay: 200, authorize: async request => {
    if ((step === 'file' && request.phase === 'disclose') || (step !== 'file' && request.phase === 'send')) return new Promise<boolean>(resolve => { approve = resolve; });
    return true;
  } });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    if (step === 'discard') { approve(false); await vi.advanceTimersByTimeAsync(100); expect(s.closes).toHaveBeenCalledOnce(); }
    s.composer.textContent = 'new user draft';
    if (step !== 'discard') approve(step !== 'close');
    await vi.advanceTimersByTimeAsync(1000); await task;
    expect(s.composer.textContent).toBe('new user draft'); expect(s.clicks).not.toHaveBeenCalled(); expect(s.discards).not.toHaveBeenCalled();
    expect(s.closes).toHaveBeenCalledTimes(step === 'discard' ? 1 : 0);
    expect(s.assignments).toHaveBeenCalledTimes(step === 'file' ? 0 : 1);
    if (step !== 'file') expect(document.querySelector('#editor')).not.toBeNull();
    expect(s.events.at(-1)).toMatchObject({ clicked: false, confirmed: false, reason: 'draft', detail: 'draft-appeared' });
  } finally { s.connector.stop(); }
});

test('post-Send draft appearance leaves the editor open and reports an unknown send', async () => {
  const s = setup({ unconfirmed: true, retainAfterSend: true, typedAfterSend: 'new user draft' });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(STICKER_MAKER_CONFIRMATION_MS + 100); await task;
    expect(s.clicks).toHaveBeenCalledOnce(); expect(s.closes).not.toHaveBeenCalled(); expect(s.discards).not.toHaveBeenCalled();
    expect(s.composer.textContent).toBe('new user draft'); expect(document.querySelector('#editor')).not.toBeNull();
    expect(s.events.at(-1)).toMatchObject({ clicked: true, confirmed: false, reason: 'draft', detail: 'draft-appeared' });
  } finally { s.connector.stop(); }
});

test.each(['data-id', 'testid', 'transitive-alias'] as const)('an old sticker remount retaining only %s cannot confirm maker Send', async retained => {
  const s = setup({ unconfirmed: true });
  const row = document.createElement('div'); row.dataset.id = 'true_123@c.us_old'; row.dataset.testid = 'conv-msg-OLD';
  row.innerHTML = '<span aria-label="You:"></span><div data-testid="sticker-container"></div>'; document.querySelector('#main')!.append(row);
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const replacement = row.cloneNode(true) as HTMLElement;
    if (retained === 'data-id') delete replacement.dataset.testid;
    else if (retained === 'testid') delete replacement.dataset.id;
    else replacement.dataset.testid = 'conv-msg-OLD-REMOUNT';
    row.replaceWith(replacement);
    if (retained === 'transitive-alias') { await vi.advanceTimersByTimeAsync(100); delete replacement.dataset.id; }
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_CONFIRMATION_MS); await task;
    expect(s.events.at(-1)).toMatchObject({ clicked: true, confirmed: false, detail: 'confirm-timeout' });
  } finally { s.connector.stop(); }
});

test.each(['data-id', 'dom-id', 'no-id'] as const)('a new grouped %s sticker inherits outgoing direction from its wrapper', async identity => {
  const s = setup({ unconfirmed: true });
  const row = document.createElement('div'); row.className = 'message-out'; row.dataset.testid = 'conv-msg-GROUP';
  row.innerHTML = '<span aria-label="You:"></span><div data-testid="grouped-sticker-item" data-id="OLD"><div data-testid="sticker-container"></div></div>'; document.querySelector('#main')!.append(row);
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const item = document.createElement('div'); item.dataset.testid = 'grouped-sticker-item';
    if (identity === 'data-id') item.dataset.id = 'NEW'; else if (identity === 'dom-id') item.id = 'NEW';
    item.innerHTML = '<div data-testid="sticker-container"></div>'; row.append(item);
    await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.events.at(-1)).toMatchObject({ clicked: true, confirmed: true });
  } finally { s.connector.stop(); }
});

test.each([true, false])('cleanup rediscovers a remounted editor and verifies its removal (closes=%s)', async closes => {
  let approve!: (value: boolean) => void;
  const s = setup({ authorize: async request => request.phase === 'disclose' || new Promise<boolean>(resolve => { approve = resolve; }) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const editor = document.querySelector<HTMLElement>('#editor')!, replacement = editor.cloneNode(true) as HTMLElement;
    for (const element of [replacement, ...replacement.querySelectorAll<HTMLElement>('*')]) { element.checkVisibility = () => true; element.getBoundingClientRect = () => ({ width: 100, height: 100 } as DOMRect); }
    const close = vi.fn(() => { if (closes) replacement.remove(); }); replacement.querySelector<HTMLElement>('[aria-label="Close"]')!.onclick = close;
    editor.replaceWith(replacement); approve(false); await vi.advanceTimersByTimeAsync(1200); await task;
    expect(s.closes).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce(); expect(s.clicks).not.toHaveBeenCalled();
    expect(replacement.isConnected).toBe(!closes);
    expect(s.events.at(-1)).toMatchObject({ clicked: false, confirmed: false, detail: closes ? 'editor-changed' : 'editor-cleanup-failed' });
  } finally { s.connector.stop(); }
});


test.each(['file', 'send'] as const)('new IME composition before %s reports draft-appeared without cleanup', async step => {
  let approve!: (value: boolean) => void;
  const s = setup({ authorize: async request => request.phase === (step === 'file' ? 'disclose' : 'send') ? new Promise<boolean>(resolve => { approve = resolve; }) : true });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    s.current.composing = true; approve(true); await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.clicks).not.toHaveBeenCalled(); expect(s.closes).not.toHaveBeenCalled(); expect(s.discards).not.toHaveBeenCalled();
    expect(s.events.at(-1)).toMatchObject({ clicked: false, confirmed: false, reason: 'draft', detail: 'draft-appeared' });
  } finally { s.connector.stop(); }
});

test.each([false, true])('post-Send draft appearance reports unknown even after confirmation (retained=%s)', async retained => {
  const s = setup({ retainAfterSend: retained, typedAfterSend: 'new user draft' });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.clicks).toHaveBeenCalledOnce(); expect(s.closes).not.toHaveBeenCalled(); expect(s.discards).not.toHaveBeenCalled();
    expect(s.composer.textContent).toBe('new user draft');
    expect(s.events.at(-1)).toMatchObject({ clicked: true, confirmed: false, reason: 'draft', detail: 'draft-appeared' });
  } finally { s.connector.stop(); }
});

// Ownership race siblings: revoke before mount; mount before revoke (including
// the same JS turn); chat/row/root departure and return; unproved user media;
// pending blob proof; remount before/after revoke; empty cleanup before mount;
// replaced Close; menu mount before cancel; and chat change during Discard.
function visibleTree(root: HTMLElement) {
  for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    element.checkVisibility = () => true;
    element.getBoundingClientRect = () => ({ width: 100, height: 100 } as DOMRect);
  }
}
function userEditor(source = 'blob:user-draft') {
  const layer = document.createElement('div'); layer.id = 'user-editor';
  layer.innerHTML = '<div data-testid="media-editor-canvas"><canvas></canvas></div><img><button aria-label="Close">Close</button><div role="button" aria-label="Send">Send</div><textarea>my media draft</textarea>';
  layer.querySelector('img')!.src = source;
  const close = vi.fn(() => layer.remove()); layer.querySelector<HTMLButtonElement>('button')!.onclick = close;
  document.body.append(layer); visibleTree(layer);
  return { layer, close };
}

test.each(['cancel', 'chat', 'row', 'root'] as const)('%s before mount stops discovery and preserves an editor opened afterwards', async change => {
  const s = setup({ noEditor: true });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    expect(s.assignments).toHaveBeenCalledOnce();
    if (change === 'cancel') s.connector.cancel();
    if (change === 'chat') { s.current.chatId = '456@c.us'; s.current.name = 'B'; }
    if (change === 'row') document.querySelector('[aria-selected]')!.replaceWith(document.querySelector('[aria-selected]')!.cloneNode(true));
    if (change === 'root') document.querySelector('#main')!.replaceWith(document.querySelector('#main')!.cloneNode(true));
    // Even an identical file cannot revive a revoked preparation token.
    const user = userEditor(s.sticker.image);
    await vi.advanceTimersByTimeAsync(100); await task;
    expect(user.close).not.toHaveBeenCalled(); expect(user.layer.isConnected).toBe(true);
    expect(user.layer.querySelector('textarea')!.value).toBe('my media draft');
    expect(s.clicks).not.toHaveBeenCalled(); expect(s.discards).not.toHaveBeenCalled();
    expect(document.querySelector('#maker-menu')).toBeNull(); expect(s.connector.preparation(s.current)).toBeUndefined();
    if (change !== 'cancel') expect(s.events.at(-1)).toMatchObject({ type: 'stickerCancelled', reason: 'chat-changed' });
  } finally { s.connector.stop(); }
});

test.each(['cancel', 'chat'] as const)('mount immediately before %s is captured before the wait loop resumes and is cleaned once', async change => {
  const s = setup({ noEditor: true });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    s.mountEditor();
    if (change === 'cancel') s.connector.cancel();
    else {
      // Observe the valid mount, then publish a destination change with no wait.
      await Promise.resolve(); s.current.chatId = '456@c.us'; s.current.name = 'B';
      s.connector.preparation(s.current);
    }
    await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.closes).toHaveBeenCalledOnce(); expect(s.discards).toHaveBeenCalledOnce();
    expect(s.clicks).not.toHaveBeenCalled(); expect(document.querySelector('#editor, #discard-dialog, #maker-menu')).toBeNull();
    expect(s.connector.preparation(s.current)).toBeUndefined();
  } finally { s.connector.stop(); }
});

test.each(['chat', 'row', 'root'] as const)('%s leaving and returning cannot revive a waiting token', async change => {
  const s = setup({ noEditor: true });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    if (change === 'chat') {
      s.current.chatId = '456@c.us'; s.connector.preparation(s.current); s.current.chatId = snapshot.chatId;
    } else {
      const anchor = document.querySelector(change === 'row' ? '[aria-selected]' : '#main')!, parent = anchor.parentElement!;
      anchor.remove(); parent.append(anchor);
    }
    const user = userEditor(s.sticker.image);
    await vi.advanceTimersByTimeAsync(100); await task;
    expect(user.close).not.toHaveBeenCalled(); expect(user.layer.isConnected).toBe(true);
    expect(s.connector.preparation(s.current)).toBeUndefined();
    expect(s.events.at(-1)).toMatchObject({ type: 'stickerCancelled', reason: 'chat-changed' });
  } finally { s.connector.stop(); }
});

test.each(['missing', 'wrong-data', 'wrong-blob'] as const)('a new canvas with %s file evidence is never owned or closed', async evidence => {
  const s = setup({ noEditor: true });
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => ({ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]) }) })));
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const user = userEditor(evidence === 'wrong-data' ? 'data:image/png;base64,dXNlcg==' : 'blob:user-draft');
    if (evidence === 'missing') user.layer.querySelector('img')!.remove();
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_PREPARATION_MS + 100); await task;
    expect(user.close).not.toHaveBeenCalled(); expect(user.layer.isConnected).toBe(true);
    expect(s.clicks).not.toHaveBeenCalled(); expect(s.events.at(-1)).toMatchObject({ detail: 'editor-timeout' });
  } finally { s.connector.stop(); }
});

test.each([true, false])('blob byte proof authorizes only the assigned file (matches=%s)', async matches => {
  const s = setup({ noEditor: true, noNativeMarker: true });
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => ({ size: s.sticker.bytes.length, arrayBuffer: async () => matches ? s.sticker.bytes : new Uint8Array([1, 2, 3]) }) })));
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    s.mountEditor(); document.querySelector<HTMLImageElement>('#editor img')!.src = 'blob:assigned-file';
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_PREPARATION_MS + 100); await task;
    expect(s.clicks).toHaveBeenCalledTimes(matches ? 1 : 0);
    expect(s.closes).not.toHaveBeenCalled();
    expect(document.querySelector('#editor') !== null).toBe(!matches);
  } finally { s.connector.stop(); }
});

test.each(['cancel', 'chat'] as const)('%s while blob proof is pending cannot adopt an editor when proof resolves later', async change => {
  const s = setup({ noEditor: true, noNativeMarker: true });
  let complete!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { complete = resolve; })));
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    s.mountEditor(); document.querySelector<HTMLImageElement>('#editor img')!.src = 'blob:assigned-file';
    await Promise.resolve(); expect(fetch).toHaveBeenCalledOnce();
    if (change === 'cancel') s.connector.cancel();
    else { s.current.chatId = '456@c.us'; s.connector.preparation(s.current); }
    await vi.advanceTimersByTimeAsync(100); await task;
    complete({ blob: async () => ({ size: s.sticker.bytes.length, arrayBuffer: async () => s.sticker.bytes }) });
    await vi.advanceTimersByTimeAsync(100);
    expect(s.closes).not.toHaveBeenCalled(); expect(s.discards).not.toHaveBeenCalled(); expect(s.clicks).not.toHaveBeenCalled();
    expect(document.querySelector('#editor')).not.toBeNull(); expect(s.connector.preparation(s.current)).toBeUndefined();
  } finally { s.connector.stop(); }
});

test('a no-editor cleanup result cannot satisfy later cleanup of a proved editor', async () => {
  const s = setup({ noEditor: true, authorize: async request => request.phase === 'disclose' });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const cleanup = s.connector as unknown as { closeMaker(): Promise<boolean> };
    expect(await cleanup.closeMaker()).toBe(true);
    s.mountEditor(); await vi.advanceTimersByTimeAsync(100); await task;
    expect(s.closes).toHaveBeenCalledOnce(); expect(s.discards).toHaveBeenCalledOnce();
    expect(document.querySelector('#editor, #discard-dialog')).toBeNull();
  } finally { s.connector.stop(); }
});

test.each(['before', 'after'] as const)('remount %s cancellation only closes an instance proved while the token was valid', async ordering => {
  const s = setup({ authorize: async request => request.phase === 'disclose' || new Promise<boolean>(() => {}) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const original = document.querySelector<HTMLElement>('#editor')!, replacement = original.cloneNode(true) as HTMLElement;
    visibleTree(replacement); const close = vi.fn(() => replacement.remove());
    replacement.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.onclick = close;
    if (ordering === 'before') { original.replaceWith(replacement); s.connector.cancel(); }
    else { s.connector.cancel(); document.body.append(replacement); }
    await vi.advanceTimersByTimeAsync(100); await task;
    expect(close).toHaveBeenCalledTimes(ordering === 'before' ? 1 : 0);
    expect(s.closes).toHaveBeenCalledTimes(ordering === 'after' ? 1 : 0);
    expect(replacement.isConnected).toBe(ordering === 'after'); expect(s.clicks).not.toHaveBeenCalled();
  } finally { s.connector.stop(); }
});

test('a replaced Close inside the proved instance is refreshed without adopting another layer', async () => {
  const s = setup({ authorize: async request => request.phase === 'disclose' || new Promise<boolean>(() => {}) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const original = document.querySelector<HTMLButtonElement>('#editor [aria-label="Close"]')!, replacement = original.cloneNode(true) as HTMLButtonElement;
    visibleTree(replacement); const close = vi.fn(() => document.querySelector('#editor')!.remove()); replacement.onclick = close;
    original.replaceWith(replacement); s.connector.cancel(); await task;
    expect(close).toHaveBeenCalledOnce(); expect(s.closes).not.toHaveBeenCalled(); expect(document.querySelector('#editor')).toBeNull();
  } finally { s.connector.stop(); }
});

test('an editor opened during disclosure is preserved without assigning the file', async () => {
  let disclose!: (allowed: boolean) => void;
  const s = setup({ authorize: async () => new Promise(resolve => { disclose = resolve; }) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const user = userEditor(s.sticker.image); disclose(true); await task;
    expect(s.assignments).not.toHaveBeenCalled(); expect(user.close).not.toHaveBeenCalled();
    expect(user.layer.isConnected).toBe(true); expect(s.events.at(-1)).toMatchObject({ detail: 'editor-preopen' });
  } finally { s.connector.stop(); }
});

test('replacing the file inside the owned layer revokes destructive cleanup evidence', async () => {
  let approve!: (allowed: boolean) => void;
  const s = setup({ authorize: async request => request.phase === 'disclose' || new Promise(resolve => { approve = resolve; }) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    document.querySelector<HTMLImageElement>('#editor img')!.src = 'blob:replacement-user-file';
    approve(false); await task;
    expect(s.closes).not.toHaveBeenCalled(); expect(s.discards).not.toHaveBeenCalled(); expect(s.clicks).not.toHaveBeenCalled();
    expect(document.querySelector('#editor')).not.toBeNull(); expect(s.events.at(-1)).toMatchObject({ detail: 'editor-cleanup-failed' });
    expect(s.connector.preparation(s.current)).toBeUndefined();
  } finally { s.connector.stop(); }
});

test('chat change during Discard closes only the proved old instance and leaves the new chat editor untouched', async () => {
  const s = setup({ discardDelay: 200, authorize: async request => request.phase === 'disclose' });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    expect(s.closes).toHaveBeenCalledOnce();
    s.current.chatId = '456@c.us'; s.current.name = 'B';
    const user = userEditor();
    await vi.advanceTimersByTimeAsync(300); await task;
    expect(s.discards).toHaveBeenCalledOnce(); expect(document.querySelector('#editor, #discard-dialog')).toBeNull();
    expect(user.close).not.toHaveBeenCalled(); expect(user.layer.isConnected).toBe(true);
  } finally { s.connector.stop(); }
});

test('an attach menu mounted immediately before cancel is drained and closed without Escape', async () => {
  const s = setup();
  const attach = document.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!, openMenu = attach.onclick!;
  let open!: () => void;
  attach.onclick = event => {
    if (document.querySelector('#maker-menu')) { document.querySelector('#maker-menu')!.remove(); return; }
    open = () => { openMenu.call(attach, event); };
  };
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    open(); s.connector.cancel(); await task;
    expect(document.querySelector('#maker-menu')).toBeNull(); expect(s.assignments).not.toHaveBeenCalled(); expect(s.clicks).not.toHaveBeenCalled();
    expect(s.connector.preparation(s.current)).toBeUndefined();
  } finally { s.connector.stop(); }
});

test('a title changing away and back in one turn permanently revokes the token', async () => {
  const s = setup({ noEditor: true });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const title = document.querySelector('header')!; title.textContent = 'B'; title.textContent = snapshot.name;
    expect(s.connector.preparation(s.current)).toBeUndefined();
    const user = userEditor(s.sticker.image); await vi.advanceTimersByTimeAsync(100); await task;
    expect(user.close).not.toHaveBeenCalled(); expect(user.layer.isConnected).toBe(true);
    expect(s.events.at(-1)).toMatchObject({ type: 'stickerCancelled', reason: 'chat-changed' });
  } finally { s.connector.stop(); }
});

test('cancel keeps the input cleanup marker only until the already proved editor is discarded', async () => {
  const s = setup({ discardDelay: 200, authorize: async request => request.phase === 'disclose' || new Promise<boolean>(() => {}) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    s.connector.cancel();
    expect(s.connector.preparation(s.current)).toBe(nonce);
    await vi.advanceTimersByTimeAsync(300); await task;
    expect(s.connector.preparation(s.current)).toBeUndefined();
    expect(s.closes).toHaveBeenCalledOnce(); expect(s.discards).toHaveBeenCalledOnce(); expect(s.clicks).not.toHaveBeenCalled();
  } finally { s.connector.stop(); }
});

// DOM pieces may mount in separate turns: thumbnail, native controls, then
// message identity, content and direction. Ownership and append evidence must
// survive those stages without adopting replacement files or older history.
test.each(['send', 'close', 'marker', undefined] as const)('owned shell accepts its first re-encoded thumbnail with delayed %s', async delayedControl => {
  const s = setup({ thumbnailDelay: 400, spinner: 400, delayedControl });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(300);
    expect(s.clicks).not.toHaveBeenCalled();
    expect(s.permissions.map(p => p.phase)).toEqual(['disclose']);
    await vi.advanceTimersByTimeAsync(300); await task;
    expect(s.clicks).toHaveBeenCalledOnce(); expect(s.events.at(-1)).toMatchObject({ confirmed: true });
    expect(document.querySelector('#editor')).toBeNull();
  } finally { s.connector.stop(); }
});

test.each(['deny', 'cancel-before-thumbnail', 'cancel-after-thumbnail'] as const)('shell-then-thumbnail permits owned cleanup on %s', async end => {
  const s = setup({ thumbnailDelay: 400, spinner: 400, authorize: async request => request.phase === 'disclose' || (end === 'deny' ? false : new Promise<boolean>(() => {})) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(end === 'cancel-before-thumbnail' ? 100 : 500);
    if (end !== 'deny') s.connector.cancel();
    await vi.advanceTimersByTimeAsync(200); await task;
    expect(s.clicks).not.toHaveBeenCalled(); expect(s.closes).toHaveBeenCalledOnce(); expect(s.discards).toHaveBeenCalledOnce();
    expect(document.querySelector('#editor, #discard-dialog')).toBeNull();
  } finally { s.connector.stop(); }
});

test.each(['replace', 'restore-original', 'second-source'] as const)('an established first thumbnail cannot be replaced (%s)', async change => {
  let approve!: (allowed: boolean) => void;
  const s = setup({ thumbnailDelay: 200, spinner: 200, authorize: async request => request.phase === 'disclose' || new Promise(resolve => { approve = resolve; }) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(300);
    const image = document.querySelector<HTMLImageElement>('#editor img')!;
    if (change === 'second-source') { const extra = document.createElement('img'); extra.src = 'blob:replacement-file'; image.after(extra); }
    else image.src = change === 'restore-original' ? s.sticker.image : 'blob:replacement-file';
    approve(true); await task;
    expect(s.clicks).not.toHaveBeenCalled(); expect(s.closes).not.toHaveBeenCalled(); expect(s.discards).not.toHaveBeenCalled();
    expect(document.querySelector('#editor')).not.toBeNull(); expect(s.events.at(-1)).toMatchObject({ detail: 'editor-cleanup-failed' });
  } finally { s.connector.stop(); }
});

test.each(['prepend', 'group-prepend', 'append', 'group-append', 'delayed-content', 'delayed-direction', 'off-bottom', 'not-near-last', 'not-near-last-checks', 'not-near-last-aliases', 'frontier-unmounted'] as const)('maker requires appended message evidence (%s)', async placement => {
  const s = setup({ unconfirmed: true });
  const main = document.querySelector('#main')!;
  const baseline = document.createElement('div'); baseline.className = 'message-out'; baseline.dataset.testid = 'conv-msg-GROUP';
  baseline.innerHTML = '<div data-testid="grouped-sticker-item" id="BASELINE"><div data-testid="sticker-container"></div></div>'; main.append(baseline);
  if (placement.startsWith('not-near-last')) s.current.messages = [0, 1].map(i => ({ id: placement === 'not-near-last-checks' ? `OPAQUE-${i}` : `true_123@c.us_later-${i}`, outgoing: true, text: '' }));
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const row = document.createElement('div'); row.dataset.id = placement === 'delayed-direction' ? 'OPAQUE' : 'true_123@c.us_new';
    row.innerHTML = placement === 'delayed-content' ? '' : '<div data-testid="sticker-container"></div>';
    if (placement.startsWith('group-')) { row.dataset.testid = 'grouped-sticker-item'; placement === 'group-prepend' ? baseline.prepend(row) : baseline.append(row); }
    else if (placement === 'prepend') main.prepend(row);
    else main.append(row);
    if (placement === 'off-bottom') s.current.atBottom = false;
    if (placement === 'frontier-unmounted') baseline.remove();
    if (placement.startsWith('not-near-last')) for (let i = 0; i < 2; i++) {
      const later = document.createElement('div');
      if (placement === 'not-near-last-aliases') later.dataset.testid = `conv-msg-true_123@c.us_later-${i}`;
      else if (placement === 'not-near-last-checks') { later.dataset.id = `OPAQUE-${i}`; later.innerHTML = '<div data-testid="msg-meta"><span data-icon="msg-check"></span></div>'; }
      else later.dataset.id = `true_123@c.us_later-${i}`;
      // These are already known messages remounting after the candidate. A
      // candidate before the last outgoing sticker cannot confirm the send.
      later.insertAdjacentHTML('beforeend', '<div data-testid="sticker-container"></div>');
      main.append(later);
    }
    await vi.advanceTimersByTimeAsync(200);
    if (placement === 'delayed-content') row.innerHTML = '<div data-testid="sticker-container"></div>';
    if (placement === 'delayed-direction') row.className = 'message-out';
    // History cannot become a send just because its anchors disappear.
    if (placement === 'prepend' || placement === 'group-prepend') baseline.remove();
    if (placement === 'off-bottom') s.current.atBottom = true;
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_CONFIRMATION_MS + 100); await task;
    expect(s.events.at(-1)).toMatchObject({ clicked: true, confirmed: ['append', 'group-append', 'delayed-content', 'delayed-direction', 'off-bottom'].includes(placement) });
  } finally { s.connector.stop(); }
});

test('first thumbnail arriving during Send authorization belongs to the already owned shell', async () => {
  let approve!: (allowed: boolean) => void;
  const s = setup({ thumbnailDelay: 400, authorize: async request => request.phase === 'disclose' || new Promise(resolve => { approve = resolve; }) });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    expect(s.permissions.map(p => p.phase)).toEqual(['disclose', 'send']); expect(document.querySelector('#editor img')).toBeNull();
    await vi.advanceTimersByTimeAsync(400); approve(true); await task;
    expect(s.clicks).toHaveBeenCalledOnce(); expect(s.events.at(-1)).toMatchObject({ confirmed: true });
  } finally { s.connector.stop(); }
});

test('first thumbnail arriving during Discard teardown retains shell ownership after cancellation', async () => {
  const s = setup({ thumbnailDelay: 400, spinner: -1, discardDelay: 500 });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100); s.connector.cancel();
    await vi.advanceTimersByTimeAsync(600); await task;
    expect(s.closes).toHaveBeenCalledOnce(); expect(s.discards).toHaveBeenCalledOnce(); expect(s.clicks).not.toHaveBeenCalled();
    expect(document.querySelector('#editor, #discard-dialog')).toBeNull();
  } finally { s.connector.stop(); }
});

test('a thumbnail arriving in an unrelated shell cannot establish sticker editor ownership', async () => {
  const s = setup({ noEditor: true });
  try {
    const task = s.connector.make(s.ticket, s.sticker.image); await vi.advanceTimersByTimeAsync(100);
    const user = userEditor(); const thumbnail = user.layer.querySelector('img')!; thumbnail.remove();
    await vi.advanceTimersByTimeAsync(100); thumbnail.src = 'data:image/png;base64,cmVlbmNvZGVk'; user.layer.append(thumbnail);
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_PREPARATION_MS + 100); await task;
    expect(user.close).not.toHaveBeenCalled(); expect(user.layer.isConnected).toBe(true); expect(s.clicks).not.toHaveBeenCalled();
    expect(s.events.at(-1)).toMatchObject({ detail: 'editor-timeout' });
  } finally { s.connector.stop(); }
});

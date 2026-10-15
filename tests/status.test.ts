import { expect, test, vi } from 'vitest';
import { initialState, type Status, type Sticker } from '../src/shared/model';
import { StatusCache, StatusPublisher, statusUpdate } from '../src/core/status';
import { ChromeSync } from '../src/main/chrome-sync';
const status = (sequence = 1): Status => ({ sequence, state: initialState(), runtimePaused: false,
  chat: { chatId: null, name: '', kind: 'direct', ready: false, canSendSticker: false },
  keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true, message: 'Ready', pending: null });
const sticker: Sticker = { id: 'a'.repeat(64), searchTerms: 'cat', groups: [], kind: 'static', size: 24, firstSeen: 1, lastSeen: 1,
  fingerprint: { version: 1, animated: false, hash: 'a'.repeat(16), pixels: 'a'.repeat(288) } };

test('initial and sticker delta omit main-only data and reconstruct a compatible UI shape', () => {
  const initial = status(); initial.state.stickers = [sticker]; initial.state.conversations.private = ['b'.repeat(64)];
  initial.state.ledger.private = [{ at: 1, messageId: 'private' }]; initial.state.forgottenStickers = ['c'.repeat(64)];
  const wire = statusUpdate(initial), cache = new StatusCache();
  for (const field of ['conversations', 'ledger', 'forgottenStickers', 'desktop']) expect(wire.state).not.toHaveProperty(field);
  expect(wire.state?.stickers?.[0]).not.toHaveProperty('fingerprint');
  expect(cache.accept(wire)?.state).toMatchObject({ conversations: {}, ledger: {}, forgottenStickers: [], stickers: [{ searchTerms: 'cat' }] });
  const edited = { ...initial, sequence: 2, state: { ...initial.state, stickers: [{ ...sticker, searchTerms: 'dog' }] } };
  const delta = statusUpdate(edited, initial.state, initial);
  expect(delta.state).toBeUndefined(); expect(delta.stickerChanges?.upsert[0]).not.toHaveProperty('fingerprint');
  expect(cache.accept(delta)?.state.stickers[0].searchTerms).toBe('dog');
});

test('only changed settings/transient fields publish; main-only and fingerprint changes are suppressed', () => {
  const publisher = new StatusPublisher(() => {}), initial = status(); initial.state.stickers = [sticker];
  expect(publisher.next(initial)).toBeDefined();
  expect(publisher.next({ ...initial, sequence: 2, chat: { ...initial.chat } })).toBeUndefined();
  const privateChange = { ...initial, sequence: 2, state: { ...initial.state, desktop: { notifications: 'allowed' as const, startAtLogin: true }, conversations: { hidden: ['a'.repeat(64)] },
    stickers: [{ ...sticker, fingerprint: { ...sticker.fingerprint!, hash: 'b'.repeat(16) } }] } };
  expect(publisher.next(privateChange)).toBeUndefined();
  const settingsChange = { ...privateChange, state: { ...privateChange.state, global: { ...initial.state.global, tone: 'friendly' as const } } };
  expect(publisher.next(settingsChange)).toEqual({ sequence: 2, state: { global: settingsChange.state.global } });
  expect(publisher.next({ ...settingsChange, sequence: 3, message: 'Thinking' })).toEqual({ sequence: 3, message: 'Thinking' });
});

test('shield bytes cross the publication stream once per nonce and bounds deltas keep the captured image', () => {
  const publisher = new StatusPublisher(() => {}), cache = new StatusCache(), initial = status();
  const bounds = { x: 1, y: 0, width: 100, height: 200 };
  const shield = { ...initial, sequence: 2, stickerShield: { nonce: 'one', image: 'large capture', bounds, panel: bounds } };
  cache.accept(publisher.next(initial)!);
  const capture = publisher.next(shield)!; expect(capture.stickerShield?.image).toBe('large capture'); cache.accept(capture);
  const transient = publisher.next({ ...shield, sequence: 3, message: 'Sending' })!;
  expect(transient).not.toHaveProperty('stickerShield'); cache.accept(transient);
  const moved = publisher.next({ ...shield, sequence: 4, message: 'Sending', stickerShield: { ...shield.stickerShield, bounds: { ...bounds, width: 200 } } })!;
  expect(moved.stickerShield).not.toHaveProperty('image'); expect(cache.accept(moved)?.stickerShield).toMatchObject({ image: 'large capture', bounds: { width: 200 } });
  expect(publisher.next({ ...shield, sequence: 5, stickerShield: { ...shield.stickerShield, nonce: 'two' } })?.stickerShield?.image).toBe('large capture');
  expect(publisher.next({ ...shield, sequence: 6, stickerShield: null })?.stickerShield).toBeNull();
});

test('projected initial read reconciles queued smaller deltas and ignores older events', () => {
  const initial = status(), next = { ...initial, sequence: 2, message: 'Thinking', state: { ...initial.state, provider: 'anthropic' as const } };
  const cache = new StatusCache(); expect(cache.accept(statusUpdate(next, initial.state, initial))).toBeUndefined();
  const result = cache.accept(statusUpdate(initial));
  expect(result?.sequence).toBe(2); expect(result?.state.provider).toBe('anthropic'); expect(result?.message).toBe('Thinking');
  expect(cache.accept({ sequence: 1, message: 'stale' })).toBe(result);
});

test('chrome geometry/pending/panel commands deduplicate and a new document resets the cache', () => {
  const sync = new ChromeSync(() => {}), command = { type: 'chrome' as const, panel: 'stickers' as const, pending: false, panelBounds: { left: 64, right: 494 } };
  expect(sync.next(command)).toEqual(command); expect(sync.next({ ...command, panelBounds: { ...command.panelBounds } })).toBeUndefined();
  expect(sync.next({ ...command, pending: true })).toBeDefined();
  expect(sync.next({ ...command, panelBounds: { left: 65, right: 495 } })).toBeDefined();
  sync.reset(); expect(sync.next(command)).toBeDefined();
});

test('reset sends complete unchanged state and the same shield nonce to a fresh controls cache', () => {
  const publisher = new StatusPublisher(() => {}), bounds = { x: 1, y: 0, width: 100, height: 200 };
  const initial = { ...status(), panel: 'stickers' as const, stickerShield: { nonce: 'one', image: 'capture', bounds, panel: bounds } };
  publisher.next(initial);
  expect(publisher.next(initial)).toBeUndefined();
  publisher.reset();
  const update = publisher.next({ ...initial, sequence: 2 })!;
  expect(update).toEqual(statusUpdate({ ...initial, sequence: 2 }));
  expect(new StatusCache().accept(update)).toMatchObject({ panel: 'stickers', stickerShield: { nonce: 'one', image: 'capture' } });
});

test('one-shot reads preserve each subscriber baseline and always include the shield image', () => {
  const initial = { ...status(), panel: 'stickers' as const, stickerShield: null };
  const subscribers = [new StatusCache(), new StatusCache()];
  const publishers = subscribers.map(cache => new StatusPublisher(update => { cache.accept(update); }));
  publishers.forEach(publisher => publisher.next(initial));
  const bounds = { x: 1, y: 0, width: 100, height: 200 };
  const busy = { ...initial, sequence: 2, chat: { ...initial.chat, stickerSendBlockedReason: 'busy' as const },
    stickerSend: { id: sticker.id, name: 'A friend', nonce: 'maker', route: 'maker' as const, animated: false, state: 'preparing' as const } };
  expect(statusUpdate(busy)).toMatchObject({ state: { stickers: [] }, stickerSend: busy.stickerSend, chat: busy.chat });
  const shield = { ...busy, stickerShield: { nonce: 'maker', image: 'capture', bounds, panel: bounds } };
  publishers[0].next(shield);
  expect(statusUpdate(shield).stickerShield?.image).toBe('capture');
  // The second subscriber still needs all fields, despite the first delivery.
  expect(publishers[1].next(shield)).toMatchObject({ stickerSend: busy.stickerSend, chat: busy.chat, stickerShield: shield.stickerShield });
  expect(publishers[0].next(shield)).toBeUndefined();
  expect(statusUpdate(shield).stickerShield?.image).toBe('capture');
});

test('failed status and chrome deliveries do not advance their baselines', () => {
  const deliver = vi.fn(), publisher = new StatusPublisher(deliver), initial = status();
  publisher.next(initial);
  const changed = { ...initial, sequence: 2, message: 'Sending' };
  deliver.mockImplementationOnce(() => { throw new Error('delivery failed'); });
  expect(() => publisher.next(changed)).toThrow('delivery failed');
  expect(publisher.next(changed)).toEqual({ sequence: 2, message: 'Sending' });
  expect(publisher.next(changed)).toBeUndefined();

  const sendChrome = vi.fn(), sync = new ChromeSync(sendChrome);
  const command = { type: 'chrome' as const, panel: 'stickers' as const, pending: false, panelBounds: null };
  sendChrome.mockImplementationOnce(() => { throw new Error('delivery failed'); });
  expect(() => sync.next(command)).toThrow('delivery failed');
  expect(sync.next(command)).toEqual(command);
  expect(sync.next(command)).toBeUndefined();
});

test('a changed shield image is delivered even when its nonce is unchanged', () => {
  const cache = new StatusCache(), publisher = new StatusPublisher(update => { cache.accept(update); });
  const bounds = { x: 1, y: 0, width: 100, height: 200 };
  const initial = { ...status(), stickerShield: { nonce: 'one', image: 'old', bounds, panel: bounds } };
  publisher.next(initial);
  const changed = { ...initial, sequence: 2, stickerShield: { ...initial.stickerShield, image: 'new' } };
  expect(publisher.next(changed)?.stickerShield?.image).toBe('new');
  expect(cache.accept({ sequence: 0 })?.stickerShield?.image).toBe('new');
});

test.each(Array.from({ length: 12 }, (_, seed) => seed + 1))('interleaved reads and publications reconstruct full state for every subscriber (seed %i)', seed => {
  let randomState = seed;
  const random = (max: number) => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % max; };
  let current: Status = { ...status(), stickerSend: null, stickerShield: null, stickerLocation: null, panel: null, theme: 'dark' };
  const subscribers = Array.from({ length: 2 }, () => {
    const subscriber = { cache: new StatusCache(), reconstructed: undefined as Status | undefined };
    const publisher = new StatusPublisher(update => { subscriber.reconstructed = subscriber.cache.accept(structuredClone(update)); });
    publisher.next(current);
    return { subscriber, publisher };
  });
  const observable = (snapshot: Status) => { const { sequence: _sequence, ...rest } = snapshot; return rest; };
  for (let step = 1; step <= 120; step++) {
    current = { ...current, sequence: step + 1 };
    switch (random(10)) {
      case 0: current = { ...current, message: `message ${random(5)}`, runtimePaused: Boolean(random(2)) }; break;
      case 1: current = { ...current, panel: random(2) ? 'stickers' : null, theme: random(2) ? 'dark' : 'light' }; break;
      case 2: current = { ...current, state: { ...current.state, global: { ...current.state.global, tone: random(2) ? 'friendly' : 'natural' } } }; break;
      case 3: {
        const id = String(random(4)).repeat(64), existing = current.state.stickers.find(s => s.id === id);
        const stickers = existing ? current.state.stickers.map(s => s.id === id ? { ...s, searchTerms: `term ${step}` } : s) :
          [...current.state.stickers, { ...sticker, id, searchTerms: `term ${step}` }];
        current = { ...current, state: { ...current.state, stickers } }; break;
      }
      case 4: current = { ...current, state: { ...current.state, stickers: current.state.stickers.slice(1) } }; break;
      case 5: {
        const busy = Boolean(random(2));
        current = { ...current, chat: { ...current.chat, ready: true, canSendSticker: !busy, stickerSendBlockedReason: busy ? 'busy' : undefined },
          stickerSend: busy ? { id: sticker.id, name: 'A friend', nonce: `maker ${step}`, route: 'maker', animated: false, state: 'preparing' } : null }; break;
      }
      case 6: {
        const bounds = { x: 1, y: 0, width: step, height: 200 };
        current = { ...current, stickerShield: random(3) ? { nonce: current.stickerShield?.nonce ?? `shield ${step}`,
          image: current.stickerShield?.image ?? `capture ${step}`, bounds, panel: bounds } : null }; break;
      }
      case 7: current = { ...current, pending: random(2) ? { text: `pending ${step}`, due: step } : null }; break;
      case 8: current = { ...current, state: { ...current.state, conversations: { hidden: [String(step)] } } }; break;
      // No observable change: suppression must also preserve delivered history.
    }
    for (let read = 0, count = random(6); read < count; read++) {
      const full = new StatusCache().accept(statusUpdate(current))!;
      expect(full.stickerShield).toEqual(current.stickerShield);
    }
    if (random(8) === 0) {
      const { subscriber, publisher } = subscribers[random(subscribers.length)];
      subscriber.cache = new StatusCache(); subscriber.reconstructed = undefined; publisher.reset();
    }
    const full = new StatusCache().accept(statusUpdate(current))!;
    for (const { subscriber, publisher } of subscribers) {
      publisher.next(current);
      expect(observable(subscriber.reconstructed!)).toEqual(observable(full));
    }
  }
});

test('forgotten stickers project only a boolean on initial status and deletion deltas', () => {
  const initial = status(), cache = new StatusCache();
  const first = statusUpdate(initial); expect(first.state?.hasForgotten).toBe(false); cache.accept(first);
  const deleted = { ...initial, sequence: 2, state: { ...initial.state, forgottenStickers: [sticker.id] } };
  const delta = statusUpdate(deleted, initial.state, initial);
  expect(delta.state).toEqual({ hasForgotten: true }); expect(cache.accept(delta)?.state.hasForgotten).toBe(true);
  const reopened = new StatusCache().accept(statusUpdate(deleted));
  expect(reopened?.state.hasForgotten).toBe(true); expect(reopened?.state.forgottenStickers).toEqual([]);
  const more = { ...deleted, sequence: 3, state: { ...deleted.state, forgottenStickers: [...deleted.state.forgottenStickers, 'b'.repeat(64)] } };
  expect(statusUpdate(more, deleted.state, deleted)).toEqual({ sequence: 3 });
});

// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { initialState, type Status, type StickerShield } from '../src/shared/model';
import { useShield } from '../src/ui/shield';
import type { Act } from '../src/ui/index';
import { Stickers } from '../src/ui/stickers';

const shield: StickerShield = {
  nonce: 'shield-1', image: 'data:image/jpeg;base64,c25hcHNob3Q=',
  bounds: { x: 560, y: 0, width: 720, height: 832 },
  panel: { x: 73, y: 0, width: 430, height: 832 }
};
const status = (stickerShield: StickerShield | null = shield): Status => ({
  sequence: 1, state: initialState(), runtimePaused: false,
  chat: { chatId: '123@c.us', settingsId: '123@c.us', name: 'Alex', kind: 'direct', ready: true, canSendSticker: true },
  keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true,
  message: '', pending: null, panel: 'stickers', stickerShield
});
let root: Root, host: HTMLDivElement;
function Harness({ status }: { status: Status }) {
  const drawn = useShield(status);
  return <><section data-frame={drawn.frame ? '' : undefined} style={drawn.frame}/>{drawn.layer}</>;
}
const render = (next: Status) => act(() => root.render(<Harness status={next}/>));
const resize = (width: number) => act(() => {
  vi.stubGlobal('innerWidth', width); window.dispatchEvent(new Event('resize'));
});
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('innerWidth', 430); vi.stubGlobal('innerHeight', 832);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  Object.assign(window, { companion: { shieldReady: vi.fn(async () => {}), shieldFaded: vi.fn(async () => {}) } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test('status-before-enlarge keeps the panel at the native view origin and offsets the chat shield', () => {
  render(status(null)); render(status());
  expect(host.querySelector('.shield')).not.toBeNull();
  expect(window.companion.shieldReady).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(16));
  expect(window.companion.shieldReady).toHaveBeenCalledExactlyOnceWith(shield.nonce, false);
  vi.stubGlobal('innerWidth', 1280 - shield.panel.x); // Native bounds can change before a resize event.

  const frame = host.querySelector<HTMLElement>('section')!;
  expect(frame.style.getPropertyValue('--panel-width')).toBe('430px');
  expect(host.querySelector<HTMLElement>('.shield')!.style.left).toBe('487px');
});

test('enlarge-before-status draws the shield once its coordinates arrive', () => {
  render(status(null)); resize(1280 - shield.panel.x); render(status());
  expect(host.querySelector('.shield')).not.toBeNull();
  expect(host.querySelector<HTMLElement>('section')!.style.getPropertyValue('--panel-width')).toBe('430px');
});

test('fade-before-resize retains the pointer-blocking shield and panel placement until the native view shrinks', () => {
  render(status()); resize(1280 - shield.panel.x); render(status(null));
  expect(host.querySelector('.shield')?.hasAttribute('data-leaving')).toBe(true);
  act(() => vi.advanceTimersByTime(149)); expect(host.querySelector('.shield')).not.toBeNull();
  expect(window.companion.shieldFaded).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1)); expect(host.querySelector('.shield')).not.toBeNull();
  expect(window.companion.shieldFaded).toHaveBeenCalledExactlyOnceWith(shield.nonce);
  const click = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  act(() => host.querySelector('.shield')!.dispatchEvent(click));
  expect(click.defaultPrevented).toBe(true);
  act(() => vi.advanceTimersByTime(350)); expect(host.querySelector('.shield')).not.toBeNull();
  expect(host.querySelector('section')?.hasAttribute('data-frame')).toBe(true);
  vi.stubGlobal('innerWidth', 430);
  expect(host.querySelector<HTMLElement>('section')!.style.getPropertyValue('--panel-width')).toBe('430px');
  resize(430);
  expect(host.querySelector('.shield')).toBeNull();
  expect(host.querySelector('section')?.hasAttribute('data-frame')).toBe(false);
});

test.each([430, 431])('resize-before-fade removes the shield immediately at width %s without reviving it', width => {
  render(status()); resize(1280 - shield.panel.x); render(status(null));
  act(() => vi.advanceTimersByTime(75));
  resize(width);
  expect(host.querySelector('.shield')).toBeNull();
  expect(host.querySelector('section')?.hasAttribute('data-frame')).toBe(false);
  act(() => vi.advanceTimersByTime(1000));
  expect(window.companion.shieldFaded).not.toHaveBeenCalled();
  resize(1280 - shield.panel.x);
  expect(host.querySelector('.shield')).toBeNull();
});

test('the renderer cap removes a stuck shield and a fresh nonce can appear afterward', () => {
  render(status()); resize(1280 - shield.panel.x);
  act(() => vi.advanceTimersByTime(10_000));
  expect(host.querySelector('.shield')?.hasAttribute('data-leaving')).toBe(true);
  act(() => vi.advanceTimersByTime(999)); expect(host.querySelector('.shield')).not.toBeNull();
  act(() => vi.advanceTimersByTime(1)); expect(host.querySelector('.shield')).toBeNull();
  render(status({ ...shield, nonce: 'shield-2' }));
  expect(host.querySelector('.shield')).not.toBeNull();
  expect(host.querySelector('.shield')?.hasAttribute('data-leaving')).toBe(false);
});

test('reduced motion skips the fade but retains the shield layer until restore', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  render(status());
  act(() => vi.advanceTimersByTime(16));
  expect(window.companion.shieldReady).toHaveBeenCalledExactlyOnceWith(shield.nonce, true);
  resize(1280 - shield.panel.x); render(status(null));
  expect(host.querySelector('.shield')?.hasAttribute('data-leaving')).toBe(true);
  act(() => vi.advanceTimersByTime(0));
  expect(window.companion.shieldFaded).toHaveBeenCalledExactlyOnceWith(shield.nonce);
  expect(host.querySelector('section')?.hasAttribute('data-frame')).toBe(true);
  vi.stubGlobal('innerWidth', 430);
  expect(host.querySelector<HTMLElement>('section')!.style.getPropertyValue('--panel-width')).toBe('430px');
  resize(430);
  expect(host.querySelector('.shield')).toBeNull();
  expect(host.querySelector('section')?.hasAttribute('data-frame')).toBe(false);
});

test('a fresh shield cancels the old fade acknowledgment and restore cap', () => {
  render(status()); resize(1280 - shield.panel.x); render(status(null));
  act(() => vi.advanceTimersByTime(75));
  render(status({ ...shield, nonce: 'shield-2' }));
  act(() => vi.advanceTimersByTime(1000));
  expect(window.companion.shieldFaded).not.toHaveBeenCalled();
  expect(host.querySelector('.shield')).not.toBeNull();
  expect(host.querySelector('.shield')?.hasAttribute('data-leaving')).toBe(false);
});

test.each(['finding', 'preparing', 'sending'] as const)('Escape is consumed during %s and only requests cancellation before hand-off', state => {
  const next = status(null), action = vi.fn(async () => true);
  next.stickerSend = { id: 'a'.repeat(64), nonce: 'send-1', name: 'Alex', animated: state === 'finding', route: state === 'finding' ? 'picker' : 'maker', state };
  act(() => root.render(<Stickers status={next} act={action}/>));
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => window.dispatchEvent(escape));
  expect(escape.defaultPrevented).toBe(true);
  if (state === 'sending') expect(action).not.toHaveBeenCalled();
  else expect(action).toHaveBeenCalledExactlyOnceWith({ type: 'cancelSticker' });
});

test('a send that finishes before the drawing frame never acknowledges an absent shield', () => {
  render(status()); render(status(null));
  act(() => vi.advanceTimersByTime(16));
  expect(window.companion.shieldReady).not.toHaveBeenCalled();
});

const draftFailures = [
  { detail: 'draft-present', sent: 'not-sent', route: 'maker', message: 'Send or clear your draft first, then send the sticker.' },
  { detail: 'draft-present', sent: 'not-sent', route: 'picker', message: 'Send or clear your draft first, then send the sticker.' },
  { detail: 'draft-appeared', sent: 'not-sent', route: 'maker', message: 'Send or clear your draft first, then send the sticker.' },
  { detail: 'draft-appeared', sent: 'unknown', route: 'maker', message: 'Couldn’t confirm the sticker was sent. Check the chat before sending again.' }
] as const;
test.each(draftFailures)('draft failure $detail ($sent) uses accurate row and live-region text with no send action', ({ detail, sent, route, message }) => {
  const next = status(null), action = vi.fn(async () => true), id = 'a'.repeat(64);
  next.state.stickers = [{ id, groups: [], kind: 'static', size: 12, searchTerms: 'draft test', firstSeen: 1, lastSeen: 1 }];
  act(() => root.render(<Stickers status={next} act={action}/>));
  // A pre-interaction refusal can arrive without any intermediate preparing state.
  next.stickerSend = { id, nonce: 'draft-1', name: 'Alex', route, animated: false, state: 'failed', sent, reason: 'draft', detail };
  act(() => root.render(<Stickers status={next} act={action}/>));
  const row = host.querySelector('.sticker-message')!;
  expect(row.querySelector('.msg p')?.textContent).toBe(message);
  expect(host.querySelector('[aria-live]')?.textContent).toBe(message);
  expect(row.querySelector('.msg button')).toBeNull(); expect(action).not.toHaveBeenCalled();
});

test.each(draftFailures.flatMap(failure => (['before', 'after'] as const).map(when => ({ ...failure, when }))))('draft failure $detail ($sent) stays explained when its card is filtered $when the result arrives', ({ detail, sent, route, message, when }) => {
  const next = status(null), action = vi.fn(async () => true), id = 'a'.repeat(64);
  next.state.stickers = [{ id, groups: [], kind: 'static', size: 12, searchTerms: 'draft test', firstSeen: 1, lastSeen: 1 }];
  const draw = () => act(() => root.render(<Stickers status={next} act={action}/>));
  const filter = (query: string) => act(() => {
    const input = host.querySelector<HTMLInputElement>('.search')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  draw();
  if (when === 'before') filter('no matching sticker');
  next.stickerSend = { id, nonce: 'draft-1', name: 'Alex', route, animated: false, state: 'failed', sent, reason: 'draft', detail };
  draw();
  if (when === 'after') filter('no matching sticker');
  expect(host.querySelector('.sticker-message')).toBeNull();
  expect(host.querySelector('.sticker-strip')?.textContent).toContain(message);
  expect(host.querySelector('[aria-live]')?.textContent).toBe(message);
  act(() => vi.advanceTimersByTime(2000));
  expect(host.querySelector('.sticker-strip')?.textContent).toContain(message);
  filter('');
  expect(host.querySelector('.sticker-message .msg p')?.textContent).toBe(message);
  expect(host.querySelector('.sticker-message .msg button')).toBeNull();
  expect((host.querySelector('.sticker-strip')?.textContent ?? '')).not.toContain(message);
  filter('no matching sticker');
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => window.dispatchEvent(escape));
  expect(escape.defaultPrevented).toBe(true);
  expect((host.querySelector('.sticker-strip')?.textContent ?? '')).not.toContain(message);
  expect(host.querySelector('[aria-live]')?.textContent).toBe('');
  expect(action).not.toHaveBeenCalled();
});

test.each(['unknown', 'confirmed', undefined] as const)('editor-unavailable does not imply nothing was sent when outcome is %s', sent => {
  const next = status(null), action = vi.fn(async () => true), id = 'a'.repeat(64);
  next.state.stickers = [{ id, groups: [], kind: 'static', size: 12, searchTerms: 'editor test', firstSeen: 1, lastSeen: 1 }];
  act(() => root.render(<Stickers status={next} act={action}/>));
  next.stickerSend = { id, nonce: 'editor-1', name: 'Alex', route: 'maker', animated: false, state: 'failed', sent, reason: 'editor-unavailable' };
  act(() => root.render(<Stickers status={next} act={action}/>));
  expect(host.querySelector('.sticker-message .msg p')?.textContent).toBe(sent === 'confirmed' ? 'Sticker sent.' : 'Couldn’t confirm the sticker was sent. Check the chat before sending it again.');
  expect(host.querySelector('[aria-live]')?.textContent).toBe(sent === 'confirmed' ? 'Sticker sent' : 'Couldn’t confirm the sticker was sent');
  expect(host.querySelector('.sticker-message .msg button')).toBeNull();
  expect(action).not.toHaveBeenCalled();
});

test.each(['Try again', 'Send still'])('animated missing row %s requires a trusted event and chooses the explicit route', async label => {
  const next = status(null), action = vi.fn(async (_action: unknown) => true), id = 'a'.repeat(64);
  next.chat.destinationToken = '1';
  next.state.stickers = [{ id, groups: [], kind: 'static', size: 12, searchTerms: 'animated', firstSeen: 1, lastSeen: 1 }];
  const draw = () => act(() => root.render(<Stickers status={next} act={action}/>));
  // JSDOM cannot create trusted native events. Invoke the actual React handler
  // with the trust flag for the authorized half, and DOM click for rejection.
  const trustedClick = async (button: HTMLButtonElement) => {
    const key = Object.keys(button).find(key => key.startsWith('__reactProps$'))!;
    const handler = (button as unknown as Record<string, { onClick: (event: { nativeEvent: { isTrusted: boolean } }) => void }>)[key].onClick;
    await act(async () => handler({ nativeEvent: { isTrusted: true } }));
  };
  draw();
  await trustedClick(host.querySelector<HTMLButtonElement>('.sticker-art')!);
  const original = action.mock.calls[0][0] as { nonce: string };
  next.stickerSend = { id, nonce: original.nonce, name: 'Alex', route: 'picker', animated: true, state: 'missing' };
  draw();
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('.sticker-message .msg button')];
  expect(buttons.map(button => button.textContent)).toEqual(['Send still', 'Try again']);
  const button = buttons.find(button => button.textContent === label)!;
  act(() => button.click());
  expect(action).toHaveBeenCalledTimes(1);
  await trustedClick(button);
  expect(action).toHaveBeenCalledTimes(2);
  const retry = action.mock.calls[1][0] as { nonce: string; still?: true };
  expect(retry).toMatchObject({ type: 'sendSticker', id, destinationToken: '1' });
  expect(retry.nonce).not.toBe(original.nonce);
  expect(retry.still).toBe(label === 'Send still' ? true : undefined);
});

test('sticker cards load protocol images lazily and recover after an image error', () => {
  const next = status(null), id = 'a'.repeat(64);
  next.state.stickers = [{ id, searchTerms: 'recovery', firstSeen: 1, lastSeen: 1, groups: [], kind: 'animated', size: 42 }];
  act(() => root.render(<Stickers status={next} act={vi.fn(async () => true)}/>));
  const image = host.querySelector('img')!;
  expect(image.getAttribute('src')).toBe(`companion-sticker://${id}`);
  expect(image.getAttribute('loading')).toBe('lazy');
  act(() => image.dispatchEvent(new Event('error')));
  const retry = [...host.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Image unavailable. Retry')!;
  expect(retry).toBeDefined(); act(() => retry.click());
  const recovered = host.querySelector('img')!; expect(recovered).not.toBe(image);
  act(() => recovered.dispatchEvent(new Event('load')));
  expect(host.textContent).not.toContain('Image unavailable');
});
test.each(['Sticker library is full', "Couldn't save new stickers"])('the notice strip shows %s', error => {
  const next = status(null); next.stickerLibraryError = error;
  act(() => root.render(<Stickers status={next} act={vi.fn(async () => true)}/>));
  expect(host.querySelector('.sticker-strip')?.textContent).toContain(error);
});


test.each(['not-sent', 'unknown'] as const)('direct storage failure uses accurate wording and announcement (%s)', sent => {
  const next = status(null), action = vi.fn(async () => true), id = 'a'.repeat(64);
  next.state.stickers = [{ id, groups: [], kind: 'static', size: 12, searchTerms: 'storage test', firstSeen: 1, lastSeen: 1 }];
  act(() => root.render(<Stickers status={next} act={action}/>));
  next.stickerSend = { id, nonce: 'storage-1', name: 'Alex', route: 'direct', animated: false, state: 'failed', sent };
  act(() => root.render(<Stickers status={next} act={action}/>));
  expect(host.querySelector('.sticker-message .msg p')?.textContent).toBe(sent === 'not-sent' ? 'Couldn’t send the sticker. Nothing was sent.' : 'Couldn’t confirm the sticker was sent. Check the chat before sending it again.');
  expect(host.querySelector('[aria-live]')?.textContent).toBe(sent === 'not-sent' ? 'Nothing was sent' : 'Couldn’t confirm the sticker was sent');
  expect(action).not.toHaveBeenCalled();
});

const libraryStatus = (count = 6) => {
  const next = status(null); next.chat.destinationToken = 'destination-1';
  next.state.stickers = Array.from({ length: count }, (_, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), groups: [], kind: 'static' as const, size: 12, searchTerms: `sticker ${i}`, firstSeen: 1, lastSeen: count - i }));
  return next;
};
const drawLibrary = (next: Status, action: Act = vi.fn(async () => true)) => act(() => root.render(<Stickers status={next} act={action}/>));
const tile = (index = 0) => host.querySelectorAll<HTMLButtonElement>('.sticker-art')[index];
const clickText = (label: string) => act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label || button.getAttribute('aria-label') === label)!.click());
const inputText = (selector: string, value: string) => act(() => {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const pressEscape = () => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => window.dispatchEvent(event)); return event.defaultPrevented;
};
const authorizedClick = async (button: HTMLButtonElement, detail = 1) => {
  // JSDOM has no trusted input or browser keyboard-to-click default action.
  // Exercise the React handler with the native click emitted by those actions.
  const key = Object.keys(button).find(key => key.startsWith('__reactProps$'))!;
  const props = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[key];
  await act(async () => props.onClick({ nativeEvent: { isTrusted: true, detail } }));
};

beforeEach(() => { Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }); });

test.each([{ label: 'click', detail: 1 }, { label: 'keyboard activation', detail: 0 }])('$label sends from the tile and synthetic clicks cannot send', async ({ detail }) => {
  const next = libraryStatus(1), action = vi.fn(async (_action: unknown) => true);
  drawLibrary(next, action);
  expect(tile().tagName).toBe('BUTTON'); expect(tile().getAttribute('aria-label')).toBe('sticker 0');
  expect(host.querySelector('.sticker-actions')).toBeNull();
  act(() => tile().click()); expect(action).not.toHaveBeenCalled();
  await authorizedClick(tile(), detail);
  expect(action).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'sendSticker', id: next.state.stickers[0].id, destinationToken: 'destination-1' }));
  expect(tile().hasAttribute('data-busy')).toBe(true);
  expect(host.querySelector('.spinner')).not.toBeNull();
  expect(host.querySelector('.cancel-send')).not.toBeNull();
  expect(host.querySelector('[aria-live]')?.textContent).toBe('Sending sticker…');
});

test('busy tile activation does nothing and announces the reason without disabling other tiles', async () => {
  const next = libraryStatus(2), action = vi.fn(async (_action: unknown) => true);
  drawLibrary(next, action); await authorizedClick(tile());
  expect(tile(1).hasAttribute('aria-disabled')).toBe(false);
  await authorizedClick(tile(1));
  expect(action).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[aria-live]')?.textContent).toBe('Wait for the current sticker');
});

test.each(['sent', 'cancelled'] as const)('%s feedback clears after 1.5 seconds, including a result filtered after arrival', state => {
  const next = libraryStatus(1); drawLibrary(next);
  next.stickerSend = { id: next.state.stickers[0].id, nonce: 'result', name: 'Alex', route: 'maker', animated: false, state };
  drawLibrary(next);
  expect(host.querySelector('.sticker-overlay')?.textContent).toBe(state === 'sent' ? 'Sent' : 'Cancelled');
  expect(tile().hasAttribute('data-sent')).toBe(state === 'sent');
  inputText('.search', 'no match');
  expect(host.querySelector('.sticker-strip')?.textContent).toBe(state === 'sent' ? 'Sent to Alex' : 'Cancelled');
  act(() => vi.advanceTimersByTime(1499)); expect(host.querySelector('[aria-live]')?.textContent).not.toBe('');
  act(() => vi.advanceTimersByTime(1)); expect(host.querySelector('[aria-live]')?.textContent).toBe('');
  expect(host.querySelector('.sticker-strip')).toBeNull();
});

test('no chat dims the tile, explains why in the header, and cannot send', async () => {
  const next = libraryStatus(1), action = vi.fn(async () => true); next.chat.canSendSticker = false; delete next.chat.destinationToken;
  drawLibrary(next, action); expect(tile().getAttribute('aria-disabled')).toBe('true');
  expect(host.querySelector('.sticker-head .sticker-strip')?.textContent).toBe('Open a chat to send');
  await authorizedClick(tile()); expect(action).not.toHaveBeenCalled();
  clickText('Edit stickers'); expect(tile().hasAttribute('aria-disabled')).toBe(false);
});

test('count inside Search uses N or M of N and a separate accessible description', () => {
  drawLibrary(libraryStatus());
  expect(host.querySelector('.sticker-search .count')?.textContent).toBe('6');
  const input = host.querySelector('.search')!;
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('6 stickers indexed');
  inputText('.search', 'sticker 2'); expect(host.querySelector('.count')?.textContent).toBe('1 of 6');
  inputText('.search', 'sticker'); expect(host.querySelector('.count')?.textContent).toBe('6');
  inputText('.search', 'no match'); expect(host.querySelector('.count')?.textContent).toBe('0 of 6');
});

test('failure row and arrow follow the resolved grid columns when resized', () => {
  let tracks = '90px 90px 90px 90px';
  vi.stubGlobal('getComputedStyle', () => ({ gridTemplateColumns: tracks }));
  const next = libraryStatus(); drawLibrary(next);
  next.stickerSend = { id: next.state.stickers[3].id, nonce: 'failure', name: 'Alex', route: 'direct', animated: false, state: 'failed', sent: 'unknown' }; drawLibrary(next);
  const grid = host.querySelector<HTMLElement>('.sticker-grid')!, row = grid.querySelector<HTMLElement>('.sticker-message')!;
  expect(grid.style.getPropertyValue('--cols')).toBe('4'); expect(row.style.getPropertyValue('--col')).toBe('4');
  expect(row.previousElementSibling?.getAttribute('data-sticker')).toBe(next.state.stickers[3].id);
  expect(tile(3).querySelector('.mark')?.textContent).toBe('!');
  expect(tile(3).parentElement?.hasAttribute('data-attached')).toBe(true);
  tracks = '110px 110px 110px'; act(() => window.dispatchEvent(new Event('resize')));
  expect(grid.style.getPropertyValue('--cols')).toBe('3'); expect(row.style.getPropertyValue('--col')).toBe('1');
  expect(row.previousElementSibling?.getAttribute('data-sticker')).toBe(next.state.stickers[5].id);
  expect(row.querySelector('.msg button')).toBeNull();
  act(() => row.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click());
  expect(grid.querySelector('.sticker-message')).toBeNull(); expect(document.activeElement).toBe(tile(3));
});

test('maker failure offers only Try again and another send replaces the attached message', async () => {
  const next = libraryStatus(2), action = vi.fn(async (_action: unknown) => true); drawLibrary(next, action);
  next.stickerSend = { id: next.state.stickers[0].id, nonce: 'failure', name: 'Alex', route: 'maker', animated: false, state: 'failed', sent: 'not-sent', reason: 'editor-unavailable' }; drawLibrary(next, action);
  expect(host.querySelector('.sticker-message .msg button')?.textContent).toBe('Try again');
  await authorizedClick(tile(1)); expect(host.querySelector('.sticker-message')).toBeNull();
  expect(action).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: next.state.stickers[1].id }));
});

test('chat change dismisses even an unconfirmed message that has no retry', () => {
  const next = libraryStatus(1); drawLibrary(next);
  next.stickerSend = { id: next.state.stickers[0].id, nonce: 'failure', name: 'Alex', route: 'maker', animated: false, state: 'failed', sent: 'unknown' }; drawLibrary(next);
  expect(host.querySelector('.sticker-message')).not.toBeNull();
  next.chat = { ...next.chat, name: 'Another chat', chatId: '456@c.us', settingsId: '456@c.us' }; drawLibrary(next);
  expect(host.querySelector('.sticker-message')).toBeNull(); expect(host.querySelector('[aria-live]')?.textContent).toBe('');
});

test('edit mode switches editors only after the dirty prompt and Done keeps Search', () => {
  const next = libraryStatus(2); drawLibrary(next); inputText('.search', 'sticker'); clickText('Edit stickers');
  act(() => tile().click()); expect(tile().getAttribute('aria-expanded')).toBe('true');
  inputText('textarea', 'changed terms'); act(() => tile(1).click());
  expect(host.querySelector('.discard')).not.toBeNull(); expect(host.querySelector('textarea')?.value).toBe('changed terms');
  expect(pressEscape()).toBe(true); expect(host.querySelector('.discard')).toBeNull();
  act(() => tile(1).click()); clickText('Discard');
  expect(host.querySelector('textarea')?.value).toBe('sticker 1');
  inputText('textarea', 'another draft'); clickText('Done'); clickText('Keep editing');
  expect(host.querySelector('textarea')?.value).toBe('another draft'); expect(host.querySelector('.sticker-mode')?.textContent).toBe('Done');
  clickText('Done'); clickText('Discard'); expect(host.querySelector('.sticker-detail')).toBeNull();
  expect(host.querySelector('.sticker-mode')?.getAttribute('aria-label')).toBe('Edit stickers'); expect(host.querySelector<HTMLInputElement>('.search')?.value).toBe('sticker');
});

test('Escape keeps editing a prompt, requests close, leaves edit mode, cancels, dismisses, then permits panel close', () => {
  const next = libraryStatus(1), action = vi.fn(async () => true); drawLibrary(next, action); clickText('Edit stickers'); act(() => tile().click()); inputText('textarea', 'dirty');
  expect(action).toHaveBeenCalledExactlyOnceWith({ type: 'removeStickerTag', id: next.state.stickers[0].id }); action.mockClear();
  expect(pressEscape()).toBe(true); expect(host.querySelector('.discard')).not.toBeNull();
  expect(pressEscape()).toBe(true); expect(host.querySelector('.discard')).toBeNull();
  expect(host.querySelector('textarea')?.value).toBe('dirty');
  expect(pressEscape()).toBe(true); clickText('Discard');
  next.stickerSend = { id: next.state.stickers[0].id, nonce: 'finding', name: 'Alex', route: 'picker', animated: true, state: 'finding' }; drawLibrary(next, action);
  expect(pressEscape()).toBe(true); expect(action).not.toHaveBeenCalled(); expect(host.querySelector('.sticker-mode')?.getAttribute('aria-label')).toBe('Edit stickers');
  expect(pressEscape()).toBe(true); expect(action).toHaveBeenCalledExactlyOnceWith({ type: 'cancelSticker' });
  next.stickerSend = { ...next.stickerSend, state: 'failed', sent: 'unknown' }; drawLibrary(next, action);
  expect(pressEscape()).toBe(true); expect(host.querySelector('.sticker-message')).toBeNull(); expect(pressEscape()).toBe(false);
});

test('Done and Back prompt for a filtered dirty editor without changing the search', () => {
  const next = libraryStatus(1), action = vi.fn(async (_action: unknown) => true); drawLibrary(next, action); clickText('Edit stickers'); act(() => tile().click()); inputText('textarea', 'dirty'); inputText('.search', 'no match');
  expect(action).toHaveBeenCalledExactlyOnceWith({ type: 'removeStickerTag', id: next.state.stickers[0].id }); action.mockClear();
  expect(host.querySelector('.sticker-detail')).toBeNull(); clickText('Done');
  expect(host.querySelector('.discard')).not.toBeNull(); expect(host.querySelector<HTMLInputElement>('.search')?.value).toBe('no match');
  clickText('Keep editing'); inputText('.search', ''); expect(host.querySelector('textarea')?.value).toBe('dirty');
  act(() => host.querySelector<HTMLButtonElement>('.back')!.click()); expect(action).not.toHaveBeenCalled();
  clickText('Discard'); expect(action).toHaveBeenCalledExactlyOnceWith({ type: 'panel', panel: null });
});

test('Save closes the editor and Locate and confirmed deletion retain the existing actions', async () => {
  const next = libraryStatus(1), action = vi.fn(async (_action: unknown) => true); drawLibrary(next, action); clickText('Edit stickers'); act(() => tile().click());
  clickText('Locate in WhatsApp'); expect(action).toHaveBeenLastCalledWith({ type: 'locateSticker', id: next.state.stickers[0].id, destinationToken: 'destination-1' });
  inputText('textarea', 'saved terms'); await act(async () => clickText('Save'));
  expect(action).toHaveBeenLastCalledWith({ type: 'sticker', id: next.state.stickers[0].id, searchTerms: 'saved terms' }); expect(host.querySelector('.sticker-detail')).toBeNull();
  act(() => tile().click()); act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Delete sticker"]')!.click()); await act(async () => clickText('Delete'));
  expect(action).toHaveBeenLastCalledWith({ type: 'forgetSticker', id: next.state.stickers[0].id }); expect(host.querySelector('.sticker-detail')).toBeNull();
});

test('direct-send safety notice can be dismissed, links to AI settings, and reappears for a fresh stop', () => {
  const next = libraryStatus(1), action = vi.fn(async (_action: unknown) => true); next.state.global.directStickerDisabledReason = 'send-error'; next.state.global.directStickerDisabledAt = 10;
  drawLibrary(next, action); expect(host.querySelector('.warn')?.textContent).toContain('Direct sending turned off: a direct send failed.');
  act(() => host.querySelector<HTMLAnchorElement>('.warn a')!.click()); expect(action).toHaveBeenLastCalledWith({ type: 'panel', panel: 'settings' });
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss direct-send notice"]')!.click()); expect(host.querySelector('.warn')).toBeNull();
  drawLibrary(next, action); expect(host.querySelector('.warn')).toBeNull();
  next.state.global.directStickerDisabledAt = 11; drawLibrary(next, action); expect(host.querySelector('.warn')).not.toBeNull();
});

test.each(['finding', 'preparing', 'sending'] as const)('tile cancellation is available only before hand-off (%s)', state => {
  const next = libraryStatus(1), action = vi.fn(async () => true); drawLibrary(next, action);
  next.stickerSend = { id: next.state.stickers[0].id, nonce: 'busy', name: 'Alex', route: 'maker', animated: false, state }; drawLibrary(next, action);
  const cancel = host.querySelector<HTMLButtonElement>('.cancel-send');
  expect(Boolean(cancel)).toBe(state !== 'sending');
  if (cancel) { act(() => cancel.click()); expect(action).toHaveBeenCalledExactlyOnceWith({ type: 'cancelSticker' }); }
});

test('a broken image retries in normal mode and remains editable and forgettable in edit mode', () => {
  const next = libraryStatus(1); drawLibrary(next);
  act(() => host.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(tile().getAttribute('aria-label')).toBe('Image unavailable. Retry');
  clickText('Edit stickers'); act(() => tile().click());
  expect(host.querySelector('textarea')?.value).toBe('sticker 0');
  expect([...host.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Delete sticker')).toBe(true);
});

test('a filtered dirty prompt defers a send message and renders only one detail without an arrow target', () => {
  const next = libraryStatus(2); drawLibrary(next); clickText('Edit stickers'); act(() => tile().click());
  inputText('textarea', 'dirty'); inputText('.search', 'sticker 1');
  next.stickerSend = { id: next.state.stickers[1].id, nonce: 'failure', name: 'Alex', route: 'direct', animated: false, state: 'failed', sent: 'unknown' }; drawLibrary(next);
  clickText('Done');
  expect(host.querySelectorAll('.sticker-detail')).toHaveLength(1);
  expect(host.querySelector('.sticker-detail')?.hasAttribute('data-detached')).toBe(true);
  expect(host.querySelector('.discard')).not.toBeNull();
});

test('missing-image Retry remains usable without a chat because it only reloads the local image', () => {
  const next = libraryStatus(1); next.chat.canSendSticker = false; delete next.chat.destinationToken;
  const action = vi.fn(async () => true); drawLibrary(next, action);
  const image = host.querySelector('img')!; act(() => image.dispatchEvent(new Event('error')));
  expect(tile().hasAttribute('aria-disabled')).toBe(false);
  act(() => tile().click()); expect(host.querySelector('img')).not.toBe(image); expect(action).not.toHaveBeenCalled();
});

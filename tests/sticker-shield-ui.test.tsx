// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { initialState, type Status, type StickerShield } from '../src/shared/model';
import { useShield } from '../src/ui/shield';
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
  next.state.stickers = [{ id, image: 'data:image/webp;base64,AAAA', searchTerms: 'draft test', firstSeen: 1, lastSeen: 1 }];
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
  next.state.stickers = [{ id, image: 'data:image/webp;base64,AAAA', searchTerms: 'draft test', firstSeen: 1, lastSeen: 1 }];
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
  expect(host.querySelector('.hint')?.textContent).toContain(message);
  expect(host.querySelector('[aria-live]')?.textContent).toBe(message);
  act(() => vi.advanceTimersByTime(2000));
  expect(host.querySelector('.hint')?.textContent).toContain(message);
  filter('');
  expect(host.querySelector('.sticker-message .msg p')?.textContent).toBe(message);
  expect(host.querySelector('.sticker-message .msg button')).toBeNull();
  expect(host.querySelector('.hint')?.textContent).not.toContain(message);
  filter('no matching sticker');
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => window.dispatchEvent(escape));
  expect(escape.defaultPrevented).toBe(true);
  expect(host.querySelector('.hint')?.textContent).not.toContain(message);
  expect(host.querySelector('[aria-live]')?.textContent).toBe('');
  expect(action).not.toHaveBeenCalled();
});

test.each(['unknown', 'confirmed', undefined] as const)('editor-unavailable does not imply nothing was sent when outcome is %s', sent => {
  const next = status(null), action = vi.fn(async () => true), id = 'a'.repeat(64);
  next.state.stickers = [{ id, image: 'data:image/webp;base64,AAAA', searchTerms: 'editor test', firstSeen: 1, lastSeen: 1 }];
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
  next.state.stickers = [{ id, image: 'data:image/webp;base64,AAAA', searchTerms: 'animated', firstSeen: 1, lastSeen: 1 }];
  const draw = () => act(() => root.render(<Stickers status={next} act={action}/>));
  // JSDOM cannot create trusted native events. Invoke the actual React handler
  // with the trust flag for the authorized half, and DOM click for rejection.
  const trustedClick = async (button: HTMLButtonElement) => {
    const key = Object.keys(button).find(key => key.startsWith('__reactProps$'))!;
    const handler = (button as unknown as Record<string, { onClick: (event: { nativeEvent: { isTrusted: boolean } }) => void }>)[key].onClick;
    await act(async () => handler({ nativeEvent: { isTrusted: true } }));
  };
  draw();
  await trustedClick(host.querySelector<HTMLButtonElement>('.send')!);
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

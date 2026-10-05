// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { initialState, type Status } from '../src/shared/model';
import { Stickers } from '../src/ui/stickers';
import { stickerURL } from '../src/shared/sticker-url';

vi.mock('../src/shared/sticker-url', () => ({ stickerURL: vi.fn((id: string) => `companion-sticker://${id}`) }));
let host: HTMLDivElement, root: Root, status: Status;
const action = vi.fn(async () => true);
const observers: { targets: Element[]; callback: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
const rect = (top: number, height: number, width = 316) => ({ top, bottom: top + height, left: 0, right: width, width, height, x: 0, y: top, toJSON() {} });
const draw = () => act(() => root.render(<Stickers status={status} act={action}/>));
const cards = () => [...host.querySelectorAll<HTMLElement>('[data-sticker]')];
const tile = (index: number) => host.querySelector<HTMLButtonElement>(`[data-sticker="${status.state.stickers[index].id}"] .sticker-art`)!;
const click = (label: string) => act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label || button.getAttribute('aria-label') === label)!.click());
const fill = (selector: string, text: string) => act(() => {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const scroll = (top: number) => act(() => { host.scrollTop = top; host.dispatchEvent(new Event('scroll')); });
const key = (button: HTMLElement, key: string, shiftKey = false) => act(() => {
  button.focus(); button.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('getComputedStyle', () => ({ gridTemplateColumns: '100px 100px 100px' }));
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', class {
    targets: Element[] = []; disconnect = vi.fn();
    constructor(public callback: () => void) { observers.push(this); }
    observe(target: Element) { this.targets.push(target); }
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('sticker-grid')) return rect(100 - host.scrollTop, 18000);
    if (this.classList.contains('sticker-head')) return rect(0, 100);
    if (this.classList.contains('sticker-detail')) return rect(0, 320);
    if (this.classList.contains('sticker-select-bar')) return rect(350, 50);
    return rect(0, 400);
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(316);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div'); host.className = 'panel'; document.body.append(host);
  host.scrollTo = vi.fn(options => { host.scrollTop = (options as ScrollToOptions).top ?? host.scrollTop; });
  root = createRoot(host);
  status = { sequence: 1, runtimePaused: false, state: initialState(), chat: { chatId: null, name: '', kind: 'direct', ready: false, canSendSticker: false }, keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true, message: '', pending: null };
  status.state.stickers = Array.from({ length: 494 }, (_, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), kind: 'animated', size: 12, searchTerms: `sticker ${i} buenos días`, firstSeen: 1, lastSeen: 494 - i, groups: i % 2 ? ['group'] : [] }));
  action.mockClear(); vi.mocked(stickerURL).mockClear(); draw();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('494 animated stickers mount only viewport rows and overscan, releasing offscreen images and all images on close', () => {
  expect(cards()).toHaveLength(12);
  expect(host.querySelectorAll('img[decoding="async"]')).toHaveLength(12);
  const oldImage = tile(0).querySelector('img')!;
  scroll(1080);
  expect(cards()).toHaveLength(15);
  expect(oldImage.isConnected).toBe(false);
  expect(tile(0)).toBeNull(); expect(tile(30)).not.toBeNull();
  expect(host.querySelectorAll('.sticker-spacer')).toHaveLength(2);
  const count = host.querySelectorAll('*').length;
  act(() => root.render(null)); expect(host.querySelectorAll('img')).toHaveLength(0);
  host.scrollTop = 0; draw(); scroll(1080);
  expect(host.querySelectorAll('*')).toHaveLength(count);
  expect(host.querySelectorAll('.sticker-grid')).toHaveLength(1);
  expect(host.querySelectorAll('img')).toHaveLength(15);
});

test('arrow navigation and Tab bridge virtual windows, including backward edit-mode tab order', () => {
  key(tile(11), 'ArrowDown');
  expect(document.activeElement).toBe(tile(14)); expect(tile(14)).not.toBeNull();
  scroll(0);
  key(tile(11), 'Tab'); expect(document.activeElement).toBe(tile(12));
  click('Edit stickers'); scroll(1080);
  const first = cards()[0], index = status.state.stickers.findIndex(sticker => sticker.id === first.dataset.sticker);
  key(first.querySelector('.sticker-art')!, 'Tab', true);
  expect(document.activeElement).toBe(tile(index - 1).parentElement!.querySelector('.sticker-pick'));
});

test('inline editor stays mounted with its draft and correct arrow while offscreen tiles unmount; closing restores its tile focus', () => {
  click('Edit stickers'); act(() => tile(1).click()); fill('textarea', 'unsaved terms');
  const editor = host.querySelector('.sticker-detail')!, textarea = host.querySelector('textarea')!;
  expect((editor as HTMLElement).style.getPropertyValue('--col')).toBe('2');
  expect(editor.previousElementSibling?.getAttribute('data-sticker')).toBe(status.state.stickers[2].id);
  scroll(2400); expect(tile(1)).toBeNull(); expect(textarea.isConnected).toBe(true); expect(textarea.value).toBe('unsaved terms');
  expect(host.querySelectorAll('img').length).toBeLessThan(20);
  click('Close'); expect(host.querySelector('.discard')).not.toBeNull(); click('Discard');
  expect(document.activeElement).toBe(tile(1)); expect(host.querySelector('.sticker-detail')).toBeNull();
});

test('filtering keeps hidden drafts, resets scrolling and Select all selects the entire filtered library', () => {
  click('Edit stickers'); act(() => tile(0).click()); fill('textarea', 'hidden draft');
  scroll(2000); fill('.search', '"buenos dias" sticker');
  expect(host.scrollTop).toBe(0); expect(host.querySelector('.count')?.textContent).toBe('494');
  fill('.search', 'sticker 10'); expect(host.querySelector('textarea')).toBeNull();
  click('Select all'); expect(host.querySelector('.sticker-select-bar')?.textContent).toContain('15 selected');
  click('Clear'); fill('.search', ''); expect(host.querySelector('textarea')?.value).toBe('hidden draft');
});

test('editor typing and unrelated statuses do not rerender tiles, normalize library text, or measure unchanged layout', () => {
  const normalize = vi.spyOn(String.prototype, 'normalize');
  click('Edit stickers'); act(() => tile(0).click());
  vi.mocked(stickerURL).mockClear(); normalize.mockClear();
  const geometry = vi.mocked(HTMLElement.prototype.getBoundingClientRect); geometry.mockClear();
  fill('textarea', 'a'); fill('textarea', 'ab'); fill('textarea', 'abc');
  status = { ...status, message: 'Unrelated update' }; draw();
  expect(stickerURL).not.toHaveBeenCalled(); expect(normalize).not.toHaveBeenCalled(); expect(geometry).not.toHaveBeenCalled();
  fill('.search', '"buenos días"');
  expect(normalize).toHaveBeenCalledTimes(1);
  const changed = { ...status.state.stickers[1], searchTerms: 'changed día' };
  status = { ...status, state: { ...status.state, stickers: status.state.stickers.map(sticker => sticker.id === changed.id ? changed : sticker) } }; draw();
  expect(normalize).toHaveBeenCalledTimes(3); // changed text + the current query
});

test('status updates preserve established order; a new query refreshes lastSeen order and appends newcomers once', () => {
  const changed = { ...status.state.stickers[20], lastSeen: 999 };
  status = { ...status, state: { ...status.state, stickers: status.state.stickers.map(sticker => sticker.id === changed.id ? changed : sticker) } }; draw();
  expect(cards()[0].dataset.sticker).toBe(status.state.stickers[0].id);
  fill('.search', 'sticker'); expect(cards()[0].dataset.sticker).toBe(changed.id);
  expect(new Set(cards().map(card => card.dataset.sticker)).size).toBe(cards().length);
});

test('selection cleanup and group membership operate on the full selected set across virtual windows', () => {
  status = { ...status, state: { ...status.state, stickerGroups: [{ id: 'group', name: 'Odd' }] } }; draw();
  click('Edit stickers'); click('Select all'); click('Groups ▾');
  expect(host.querySelector('.pop-row')?.getAttribute('aria-checked')).toBe('mixed');
  const retained = status.state.stickers.filter(sticker => sticker.groups.includes('group'));
  const linearLookup = vi.spyOn(retained, 'some');
  status = { ...status, state: { ...status.state, stickers: retained } }; draw();
  expect(linearLookup).not.toHaveBeenCalled();
  expect(host.querySelector('.sticker-select-bar')?.textContent).toContain('247 selected');
  expect(host.querySelector('.pop-row')?.getAttribute('aria-checked')).toBe('true');
  const geometry = vi.mocked(HTMLElement.prototype.getBoundingClientRect); geometry.mockClear(); scroll(1000);
  expect(geometry).not.toHaveBeenCalled();
});

test('unmount disconnects every viewport/column/group observer', () => {
  status = { ...status, state: { ...status.state, stickerGroups: [{ id: 'group', name: 'Odd' }] } }; draw();
  act(() => root.render(null));
  expect(observers.length).toBeGreaterThan(2);
  for (const observer of observers) expect(observer.disconnect).toHaveBeenCalledOnce();
});

test('memoized tile actions use the latest destination token and still require trusted activation', async () => {
  status = { ...status, chat: { ...status.chat, canSendSticker: true, destinationToken: 'first-token' } }; draw();
  vi.mocked(stickerURL).mockClear();
  status = { ...status, chat: { ...status.chat, destinationToken: 'latest-token' } }; draw();
  expect(stickerURL).not.toHaveBeenCalled();
  act(() => tile(0).click()); expect(action).not.toHaveBeenCalled();
  const button = tile(0), propsKey = Object.keys(button).find(key => key.startsWith('__reactProps$'))!;
  const props = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[propsKey];
  await act(async () => props.onClick({ nativeEvent: { isTrusted: true } }));
  expect(action).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'sendSticker', id: status.state.stickers[0].id, destinationToken: 'latest-token' }));
});

test('Tab from an offscreen inline detail bridges to adjacent tiles without skipping rows', () => {
  click('Edit stickers'); act(() => tile(1).click());
  scroll(3000);
  const last = [...host.querySelectorAll<HTMLButtonElement>('.sticker-detail button')].at(-1)!;
  key(last, 'Tab'); expect(document.activeElement).toBe(tile(3));
  scroll(3000);
  const first = host.querySelector<HTMLButtonElement>('.sticker-detail button')!;
  key(first, 'Tab', true);
  expect(document.activeElement).toBe(tile(2).parentElement!.querySelector('.sticker-pick'));
});


test('group membership counts and chip fades stay memoized during unrelated renders and editor typing', () => {
  status = { ...status, state: { ...status.state, stickerGroups: [{ id: 'group', name: 'Odd' }] } }; draw();
  click('Edit stickers'); click('Select all');
  const memberships = status.state.stickers.map(sticker => vi.spyOn(sticker.groups, Symbol.iterator));
  const widths = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get'); widths.mockClear();
  click('Groups ▾');
  status = { ...status, message: 'Unrelated update' }; draw();
  expect(memberships.every(iterator => iterator.mock.calls.length === 0)).toBe(true);
  expect(widths).not.toHaveBeenCalled();
});

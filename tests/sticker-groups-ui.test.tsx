// @vitest-environment jsdom
import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { initialState, type Action, type Status } from '../src/shared/model';
import { applyStickerGroupAction, type StickerGroupAction } from '../src/core/sticker-groups';
import { Stickers } from '../src/ui/stickers';
const group = '550e8400-e29b-41d4-a716-446655440000', second = '550e8400-e29b-41d4-a716-446655440001', third = '550e8400-e29b-41d4-a716-446655440002';
let host: HTMLDivElement, root: Root, status: Status;
const actions = vi.fn(async (action: Action) => {
  if (action.type.includes('StickerGroup') || action.type === 'stickerGroupMembership') {
    const next = structuredClone(status.state);
    try { applyStickerGroupAction(next, action as StickerGroupAction, () => third); }
    catch { return false; }
    status = { ...status, state: next }; draw();
  }
  return true;
});
const draw = () => root.render(<Stickers status={status} act={actions}/>);
const button = (text: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text || b.getAttribute('aria-label') === text)!;
const click = (text: string, scope: ParentNode = host) => act(() => button(text, scope).click());
const field = (name: string) => host.querySelector<HTMLInputElement>(name === 'Search terms' ? 'textarea' : `input[aria-label="${name}"]`)!;
const fill = (name: string, text: string) => act(() => {
  const input = field(name); Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const escape = () => { const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); act(() => window.dispatchEvent(event)); return event.defaultPrevented; };
const enter = async () => act(async () => { field('New group name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
const tiles = () => host.querySelectorAll<HTMLButtonElement>('.sticker-art');
const picks = () => host.querySelectorAll<HTMLButtonElement>('.sticker-pick');
const header = () => host.querySelector('.sticker-group-chips')!;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); actions.mockClear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  host.className = 'panel';
  host.scrollTo = vi.fn(options => { host.scrollTop = (options as ScrollToOptions).top ?? host.scrollTop; });
  status = { sequence: 1, runtimePaused: false, state: initialState(), chat: { chatId: null, name: '', kind: 'direct', ready: false, canSendSticker: false }, keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true, message: '', pending: null };
  status.state.stickerGroups = [{ id: group, name: 'Animals' }, { id: second, name: 'Favorites' }];
  status.state.stickers = Array.from({ length: 3 }, (_, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), kind: 'static', size: 12, searchTerms: ['dog, perro', 'cat, gato', 'dog, puppy'][i], firstSeen: 1, lastSeen: 3 - i, groups: i < 2 ? [group] : [] }));
  act(draw);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

test('chip filtering intersects search, counts narrow results, and Search all groups keeps the query', () => {
  click('Animals', header()); expect(tiles()).toHaveLength(2); expect(host.querySelector('.count')?.textContent).toBe('2 of 3');
  fill('Search stickers', 'dog'); expect(tiles()).toHaveLength(1); expect(host.querySelector('.count')?.textContent).toBe('1 of 3');
  fill('Search stickers', 'puppy'); expect(tiles()).toHaveLength(0);
  expect(host.querySelector('.empty p')?.textContent).toBe('No matches in Animals');
  click('Search all groups'); expect(field('Search stickers').value).toBe('puppy'); expect(tiles()).toHaveLength(1);
  click('Edit stickers'); click('Done'); expect(field('Search stickers').value).toBe('puppy');
});

test('groups row is hidden only in normal mode with no groups; group filter survives Done', () => {
  click('Animals', header()); click('Edit stickers'); click('Done'); expect(tiles()).toHaveLength(2);
  status = { ...status, state: { ...status.state, stickerGroups: [], stickers: status.state.stickers.map(s => ({ ...s, groups: [] })) } }; act(draw);
  expect(host.querySelector('.sticker-group-chips')).toBeNull(); click('Edit stickers'); expect(header()).not.toBeNull();
});

test('selection circles are focusable sibling checkbox buttons; modifier-click selects without opening editor', () => {
  click('Edit stickers'); const pick = picks()[0];
  expect(pick.tagName).toBe('BUTTON'); expect(pick.getAttribute('role')).toBe('checkbox'); expect(pick.parentElement).toBe(tiles()[0].parentElement); expect(pick.closest('.sticker-art')).toBeNull();
  act(() => pick.focus()); expect(document.activeElement).toBe(pick); expect(pick.tabIndex).toBe(0);
  // Native Space activation is exercised in the desktop suite; JSDOM has no default button activation.
  act(() => pick.click()); expect(pick.getAttribute('aria-checked')).toBe('true');
  act(() => tiles()[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
  act(() => tiles()[2].dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })));
  expect(host.querySelector('.sticker-detail')).toBeNull(); expect(host.querySelector('.sticker-select-bar span')?.textContent).toBe('3 selected');
  click('Clear'); expect(picks()[0].getAttribute('aria-checked')).toBe('false');
});

test('Select all selects only current search and group; popover tri-state adds/removes the whole selection', async () => {
  click('Edit stickers'); fill('Search stickers', 'dog'); click('Select all'); click('Groups ▾');
  let animal = host.querySelector<HTMLButtonElement>('.pop-row[role=checkbox]')!;
  expect(animal.getAttribute('aria-checked')).toBe('mixed');
  await act(async () => animal.click()); animal = host.querySelector<HTMLButtonElement>('.pop-row[role=checkbox]')!;
  expect(animal.getAttribute('aria-checked')).toBe('true'); expect(status.state.stickers[2].groups).toEqual([group]);
  await act(async () => animal.click()); expect(host.querySelector('.pop-row[role=checkbox]')?.getAttribute('aria-checked')).toBe('false');
  expect(status.state.stickers[1].groups).toEqual([group]);
  expect(escape()).toBe(true); click('Clear'); click('Animals', header()); fill('Search stickers', 'cat'); click('Select all'); expect(host.querySelector('.sticker-select-bar span')?.textContent).toBe('1 selected');
});

test('per-sticker membership saves immediately and leaves unsaved search terms intact', async () => {
  click('Edit stickers'); act(() => tiles()[0].click()); fill('Search terms', 'unsaved dog');
  const toggles = host.querySelector('.sticker-detail-groups')!;
  expect(button('Animals', toggles).getAttribute('aria-pressed')).toBe('true');
  await act(async () => button('Favorites', toggles).click());
  expect(status.state.stickers[0].groups).toEqual([group, second]); expect(field('Search terms').value).toBe('unsaved dog');
  expect(actions).toHaveBeenLastCalledWith({ type: 'stickerGroupMembership', id: status.state.stickers[0].id, groupId: second, member: true });
  click('Done'); expect(host.querySelector('.discard')).not.toBeNull(); click('Keep editing'); expect(button('Done')).toBeDefined();
});

test('inline create rejects blank/duplicate names, Enter creates/filter selects, rename and confirmed delete retain stickers', async () => {
  click('Edit stickers'); click('+ New group'); expect(document.activeElement).toBe(field('New group name'));
  expect(field('New group name').placeholder).toBe('Group name');
  await enter(); expect(field('New group name')).not.toBeNull();
  fill('New group name', ' animals '); await enter(); expect(actions).not.toHaveBeenCalled();
  fill('New group name', ' New '); await enter(); expect(status.state.stickerGroups.at(-1)).toEqual({ id: third, name: 'New' });
  expect(tiles()).toHaveLength(0); expect(button('New', header()).getAttribute('aria-pressed')).toBe('true');
  click('New', header()); fill('Group name', 'Renamed'); await act(async () => button('Save', host.querySelector('.sticker-group-edit')!).click());
  expect(status.state.stickerGroups.at(-1)?.name).toBe('Renamed');
  click('Renamed', header()); click('Delete', host.querySelector('.sticker-group-edit')!); expect(host.querySelector('[aria-label="Delete group?"]')).not.toBeNull();
  expect(status.state.stickerGroups).toHaveLength(3); click('Keep'); expect(status.state.stickerGroups).toHaveLength(3);
  click('Renamed', header()); click('Delete', host.querySelector('.sticker-group-edit')!); await act(async () => button('Delete', host.querySelector('.sticker-group-edit')!).click());
  expect(status.state.stickerGroups).toHaveLength(2); expect(status.state.stickers).toHaveLength(3); expect(tiles()).toHaveLength(3);
});

test('popover New group assigns the selection and Done resets all transient edit state', async () => {
  click('Edit stickers'); act(() => picks()[0].click()); click('Groups ▾'); click('New group…'); fill('New group name', 'Chosen'); await enter();
  expect(status.state.stickers[0].groups).toEqual([group, third]); expect(tiles()).toHaveLength(1);
  click('Groups ▾'); click('Done'); expect(host.querySelector('.sticker-select-bar')).toBeNull(); expect(host.querySelector('.sticker-groups-popover')).toBeNull();
  expect(tiles()).toHaveLength(1); click('Edit stickers'); expect(picks()[0].getAttribute('aria-checked')).toBe('false'); expect(button('Select all')).toBeDefined();
});

test('Escape closes popover, keeps dirty prompt, closes editor, cancels group row, clears selection, leaves edit mode, permits panel close', () => {
  click('Edit stickers'); act(() => picks()[0].click()); act(() => tiles()[0].click()); fill('Search terms', 'dirty');
  click('Animals', header()); click('Animals', header()); expect(field('Group name')).not.toBeNull();
  click('Done'); expect(host.querySelector('.discard')).not.toBeNull(); click('Groups ▾');
  expect(escape()).toBe(true); expect(host.querySelector('.sticker-groups-popover')).toBeNull(); expect(host.querySelector('.discard')).not.toBeNull();
  expect(escape()).toBe(true); expect(host.querySelector('.discard')).toBeNull(); expect(field('Search terms').value).toBe('dirty');
  expect(escape()).toBe(true); expect(host.querySelector('.discard')).not.toBeNull(); click('Discard'); expect(host.querySelector('.sticker-detail')).toBeNull();
  expect(escape()).toBe(true); expect(host.querySelector('.sticker-group-edit')).toBeNull(); expect(host.querySelector('.sticker-select-bar span')?.textContent).toBe('1 selected');
  expect(escape()).toBe(true); expect(button('Select all')).toBeDefined(); expect(escape()).toBe(true); expect(button('Edit stickers')).toBeDefined(); expect(escape()).toBe(false);
});

test('Escape cancels a new field and outside click dismisses the groups popover', () => {
  click('Edit stickers'); click('+ New group'); fill('New group name', 'Cancelled'); expect(escape()).toBe(true); expect(host.querySelector('.chip-input')).toBeNull();
  act(() => picks()[0].click()); click('Groups ▾');
  act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))); expect(host.querySelector('.sticker-groups-popover')).toBeNull();
});

test('removing the last selected sticker closes the popover without reopening it on a later selection', () => {
  click('Edit stickers'); act(() => picks()[0].click()); click('Groups ▾');
  act(() => picks()[0].click()); expect(host.querySelector('.sticker-groups-popover')).toBeNull();
  act(() => picks()[1].click()); expect(host.querySelector('.sticker-groups-popover')).toBeNull();
});

test('Delete confirmation uses the saved group name when a rename draft is unsaved', () => {
  click('Edit stickers'); click('Animals', header()); click('Animals', header()); fill('Group name', 'Proposed rename');
  click('Delete', host.querySelector('.sticker-group-edit')!);
  expect(host.querySelector('.sticker-group-edit')?.textContent).toContain('Delete “Animals”?');
});

const dimensions = (row: Element, width = 300, content = 900) => {
  Object.defineProperties(row, { clientWidth: { configurable: true, value: width }, scrollWidth: { configurable: true, value: content } });
};
const wheel = (row: Element, deltaY: number, options: WheelEventInit = {}) => {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...options });
  act(() => row.dispatchEvent(event)); return event.defaultPrevented;
};

test('vertical wheel scrolls chips, clamps to ends, and passes through at ends, on Ctrl or horizontal gestures', () => {
  const row = header() as HTMLDivElement; dimensions(row);
  expect(wheel(row, 120)).toBe(true); expect(row.scrollLeft).toBe(120);
  expect(row.hasAttribute('data-fade-start')).toBe(true); expect(row.hasAttribute('data-fade-end')).toBe(true);
  expect(wheel(row, 1000)).toBe(true); expect(row.scrollLeft).toBe(600);
  expect(row.hasAttribute('data-fade-end')).toBe(false);
  expect(wheel(row, 100)).toBe(false); expect(row.scrollLeft).toBe(600);
  expect(wheel(row, -1000)).toBe(true); expect(row.scrollLeft).toBe(0);
  expect(wheel(row, -100)).toBe(false);
  expect(wheel(row, 100, { ctrlKey: true })).toBe(false);
  expect(wheel(row, 100, { deltaX: 100 })).toBe(false);
  expect(wheel(row, 100, { deltaX: -200 })).toBe(false); expect(row.scrollLeft).toBe(0);
  dimensions(row, 300, 300); expect(wheel(row, 100)).toBe(false);
});

test('wheel listeners stay attached in edit mode and detach when the conditional chip row unmounts', () => {
  const row = header() as HTMLDivElement; dimensions(row);
  click('Edit stickers'); expect(header()).toBe(row); expect(wheel(row, 100)).toBe(true);
  click('Done'); expect(wheel(row, 100)).toBe(true); expect(row.scrollLeft).toBe(200);
  status = { ...status, state: { ...status.state, stickerGroups: [] } }; act(draw);
  expect(host.querySelector('.sticker-group-chips')).toBeNull();
  expect(wheel(row, 100)).toBe(false); expect(row.scrollLeft).toBe(200);
  click('Edit stickers'); const newRow = header() as HTMLDivElement; dimensions(newRow);
  expect(newRow).not.toBe(row); expect(wheel(newRow, 100)).toBe(true); expect(newRow.scrollLeft).toBe(100);
});

test('chip fades track scroll and window resize with a one-pixel tolerance', () => {
  const row = header() as HTMLDivElement; dimensions(row);
  act(() => window.dispatchEvent(new Event('resize')));
  expect(row.hasAttribute('data-fade-start')).toBe(false); expect(row.hasAttribute('data-fade-end')).toBe(true);
  row.scrollLeft = 1; act(() => row.dispatchEvent(new Event('scroll')));
  expect(row.hasAttribute('data-fade-start')).toBe(false);
  row.scrollLeft = 599; act(() => row.dispatchEvent(new Event('scroll')));
  expect(row.hasAttribute('data-fade-start')).toBe(true); expect(row.hasAttribute('data-fade-end')).toBe(false);
  row.scrollLeft = 598; act(() => row.dispatchEvent(new Event('scroll')));
  expect(row.hasAttribute('data-fade-end')).toBe(true);
  row.scrollLeft = 0; dimensions(row, 900, 900); act(() => window.dispatchEvent(new Event('resize')));
  expect(row.hasAttribute('data-fade-start')).toBe(false); expect(row.hasAttribute('data-fade-end')).toBe(false);
});

test('chip fades remeasure changed chip contents, edit-mode chips, and observed resizes, and clean up observers', async () => {
  const observers: { callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); disconnect = vi.fn();
    constructor(public callback: () => void) { observers.push(this); }
  });
  status = { ...status, state: { ...status.state, stickerGroups: [] } }; act(draw);
  click('Edit stickers'); const row = header() as HTMLDivElement, observer = observers.find(observer => observer.observe.mock.calls.some(([element]) => element === row))!;
  expect(observer.observe).toHaveBeenCalledWith(row);
  dimensions(row); act(() => observer.callback()); expect(row.hasAttribute('data-fade-end')).toBe(true);
  dimensions(row, 900, 900); click('+ New group'); expect(row.hasAttribute('data-fade-end')).toBe(false);
  dimensions(row); fill('New group name', 'Created'); await enter(); expect(row.hasAttribute('data-fade-end')).toBe(true);
  click('Created', header()); dimensions(row, 900, 900); fill('Group name', 'Short');
  await act(async () => button('Save', host.querySelector('.sticker-group-edit')!).click());
  expect(row.hasAttribute('data-fade-end')).toBe(false);
  dimensions(row); click('Done'); expect(row.hasAttribute('data-fade-end')).toBe(true);
  click('Edit stickers'); click('Short', header()); click('Delete', host.querySelector('.sticker-group-edit')!);
  dimensions(row, 900, 900); await act(async () => button('Delete', host.querySelector('.sticker-group-edit')!).click());
  expect(row.hasAttribute('data-fade-end')).toBe(false);
  click('Done'); expect(host.querySelector('.sticker-group-chips')).toBeNull();
  expect(observer.disconnect).toHaveBeenCalledOnce();
  row.scrollLeft = 20; act(() => row.dispatchEvent(new Event('scroll')));
  expect(row.hasAttribute('data-fade-start')).toBe(false);
});

const deepScroll = () => { host.scrollTop = 1200; vi.mocked(host.scrollTo).mockClear(); };
const expectReset = () => { expect(host.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0 }); expect(host.scrollTop).toBe(0); };
test('search, chips, both all-groups buttons, creation and deletion reset the panel scroll to the first result', async () => {
  deepScroll(); click('Animals', header()); expectReset();
  deepScroll(); fill('Search stickers', 'puppy'); expectReset();
  deepScroll(); click('Search all groups'); expectReset(); expect(field('Search stickers').value).toBe('puppy');
  fill('Search stickers', ''); click('Edit stickers'); click('+ New group'); fill('New group name', 'Empty');
  deepScroll(); await enter(); expectReset();
  expect(host.querySelector('.empty p')?.textContent).toBe('No stickers in Empty');
  deepScroll(); click('Show all groups'); expectReset();
  click('Empty', header()); click('Empty', header()); click('Delete', host.querySelector('.sticker-group-edit')!);
  deepScroll(); await act(async () => button('Delete', host.querySelector('.sticker-group-edit')!).click()); expectReset();
  click('Animals', header()); deepScroll();
  status = { ...status, state: { ...status.state, stickerGroups: status.state.stickerGroups.filter(g => g.id !== group) } }; act(draw);
  expectReset(); expect(tiles()).toHaveLength(3);
});

test('sends, editing, selection, renames and membership changes keep the panel scroll in place', async () => {
  click('Animals', header()); deepScroll();
  status = { ...status, stickerSend: { id: status.state.stickers[0].id, nonce: 'test', name: 'Alex', route: 'maker', animated: false, state: 'finding' } }; act(draw);
  click('Edit stickers'); act(() => tiles()[0].click()); fill('Search terms', 'dog edited');
  act(() => picks()[0].click());
  await act(async () => button('Animals', host.querySelector('.sticker-detail-groups')!).click());
  expect(tiles()).toHaveLength(1);
  status = { ...status, state: { ...status.state, stickers: status.state.stickers.map(s => ({ ...s, searchTerms: `${s.searchTerms}, updated` })) } }; act(draw);
  click('Animals', header()); fill('Group name', 'Pets');
  await act(async () => button('Save', host.querySelector('.sticker-group-edit')!).click());
  expect(host.scrollTo).not.toHaveBeenCalled(); expect(host.scrollTop).toBe(1200);
});

test('empty states name the current group and distinguish an empty group, a failed group search, and the whole library', () => {
  click('Favorites', header()); expect(host.querySelector('.empty p')?.textContent).toBe('No stickers in Favorites'); expect(button('Show all groups')).toBeDefined();
  fill('Search stickers', 'missing'); expect(host.querySelector('.empty p')?.textContent).toBe('No matches in Favorites'); expect(button('Search all groups')).toBeDefined();
  click('Search all groups'); expect(host.querySelector('.empty p')?.textContent).toBe('No matching stickers');
  expect(host.querySelector('.empty small')?.textContent).toBe('Try another word or phrase.');
  fill('Search stickers', ''); status = { ...status, state: { ...status.state, stickers: [] } }; act(draw);
  expect(host.querySelector('.empty p')?.textContent).toBe('Your stickers will appear here');
});

test('Escape closes a popover before clearing focused search, then keeps a dirty prompt before other edit state', () => {
  click('Edit stickers'); act(() => picks()[0].click()); act(() => tiles()[0].click()); fill('Search terms', 'dirty');
  click('Animals', header()); click('Animals', header()); click('Done');
  fill('Search stickers', 'dog'); click('Groups ▾'); act(() => field('Search stickers').focus());
  expect(escape()).toBe(true); expect(host.querySelector('.sticker-groups-popover')).toBeNull(); expect(field('Search stickers').value).toBe('dog');
  act(() => field('Search stickers').focus()); deepScroll();
  expect(escape()).toBe(true); expect(field('Search stickers').value).toBe(''); expectReset();
  expect(host.querySelector('.discard')).not.toBeNull(); expect(host.querySelector('.sticker-group-edit')).not.toBeNull(); expect(picks()[0].getAttribute('aria-checked')).toBe('true');
  expect(escape()).toBe(true); expect(host.querySelector('.discard')).toBeNull(); expect(field('Search terms').value).toBe('dirty');
});

test('Escape clears search only while focused, ahead of inline editing, selection, edit mode and sends', () => {
  click('Edit stickers'); act(() => picks()[0].click()); click('+ New group'); fill('Search stickers', 'dog');
  act(() => field('Search stickers').focus()); expect(escape()).toBe(true);
  expect(host.querySelector('.chip-input')).not.toBeNull(); expect(picks()[0].getAttribute('aria-checked')).toBe('true'); expect(button('Done')).toBeDefined();
  fill('Search stickers', 'dog'); act(() => field('New group name').focus()); expect(escape()).toBe(true);
  expect(host.querySelector('.chip-input')).toBeNull(); expect(field('Search stickers').value).toBe('dog');
  click('Done');
  status = { ...status, stickerSend: { id: status.state.stickers[0].id, nonce: 'test', name: 'Alex', route: 'maker', animated: false, state: 'finding' } }; act(draw);
  act(() => field('Search stickers').focus()); actions.mockClear(); expect(escape()).toBe(true);
  expect(actions).not.toHaveBeenCalled(); expect(field('Search stickers').value).toBe('');
  expect(escape()).toBe(true); expect(actions).toHaveBeenCalledExactlyOnceWith({ type: 'cancelSticker' });
  status = { ...status, stickerSend: undefined }; act(draw); expect(escape()).toBe(false);
});

test.each([0, 1, 2])('Delete confirmation describes %i stickers with the right singular or empty wording', count => {
  status = { ...status, state: { ...status.state, stickers: status.state.stickers.map((s, i) => ({ ...s, groups: i < count ? [group] : [] })) } }; act(draw);
  click('Edit stickers'); click('Animals', header()); click('Animals', header()); click('Delete', host.querySelector('.sticker-group-edit')!);
  expect(host.querySelector('.sticker-group-edit span')?.textContent).toBe('Delete “Animals”?' + (count === 0 ? '' : count === 1 ? ' Its sticker stays in the library.' : ' Its 2 stickers stay in the library.'));
});

test('New group is the first popover row without a divider when the library has no groups', () => {
  const style = document.createElement('style');
  // Apply the actual popover rules to test the first-child override in JSDOM.
  style.textContent = readFileSync('src/ui/style.css', 'utf8').split('\n').filter(line => line.startsWith('.sticker-select-bar .pop-row.new') || line.startsWith('.pop-row.new:first-child')).join('\n');
  document.head.append(style);
  try {
    click('Edit stickers'); act(() => picks()[0].click()); click('Groups ▾');
    expect(getComputedStyle(button('New group…')).marginTop).toBe('4px');
    status = { ...status, state: { ...status.state, stickerGroups: [] } }; act(draw);
    const popover = host.querySelector('.sticker-groups-popover')!;
    expect(popover.childElementCount).toBe(1); expect(popover.firstElementChild).toBe(button('New group…'));
    const computed = getComputedStyle(button('New group…'));
    expect(computed.borderTopWidth).toBe('0px'); expect(computed.marginTop).toBe('0px');
  } finally { style.remove(); }
});

// @vitest-environment jsdom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { initialState, type Action, type Panel, type Status, type StatusUpdate } from '../src/shared/model';
import { applyStickerGroupAction, type StickerGroupAction } from '../src/core/sticker-groups';

const mounted = vi.hoisted(() => ({ root: undefined as Root | undefined }));
vi.mock('react-dom/client', async importOriginal => {
  const actual = await importOriginal<typeof import('react-dom/client')>();
  return { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => (mounted.root = actual.createRoot(...args)) };
});
const animals = '550e8400-e29b-41d4-a716-446655440000';
const birds = '550e8400-e29b-41d4-a716-446655440001';
const created = '550e8400-e29b-41d4-a716-446655440002';
let status: Status, receive: (update: StatusUpdate) => void, navigate: (panel: Panel) => void;
let appEscape: (event: KeyboardEvent) => void;
const unsubscribe = vi.fn(), stopNavigation = vi.fn();
const publish = () => receive({ ...status, sequence: ++status.sequence });
const actions = vi.fn(async (action: Action) => {
  if (action.type === 'panel') status = { ...status, panel: action.panel };
  if (action.type === 'sticker') status = { ...status, state: { ...status.state, stickers: status.state.stickers.map(sticker => sticker.id === action.id ? { ...sticker, searchTerms: action.searchTerms } : sticker) } };
  if (action.type === 'forgetSticker' || action.type === 'forgetStickers') {
    const ids = action.type === 'forgetSticker' ? [action.id] : action.ids;
    status = { ...status, state: { ...status.state, stickers: status.state.stickers.filter(sticker => !ids.includes(sticker.id)) } };
  }
  if (action.type.includes('StickerGroup') || action.type === 'stickerGroupMembership') {
    const state = structuredClone(status.state); applyStickerGroupAction(state, action as StickerGroupAction, () => created); status = { ...status, state };
  }
  publish(); return { ok: true };
});
const button = (name: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name || button.getAttribute('aria-label') === name)!;
const click = async (name: string, scope: ParentNode = document) => act(async () => { const target = button(name, scope); expect(target, name).toBeDefined(); target.focus(); target.click(); });
const fill = (selector: string, value: string) => act(() => {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const escape = () => act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
const textarea = () => document.querySelector<HTMLTextAreaElement>('textarea')!;
const prompt = () => document.querySelector('.discard');
const panelActions = () => actions.mock.calls.filter(([action]) => action.type === 'panel');
type Visibility = 'visible' | 'search-hidden' | 'group-hidden';
const visibility: Visibility[] = ['visible', 'search-hidden', 'group-hidden'];
const hide = async (view: Visibility) => {
  if (view === 'search-hidden') fill('.search', 'cat');
  if (view === 'group-hidden') await click('Birds');
  if (view !== 'visible') expect(textarea()).toBeNull();
};
const prepare = async (view: Visibility) => {
  await click('Edit stickers'); await click('dog'); fill('textarea', 'unsaved dog'); await hide(view);
};
const paths = ['Escape', 'Done', 'Close panel', 'Close editor', 'switch editor', 'rail close', 'rail settings', 'rail chat', 'App close', 'Settings'] as const;
type Path = typeof paths[number];
const exit = async (path: Path, view: Visibility) => {
  if (path === 'Escape') { act(() => button('cat').focus()); escape(); }
  else if (path === 'Close editor') {
    if (view !== 'visible') await click('Done'); // The hidden row becomes available with its prompt.
    await click('Close');
  } else if (path === 'switch editor') await click('cat');
  else if (path.startsWith('rail')) await act(async () => navigate(path === 'rail close' ? null : path === 'rail settings' ? 'settings' : 'chat'));
  else if (path === 'App close') act(() => appEscape(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })));
  else if (path === 'Settings') await act(async () => document.querySelector<HTMLAnchorElement>('.warn a')!.click());
  else await click(path);
};

beforeEach(async () => {
  vi.resetModules(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); actions.mockClear(); unsubscribe.mockClear(); stopNavigation.mockClear();
  document.body.innerHTML = '<div id="root"></div>';
  HTMLElement.prototype.scrollTo = vi.fn(); HTMLElement.prototype.scrollIntoView = vi.fn();
  status = { sequence: 1, panel: 'stickers', runtimePaused: false, state: { ...initialState(), global: { ...initialState().global, aiFeatures: true } }, chat: { chatId: null, name: '', kind: 'direct', ready: false, canSendSticker: false }, keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true, message: '', pending: null };
  status.state.global.directStickerDisabledReason = 'send-error';
  status.state.stickerGroups = [{ id: animals, name: 'Animals' }, { id: birds, name: 'Birds' }];
  status.state.stickers = ['dog', 'cat', 'bird'].map((name, index) => ({ id: (index + 1).toString().padStart(64, '0'), searchTerms: name, kind: 'static', size: 12, firstSeen: 1, lastSeen: 3 - index, groups: index === 0 ? [animals] : [birds] }));
  Object.assign(window, { companion: {
    status: async () => status,
    subscribe: (callback: typeof receive) => { receive = callback; return unsubscribe; },
    subscribePanelNavigation: (callback: typeof navigate) => { navigate = callback; return stopNavigation; },
    action: actions
  } });
  const listeners = vi.spyOn(document, 'addEventListener');
  await act(async () => { await import('../src/ui/index'); });
  appEscape = listeners.mock.calls.find(([name, , options]) => name === 'keydown' && options === undefined)![1] as typeof appEscape;
});
afterEach(() => {
  act(() => mounted.root!.unmount()); expect(unsubscribe).toHaveBeenCalledOnce(); expect(stopNavigation).toHaveBeenCalledOnce();
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

test.each(['no-key', 'auth', 'no-vision'] as const)('tagging %s links open Providers from strip and editor, then regular navigation opens the settings list', async error => {
  status = { ...status, fixture: false, stickerTagging: { state: 'blocked', total: 2, completed: 0, tagged: 0, failed: 0, provider: 'openai', error } };
  await act(async () => publish());
  await click('Settings', document.querySelector('.tag-strip')!);
  expect(status.panel).toBe('settings'); expect(document.querySelector('h1')?.textContent).toBe('Providers');
  expect(document.querySelector('input[type="password"]')).not.toBeNull();
  await click('Back to settings'); expect(document.querySelector('h1')?.textContent).toBe('Settings');
  await act(async () => navigate('stickers'));
  await click('Edit stickers'); await click('dog');
  status = { ...status, stickerTags: { [status.state.stickers[0].id]: { state: 'failed', error } } };
  await act(async () => publish());
  await click('Settings', document.querySelector('.sticker-detail')!);
  expect(document.querySelector('h1')?.textContent).toBe('Providers');
  await click('Close panel'); await act(async () => navigate('settings'));
  expect(document.querySelector('h1')?.textContent).toBe('Settings');
});

test('Providers navigation keeps the unsaved-draft guard and opens its destination only after Discard', async () => {
  await prepare('visible');
  status = { ...status, fixture: false, stickerTagging: { state: 'blocked', total: 2, completed: 0, tagged: 0, failed: 0, provider: 'openai', error: 'no-key' } };
  await act(async () => publish());
  await click('Settings', document.querySelector('.tag-strip')!);
  expect(prompt()).not.toBeNull(); expect(panelActions()).toHaveLength(0);
  await click('Keep editing'); expect(textarea().value).toBe('unsaved dog');
  await click('Settings', document.querySelector('.tag-strip')!); await click('Discard');
  expect(status.panel).toBe('settings'); expect(document.querySelector('h1')?.textContent).toBe('Providers');
});

test.each(visibility.flatMap(view => paths.map(path => ({ view, path }))))('$path guards a $view dirty draft; Keep reveals it and Discard completes the exit', async ({ view, path }) => {
  await prepare(view); await exit(path, view);
  expect(prompt()).not.toBeNull(); expect(textarea().value).toBe('unsaved dog'); expect(panelActions()).toHaveLength(0);
  expect(button('Done')).toBeDefined(); expect(document.activeElement).toBe(button('Keep editing'));
  if (view !== 'visible') expect(document.querySelector('.sticker-detail')?.hasAttribute('data-detached')).toBe(true);
  await click('Keep editing');
  expect(prompt()).toBeNull(); expect(textarea().value).toBe('unsaved dog'); expect(document.activeElement).toBe(textarea());
  expect(button('dog')).toBeDefined(); expect(panelActions()).toHaveLength(0);
  await hide(view); await exit(path, view); await click('Discard');
  expect(prompt()).toBeNull();
  const destination = path === 'rail settings' || path === 'Settings' ? 'settings' : path === 'rail chat' ? 'chat' : null;
  if (['Close panel', 'rail close', 'rail settings', 'rail chat', 'App close', 'Settings'].includes(path)) {
    expect(panelActions()).toEqual([[{ type: 'panel', panel: destination }]]); expect(status.panel).toBe(destination);
  } else if (path === 'switch editor') expect(textarea().value).toBe('cat');
  else expect(textarea()).toBeNull();
  expect(status.state.stickers[0].searchTerms).toBe('dog');
});

test.each(visibility)('repeated Escape cannot lose a %s draft or reach App close without Discard', async view => {
  await prepare(view); act(() => button('cat').focus()); escape();
  expect(prompt()).not.toBeNull(); escape(); expect(prompt()).toBeNull(); expect(textarea().value).toBe('unsaved dog');
  escape(); expect(prompt()).not.toBeNull(); expect(panelActions()).toHaveLength(0);
  await click('Discard'); escape(); escape();
  expect(status.panel).toBeNull(); expect(panelActions()).toHaveLength(1);
});

test('clicking the same visible sticker guards its draft before toggling the editor closed', async () => {
  await prepare('visible'); await click('dog'); expect(prompt()).not.toBeNull();
  await click('Keep editing'); expect(textarea().value).toBe('unsaved dog');
  await click('dog'); await click('Discard'); expect(textarea()).toBeNull();
});

const changes = ['search', 'group', 'membership', 'bulk membership', 'group deletion', 'new group', 'rename group'] as const;
test.each(visibility.flatMap(view => changes.map(change => ({ view, change }))))('$change preserves a $view draft and the later exit still asks', async ({ view, change }) => {
  await prepare(view);
  if (change === 'search') fill('.search', 'bird');
  else if (change === 'group') await click('Birds');
  else if (change === 'membership' || change === 'bulk membership') {
    await act(async () => actions(change === 'membership'
      ? { type: 'stickerGroupMembership', id: status.state.stickers[0].id, groupId: animals, member: false }
      : { type: 'bulkStickerGroupMembership', stickerIds: [status.state.stickers[0].id], groupId: animals, member: false }));
  } else if (change === 'group deletion') await act(async () => actions({ type: 'deleteStickerGroup', id: animals }));
  else if (change === 'new group') {
    await click('+ New group'); fill('[aria-label="New group name"]', 'New');
    await act(async () => document.querySelector('input[aria-label="New group name"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  } else await act(async () => actions({ type: 'renameStickerGroup', id: animals, name: 'Renamed' }));
  expect(prompt()).toBeNull(); await click('Done'); expect(prompt()).not.toBeNull(); expect(textarea().value).toBe('unsaved dog');
  await click('Keep editing'); expect(textarea().value).toBe('unsaved dog'); expect(document.activeElement).toBe(textarea());
});

test.each(visibility.flatMap(view => ['bar', 'keyboard', 'editor'].map(route => ({ view, route }))))('$route deletion explicitly discards only the deleted $view draft after confirmation', async ({ view, route }) => {
  await click('Edit stickers'); await click('Select dog'); await click('dog'); fill('textarea', 'unsaved dog'); await hide(view);
  expect(actions).toHaveBeenCalledWith({ type: 'removeStickerTag', id: status.state.stickers[0].id }); actions.mockClear();
  if (route === 'editor') {
    if (view !== 'visible') { await click('Done'); await click('Keep editing'); }
    await click('Delete sticker');
  } else if (route === 'bar') await click('Delete 1 sticker');
  else { act(() => button('cat').focus()); act(() => button('cat').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))); }
  const question = document.querySelector(route === 'editor' ? '.actions.confirm' : '.sticker-select-bar')!;
  expect(question.textContent).toContain('Unsaved changes will be discarded.');
  await click('Keep', question); expect(actions).not.toHaveBeenCalled();
  // A kept deletion retains its draft even when the editor remains filtered out.
  await click('Done'); expect(textarea().value).toBe('unsaved dog'); await click('Keep editing');
  if (route === 'editor') await click('Delete sticker');
  else {
    await hide(view);
    if (route === 'bar') await click('Delete 1 sticker');
    else act(() => button('cat').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })));
  }
  await click('Delete', document.querySelector(route === 'editor' ? '.actions.confirm' : '.sticker-select-bar')!);
  expect(status.state.stickers.map(sticker => sticker.searchTerms)).toEqual(['cat', 'bird']); expect(textarea()).toBeNull();
  await click('Done'); expect(prompt()).toBeNull();
});

test.each(visibility)('deleting a different sticker preserves the %s draft and its exit guard', async view => {
  await prepare(view); await click('Select cat'); await click('Delete 1 sticker'); await click('Delete', document.querySelector('.sticker-select-bar')!);
  await click('Done'); expect(prompt()).not.toBeNull(); expect(textarea().value).toBe('unsaved dog');
});

test.each(visibility)('an older Save cannot close a newer discard prompt for a %s draft', async view => {
  await prepare('visible'); const successful = actions.getMockImplementation()!; let resolve!: () => void;
  actions.mockImplementationOnce(async action => { await new Promise<void>(done => { resolve = done; }); return successful(action); });
  await click('Save'); await hide(view); await click('Done'); const keep = button('Keep editing');
  await act(async () => resolve()); expect(prompt()).not.toBeNull(); expect(button('Keep editing')).toBe(keep);
  expect(document.activeElement).toBe(keep); expect(textarea().value).toBe('unsaved dog'); expect(status.panel).toBe('stickers');
});

test('navigation without a draft completes once and a hidden delete question does not intercept Escape', async () => {
  await click('Edit stickers'); await click('dog'); await click('Delete sticker'); fill('.search', 'cat');
  expect(document.querySelector('.actions.confirm')).toBeNull(); act(() => button('cat').focus()); escape();
  expect(button('Edit stickers')).toBeDefined(); expect(prompt()).toBeNull();
  await act(async () => navigate('settings')); expect(panelActions()).toEqual([[{ type: 'panel', panel: 'settings' }]]);
});


test.each(visibility)('a failed deletion preserves the %s draft and its discard guard', async view => {
  await click('Edit stickers'); await click('Select dog'); await click('dog'); fill('textarea', 'unsaved dog'); await hide(view);
  await click('Delete 1 sticker'); actions.mockResolvedValueOnce({ ok: false }); await click('Delete', document.querySelector('.sticker-select-bar')!);
  expect(status.state.stickers[0].searchTerms).toBe('dog'); await click('Done');
  expect(prompt()).not.toBeNull(); expect(textarea().value).toBe('unsaved dog');
});

test.each(['membership', 'bulk membership'] as const)('%s removal from the active group hides but retains a dirty draft', async route => {
  await prepare('visible'); await click('Animals', document.querySelector('.sticker-group-chips')!);
  await act(async () => actions(route === 'membership'
    ? { type: 'stickerGroupMembership', id: status.state.stickers[0].id, groupId: animals, member: false }
    : { type: 'bulkStickerGroupMembership', stickerIds: [status.state.stickers[0].id], groupId: animals, member: false }));
  expect(textarea()).toBeNull(); act(() => button('Done').focus()); escape();
  expect(prompt()).not.toBeNull(); expect(textarea().value).toBe('unsaved dog'); await click('Keep editing');
  expect(textarea().value).toBe('unsaved dog'); expect(document.activeElement).toBe(textarea());
});

test.each(visibility)('clearing search with Escape retains a %s draft before the next editor exit', async view => {
  await prepare(view); fill('.search', 'cat'); act(() => document.querySelector<HTMLInputElement>('.search')!.focus()); escape();
  expect(document.querySelector<HTMLInputElement>('.search')!.value).toBe(''); expect(prompt()).toBeNull();
  await click('Done'); expect(prompt()).not.toBeNull(); expect(textarea().value).toBe('unsaved dog');
});

test('hidden drafts survive Escape clearing popovers, inline group edits and selections before the exit guard', async () => {
  await prepare('search-hidden'); await click('Select cat'); await click('Groups ▾'); escape();
  expect(document.querySelector('.sticker-groups-popover')).toBeNull(); expect(prompt()).toBeNull();
  await click('+ New group'); escape(); expect(document.querySelector('[aria-label="New group name"]')).toBeNull();
  expect(prompt()).toBeNull(); escape(); expect(button('Select all')).toBeDefined(); expect(prompt()).toBeNull();
  escape(); expect(prompt()).not.toBeNull(); expect(textarea().value).toBe('unsaved dog'); expect(panelActions()).toHaveLength(0);
});

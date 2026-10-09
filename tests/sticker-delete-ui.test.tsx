// @vitest-environment jsdom
import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { initialState, type Action, type Status } from '../src/shared/model';
import { Stickers } from '../src/ui/stickers';

let host: HTMLDivElement, root: Root, status: Status;
const group = '550e8400-e29b-41d4-a716-446655440000';
const actions = vi.fn(async (action: Action) => {
  if (action.type === 'forgetSticker' || action.type === 'forgetStickers') {
    const ids = action.type === 'forgetSticker' ? [action.id] : action.ids;
    status = { ...status, state: { ...status.state, stickers: status.state.stickers.filter(s => !ids.includes(s.id)) } }; draw();
  }
  return true;
});
const draw = () => root.render(<Stickers status={status} act={actions}/>);
const button = (name: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === name || b.getAttribute('aria-label') === name)!;
const click = async (name: string, scope: ParentNode = host) => act(async () => { const target = button(name, scope); target.focus(); target.click(); });
const tiles = () => [...host.querySelectorAll<HTMLButtonElement>('.sticker-art')];
const picks = () => [...host.querySelectorAll<HTMLButtonElement>('.sticker-pick')];
const bar = () => host.querySelector<HTMLElement>('.sticker-select-bar')!;
const search = () => host.querySelector<HTMLInputElement>('.search')!;
const fill = (selector: string, value: string) => act(() => {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const key = (key: string, target: EventTarget = document.activeElement!) => act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
const announce = () => host.querySelector('[aria-live=polite]')?.textContent;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); actions.mockClear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div'); host.className = 'panel'; host.scrollTo = vi.fn(); document.body.append(host); root = createRoot(host);
  status = { sequence: 1, state: initialState(), runtimePaused: false, chat: { chatId: null, name: '', kind: 'direct', ready: false, canSendSticker: false }, keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true, message: '', pending: null };
  status.state.stickerGroups = [{ id: group, name: 'Animals' }];
  status.state.stickers = ['dog', 'cat', 'bird', 'fish'].map((name, i) => ({ id: (i + 1).toString().padStart(64, '0'), searchTerms: name, kind: 'static', size: 12, firstSeen: 1, lastSeen: 4 - i, groups: i < 2 ? [group] : [] }));
  act(draw);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('bulk trash confirms, focuses Keep, deletes in one action and focuses the replacement tile', async () => {
  await click('Edit stickers'); await click('Select dog'); await click('Select bird');
  const ids = [status.state.stickers[0].id, status.state.stickers[2].id];
  expect([...bar().children].map(e => e.textContent)).toEqual(['×', '2 selected', '', 'Groups ▾', '']);
  await click('Delete 2 stickers'); expect(actions).not.toHaveBeenCalled(); expect(document.activeElement).toBe(button('Keep', bar()));
  expect(bar().getAttribute('aria-label')).toBe('Delete 2 stickers?');
  await click('Delete', bar()); expect(actions).toHaveBeenCalledExactlyOnceWith({ type: 'forgetStickers', ids });
  expect(host.querySelector('.count')?.textContent).toBe('2'); expect(button('Select all', bar())).toBeDefined();
  expect(document.activeElement).toBe(tiles()[0]); expect(tiles()[0].getAttribute('aria-label')).toBe('cat');
  expect(announce()).toBe('2 stickers deleted');
});

test('Keep and Escape restore trash focus, preserve selection and precede clearing search/selection/edit mode', async () => {
  await click('Edit stickers'); await click('Select dog'); fill('.search', 'dog');
  await click('Delete 1 sticker'); await click('Keep', bar());
  expect(document.activeElement).toBe(button('Delete 1 sticker')); expect(picks()[0].getAttribute('aria-checked')).toBe('true');
  await click('Delete 1 sticker'); act(() => search().focus()); key('Escape');
  expect(document.activeElement).toBe(button('Delete 1 sticker')); expect(search().value).toBe('dog');
  expect(button('Done')).toBeDefined(); expect(actions).not.toHaveBeenCalled();
  key('Escape'); expect(document.activeElement).toBe(button('Select all')); key('Escape'); expect(button('Edit stickers')).toBeDefined();
});

test.each(['Delete', 'Backspace'])('%s on an edit tile temporarily selects it and Keep/Esc restores it', async name => {
  await click('Edit stickers'); const tile = tiles()[1]; act(() => tile.focus()); key(name);
  expect(bar().getAttribute('aria-label')).toBe('Delete 1 sticker?'); expect(picks()[1].getAttribute('aria-checked')).toBe('true');
  expect(document.activeElement).toBe(button('Keep')); await click('Keep');
  expect(document.activeElement).toBe(tile); expect(picks()[1].getAttribute('aria-checked')).toBe('false');
  key(name); key('Escape'); expect(document.activeElement).toBe(tile); expect(button('Select all')).toBeDefined();
  expect(actions).not.toHaveBeenCalled();
});

test.each(['Keep', 'Escape'])('reopening a keyboard question retains temporary-selection ownership for %s', async answer => {
  await click('Edit stickers'); const original = tiles()[0];
  act(() => original.focus()); key('Delete');
  // Reopen from a different tile, then again from the automatically selected tile.
  act(() => tiles()[1].focus()); key('Backspace');
  act(() => original.focus()); key('Delete');
  expect(bar().getAttribute('aria-label')).toBe('Delete 1 sticker?');
  expect(picks().filter(pick => pick.getAttribute('aria-checked') === 'true')).toEqual([picks()[0]]);
  expect(document.activeElement).toBe(button('Keep', bar()));
  if (answer === 'Keep') await click('Keep', bar()); else key('Escape');
  expect(document.activeElement).toBe(original); expect(button('Select all')).toBeDefined();
  expect(picks().every(pick => pick.getAttribute('aria-checked') === 'false')).toBe(true);
  await click('Select cat'); await click('Delete 1 sticker'); await click('Delete', bar());
  expect(actions).toHaveBeenCalledExactlyOnceWith({ type: 'forgetStickers', ids: ['2'.padStart(64, '0')] });
});

test('keyboard and trash reopening preserve an explicit selection and the original focus target', async () => {
  await click('Edit stickers'); await click('Select dog'); await click('Select bird'); await click('dog');
  await click('Delete sticker'); await click('Delete 2 stickers');
  expect(host.querySelector('.actions.confirm')).toBeNull();
  act(() => tiles()[1].focus()); key('Delete');
  await click('Keep', bar()); expect(document.activeElement).toBe(button('Delete 2 stickers'));
  expect(picks().filter(pick => pick.getAttribute('aria-checked') === 'true')).toEqual([picks()[0], picks()[2]]);
  expect(actions).not.toHaveBeenCalled();
});

test.each(['Keep', 'Escape'])('editor trash replaces a keyboard question without retaining its temporary selection (%s)', async answer => {
  await click('Edit stickers'); await click('cat');
  act(() => tiles()[0].focus()); key('Delete');
  expect(picks()[0].getAttribute('aria-checked')).toBe('true');
  await click('Delete sticker');
  expect(bar().getAttribute('aria-label')).toBeNull(); expect(button('Select all')).toBeDefined();
  expect(host.querySelector('.actions.confirm')).not.toBeNull();
  if (answer === 'Keep') await click('Keep', host.querySelector('.sticker-detail')!); else key('Escape');
  expect(document.activeElement).toBe(button('Delete sticker'));
  expect(picks().every(pick => pick.getAttribute('aria-checked') === 'false')).toBe(true);
  expect(actions).not.toHaveBeenCalled();
});

test('Delete key uses existing selection, including hidden tiles, and does nothing in text fields or normal mode', async () => {
  act(() => tiles()[0].focus()); key('Delete'); expect(bar()).toBeNull();
  await click('Edit stickers'); await click('Select dog'); await click('Select bird');
  fill('.search', 'cat'); act(() => tiles()[0].focus()); key('Backspace');
  expect(bar().getAttribute('aria-label')).toBe('Delete 2 stickers?'); key('Escape'); expect(document.activeElement).toBe(tiles()[0]);
  expect(bar().textContent).toContain('2 selected');
  await click('cat'); const text = host.querySelector<HTMLTextAreaElement>('textarea')!; key('Delete', text);
  expect(button('Delete sticker')).toBeDefined(); expect(bar().getAttribute('aria-label')).toBeNull();
  key('Backspace', search()); expect(bar().getAttribute('aria-label')).toBeNull();
});

test('bulk deletion includes selection hidden by group and search and uses the last visible tile if none selected are visible', async () => {
  await click('Edit stickers'); await click('Select bird'); await click('Select fish'); await click('Animals'); fill('.search', 'cat');
  await click('Delete 2 stickers'); await click('Delete', bar());
  expect(status.state.stickers.map(s => s.searchTerms)).toEqual(['dog', 'cat']);
  expect(document.activeElement).toBe(tiles()[0]); expect(host.querySelector('.count')?.textContent).toBe('1 of 2'); expect(announce()).toBe('2 stickers deleted');
});

test('deleting the last visible position focuses the last remaining tile, and deleting everything focuses Search', async () => {
  await click('Edit stickers'); await click('Select fish'); await click('Delete 1 sticker'); await click('Delete', bar());
  expect(document.activeElement).toBe(tiles().at(-1)); expect(announce()).toBe('1 sticker deleted');
  await click('Select all'); await click('Delete 3 stickers'); await click('Delete', bar());
  expect(document.activeElement).toBe(search()); expect(tiles()).toHaveLength(0); expect(announce()).toBe('3 stickers deleted');
  expect(button('Select all').disabled).toBe(true);
});

test('editor trash confirms without moving textarea/groups; Keep and Esc restore trash before closing editor', async () => {
  await click('Edit stickers'); await click('dog'); fill('textarea', 'unsaved terms');
  expect(actions).toHaveBeenCalledExactlyOnceWith({ type: 'removeStickerTag', id: status.state.stickers[0].id }); actions.mockClear();
  const text = host.querySelector('textarea'), groups = host.querySelector('.sticker-detail-groups');
  await click('Delete sticker'); expect(document.activeElement).toBe(button('Keep')); expect(host.querySelector('textarea')).toBe(text); expect(host.querySelector('.sticker-detail-groups')).toBe(groups);
  await click('Keep'); expect(document.activeElement).toBe(button('Delete sticker')); expect((text as HTMLTextAreaElement).value).toBe('unsaved terms');
  await click('Delete sticker'); key('Escape'); expect(document.activeElement).toBe(button('Delete sticker')); expect(host.querySelector('.discard')).toBeNull();
  key('Escape'); expect(host.querySelector('.discard')).not.toBeNull(); expect(actions).not.toHaveBeenCalled();
});

test('confirmed editor deletion drops drafts, resets selection and focuses the replacement', async () => {
  await click('Edit stickers'); await click('Select bird'); await click('dog'); fill('textarea', 'unsaved'); const id = status.state.stickers[0].id;
  expect(actions).toHaveBeenCalledExactlyOnceWith({ type: 'removeStickerTag', id }); actions.mockClear();
  await click('Delete sticker'); await click('Delete', host.querySelector('.sticker-detail')!);
  expect(actions).toHaveBeenCalledExactlyOnceWith({ type: 'forgetSticker', id }); expect(host.querySelector('.sticker-detail')).toBeNull();
  expect(document.activeElement).toBe(tiles()[0]); expect(tiles()[0].getAttribute('aria-label')).toBe('cat'); expect(button('Select all')).toBeDefined(); expect(announce()).toBe('1 sticker deleted');
});

test('only one question opens and selection changes dismiss either question; Done dismisses bar question', async () => {
  await click('Edit stickers'); await click('dog'); await click('Select bird'); await click('Delete sticker');
  await click('Delete 1 sticker'); expect(host.querySelector('.actions.confirm')).toBeNull(); expect(bar().getAttribute('aria-label')).toBe('Delete 1 sticker?');
  await click('Delete sticker'); expect(bar().getAttribute('aria-label')).toBeNull(); expect(host.querySelector('.actions.confirm')).not.toBeNull();
  await click('Select fish'); expect(host.querySelector('.actions.confirm')).toBeNull();
  await click('Delete 2 stickers'); await click('Select bird'); expect(bar().getAttribute('aria-label')).toBeNull(); expect(bar().textContent).toContain('1 selected');
  await click('Delete 1 sticker'); await click('Done'); expect(bar()).toBeNull(); expect(button('Edit stickers')).toBeDefined();
});

test('failed deletion keeps the question and library; pending Delete stays focused and locks repeated actions', async () => {
  let resolve!: (value: boolean) => void;
  await click('Edit stickers'); await click('Select dog'); await click('Delete 1 sticker');
  actions.mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done; }));
  await click('Delete', bar()); expect(button('Delete', bar()).disabled).toBe(false); expect(button('Delete', bar()).getAttribute('aria-busy')).toBe('true'); expect(button('Delete', bar()).getAttribute('aria-disabled')).toBe('true'); expect(document.activeElement).toBe(button('Delete', bar())); expect(button('Keep', bar()).disabled).toBe(true);
  await click('Delete', bar()); expect(actions).toHaveBeenCalledTimes(1);
  key('Escape'); expect(bar().getAttribute('aria-label')).toBe('Delete 1 sticker?');
  await act(async () => resolve(false)); expect(button('Keep', bar()).disabled).toBe(false); expect(tiles()).toHaveLength(4); expect(announce()).toBe('');
  expect(bar().getAttribute('aria-label')).toBe('Delete 1 sticker?');
});

test('Escape closes the delete question, editor, selection and edit mode in order', async () => {
  await click('Edit stickers'); await click('Select bird'); await click('dog'); await click('Delete sticker');
  key('Escape'); expect(document.activeElement).toBe(button('Delete sticker')); expect(host.querySelector('.sticker-detail')).not.toBeNull();
  key('Escape'); expect(host.querySelector('.sticker-detail')).toBeNull(); expect(bar().textContent).toContain('1 selected');
  key('Escape'); expect(button('Select all')).toBeDefined(); expect(button('Done')).toBeDefined();
  key('Escape'); expect(button('Edit stickers')).toBeDefined(); expect(actions).not.toHaveBeenCalled();
});

test('keyboard confirmation deletes the automatically selected tile and restores focus after it', async () => {
  await click('Edit stickers'); const id = status.state.stickers[1].id;
  act(() => tiles()[1].focus()); key('Delete'); await click('Delete', bar());
  expect(actions).toHaveBeenCalledExactlyOnceWith({ type: 'forgetStickers', ids: [id] });
  expect(document.activeElement).toBe(tiles()[1]); expect(tiles()[1].getAttribute('aria-label')).toBe('bird');
  expect(button('Select all')).toBeDefined();
});

test('editor failure retains draft and question with focus restored by Keep', async () => {
  await click('Edit stickers'); await click('dog'); fill('textarea', 'draft'); await click('Delete sticker');
  actions.mockResolvedValueOnce(false); await click('Delete', host.querySelector('.sticker-detail')!);
  expect(host.querySelector('.actions.confirm')).not.toBeNull(); expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('draft'); expect(tiles()).toHaveLength(4);
  await click('Keep'); expect(document.activeElement).toBe(button('Delete sticker'));
});

test('repeated deleted counts replace the announcement content and later send feedback remains audible', async () => {
  await click('Edit stickers'); await click('Select dog'); await click('Delete 1 sticker'); await click('Delete', bar());
  const previous = host.querySelector('[aria-live=polite] span');
  await click('Select cat'); await click('Delete 1 sticker'); await click('Delete', bar());
  expect(announce()).toBe('1 sticker deleted'); expect(host.querySelector('[aria-live=polite] span')).not.toBe(previous);
  status = { ...status, stickerSend: { id: status.state.stickers[0].id, nonce: '550e8400-e29b-41d4-a716-446655440001', name: 'Alex', route: 'picker', animated: false, state: 'sent' } }; act(draw);
  expect(announce()).toBe('Sent to Alex');
});

test.each(['bar', 'keyboard', 'editor'])('%s deletion announcement survives hiding an old failed-send result', async path => {
  status = { ...status, stickerSend: { id: status.state.stickers[0].id, nonce: 'failed-send', name: 'Alex', route: 'maker', animated: false, state: 'failed', sent: 'not-sent' } }; act(draw);
  expect(announce()).toBe('Nothing was sent');
  await click('Edit stickers');
  if (path === 'bar') { await click('Select dog'); await click('Delete 1 sticker'); }
  else if (path === 'keyboard') { act(() => tiles()[0].focus()); key('Delete'); }
  else { await click('dog'); await click('Delete sticker'); }
  await click('Delete', path === 'editor' ? host.querySelector('.sticker-detail')! : bar());
  expect(host.querySelector('.sticker-message')).toBeNull(); expect(announce()).toBe('1 sticker deleted');
  // Main clearing the old send, and group/filter status updates, are passive.
  status = { ...status, stickerSend: null }; act(draw);
  await click('Animals'); await click('Select cat'); await click('Groups ▾');
  status = { ...status, state: { ...status.state, stickerGroups: [...status.state.stickerGroups, { id: '550e8400-e29b-41d4-a716-446655440002', name: 'New group' }] } }; act(draw);
  expect(announce()).toBe('1 sticker deleted');
  status = { ...status, stickerSend: { id: status.state.stickers[0].id, nonce: 'new-send', name: 'Alex', route: 'maker', animated: false, state: 'preparing' } }; act(draw);
  expect(announce()).toBe('Sending sticker…');
});

test('expiring an old successful send does not clear a later deletion announcement', async () => {
  vi.useFakeTimers();
  try {
    status = { ...status, stickerSend: { id: status.state.stickers[0].id, nonce: 'sent-result', name: 'Alex', route: 'picker', animated: false, state: 'sent' } }; act(draw);
    await click('Edit stickers'); await click('Select cat'); await click('Delete 1 sticker'); await click('Delete', bar());
    expect(announce()).toBe('1 sticker deleted');
    act(() => vi.advanceTimersByTime(1500)); expect(announce()).toBe('1 sticker deleted');
    expect(host.querySelector('[data-sent]')).toBeNull();
  } finally { vi.useRealTimers(); }
});

test('send cancellation published by deletion cleanup does not erase the deletion announcement', async () => {
  status = { ...status, stickerSend: { id: status.state.stickers[0].id, nonce: 'active-send', name: 'Alex', route: 'maker', animated: false, state: 'preparing' } }; act(draw);
  await click('Edit stickers'); await click('Select dog'); await click('Delete 1 sticker');
  const successful = actions.getMockImplementation()!;
  actions.mockImplementationOnce(async action => {
    const ok = await successful(action);
    status = { ...status, stickerSend: { ...status.stickerSend!, state: 'cancelled', sent: 'not-sent' } }; draw();
    return ok;
  });
  await click('Delete', bar()); expect(announce()).toBe('1 sticker deleted');
});

test('clearing an old busy warning does not clear deletion feedback, but a new send attempt does', async () => {
  const authorizedClick = async (target: HTMLButtonElement) => {
    const key = Object.keys(target).find(key => key.startsWith('__reactProps$'))!;
    const props = (target as unknown as Record<string, { onClick: (event: unknown) => void }>)[key];
    await act(async () => props.onClick({ nativeEvent: { isTrusted: true } }));
  };
  status = { ...status, chat: { ...status.chat, stickerSendBlockedReason: 'busy' } }; act(draw);
  await authorizedClick(tiles()[0]); expect(announce()).toBe('Wait for the current sticker');
  await click('Edit stickers'); await click('Select dog'); await click('Delete 1 sticker'); await click('Delete', bar());
  expect(announce()).toBe('1 sticker deleted');
  status = { ...status, chat: { ...status.chat, stickerSendBlockedReason: undefined } }; act(draw);
  expect(announce()).toBe('1 sticker deleted');
  await click('Done');
  status = { ...status, chat: { ...status.chat, stickerSendBlockedReason: 'busy' } }; act(draw);
  await authorizedClick(tiles()[0]); expect(announce()).toBe('Wait for the current sticker');
  status = { ...status, chat: { ...status.chat, stickerSendBlockedReason: undefined, canSendSticker: true, destinationToken: 'destination-1' } }; act(draw);
  await authorizedClick(tiles()[0]); expect(announce()).toBe('Sending sticker…');
  expect(actions).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'sendSticker', id: status.state.stickers[0].id }));
});


test('changing the group filter closes a question while preserving deliberate hidden selections', async () => {
  await click('Edit stickers'); await click('Select bird'); await click('Delete 1 sticker'); await click('Animals');
  expect(bar().getAttribute('aria-label')).toBeNull(); expect(bar().textContent).toContain('1 selected'); expect(tiles()).toHaveLength(2);
  await click('Clear selection'); act(() => tiles()[0].focus()); key('Delete'); await click('All');
  expect(bar().getAttribute('aria-label')).toBeNull(); expect(button('Select all')).toBeDefined();
  expect(picks().every(pick => pick.getAttribute('aria-checked') === 'false')).toBe(true); expect(actions).not.toHaveBeenCalled();
});

test.each(['other circle', 'same circle', 'ctrl tile', 'meta tile', 'Keep', 'Escape', 'filter', 'search', 'new group', 'open editor', 'Done', 'panel close'])('temporary keyboard selection is removed on %s dismissal', async path => {
  await click('Edit stickers'); act(() => tiles()[0].focus()); key('Delete');
  switch (path) {
    case 'other circle': await click('Select cat'); break;
    case 'same circle': await click('Select dog'); break;
    case 'ctrl tile':
    case 'meta tile': act(() => tiles()[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: path === 'ctrl tile', metaKey: path === 'meta tile' }))); break;
    case 'Keep': await click('Keep', bar()); break;
    case 'Escape': key('Escape'); break;
    case 'filter': await click('Animals'); break;
    case 'search': fill('.search', 'cat'); break;
    case 'new group': await click('+ New group'); break;
    case 'open editor': await click('cat'); break;
    case 'Done': await click('Done'); break;
    case 'panel close': await click('Close panel'); expect(actions).toHaveBeenCalledWith({ type: 'panel', panel: null }); break;
  }
  expect(bar()?.getAttribute('aria-label')).toBeFalsy();
  if (path === 'Done' || path === 'panel close') await click('Edit stickers');
  expect(host.querySelector(`[data-sticker="${status.state.stickers[0].id}"] .sticker-pick`)?.getAttribute('aria-checked')).not.toBe('true');
  const explicit = ['other circle', 'ctrl tile', 'meta tile'].includes(path);
  expect(picks().filter(pick => pick.getAttribute('aria-checked') === 'true')).toHaveLength(explicit ? 1 : 0);
  if (explicit) {
    // The subsequent Groups and trash operations must use only the deliberate selection.
    await click('Groups ▾'); key('Escape'); await click('Delete 1 sticker'); await click('Delete', bar());
    expect(actions).toHaveBeenLastCalledWith({ type: 'forgetStickers', ids: ['2'.padStart(64, '0')] });
    expect(status.state.stickers.some(sticker => sticker.searchTerms === 'dog')).toBe(true);
  }
});

test('Groups menu dismisses editor confirmation and retains deliberate selection', async () => {
  await click('Edit stickers'); await click('Select bird'); await click('dog'); await click('Delete sticker');
  await click('Groups ▾'); expect(host.querySelector('.actions.confirm')).toBeNull();
  expect(host.querySelector('.sticker-groups-popover')).not.toBeNull();
  expect(picks()[2].getAttribute('aria-checked')).toBe('true'); expect(actions).not.toHaveBeenCalled();
});

test.each(['bar', 'keyboard', 'editor'])('%s delete restores focus after it falls to the page while Delete remains mounted', async path => {
  await click('Edit stickers');
  if (path === 'bar') { await click('Select dog'); await click('Delete 1 sticker'); }
  else if (path === 'keyboard') { act(() => tiles()[0].focus()); key('Delete'); }
  else { await click('dog'); await click('Delete sticker'); }
  const scope = path === 'editor' ? host.querySelector('.sticker-detail')! : bar();
  const successful = actions.getMockImplementation()!;
  let resolve!: () => void;
  actions.mockImplementationOnce(async action => { await new Promise<void>(done => { resolve = done; }); return successful(action); });
  await click('Delete', scope);
  const confirm = button('Delete', scope); expect(confirm.disabled).toBe(false); expect(document.activeElement).toBe(confirm);
  act(() => confirm.blur()); expect(document.activeElement).toBe(document.body); expect(confirm.isConnected).toBe(true);
  await act(async () => resolve()); expect(document.activeElement).toBe(tiles()[0]); expect(tiles()[0].getAttribute('aria-label')).toBe('cat');
});

test.each(['bar', 'keyboard', 'editor'])('%s deletion of the last sticker in a group focuses Search', async path => {
  await click('Edit stickers'); await click('Animals');
  status = { ...status, state: { ...status.state, stickers: status.state.stickers.filter(sticker => sticker.searchTerms !== 'dog') } }; act(draw);
  if (path === 'bar') { await click('Select all'); await click('Delete 1 sticker'); }
  else if (path === 'keyboard') { act(() => tiles()[0].focus()); key('Delete'); }
  else { await click('cat'); await click('Delete sticker'); }
  await click('Delete', path === 'editor' ? host.querySelector('.sticker-detail')! : bar());
  expect(tiles()).toHaveLength(0); expect(document.activeElement).toBe(search());
  expect(host.querySelector('.empty p')?.textContent).toBe('No stickers in Animals');
});

test('bar deletion of every sticker in a group focuses Search while the other groups remain', async () => {
  await click('Edit stickers'); await click('Animals'); await click('Select all'); await click('Delete 2 stickers'); await click('Delete', bar());
  expect(document.activeElement).toBe(search()); expect(tiles()).toHaveLength(0); expect(status.state.stickers).toHaveLength(2);
});

test.each(['bar', 'keyboard', 'editor'])('%s failure retry restores focus to the replacement tile', async path => {
  await click('Edit stickers');
  if (path === 'bar') { await click('Select dog'); await click('Delete 1 sticker'); }
  else if (path === 'keyboard') { act(() => tiles()[0].focus()); key('Delete'); }
  else { await click('dog'); await click('Delete sticker'); }
  const scope = path === 'editor' ? host.querySelector('.sticker-detail')! : bar();
  actions.mockResolvedValueOnce(false); await click('Delete', scope);
  expect(document.activeElement).toBe(button('Delete', scope)); expect(tiles()).toHaveLength(4);
  expect(button('Delete', scope).hasAttribute('aria-busy')).toBe(false);
  await click('Delete', scope); expect(document.activeElement).toBe(tiles()[0]); expect(tiles()[0].getAttribute('aria-label')).toBe('cat');
});

test('a delayed deletion does not steal focus from another control', async () => {
  await click('Edit stickers'); await click('Select dog'); await click('Delete 1 sticker');
  const successful = actions.getMockImplementation()!; let resolve!: () => void;
  actions.mockImplementationOnce(async action => { await new Promise<void>(done => { resolve = done; }); return successful(action); });
  await click('Delete', bar()); act(() => search().focus()); await act(async () => resolve());
  expect(document.activeElement).toBe(search());
});

test('empty library keeps the loading hint only before any deletion, including when reopening the panel', async () => {
  const original = status;
  status = { ...status, state: { ...status.state, stickers: [], hasForgotten: false } }; act(draw);
  expect(host.querySelector('.empty small')?.textContent).toContain('select Favorites');
  status = { ...status, state: { ...status.state, hasForgotten: true } }; act(draw);
  expect(host.querySelector('.empty p')?.textContent).toBe('Your stickers will appear here'); expect(host.querySelector('.empty small')).toBeNull();
  // The local successful-delete count also covers the gap before a projected status arrives.
  status = original; act(draw); await click('Edit stickers'); await click('Select all'); await click('Delete 4 stickers'); await click('Delete', bar());
  expect(document.activeElement).toBe(search()); expect(host.querySelector('.empty small')).toBeNull();
  fill('.search', 'missing'); expect(host.querySelector('.empty small')?.textContent).toBe('Try another word or phrase.');
  act(() => root.unmount()); root = createRoot(host);
  status = { ...status, state: { ...status.state, hasForgotten: true } }; act(draw);
  expect(host.querySelector('.empty small')).toBeNull();
});

test('editor Keep has the same side padding as the bar Keep', async () => {
  const style = document.createElement('style');
  style.textContent = readFileSync('src/ui/style.css', 'utf8').split('\n').filter(line => line.startsWith('.actions.confirm .quiet') || line.startsWith('.sticker-select-bar .quiet')).join('\n');
  document.head.append(style);
  try {
    await click('Edit stickers'); await click('Select dog'); await click('Delete 1 sticker');
    const barPadding = getComputedStyle(button('Keep', bar())).paddingInline; expect(barPadding).toBe('6px');
    await click('Keep', bar()); await click('dog'); await click('Delete sticker');
    expect(getComputedStyle(button('Keep', host.querySelector('.sticker-detail')!)).paddingInline).toBe(barPadding);
  } finally { style.remove(); }
});

// Complete the request only after independent panel interactions have rendered.
const deferAction = () => {
  const successful = actions.getMockImplementation()!;
  let resolve!: () => void;
  actions.mockImplementationOnce(async action => { await new Promise<void>(done => { resolve = done; }); return successful(action); });
  return () => act(async () => resolve());
};

test.each(['bar', 'keyboard', 'editor'])('%s pending deletion preserves a newer selection and open Groups', async path => {
  await click('Edit stickers');
  if (path === 'bar') { await click('Select dog'); await click('Delete 1 sticker'); }
  else if (path === 'keyboard') { act(() => tiles()[0].focus()); key('Delete'); }
  else { await click('dog'); await click('Delete sticker'); }
  const complete = deferAction();
  await click('Delete', path === 'editor' ? host.querySelector('.sticker-detail')! : bar());
  await click('Select cat'); await click('Groups ▾');
  const groupControl = document.activeElement;
  await complete();
  expect(button('Select cat').getAttribute('aria-checked')).toBe('true');
  expect(bar().textContent).toContain('1 selected'); expect(host.querySelector('.sticker-groups-popover')).not.toBeNull();
  expect(document.activeElement).toBe(groupControl); expect(announce()).toBe('1 sticker deleted');
  key('Escape'); await click('Delete 1 sticker'); await click('Delete', bar());
  expect(status.state.stickers.map(sticker => sticker.searchTerms)).toEqual(['bird', 'fish']);
});

test('opening Groups during pending editor deletion preserves its original surviving selection', async () => {
  await click('Edit stickers'); await click('Select cat'); await click('dog'); await click('Delete sticker');
  const complete = deferAction(); await click('Delete', host.querySelector('.sticker-detail')!);
  await click('Groups ▾'); const focused = document.activeElement;
  await complete();
  expect(button('Select cat').getAttribute('aria-checked')).toBe('true'); expect(host.querySelector('.sticker-groups-popover')).not.toBeNull();
  expect(document.activeElement).toBe(focused);
});

test('pending keyboard cleanup preserves an explicit re-selection of its temporary id', async () => {
  await click('Edit stickers'); act(() => tiles()[0].focus()); key('Delete');
  const complete = deferAction(); await click('Delete', bar());
  await click('Select cat'); await click('Select dog');
  await complete();
  expect(button('Select cat').getAttribute('aria-checked')).toBe('true');
  expect(bar().textContent).toContain('1 selected'); expect(tiles().map(tile => tile.getAttribute('aria-label'))).toEqual(['cat', 'bird', 'fish']);
});

test.each(['bar', 'keyboard', 'editor'])('%s pending deletion restores focus from a reopened deleted editor', async path => {
  await click('Edit stickers');
  if (path === 'bar') { await click('Select dog'); await click('Delete 1 sticker'); }
  else if (path === 'keyboard') { act(() => tiles()[0].focus()); key('Delete'); }
  else { await click('dog'); await click('Delete sticker'); }
  const complete = deferAction(); await click('Delete', path === 'editor' ? host.querySelector('.sticker-detail')! : bar());
  if (path === 'editor') { await click('Close'); }
  await click('dog'); fill('textarea', 'new deleted draft');
  expect(document.activeElement).toBe(host.querySelector('textarea'));
  await complete();
  expect(host.querySelector('.sticker-detail')).toBeNull(); expect(document.activeElement).toBe(tiles()[0]);
  expect(tiles()[0].getAttribute('aria-label')).toBe('cat');
});

test.each(['bar', 'editor'])('%s pending deletion leaves a surviving editor and its focused draft alone', async path => {
  await click('Edit stickers');
  if (path === 'bar') { await click('Select dog'); await click('Delete 1 sticker'); }
  else { await click('dog'); await click('Delete sticker'); }
  const complete = deferAction(); await click('Delete', path === 'editor' ? host.querySelector('.sticker-detail')! : bar());
  await click('cat'); fill('textarea', 'surviving draft'); const textarea = host.querySelector('textarea');
  await complete();
  expect(document.activeElement).toBe(textarea); expect(host.querySelector('textarea')).toBe(textarea);
  expect(textarea?.value).toBe('surviving draft'); expect(announce()).toBe('1 sticker deleted');
});

test('membership removal dismisses an unavailable editor question; Escape clears selection directly', async () => {
  await click('Edit stickers'); await click('Animals'); await click('Select cat'); await click('dog'); await click('Delete sticker');
  actions.mockImplementationOnce(async action => {
    expect(action.type).toBe('stickerGroupMembership');
    status = { ...status, state: { ...status.state, stickers: status.state.stickers.map(sticker => sticker.searchTerms === 'dog' ? { ...sticker, groups: [] } : sticker) } }; draw(); return true;
  });
  await click('Animals', host.querySelector('.sticker-detail-groups')!);
  expect(host.querySelector('.actions.confirm')).toBeNull(); expect(host.querySelector('textarea')).toBeNull();
  act(() => button('Clear selection').focus()); key('Escape');
  expect(document.activeElement).toBe(button('Select all')); expect(button('Done')).toBeDefined();
  await click('All'); expect(host.querySelector('.actions.confirm')).toBeNull();
});

test.each(['filter', 'group removed', 'sticker removed', 'Close', 'Done', 'panel close'])('%s dismisses editor questions without replaying them', async path => {
  await click('Edit stickers'); await click('Animals'); await click('dog'); await click('Delete sticker');
  if (path === 'filter') fill('.search', 'cat');
  else if (path === 'group removed') {
    status = { ...status, state: { ...status.state, stickerGroups: [], stickers: status.state.stickers.map(sticker => ({ ...sticker, groups: [] })) } }; act(draw);
  } else if (path === 'sticker removed') {
    status = { ...status, state: { ...status.state, stickers: status.state.stickers.slice(1) } }; act(draw);
  } else await click(path === 'panel close' ? 'Close panel' : path);
  expect(host.querySelector('.actions.confirm')).toBeNull();
  if (path === 'filter') fill('.search', '');
  if (['Close', 'Done', 'panel close'].includes(path)) {
    if (path !== 'Close') await click('Edit stickers');
    await click('dog');
  }
  expect(host.querySelector('.actions.confirm')).toBeNull();
});

test.each(['editor question', 'bar question'])('an older pending Save cannot close a newer %s', async path => {
  await click('Edit stickers'); await click('dog'); fill('textarea', 'saved draft');
  let resolve!: () => void;
  actions.mockImplementationOnce(async action => {
    await new Promise<void>(done => { resolve = done; });
    if (action.type === 'sticker') status = { ...status, state: { ...status.state, stickers: status.state.stickers.map(sticker => sticker.id === action.id ? { ...sticker, searchTerms: action.searchTerms } : sticker) } };
    draw(); return true;
  });
  await click('Save');
  if (path === 'editor question') await click('Delete sticker');
  else { await click('Select cat'); await click('Delete 1 sticker'); }
  const keep = button('Keep');
  await act(async () => resolve());
  expect(host.querySelector('textarea')).not.toBeNull(); expect(button('Keep')).toBe(keep); expect(document.activeElement).toBe(keep);
  await click('Keep'); expect(host.querySelector('textarea')?.value).toBe('saved draft');
});

test('durability banner remains visible beside the deletion announcement until sync recovery', async () => {
  await click('Edit stickers'); await click('Select dog'); await click('Delete 1 sticker');
  const successful = actions.getMockImplementation()!;
  actions.mockImplementationOnce(async action => { const ok = await successful(action); status = { ...status, stickerLibraryError: 'Sticker changes saved; disk sync pending.' }; draw(); return ok; });
  await click('Delete', bar());
  expect(announce()).toBe('1 sticker deleted'); expect(host.querySelector('.sticker-strip')?.textContent).toContain('disk sync pending');
  status = { ...status, stickerLibraryError: undefined }; act(draw);
  expect(host.querySelector('.sticker-strip')?.textContent).not.toContain('disk sync pending'); expect(announce()).toBe('1 sticker deleted');
});

test.each(['ctrl tile', 'meta tile', 'select all', 'clear and reselect'])('pending deletion preserves newer selection made with %s', async path => {
  await click('Edit stickers'); await click('Select dog'); await click('Delete 1 sticker');
  const complete = deferAction(); await click('Delete', bar());
  if (path === 'ctrl tile' || path === 'meta tile') act(() => tiles()[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: path === 'ctrl tile', metaKey: path === 'meta tile' })));
  else {
    // The first toggle dismisses the active question and exposes the ordinary bar.
    await click('Select cat'); await click('Clear selection');
    await click(path === 'select all' ? 'Select all' : 'Select cat');
  }
  await complete();
  expect(button('Select cat').getAttribute('aria-checked')).toBe('true');
  expect(picks().filter(pick => pick.getAttribute('aria-checked') === 'true')).toHaveLength(path === 'select all' ? 3 : 1);
});

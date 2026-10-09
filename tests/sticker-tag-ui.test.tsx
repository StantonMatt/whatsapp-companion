// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { initialState, type Action, type Status } from '../src/shared/model';
import { Stickers } from '../src/ui/stickers';
import { Settings } from '../src/ui/settings';
const group = '550e8400-e29b-41d4-a716-446655440000';
let root: Root, host: HTMLDivElement, status: Status;
const actions = vi.fn(async (_action: Action) => true);
const draw = () => root.render(<Stickers status={status} act={actions}/>);
const button = (name: string, parent: ParentNode = host) => [...parent.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === name || b.getAttribute('aria-label') === name)!;
const click = async (name: string, parent: ParentNode = host) => act(async () => { expect(button(name, parent), name).toBeDefined(); button(name, parent).click(); });
const escape = () => act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })));
const fill = async (value: string) => act(async () => { const field = host.querySelector('textarea')!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
const publish = (fields: Partial<Status>) => act(() => { status = { ...status, ...fields, sequence: status.sequence + 1 }; draw(); });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); actions.mockReset().mockResolvedValue(true); HTMLElement.prototype.scrollIntoView = vi.fn(); HTMLElement.prototype.scrollTo = vi.fn();
  host = document.createElement('div'); host.className = 'panel'; document.body.append(host); root = createRoot(host);
  status = { sequence: 1, panel: 'stickers', runtimePaused: false, state: initialState(), chat: { chatId: null, name: '', kind: 'direct', ready: false, canSendSticker: false }, keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true, message: '', pending: null };
  status.state.stickerGroups = [{ id: group, name: 'Favorites' }]; status.state.stickers = Array.from({ length: 4 }, (_, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), searchTerms: i === 3 ? 'curated' : '', groups: [], kind: 'static', size: 12, firstSeen: 1, lastSeen: 4 - i })); act(draw);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
test('batch scope, selection icon tooltip, and >20 confirmation with Escape', async () => {
  await click('Edit stickers'); await click('Tag 3 untagged'); expect(actions).toHaveBeenLastCalledWith({ type: 'tagStickers', ids: status.state.stickers.slice(0, 3).map(s => s.id) });
  await act(async () => host.querySelector<HTMLButtonElement>('.sticker-pick')!.click()); await click('Tag 1 untagged with AI'); expect(actions).toHaveBeenLastCalledWith({ type: 'tagStickers', ids: [status.state.stickers[0].id] });
  await click('Clear selection');
  publish({ state: { ...status.state, stickers: Array.from({ length: 21 }, (_, i) => ({ ...status.state.stickers[0], id: (i + 1).toString(16).padStart(64, '0') })) } });
  actions.mockClear(); await click('Tag 21 untagged'); expect(host.textContent).toContain('Tag 21 stickers with OpenAI?'); expect(actions).not.toHaveBeenCalled(); escape(); expect(host.textContent).not.toContain('Tag 21 stickers with OpenAI?');
  await click('Tag 21 untagged'); await click('Tag'); expect(actions).toHaveBeenCalledWith({ type: 'tagStickers', ids: status.state.stickers.map(s => s.id) });
});
test('Untagged retains tagged tiles until a filter change; typing withdraws queue membership', async () => {
  await click('Edit stickers'); await click('Untagged'); expect(host.querySelectorAll('.sticker-art')).toHaveLength(3);
  publish({ state: { ...status.state, stickers: status.state.stickers.map((s, i) => i === 0 ? { ...s, searchTerms: 'new terms' } : s) } }); expect(host.querySelectorAll('.sticker-art')).toHaveLength(3);
  await click('All'); await click('Untagged'); expect(host.querySelectorAll('.sticker-art')).toHaveLength(2);
  const id = status.state.stickers[1].id; await act(async () => host.querySelector<HTMLButtonElement>(`[data-sticker="${id}"] .sticker-art`)!.click());
  publish({ stickerTags: { [id]: { state: 'queued' } } }); await fill('user typed'); expect(actions).toHaveBeenCalledWith({ type: 'removeStickerTag', id });
});
test.each(['blocked', 'dismissed'] as const)('editing a hidden %s retry candidate withdraws it and retry includes hidden drafts', async result => {
  await click('Edit stickers'); const ids = status.state.stickers.map(s => s.id);
  publish({ stickerTagging: { state: 'blocked', total: 3, completed: 0, tagged: 0, failed: 3, provider: 'openai', error: 'quota' }, stickerTags: { [ids[1]]: { state: 'failed', error: 'quota' } } });
  if (result === 'dismissed') {
    await click('Dismiss tagging result');
    expect(actions).toHaveBeenLastCalledWith({ type: 'dismissStickerTags' });
    publish({ stickerTagging: null, stickerTags: {} });
  }
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-sticker="${ids[0]}"] .sticker-art`)!.click());
  actions.mockClear(); await fill('manual unsaved terms');
  expect(actions).toHaveBeenCalledWith({ type: 'removeStickerTag', id: ids[0] });
  // Hide the editor behind a filter; its draft still belongs in the retry exclusion set.
  await click('Favorites');
  expect(host.querySelector('textarea')).toBeNull();
  if (result === 'dismissed') publish({ stickerTagging: { state: 'partial', total: 4, completed: 4, tagged: 1, failed: 3, provider: 'openai' } });
  await click('Try again', host.querySelector('.tag-strip')!);
  expect(actions).toHaveBeenLastCalledWith({ type: 'retryStickerTags', excludedIds: [ids[0]] });
});
test('editor suggestion is unsaved, suggested groups are removable, Discard restores original and Save adds groups', async () => {
  await click('Edit stickers'); await click('curated'); await click('Suggest search terms');
  const request = actions.mock.calls.at(-1)![0]; if (request.type !== 'suggestStickerTags') throw new Error('missing suggestion request');
  publish({ stickerTags: { [request.id]: { state: 'suggested', nonce: request.nonce, suggestion: { searchTerms: 'AI terms', groups: [group] } } } });
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('AI terms'); expect(status.state.stickers[3].searchTerms).toBe('curated'); expect(host.querySelector('textarea')?.hasAttribute('data-suggested')).toBe(true);
  const chip = host.querySelector<HTMLButtonElement>('.sticker-detail-groups .chip')!; expect(chip.getAttribute('aria-pressed')).toBe('true'); expect(chip.hasAttribute('data-suggested')).toBe(true);
  await act(async () => chip.click()); expect(chip.getAttribute('aria-pressed')).toBe('false');
  await click('Discard', host.querySelector('.sticker-detail')!); expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('curated');
  await click('Suggest search terms'); const second = actions.mock.calls.at(-1)![0]; if (second.type !== 'suggestStickerTags') throw new Error('missing request');
  publish({ stickerTags: { [second.id]: { state: 'suggested', nonce: second.nonce, suggestion: { searchTerms: 'second terms', groups: [group] } } } });
  await click('Close', host.querySelector('.sticker-detail')!); expect(host.textContent).toContain('Discard changes?'); await click('Keep editing'); await click('Save', host.querySelector('.sticker-detail')!);
  expect(actions).toHaveBeenCalledWith({ type: 'sticker', id: request.id, searchTerms: 'second terms', addGroups: [group] });
});
test('pending suggestion Escape cancels, progress Stop and failures retry/settings are visible', async () => {
  await click('Edit stickers'); await act(async () => host.querySelector<HTMLButtonElement>('.sticker-art')!.click()); await click('Suggest search terms'); const id = status.state.stickers[0].id;
  escape(); expect(actions).toHaveBeenCalledWith({ type: 'removeStickerTag', id });
  publish({ stickerTagging: { state: 'running', total: 3, completed: 1, tagged: 1, failed: 0, provider: 'openai' }, stickerTags: { [id]: { state: 'working' } } });
  expect(host.textContent).toContain('Tagging 2 of 3'); await click('Stop'); expect(actions).toHaveBeenLastCalledWith({ type: 'stopStickerTags' });
  publish({ stickerTagging: { state: 'partial', total: 3, completed: 3, tagged: 2, failed: 1, provider: 'openai' }, stickerTags: { [id]: { state: 'failed', error: 'failed' } } });
  await click('Try again', host.querySelector('.tag-strip')!); expect(actions).toHaveBeenLastCalledWith({ type: 'retryStickerTags', excludedIds: [] });
  publish({ stickerTagging: { state: 'blocked', total: 3, completed: 0, tagged: 0, failed: 0, error: 'no-vision', provider: 'openai' } }); expect(host.textContent).toContain('The selected model can’t read images'); expect(button('AI settings', host.querySelector('.tag-strip')!)).toBeDefined();
});
test('automatic setting starts off, names configured provider and shows pause reason', async () => {
  act(() => root.render(<Settings status={{ ...status, panel: 'settings' }} act={actions} close={() => {}}/>));
  const toggle = host.querySelector<HTMLInputElement>('input[aria-label="Tag new stickers automatically"]') ?? [...host.querySelectorAll<HTMLInputElement>('input')].find(i => i.closest('label')?.textContent?.includes('Tag new stickers automatically'))!;
  expect(toggle.checked).toBe(false); await act(async () => toggle.click()); expect(actions).toHaveBeenLastCalledWith({ type: 'preferences', scope: 'global', patch: { automaticStickerTags: true } });
  act(() => root.render(<Settings status={{ ...status, state: { ...status.state, provider: 'anthropic', global: { ...status.state.global, automaticStickerTags: true } }, stickerTagPause: 'quota' }} act={actions} close={() => {}}/>));
  expect(host.textContent).toContain('Sends new sticker images to Anthropic.');
  expect(host.querySelector('.toggle:has(input:checked) small')?.textContent).toBe('Paused: Anthropic quota reached');
});
test('batch confirmation rechecks drafts, saved terms, queue membership and deleted stickers', async () => {
  publish({ state: { ...status.state, stickers: Array.from({ length: 25 }, (_, i) => ({ ...status.state.stickers[0], id: (i + 1).toString(16).padStart(64, '0') })) } });
  const ids = status.state.stickers.map(s => s.id);
  await click('Edit stickers'); await click('Tag 25 untagged');
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-sticker="${ids[0]}"] .sticker-art`)!.click());
  await fill('unsaved manual terms');
  publish({ state: { ...status.state, stickers: status.state.stickers.filter(s => s.id !== ids[1]).map(s => s.id === ids[2] ? { ...s, searchTerms: 'saved manually' } : s) }, stickerTags: { [ids[3]]: { state: 'queued' }, [ids[4]]: { state: 'working' } } });
  await click('Tag');
  expect(actions).toHaveBeenLastCalledWith({ type: 'tagStickers', ids: ids.slice(5) });
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('unsaved manual terms');
});
test('confirming a batch with no remaining eligible stickers sends nothing', async () => {
  publish({ state: { ...status.state, stickers: Array.from({ length: 21 }, (_, i) => ({ ...status.state.stickers[0], id: (i + 1).toString(16).padStart(64, '0') })) } });
  await click('Edit stickers'); await click('Tag 21 untagged'); actions.mockClear();
  publish({ state: { ...status.state, stickers: status.state.stickers.map(s => ({ ...s, searchTerms: 'now tagged' })) } });
  await click('Tag'); expect(actions).not.toHaveBeenCalled(); expect(host.textContent).not.toContain('Tag 21 stickers');
});
test.each(['', 'manual draft'])('Discard restores %j and only keeps genuinely unsaved drafts ineligible', async before => {
  await click('Edit stickers');
  await act(async () => host.querySelector<HTMLButtonElement>('.sticker-art')!.click());
  if (before) await fill(before);
  await click('Suggest search terms'); const request = actions.mock.calls.at(-1)![0];
  if (request.type !== 'suggestStickerTags') throw new Error('missing request');
  publish({ stickerTags: { [request.id]: { state: 'suggested', nonce: request.nonce, suggestion: { searchTerms: 'AI terms', groups: [] } } } });
  await click('Discard', host.querySelector('.sticker-detail')!);
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(before);
  // Main removes the suggestion item; eligibility must also recover locally.
  publish({ stickerTags: {} });
  await click(before ? 'Tag 2 untagged' : 'Tag 3 untagged');
  expect(actions).toHaveBeenLastCalledWith({ type: 'tagStickers', ids: status.state.stickers.slice(before ? 1 : 0, 3).map(s => s.id) });
});
test('running batches hide the bulk button, expose failure retries and exclude failures from selection tagging', async () => {
  await click('Edit stickers'); const ids = status.state.stickers.map(s => s.id);
  publish({ stickerTagging: { state: 'running', total: 3, completed: 1, tagged: 0, failed: 1, provider: 'openai' }, stickerTags: { [ids[0]]: { state: 'failed', error: 'failed' }, [ids[1]]: { state: 'working' } } });
  expect(host.querySelector('.tag-untagged')).toBeNull(); expect(button('Select all')).toBeDefined();
  expect(host.querySelector('.tag-strip')?.textContent).toContain('1 failed'); await click('Try again', host.querySelector('.tag-strip')!);
  expect(actions).toHaveBeenLastCalledWith({ type: 'retryStickerTags', excludedIds: [] });
  await click('Select all'); await click('Tag 1 untagged with AI');
  expect(actions).toHaveBeenLastCalledWith({ type: 'tagStickers', ids: [ids[2]] });
  await click('Clear selection');
  publish({ stickerTagging: { state: 'partial', total: 3, completed: 3, tagged: 0, failed: 1, provider: 'openai' }, stickerTags: { [ids[0]]: { state: 'failed', error: 'failed' } } });
  expect(button('Tag 3 untagged')).toBeDefined();
});
test.each(['queued', 'working', 'tagged', 'draft'] as const)('dimmed selection spark uses consistent accurate wording for %s stickers', async state => {
  await click('Edit stickers'); const id = status.state.stickers[0].id;
  if (state === 'draft') { await act(async () => host.querySelector<HTMLButtonElement>('.sticker-art')!.click()); await fill('draft'); }
  else if (state === 'tagged') publish({ state: { ...status.state, stickers: status.state.stickers.map(s => ({ ...s, searchTerms: 'saved' })) } });
  else publish({ stickerTags: { [id]: { state } } });
  await act(async () => host.querySelector<HTMLButtonElement>('.sticker-pick')!.click());
  const spark = host.querySelector<HTMLButtonElement>('.tag-ai')!;
  expect(spark.getAttribute('aria-disabled')).toBe('true'); expect(spark.title).toBe('No selected stickers available for AI tagging');
  expect(spark.getAttribute('aria-label')).toBe(spark.title); actions.mockClear();
  await act(async () => spark.click()); expect(actions).not.toHaveBeenCalled();
});
test.each(['quota', 'offline', 'auth', 'no-key', 'no-vision'] as const)('strip %s message has no trailing period while the editor retains sentence punctuation', async error => {
  await click('Edit stickers'); const id = status.state.stickers[0].id;
  await act(async () => host.querySelector<HTMLButtonElement>('.sticker-art')!.click());
  publish({ stickerTagging: { state: 'blocked', total: 3, completed: 0, tagged: 0, failed: 0, provider: 'openai', error }, stickerTags: { [id]: { state: 'failed', error } } });
  const stripText = host.querySelector('.tag-strip > span')?.textContent;
  expect(stripText).not.toMatch(/\./);
  expect(host.querySelector('.sticker-detail .msg p')?.textContent).toMatch(/\.$/);
});

const inputValue = async (field: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
});
const propose = async (text = 'AI terms', groups = [group]) => {
  await click('Suggest search terms');
  const request = actions.mock.calls.at(-1)![0];
  if (request.type !== 'suggestStickerTags') throw new Error('missing suggestion request');
  publish({ stickerTags: { [request.id]: { state: 'suggested', nonce: request.nonce, provider: status.state.provider, suggestion: { searchTerms: text, groups } } } });
  return request;
};
test('automatic activation of a newly created group clears Untagged through the filter path', async () => {
  await click('Edit stickers');
  const curated = status.state.stickers[3].id;
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-sticker="${curated}"] .sticker-pick`)!.click());
  await click('Untagged'); await click('Groups ▾'); await click('New group…');
  const field = host.querySelector<HTMLInputElement>('input[aria-label="New group name"]')!;
  await inputValue(field, 'Created');
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(actions).toHaveBeenCalledWith({ type: 'createStickerGroup', name: 'Created', stickerIds: [curated] });
  const created = '550e8400-e29b-41d4-a716-446655440001';
  publish({ state: { ...status.state, stickerGroups: [...status.state.stickerGroups, { id: created, name: 'Created' }], stickers: status.state.stickers.map(s => s.id === curated ? { ...s, groups: [created] } : s) } });
  expect(button('Untagged').getAttribute('aria-pressed')).toBe('false');
  expect(button('Created, edit group').getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector(`[data-sticker="${curated}"]`)).not.toBeNull();
});
test('Untagged snapshots include newly encountered stickers and reset on search and explicit group changes', async () => {
  await click('Edit stickers'); await click('Untagged');
  const arriving = { ...status.state.stickers[0], id: 'f'.repeat(64) };
  publish({ state: { ...status.state, stickers: [...status.state.stickers, arriving] }, stickerTags: { [arriving.id]: { state: 'working', provider: 'openai' } } });
  expect(host.querySelector(`[data-sticker="${arriving.id}"]`)).not.toBeNull();
  publish({ state: { ...status.state, stickers: status.state.stickers.map(s => s.id === arriving.id ? { ...s, searchTerms: 'new terms' } : s) }, stickerTags: {} });
  expect(host.querySelector(`[data-sticker="${arriving.id}"]`)).not.toBeNull();
  await inputValue(host.querySelector<HTMLInputElement>('input[aria-label="Search stickers"]')!, 'curated');
  expect(button('Untagged').getAttribute('aria-pressed')).toBe('false');
  expect(host.querySelectorAll('.sticker-art')).toHaveLength(1);
  act(() => host.querySelector<HTMLInputElement>('input[aria-label="Search stickers"]')!.focus());
  escape(); await click('Untagged'); await click('Favorites');
  expect(button('Untagged').getAttribute('aria-pressed')).toBe('false');
  expect(host.querySelectorAll('.sticker-art')).toHaveLength(0);
});
test('group-only pending suggestions stay drafts for batch and retry eligibility until Discard', async () => {
  await click('Edit stickers'); await act(async () => host.querySelector<HTMLButtonElement>('.sticker-art')!.click());
  const request = await propose(); await fill('');
  // Even an equal saved-text publication must retain proposal draft membership.
  publish({ state: { ...status.state, stickers: status.state.stickers.map(s => ({ ...s })) }, stickerTags: {} });
  await click('Tag 2 untagged');
  expect(actions).toHaveBeenLastCalledWith({ type: 'tagStickers', ids: status.state.stickers.slice(1, 3).map(s => s.id) });
  publish({ stickerTagging: { state: 'partial', total: 1, completed: 1, failed: 1, tagged: 0, provider: 'openai' } });
  await click('Try again', host.querySelector('.tag-strip')!);
  expect(actions).toHaveBeenLastCalledWith({ type: 'retryStickerTags', excludedIds: [request.id] });
  await click('Close', host.querySelector('.sticker-detail')!); expect(host.textContent).toContain('Discard changes?');
  await click('Keep editing'); await click('Discard', host.querySelector('.sticker-detail')!);
  await click('Tag 3 untagged');
  expect(actions).toHaveBeenLastCalledWith({ type: 'tagStickers', ids: status.state.stickers.slice(0, 3).map(s => s.id) });
});
test('saved membership consumes proposal metadata so removing the group cannot be undone by Save', async () => {
  await click('Edit stickers'); await act(async () => host.querySelector<HTMLButtonElement>('.sticker-art')!.click());
  const request = await propose();
  publish({ state: { ...status.state, stickers: status.state.stickers.map(s => s.id === request.id ? { ...s, groups: [group] } : s) } });
  let chip = host.querySelector<HTMLButtonElement>('.sticker-detail-groups .chip')!;
  expect(chip.hasAttribute('data-suggested')).toBe(false); expect(chip.getAttribute('aria-describedby')).toBeNull();
  await act(async () => chip.click());
  expect(actions).toHaveBeenLastCalledWith({ type: 'stickerGroupMembership', id: request.id, groupId: group, member: false });
  publish({ state: { ...status.state, stickers: status.state.stickers.map(s => s.id === request.id ? { ...s, groups: [] } : s) } });
  chip = host.querySelector<HTMLButtonElement>('.sticker-detail-groups .chip')!;
  expect(chip.getAttribute('aria-pressed')).toBe('false');
  await click('Save', host.querySelector('.sticker-detail')!);
  expect(actions).toHaveBeenCalledWith({ type: 'sticker', id: request.id, searchTerms: 'AI terms', addGroups: [] });
});
test.each(['group', 'text', 'suggestion', 'session'] as const)('late Save acknowledgements preserve newer %s edits', async change => {
  await click('Edit stickers'); await act(async () => host.querySelector<HTMLButtonElement>('.sticker-art')!.click());
  const request = await propose();
  let acknowledge!: (ok: boolean) => void;
  actions.mockImplementation(async action => action.type === 'sticker' ? new Promise<boolean>(resolve => { acknowledge = resolve; }) : true);
  await click('Save', host.querySelector('.sticker-detail')!);
  expect(actions).toHaveBeenLastCalledWith({ type: 'sticker', id: request.id, searchTerms: 'AI terms', addGroups: [group] });
  if (change === 'group') await act(async () => host.querySelector<HTMLButtonElement>('.sticker-detail-groups .chip')!.click());
  if (change === 'text') await fill('newer text');
  if (change === 'suggestion') await propose('AI terms', []);
  if (change === 'session') { await click('Close', host.querySelector('.sticker-detail')!); await click('Keep editing'); }
  await act(async () => acknowledge(true));
  expect(host.querySelector('.sticker-detail')).not.toBeNull();
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(change === 'text' ? 'newer text' : 'AI terms');
  if (change === 'group' || change === 'suggestion') expect(host.querySelector('.sticker-detail-groups .chip')?.getAttribute('aria-pressed')).toBe('false');
  expect(host.querySelector('textarea')?.hasAttribute('data-suggested')).toBe(true);
});
test('editor error names the originating provider, announces it, and leaves focus on the suggestion control', async () => {
  await click('Edit stickers'); await act(async () => host.querySelector<HTMLButtonElement>('.sticker-art')!.click());
  const control = button('Suggest search terms'); act(() => control.focus());
  await click('Suggest search terms'); const request = actions.mock.calls.at(-1)![0];
  if (request.type !== 'suggestStickerTags') throw new Error('missing request');
  publish({ state: { ...status.state, provider: 'anthropic' }, stickerTags: { [request.id]: { state: 'failed', nonce: request.nonce, provider: 'openai', error: 'auth' } } });
  expect(host.querySelector('.sticker-detail .msg p')?.textContent).toBe('OpenAI key rejected.');
  expect(host.querySelector('.sticker-detail [aria-live="polite"]')?.textContent).toBe('OpenAI key rejected.');
  expect(document.activeElement).toBe(control); expect(host.querySelector('.tag-strip')).toBeNull();
  publish({ stickerTags: {} }); expect(host.querySelector('.sticker-detail [aria-live="polite"]')?.textContent).toBe('');
});
test('rate-limited batch strips and editor failures offer retry with accurate provider wording', async () => {
  await click('Edit stickers'); await act(async () => host.querySelector<HTMLButtonElement>('.sticker-art')!.click());
  const id = status.state.stickers[0].id;
  publish({ stickerTagging: { state: 'blocked', total: 1, completed: 0, tagged: 0, failed: 1, provider: 'openai', error: 'rate-limit' }, stickerTags: { [id]: { state: 'failed', provider: 'openai', error: 'rate-limit' } } });
  expect(host.querySelector('.tag-strip > span')?.textContent).toContain('Rate limited by OpenAI');
  expect(host.querySelector('.sticker-detail .msg p')?.textContent).toBe('Rate limited by OpenAI.');
  await click('Try again', host.querySelector('.tag-strip')!);
  expect(actions).toHaveBeenLastCalledWith({ type: 'retryStickerTags', excludedIds: [] });
});
test('automatic toggle reflects and serializes rapid pending On then Off clicks', async () => {
  const pending: ((ok: boolean) => void)[] = [];
  actions.mockImplementation(async () => new Promise<boolean>(resolve => pending.push(resolve)));
  const settings = () => root.render(<Settings status={{ ...status, panel: 'settings' }} act={actions} close={() => {}}/>);
  act(settings);
  const toggle = [...host.querySelectorAll<HTMLInputElement>('input')].find(i => i.closest('label')?.textContent?.includes('Tag new stickers automatically'))!;
  await act(async () => toggle.click()); expect(toggle.checked).toBe(true);
  await act(async () => toggle.click()); expect(toggle.checked).toBe(false);
  expect(actions).toHaveBeenCalledTimes(1);
  await act(async () => pending[0](true));
  expect(actions.mock.calls.map(([action]) => action)).toEqual([
    { type: 'preferences', scope: 'global', patch: { automaticStickerTags: true } },
    { type: 'preferences', scope: 'global', patch: { automaticStickerTags: false } }
  ]);
  act(() => { status = { ...status, state: { ...status.state, global: { ...status.state.global, automaticStickerTags: true } } }; settings(); });
  expect(toggle.checked).toBe(false); // Earlier publication cannot override the newer pending click.
  await act(async () => pending[1](true)); expect(toggle.checked).toBe(false);
  act(() => { status = { ...status, state: { ...status.state, global: { ...status.state.global, automaticStickerTags: false } } }; settings(); });
  expect(toggle.checked).toBe(false);
});
test('rejected automatic toggle updates recover the persisted value', async () => {
  actions.mockResolvedValue(false);
  act(() => root.render(<Settings status={{ ...status, panel: 'settings' }} act={actions} close={() => {}}/>));
  const toggle = [...host.querySelectorAll<HTMLInputElement>('input')].find(i => i.closest('label')?.textContent?.includes('Tag new stickers automatically'))!;
  await act(async () => toggle.click()); expect(toggle.checked).toBe(false);
});
test.each(['Cancel', 'Escape'] as const)('batch confirmation focuses Tag and restores a surviving control on %s', async exit => {
  publish({ state: { ...status.state, stickers: Array.from({ length: 21 }, (_, i) => ({ ...status.state.stickers[0], id: (i + 1).toString(16).padStart(64, '0') })) } });
  await click('Edit stickers');
  act(() => button('Tag 21 untagged').focus()); await click('Tag 21 untagged');
  expect(document.activeElement).toBe(button('Tag'));
  if (exit === 'Escape') escape(); else await click('Cancel');
  expect(document.activeElement).toBe(button('Tag 21 untagged'));
});
test('batch confirmation restores Select all when its original tagging control no longer exists', async () => {
  publish({ state: { ...status.state, stickers: Array.from({ length: 21 }, (_, i) => ({ ...status.state.stickers[0], id: (i + 1).toString(16).padStart(64, '0') })) } });
  await click('Edit stickers'); await click('Tag 21 untagged');
  publish({ state: { ...status.state, stickers: status.state.stickers.map(s => ({ ...s, searchTerms: 'saved' })) } });
  escape(); expect(document.activeElement).toBe(button('Select all'));
});
test('suggested groups expose the designed tooltip and accessible pending-Save description', async () => {
  await click('Edit stickers'); await act(async () => host.querySelector<HTMLButtonElement>('.sticker-art')!.click()); await propose();
  const chip = host.querySelector<HTMLButtonElement>('.sticker-detail-groups .chip')!;
  expect(chip.title).toBe('Suggested by AI · added on Save');
  const description = chip.getAttribute('aria-describedby'); expect(description).toBeTruthy();
  expect(document.getElementById(description!)?.textContent).toBe('Suggested by AI · added on Save');
  await act(async () => chip.click()); expect(chip.title).toBe(''); expect(chip.getAttribute('aria-describedby')).toBeNull();
});

test('a pending newer suggestion cannot be closed by an older Save acknowledgement', async () => {
  await click('Edit stickers'); await act(async () => host.querySelector<HTMLButtonElement>('.sticker-art')!.click()); await propose();
  let acknowledge!: (ok: boolean) => void;
  actions.mockImplementation(async action => action.type === 'sticker' ? new Promise<boolean>(resolve => { acknowledge = resolve; }) : true);
  await click('Save', host.querySelector('.sticker-detail')!); await click('Suggest search terms');
  const request = actions.mock.calls.at(-1)![0];
  if (request.type !== 'suggestStickerTags') throw new Error('missing request');
  await act(async () => acknowledge(true));
  expect(host.querySelector('.sticker-detail')).not.toBeNull(); expect(button('Stop suggestion')).toBeDefined();
  publish({ stickerTags: { [request.id]: { state: 'suggested', nonce: request.nonce, provider: 'openai', suggestion: { searchTerms: 'newer terms', groups: [] } } } });
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('newer terms');
});
test('bulk group edits invalidate an outstanding editor Save', async () => {
  await click('Edit stickers'); await act(async () => host.querySelector<HTMLButtonElement>('.sticker-art')!.click());
  const request = await propose();
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-sticker="${request.id}"] .sticker-pick`)!.click());
  let acknowledge!: (ok: boolean) => void;
  actions.mockImplementation(async action => action.type === 'sticker' ? new Promise<boolean>(resolve => { acknowledge = resolve; }) : true);
  await click('Save', host.querySelector('.sticker-detail')!);
  await click('Groups ▾'); await click('Favorites', host.querySelector('.sticker-groups-popover')!);
  expect(actions).toHaveBeenLastCalledWith({ type: 'bulkStickerGroupMembership', stickerIds: [request.id], groupId: group, member: true });
  await act(async () => acknowledge(true));
  expect(host.querySelector('.sticker-detail')).not.toBeNull();
});
test('Save may close after its own additions are published, but not after unrelated membership changes', async () => {
  await click('Edit stickers'); await act(async () => host.querySelector<HTMLButtonElement>('.sticker-art')!.click());
  const request = await propose();
  let acknowledge!: (ok: boolean) => void;
  actions.mockImplementation(async action => action.type === 'sticker' ? new Promise<boolean>(resolve => { acknowledge = resolve; }) : true);
  await click('Save', host.querySelector('.sticker-detail')!);
  const another = '550e8400-e29b-41d4-a716-446655440002';
  publish({ state: { ...status.state, stickerGroups: [...status.state.stickerGroups, { id: another, name: 'Another' }], stickers: status.state.stickers.map(s => s.id === request.id ? { ...s, groups: [group, another] } : s) } });
  await act(async () => acknowledge(true)); expect(host.querySelector('.sticker-detail')).not.toBeNull();
  // A new Save owns the current groups; its own expected publication can close it.
  await click('Save', host.querySelector('.sticker-detail')!);
  publish({ state: { ...status.state, stickers: status.state.stickers.map(s => s.id === request.id ? { ...s, searchTerms: 'AI terms' } : s) } });
  await act(async () => acknowledge(true)); expect(host.querySelector('.sticker-detail')).toBeNull();
});
test('rapid On Off On coalesces to the accepted in-flight value without a duplicate true request', async () => {
  let acknowledge!: (ok: boolean) => void;
  actions.mockImplementation(async () => new Promise<boolean>(resolve => { acknowledge = resolve; }));
  act(() => root.render(<Settings status={{ ...status, panel: 'settings' }} act={actions} close={() => {}}/>));
  const toggle = [...host.querySelectorAll<HTMLInputElement>('input')].find(i => i.closest('label')?.textContent?.includes('Tag new stickers automatically'))!;
  await act(async () => toggle.click()); await act(async () => toggle.click()); await act(async () => toggle.click());
  expect(toggle.checked).toBe(true); expect(actions).toHaveBeenCalledTimes(1);
  await act(async () => acknowledge(true)); expect(actions).toHaveBeenCalledTimes(1); expect(toggle.checked).toBe(true);
});
test('leaving settings preserves the queued Off click after an outstanding On request', async () => {
  const pending: ((ok: boolean) => void)[] = [];
  actions.mockImplementation(async () => new Promise<boolean>(resolve => pending.push(resolve)));
  act(() => root.render(<Settings status={{ ...status, panel: 'settings' }} act={actions} close={() => {}}/>));
  const toggle = [...host.querySelectorAll<HTMLInputElement>('input')].find(i => i.closest('label')?.textContent?.includes('Tag new stickers automatically'))!;
  await act(async () => toggle.click()); await act(async () => toggle.click());
  act(() => root.render(<div/>)); await act(async () => pending[0](true));
  expect(actions).toHaveBeenLastCalledWith({ type: 'preferences', scope: 'global', patch: { automaticStickerTags: false } });
  await act(async () => pending[1](true));
});

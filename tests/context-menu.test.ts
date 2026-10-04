import { EventEmitter } from 'node:events';
import type { BrowserWindow, ContextMenuParams, Menu, MenuItemConstructorOptions, WebContents } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { editContextMenuTemplate, installEditContextMenus } from '../src/main/context-menu';

const params = (overrides: Partial<Parameters<typeof editContextMenuTemplate>[0]> = {}): Parameters<typeof editContextMenuTemplate>[0] => ({
  isEditable: true, selectionText: '', misspelledWord: '', dictionarySuggestions: [], spellcheckEnabled: true,
  editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canUndo: false, canRedo: false, canDelete: false, canEditRichly: true },
  ...overrides
});
const actions = () => ({ cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn(), replaceMisspelling: vi.fn(), addToDictionary: vi.fn() });
const labels = (template: MenuItemConstructorOptions[]) => template.map(item => item.label ?? item.type);
const click = (item: MenuItemConstructorOptions) => (item.click as () => void)();
const editLabels = ['Cut', 'Copy', 'Paste', 'separator', 'Select all'];

describe('edit context menu template', () => {
  test.each(['', 'selected text'])('editable field with selection %j shows ordered native edit actions', selectionText => {
    const target = actions();
    const template = editContextMenuTemplate(params({ selectionText }), target, true);
    expect(labels(template)).toEqual(editLabels);
    for (const [index, method] of [[0, 'cut'], [1, 'copy'], [2, 'paste'], [4, 'selectAll']] as const) {
      expect(template[index].enabled).toBe(true);
      click(template[index]); expect(target[method]).toHaveBeenCalledExactlyOnceWith();
    }
  });

  test.each(Array.from({ length: 16 }, (_, mask) => mask))('each edit flag independently controls enabled state (mask %i)', mask => {
    const enabled = [0, 1, 2, 3].map(bit => Boolean(mask & (1 << bit)));
    const base = params();
    base.editFlags = { ...base.editFlags, canCut: enabled[0], canCopy: enabled[1], canPaste: enabled[2], canSelectAll: enabled[3] };
    const template = editContextMenuTemplate(base, actions(), true);
    expect(labels(template)).toEqual(editLabels);
    expect(template.filter(item => item.type !== 'separator').map(item => item.enabled)).toEqual(enabled);
  });

  test.each([true, false])('readonly selection offers only Copy with canCopy=%s', canCopy => {
    const target = actions(), base = params({ isEditable: false, selectionText: '  selected text \n', misspelledWord: 'wrong' });
    base.editFlags.canCopy = canCopy;
    const template = editContextMenuTemplate(base, target, true);
    expect(labels(template)).toEqual(['Copy']); expect(template[0].enabled).toBe(canCopy);
    if (canCopy) { click(template[0]); expect(target.copy).toHaveBeenCalledOnce(); }
  });

  test.each(['', ' \n\t '])('non-editable content without meaningful selection %j has no menu', selectionText => {
    expect(editContextMenuTemplate(params({ isEditable: false, selectionText, misspelledWord: 'wrong', dictionarySuggestions: ['right'] }), actions(), true)).toEqual([]);
  });

  test('spelling suggestions precede edit actions, are limited to five, and target the original word', () => {
    const target = actions();
    const suggestions = ['one', 'two', 'three', 'four', 'five', 'six'];
    const template = editContextMenuTemplate(params({ misspelledWord: 'wrng', dictionarySuggestions: suggestions }), target, true);
    expect(labels(template)).toEqual([...suggestions.slice(0, 5), 'Add to dictionary', 'separator', ...editLabels]);
    for (let i = 0; i < 5; i++) { click(template[i]); expect(target.replaceMisspelling).toHaveBeenNthCalledWith(i + 1, suggestions[i]); }
    click(template[5]); expect(target.addToDictionary).toHaveBeenCalledExactlyOnceWith('wrng');
    expect(suggestions).toHaveLength(6);
  });

  test('a misspelling without suggestions still offers Add to dictionary', () => {
    expect(labels(editContextMenuTemplate(params({ misspelledWord: 'wrng' }), actions(), true))).toEqual(['Add to dictionary', 'separator', ...editLabels]);
  });

  test('suggestions are absent without a misspelled word', () => {
    expect(labels(editContextMenuTemplate(params({ dictionarySuggestions: ['unused'] }), actions(), true))).toEqual(editLabels);
  });

  test.each([[false, true], [true, false], [false, false]])('spelling requires both active session (%s) and field spellcheck (%s)', (active, spellcheckEnabled) => {
    expect(labels(editContextMenuTemplate(params({ spellcheckEnabled, misspelledWord: 'wrng', dictionarySuggestions: ['right'] }), actions(), active))).toEqual(editLabels);
  });
});

function fakeContents() {
  return Object.assign(new EventEmitter(), {
    ...actions(), session: { isSpellCheckerEnabled: vi.fn(() => true), addWordToSpellCheckerDictionary: vi.fn() }
  });
}

describe('main-process context-menu wiring', () => {
  function setup() {
    const remote = fakeContents(), controls = fakeContents(), window = {} as BrowserWindow;
    const popup = vi.fn(), buildFromTemplate = vi.fn((_template: MenuItemConstructorOptions[]) => ({ popup }) as unknown as Menu);
    installEditContextMenus([remote, controls] as unknown as WebContents[], window, { buildFromTemplate });
    return { remote, controls, window, popup, buildFromTemplate };
  }

  test('both views register and popup uses the owning window; edits and spelling use the clicked view/session', () => {
    const { remote, controls, window, popup, buildFromTemplate } = setup();
    for (const target of [remote, controls]) {
      expect(target.listenerCount('context-menu')).toBe(1);
      const event = { preventDefault: vi.fn() };
      target.emit('context-menu', event, params({ misspelledWord: 'wrng', dictionarySuggestions: ['right'] }) as ContextMenuParams);
      expect(popup).toHaveBeenLastCalledWith({ window });
      const template = buildFromTemplate.mock.calls.at(-1)![0];
      for (const item of template.filter(item => item.type !== 'separator')) click(item);
      expect(target.replaceMisspelling).toHaveBeenCalledExactlyOnceWith('right');
      expect(target.session.addWordToSpellCheckerDictionary).toHaveBeenCalledExactlyOnceWith('wrng');
      for (const method of ['cut', 'copy', 'paste', 'selectAll'] as const) expect(target[method]).toHaveBeenCalledExactlyOnceWith();
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(buildFromTemplate).toHaveBeenCalledTimes(2); expect(popup).toHaveBeenCalledTimes(2);
  });

  test('no menu is built or popped for unselected non-editable links, images or page background', () => {
    const { remote, controls, popup, buildFromTemplate } = setup();
    for (const target of [remote, controls]) {
      for (const extra of [{}, { linkURL: 'https://example.com/' }, { mediaType: 'image', srcURL: 'https://example.com/image.png' }]) {
        target.emit('context-menu', {}, { ...params({ isEditable: false, selectionText: ' \n ' }), ...extra });
      }
    }
    expect(buildFromTemplate).not.toHaveBeenCalled(); expect(popup).not.toHaveBeenCalled();
  });

  test('readonly Copy targets the emitting view only', () => {
    const { remote, controls, buildFromTemplate } = setup();
    controls.emit('context-menu', {}, params({ isEditable: false, selectionText: 'selected' }));
    const template = buildFromTemplate.mock.calls[0][0];
    expect(labels(template)).toEqual(['Copy']); click(template[0]);
    expect(controls.copy).toHaveBeenCalledOnce(); expect(remote.copy).not.toHaveBeenCalled();
  });

  test('session spellcheck state is read on each event without changing configuration', () => {
    const { remote, buildFromTemplate } = setup();
    const base = params({ misspelledWord: 'wrng', dictionarySuggestions: ['right'] });
    remote.emit('context-menu', {}, base);
    expect(labels(buildFromTemplate.mock.calls[0][0])).toEqual(['right', 'Add to dictionary', 'separator', ...editLabels]);
    remote.session.isSpellCheckerEnabled.mockReturnValue(false);
    remote.emit('context-menu', {}, base);
    expect(labels(buildFromTemplate.mock.calls[1][0])).toEqual(editLabels);
    expect(remote.session.isSpellCheckerEnabled).toHaveBeenCalledTimes(2);
  });
});

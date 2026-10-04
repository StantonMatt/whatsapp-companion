import type { BrowserWindow, ContextMenuParams, Menu, MenuItemConstructorOptions, WebContents } from 'electron';

type EditContext = Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags' | 'misspelledWord' | 'dictionarySuggestions' | 'spellcheckEnabled'>;
type EditActions = Pick<WebContents, 'cut' | 'copy' | 'paste' | 'selectAll' | 'replaceMisspelling'> & {
  addToDictionary: (word: string) => void;
};

export function editContextMenuTemplate(params: EditContext, actions: EditActions, spellcheckerActive: boolean): MenuItemConstructorOptions[] {
  if (!params.isEditable) {
    return params.selectionText.trim() ? [{ label: 'Copy', enabled: params.editFlags.canCopy, click: () => actions.copy() }] : [];
  }
  const template: MenuItemConstructorOptions[] = [];
  if (spellcheckerActive && params.spellcheckEnabled && params.misspelledWord) {
    template.push(...params.dictionarySuggestions.slice(0, 5).map(suggestion => ({
      label: suggestion, click: () => actions.replaceMisspelling(suggestion)
    })), { label: 'Add to dictionary', click: () => actions.addToDictionary(params.misspelledWord) }, { type: 'separator' });
  }
  template.push(
    { label: 'Cut', enabled: params.editFlags.canCut, click: () => actions.cut() },
    { label: 'Copy', enabled: params.editFlags.canCopy, click: () => actions.copy() },
    { label: 'Paste', enabled: params.editFlags.canPaste, click: () => actions.paste() },
    { type: 'separator' },
    { label: 'Select all', enabled: params.editFlags.canSelectAll, click: () => actions.selectAll() }
  );
  return template;
}

export function installEditContextMenus(contents: WebContents[], window: BrowserWindow, menus: Pick<typeof Menu, 'buildFromTemplate'>): void {
  for (const webContents of contents) {
    // Chromium suppresses this event when the page prevents its DOM contextmenu
    // event, leaving WhatsApp's own message/chat menus in control.
    webContents.on('context-menu', (_event, params) => {
      const template = editContextMenuTemplate(params, {
        cut: () => webContents.cut(), copy: () => webContents.copy(),
        paste: () => webContents.paste(), selectAll: () => webContents.selectAll(),
        replaceMisspelling: word => webContents.replaceMisspelling(word),
        addToDictionary: word => { webContents.session.addWordToSpellCheckerDictionary(word); }
      }, webContents.session.isSpellCheckerEnabled());
      if (template.length) menus.buildFromTemplate(template).popup({ window });
    });
  }
}

import { stickerGroupIdSchema, stickerGroupNameSchema, type Action, type State, type Sticker } from '../shared/model';

export type StickerGroupAction = Extract<Action, { type: 'createStickerGroup' | 'renameStickerGroup' | 'deleteStickerGroup' | 'stickerGroupMembership' | 'bulkStickerGroupMembership' }>;

// Main calls this inside Store.update: validate the complete request before mutating.
export function applyStickerGroupAction(state: State, action: StickerGroupAction, newId: () => string) {
  const requireStickers = (ids: string[]) => {
    const wanted = new Set(ids), stickers = state.stickers.filter(s => wanted.has(s.id));
    if (stickers.length !== wanted.size) throw new Error('Sticker no longer indexed.');
    return stickers;
  };
  const requireName = (name: string, except?: string) => {
    const trimmed = stickerGroupNameSchema.parse(name);
    if (state.stickerGroups.some(g => g.id !== except && g.name.toLowerCase() === trimmed.toLowerCase())) throw new Error('A group with this name already exists.');
    return trimmed;
  };
  const setMembership = (stickers: Sticker[], groupId: string, member: boolean) => {
    for (const sticker of stickers) sticker.groups = member ? [...new Set([...sticker.groups, groupId])] : sticker.groups.filter(id => id !== groupId);
  };
  if (action.type === 'createStickerGroup') {
    if (state.stickerGroups.length >= 50) throw new Error('The sticker library can have up to 50 groups.');
    const name = requireName(action.name), stickers = requireStickers(action.stickerIds ?? []);
    const id = stickerGroupIdSchema.parse(newId());
    if (state.stickerGroups.some(g => g.id === id)) throw new Error('Group id already exists.');
    state.stickerGroups.push({ id, name });
    setMembership(stickers, id, true);
    return;
  }
  const id = 'groupId' in action ? action.groupId : action.id;
  const group = state.stickerGroups.find(g => g.id === id);
  if (!group) throw new Error('Group no longer exists.');
  switch (action.type) {
    case 'renameStickerGroup': group.name = requireName(action.name, id); break;
    case 'deleteStickerGroup':
      state.stickerGroups = state.stickerGroups.filter(g => g.id !== id);
      setMembership(state.stickers, id, false); break;
    case 'stickerGroupMembership': setMembership(requireStickers([action.id]), id, action.member); break;
    case 'bulkStickerGroupMembership': setMembership(requireStickers(action.stickerIds), id, action.member); break;
  }
}

export function groupSelectionState(stickers: Sticker[], groupId: string): boolean | 'mixed' {
  const members = stickers.filter(s => s.groups.includes(groupId)).length;
  return members === 0 ? false : members === stickers.length ? true : 'mixed';
}

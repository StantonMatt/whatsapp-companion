import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { State, Sticker, StickerGroup } from '../shared/model';
import type { Act } from './index';
import { EditIcon } from './icons';

type GroupForm = { type: 'new'; name: string; stickerIds: string[] } | { type: 'rename' | 'delete'; id: string; name: string };
const Check = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" d="m5.5 12.5 4.2 4.2 8.8-9.2"/></svg>;
const updateChipFades = (row: HTMLElement) => {
  row.toggleAttribute('data-fade-start', row.scrollLeft > 1);
  row.toggleAttribute('data-fade-end', row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
};

export function useStickerGroups(state: State, act: Act, editMode: boolean) {
  const groups = state.stickerGroups;
  const [filter, setFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState(() => new Set<string>());
  const [popover, setPopover] = useState(false);
  const [form, setForm] = useState<GroupForm | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const session = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const chips = useRef<HTMLDivElement | null>(null);
  const chipRow = useCallback((row: HTMLDivElement | null) => {
    chips.current = row;
    if (!row) return;
    const measure = () => updateChipFades(row);
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const max = Math.max(0, row.scrollWidth - row.clientWidth);
      const next = Math.max(0, Math.min(max, row.scrollLeft + event.deltaY));
      if (next === row.scrollLeft) return;
      event.preventDefault(); row.scrollLeft = next; measure();
    };
    row.addEventListener('wheel', wheel, { passive: false });
    row.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(row);
    measure();
    return () => {
      row.removeEventListener('wheel', wheel);
      row.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
      chips.current = null;
    };
  }, []);
  // Chip contents can change without resizing the row itself.
  useLayoutEffect(() => { if (chips.current) updateChipFades(chips.current); }, [groups, editMode, filter, form?.type]);
  const stickerIds = useMemo(() => new Set(state.stickers.map(sticker => sticker.id)), [state.stickers]);
  const selectedStickers = useMemo(() => state.stickers.filter(sticker => selected.has(sticker.id)), [state.stickers, selected]);
  const membership = useMemo(() => {
    const counts = new Map<string, number>();
    for (const sticker of selectedStickers) for (const id of sticker.groups) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }, [selectedStickers]);
  const activeFilter = groups.some(g => g.id === filter) ? filter : null;
  useEffect(() => {
    if (filter && !groups.some(g => g.id === filter)) setFilter(null);
    if (form && form.type !== 'new' && !groups.some(g => g.id === form.id)) { session.current++; setForm(null); }
    setSelected(previous => {
      const next = new Set([...previous].filter(id => stickerIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [groups, stickerIds]);
  useEffect(() => { if (!selectedStickers.length) setPopover(false); }, [selectedStickers.length]);
  useEffect(() => {
    const group = created && groups.find(g => g.name === created);
    if (group) { setFilter(group.id); setCreated(null); setForm(null); }
  }, [created, groups]);
  useEffect(() => {
    if (form) { input.current?.focus(); input.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
  }, [form?.type, form && 'id' in form ? form.id : null]);
  useEffect(() => {
    if (!popover) return;
    popup.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !trigger.current?.contains(event.target)) setPopover(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [popover]);
  const cancelForm = () => { session.current++; setCreated(null); setForm(null); setSubmitting(false); };
  const clear = () => { setSelected(new Set()); setPopover(false); };
  const reset = () => { clear(); cancelForm(); };
  const toggleSelection = (id: string) => setSelected(previous => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const newGroup = (assign = false) => {
    session.current++; setCreated(null); setSubmitting(false); setPopover(false);
    setForm({ type: 'new', name: '', stickerIds: assign ? selectedStickers.map(s => s.id) : [] });
  };
  const choose = (group: StickerGroup | null) => {
    cancelForm();
    if (group && activeFilter === group.id && editMode) setForm({ type: 'rename', id: group.id, name: group.name });
    else setFilter(group?.id ?? null);
  };
  const submit = async () => {
    if (!form || submitting) return;
    const request = session.current, submitted = form;
    if (submitted.type !== 'delete' && (!submitted.name.trim() || submitted.name.trim().length > 40 || groups.some(g => (submitted.type === 'new' || g.id !== submitted.id) && g.name.toLowerCase() === submitted.name.trim().toLowerCase()))) return;
    setSubmitting(true);
    const ok = await act(submitted.type === 'new'
      ? { type: 'createStickerGroup', name: submitted.name.trim(), stickerIds: submitted.stickerIds }
      : submitted.type === 'rename' ? { type: 'renameStickerGroup', id: submitted.id, name: submitted.name.trim() }
      : { type: 'deleteStickerGroup', id: submitted.id });
    if (session.current !== request) return;
    setSubmitting(false);
    if (!ok) return;
    if (submitted.type === 'new') setCreated(submitted.name.trim());
    else { setForm(null); if (submitted.type === 'delete') setFilter(null); }
  };
  const deleteCount = form?.type === 'delete' ? state.stickers.filter(s => s.groups.includes(form.id)).length : 0;
  const header = (groups.length > 0 || editMode) && <>
    <div ref={chipRow} className="sticker-group-chips" role="group" aria-label="Group">
      <button className="chip" aria-pressed={!activeFilter} onClick={() => choose(null)}>All</button>
      {groups.map(group => <button key={group.id} className="chip" aria-pressed={activeFilter === group.id} aria-label={editMode && activeFilter === group.id ? `${group.name}, edit group` : group.name} onClick={() => choose(group)}>
        <span className="chip-name">{group.name}</span>{editMode && activeFilter === group.id && <EditIcon/>}
      </button>)}
      {editMode && (form?.type === 'new'
        ? <input ref={input} className="chip-input" aria-label="New group name" placeholder="Group name" maxLength={40} value={form.name} disabled={submitting} onChange={e => setForm({ ...form, name: e.target.value })} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}/>
        : <button className="chip add" onClick={() => newGroup()}>+ New group</button>)}
    </div>
    {editMode && form && form.type !== 'new' && <div className="sticker-group-edit" role="group" aria-label={form.type === 'delete' ? 'Delete group?' : 'Edit group'}>
      {form.type === 'delete' ? <>
        <span>Delete “{form.name}”?{deleteCount === 0 ? '' : deleteCount === 1 ? ' Its sticker stays in the library.' : ` Its ${deleteCount} stickers stay in the library.`}</span>
        <button className="primary" disabled={submitting} onClick={() => void submit()}>Delete</button><button className="quiet" disabled={submitting} onClick={cancelForm}>Keep</button>
      </> : <>
        <input ref={input} aria-label="Group name" maxLength={40} value={form.name} disabled={submitting} onChange={e => setForm({ ...form, name: e.target.value })} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}/>
        <button className="primary" disabled={submitting} onClick={() => void submit()}>Save</button><button className="quiet" disabled={submitting} onClick={() => setForm({ ...form, type: 'delete', name: groups.find(g => g.id === form.id)!.name })}>Delete</button><button className="icon-close" aria-label="Close group editor" onClick={cancelForm}>×</button>
      </>}
    </div>}
  </>;
  const bar = (visible: Sticker[]) => editMode && <div className="sticker-select-bar">
    {selectedStickers.length ? <>
      <span>{selectedStickers.length} selected</span><button className="quiet" onClick={clear}>Clear</button>
      <button ref={trigger} aria-expanded={popover} onClick={() => setPopover(!popover)}>Groups ▾</button>
    </> : <button className="link" disabled={!visible.length} onClick={() => setSelected(new Set(visible.map(s => s.id)))}>Select all</button>}
    {popover && selectedStickers.length > 0 && <div ref={popup} className="sticker-groups-popover" role="group" aria-label={`Groups for ${selectedStickers.length} stickers`}>
      {groups.map(group => {
        const count = membership.get(group.id) ?? 0;
        const checked = count === 0 ? false : count === selectedStickers.length ? true : 'mixed';
        return <button key={group.id} className="pop-row" role="checkbox" aria-checked={checked} onClick={() => void act({ type: 'bulkStickerGroupMembership', stickerIds: selectedStickers.map(s => s.id), groupId: group.id, member: checked !== true })}>
          <span className="box" aria-hidden="true">{checked === true ? <Check/> : checked === 'mixed' ? <span className="dash"/> : null}</span>{group.name}
        </button>;
      })}
      <button className="pop-row new" onClick={() => newGroup(true)}>New group…</button>
    </div>}
  </div>;
  return { filter: activeFilter, selected, header, bar, toggleSelection, reset, showAll: () => choose(null),
    closePopover: () => { if (!popover) return false; setPopover(false); trigger.current?.focus(); return true; },
    cancelInline: () => { if (!form) return false; cancelForm(); return true; },
    clearSelection: () => { if (!selectedStickers.length) return false; clear(); return true; }
  };
}

export function StickerGroupToggles({ groups, sticker, act }: { groups: StickerGroup[]; sticker: Sticker; act: Act }) {
  return groups.length > 0 && <div className="sticker-detail-groups" role="group" aria-label="Sticker groups"><span>Groups</span>
    {groups.map(group => <button key={group.id} className="chip" aria-pressed={sticker.groups.includes(group.id)} onClick={() => void act({ type: 'stickerGroupMembership', id: sticker.id, groupId: group.id, member: !sticker.groups.includes(group.id) })}>{group.name}</button>)}
  </div>;
}

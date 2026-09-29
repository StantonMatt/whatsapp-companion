import React, { useEffect, useRef, useState } from 'react';
import type { Status, Sticker } from '../shared/model';
import { searchStickers } from '../core/stickers';
import { STICKER_DRAG_TYPE, STICKER_DRAG_PREFIX } from '../shared/sticker-transfer';
import type { Act } from './index';

const locationMessages = {
  looking: 'Looking in WhatsApp…',
  found: 'Highlighted in WhatsApp. Nothing was sent.',
  missing: 'This sticker isn’t loaded in WhatsApp. Open a chat and its sticker picker, select Favorites, then wait for it to load and try again.',
  unavailable: 'WhatsApp did not respond. Wait for it to finish loading, then try again.'
};

export function Stickers({ status, act }: { status: Status; act: Act }) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const stickers = searchStickers(status.state.stickers, query);
  const selected = status.state.stickers.find(s => s.id === editing);
  const preview = status.stickerPreview;
  const previewSticker = status.state.stickers.find(s => s.id === preview?.id);
  const drag = (event: React.DragEvent, id: string) => {
    if (!event.nativeEvent.isTrusted || !status.chat.ready || preview) { event.preventDefault(); return; }
    const nonce = crypto.randomUUID();
    event.dataTransfer.clearData(); event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(STICKER_DRAG_TYPE, nonce);
    event.dataTransfer.setData('text/plain', STICKER_DRAG_PREFIX + nonce);
    void act({ type: 'beginStickerDrag', id, nonce });
  };
  return <>
    {preview && previewSticker && <StickerPreview key={preview.nonce} sticker={previewSticker} preview={preview} act={act}/>}
    <input className="search" aria-label="Search stickers" placeholder="Search stickers" value={query} onChange={e => setQuery(e.target.value)}/>
    <p className="hint">{status.state.stickers.length} stickers indexed</p>
    {!stickers.length && <div className="empty"><span aria-hidden="true">▧</span><p>{query ? 'No matching stickers' : 'Your stickers will appear here'}</p><small>{query ? 'Try another word or phrase.' : 'Open WhatsApp’s sticker picker and select Favorites. Wait for your stickers to load.'}</small></div>}
    {selected && <StickerEditor key={selected.id} sticker={selected} location={status.stickerLocation} act={act} close={() => setEditing(null)}/>}
    <div className="sticker-grid">{stickers.map(sticker => <button className="sticker" key={sticker.id} draggable={status.chat.ready && !preview} onDragStart={e => drag(e, sticker.id)} title={status.chat.ready ? "Drag into the chat to preview" : "Open a chat to drag a sticker"} onClick={() => setEditing(sticker.id)} onContextMenu={e => { e.preventDefault(); setEditing(sticker.id); }} aria-label={`Edit sticker ${sticker.searchTerms.slice(0, 120) || sticker.id.slice(0, 6)}`}><img draggable={false} src={sticker.image} alt={sticker.searchTerms.slice(0, 120) || 'Indexed sticker'}/><span>{sticker.searchTerms || 'Add search terms'}</span></button>)}</div>
  </>;
}
function StickerEditor({ sticker, location, act, close }: { sticker: Sticker; location: Status['stickerLocation']; act: Act; close: () => void }) {
  const [searchTerms, setSearchTerms] = useState(sticker.searchTerms);
  const result = location?.id === sticker.id ? location.state : null;
  return <div className="card sticker-editor"><div className="panel-title"><img draggable={false} src={sticker.image} alt="Selected sticker"/><button onClick={close} aria-label="Close search terms editor">×</button></div>
    <label>Search terms<textarea aria-label="Search terms" value={searchTerms} maxLength={4000} rows={5} onChange={e => setSearchTerms(e.target.value)} placeholder="happy, feliz, good morning, buenos días"/></label>
    <div className="actions"><button onClick={async () => { if (await act({ type: 'sticker', id: sticker.id, searchTerms })) close(); }}>Save</button><button onClick={() => void act({ type: 'locateSticker', id: sticker.id })}>Locate in WhatsApp</button><button className="quiet" onClick={async () => { if (await act({ type: 'forgetSticker', id: sticker.id })) close(); }}>Forget</button></div>
    {result && <p className="sticker-location" role="status">{locationMessages[result]}</p>}
  </div>;
}

function StickerPreview({ sticker, preview, act }: { sticker: Sticker; preview: NonNullable<Status['stickerPreview']>; act: Act }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  const cancel = () => { void act({ type: 'cancelSticker' }); };
  return <dialog ref={dialog} className="sticker-preview" aria-labelledby="sticker-preview-title" onCancel={event => { event.preventDefault(); cancel(); }}>
    <h2 id="sticker-preview-title">Send to {preview.name}</h2>
    <img src={sticker.image} alt="Sticker preview" draggable={false}/>
    {preview.state !== 'ready' && <p role="status">{preview.state === 'finding' ? 'Finding the original sticker in WhatsApp…' : preview.state === 'sending' ? 'Sending sticker…' : preview.state === 'missing' ? 'This sticker isn’t available in the open pack, Favorites or Recent stickers. Open its pack in WhatsApp, then drag it again.' : 'Couldn’t confirm sending. Check this chat before trying again.'}</p>}
    <div className="actions"><button autoFocus onClick={cancel}>Cancel</button><button className="primary" disabled={preview.state !== 'ready'} onClick={event => { if (event.nativeEvent.isTrusted) void act({ type: 'sendSticker', nonce: preview.nonce }); }}>Send sticker</button></div>
  </dialog>;
}

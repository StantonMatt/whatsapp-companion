import { stickerURL } from '../shared/sticker-url';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Status, StickerShield, ViewBounds } from '../shared/model';

type Drawn = { shield: StickerShield; art?: string };
const CAP_MS = 10_000, FADE_MS = 150, RESTORE_CAP_MS = 1000;

/** Keeps the panel in place while the controls view expands rightward over the chat, leaving WhatsApp's rail exposed. */
export function useShield(status: Status | undefined) {
  const live: StickerShield | null = status?.stickerShield ?? null;
  // Start lifting a stuck shield at the cap, independently of send completion.
  const [expired, setExpired] = useState<string | null>(null);
  useEffect(() => {
    if (!live) return;
    const timer = setTimeout(() => setExpired(live.nonce), CAP_MS); return () => clearTimeout(timer);
  }, [live?.nonce]);
  const shield = live && live.nonce !== expired ? live : null;

  const send = status?.stickerSend;
  const art = shield && send?.nonce === shield.nonce && status?.state.stickers.some(s => s.id === send.id) ? stickerURL(send.id) : undefined;
  const last = useRef<Drawn | null>(null);
  if (shield) last.current = { shield, art: art ?? (last.current?.shield.nonce === shield.nonce ? last.current.art : undefined) };
  // Opacity may finish before the native resize. Keep the inert layer mounted
  // until the view shrinks so the enlarged transparent view always has a shield.
  const [released, setReleased] = useState<string | null>(null);
  const retiring = !shield && last.current && last.current.shield.nonce !== released ? last.current : null;
  const expanded = Boolean(retiring && innerWidth > retiring.shield.panel.width + 1);
  const leaving = expanded ? retiring : null;
  useEffect(() => {
    if (!retiring) return;
    const nonce = retiring.shield.nonce;
    if (!expanded) { setReleased(nonce); return; }
    const fade = setTimeout(() => { void window.companion.shieldFaded(nonce).catch(() => {}); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : FADE_MS);
    // Main has a shorter restore bound; this also releases a layer if resize
    // delivery is lost, without keeping the renderer stuck indefinitely.
    const cap = setTimeout(() => setReleased(nonce), RESTORE_CAP_MS);
    return () => { clearTimeout(fade); clearTimeout(cap); };
  }, [retiring?.shield.nonce, expanded]);

  // CSS resolves against the live viewport during native resizing, without
  // waiting for a resize event/React commit in either direction.
  const frameRef = useRef<ViewBounds | null>(null);
  const [, resized] = useState(0);
  useEffect(() => {
    const resize = () => resized(value => value + 1);
    addEventListener('resize', resize); return () => removeEventListener('resize', resize);
  }, []);
  if (status?.panel !== 'stickers' || (!shield && !leaving && frameRef.current && innerWidth <= frameRef.current.width + 1)) frameRef.current = null;
  if (shield) frameRef.current = shield.panel;
  const frame = frameRef.current;
  useLayoutEffect(() => {
    if (!shield) return;
    // The shield is mounted (clipped outside the narrow view) before main may
    // enlarge it. The next animation frame gives Chromium a drawing opportunity.
    const request = requestAnimationFrame(() => { void window.companion.shieldReady(shield.nonce, matchMedia('(prefers-reduced-motion: reduce)').matches).catch(() => {}); });
    return () => cancelAnimationFrame(request);
  }, [shield?.nonce]);

  const drawn = shield ? last.current : leaving;
  return {
    frame: frame ? { '--panel-width': `${frame.width}px` } as React.CSSProperties : undefined,
    layer: drawn ? <Shield key={drawn.shield.nonce} {...drawn} leaving={!shield}/> : null
  };
}

function Shield({ shield, art, leaving }: Drawn & { leaving: boolean }) {
  const { x, y, width, height } = shield.bounds;
  // Inert: it only swallows pointer input over WhatsApp. Escape is handled by the panel.
  return <div className="shield" aria-hidden="true" data-preserve-auto="" data-leaving={leaving ? '' : undefined} style={{ left: x - shield.panel.x, top: y, width, height }}
    onMouseDown={e => e.preventDefault()} onContextMenu={e => e.preventDefault()}>
    <img src={shield.image} alt="" draggable={false}/>
    <div>{art && <img src={art} alt="" draggable={false}/>}<span className="spinner"/></div>
  </div>;
}

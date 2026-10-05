import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopAPI, Status, StatusUpdate, Action, Panel } from '../shared/model';
import { StatusCache } from '../core/status';
import { Settings } from './settings';
import { Stickers } from './stickers';
import { useShield } from './shield';
import './style.css';

declare global { interface Window { companion: DesktopAPI } }
export type Act = (action: Action) => Promise<boolean>;
function App() {
  const [status, setStatus] = useState<Status>();
  const panel = status?.panel ?? null;
  const [error, setError] = useState('');
  useEffect(() => {
    const cache = new StatusCache();
    const receive = (update: StatusUpdate) => { const next = cache.accept(update); if (next) setStatus(next); };
    const unsubscribe = window.companion.subscribe(receive);
    void window.companion.status().then(receive).catch(() => setError('Unable to connect to the desktop process. Restart the app.'));
    const activity = (event: Event) => {
      if (!event.isTrusted) return;
      const key = event instanceof KeyboardEvent ? event.key : null;
      if (key && ['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return;
      if (key === 'Escape' && !document.querySelector('select:open, dialog[open]')) return;
      const preserves = event.target instanceof Element && event.target.closest('[data-preserve-auto]');
      // Explicit permission controls and closing the panel must not immediately undo Resume.
      if (preserves && (event.type === 'pointerdown' || (event.type === 'keydown' && (key === 'Enter' || key === ' ')))) return;
      void window.companion.action({ type: 'cancelAuto' }).catch(() => {});
    };
    for (const name of ['pointerdown', 'keydown', 'beforeinput', 'wheel']) document.addEventListener(name, activity, { capture: true, passive: true });
    return () => {
      unsubscribe();
      for (const name of ['pointerdown', 'keydown', 'beforeinput', 'wheel']) document.removeEventListener(name, activity, true);
    };
  }, []);
  const act: Act = useCallback(async action => {
    try { const result = await window.companion.action(action); setError(result.error ?? ''); return result.ok; }
    catch { setError('The desktop operation failed. Try again.'); return false; }
  }, []);
  const stickerNavigation = useRef<((panel: Panel) => void) | null>(null);
  const navigate = useCallback((panel: Panel) => {
    if (stickerNavigation.current) stickerNavigation.current(panel);
    else void act({ type: 'panel', panel });
  }, [act]);
  const close = () => navigate(null);
  useEffect(() => window.companion.subscribePanelNavigation?.(navigate), [navigate]);
  useEffect(() => { document.documentElement.dataset.theme = status?.theme ?? 'dark'; }, [status?.theme]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      // Escape belongs to an open native picker before it belongs to the panel.
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('select:open, dialog[open]')) close();
    };
    document.addEventListener('keydown', escape); return () => document.removeEventListener('keydown', escape);
  }, [navigate]);
  const shield = useShield(status);
  return <>
    <div className="app-frame" data-enlarged={shield.frame ? '' : undefined} style={shield.frame}>
      <div data-testid="assistant-status" className={panel && panel !== 'stickers' ? 'connection-status' : 'sr-only'} role="status">{status?.message === 'Thinking…' ? '' : status?.message ?? 'Starting…'}</div>
      {error && panel && <div className="error-banner" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {panel && status && <aside className="panel" aria-label={panel === 'stickers' ? 'Sticker library' : panel === 'chat' ? 'Chat AI settings' : 'AI settings'}>
        {status.pending && panel !== 'stickers' && <div className="pending"><b>Scheduled reply</b><p>{status.pending.text}</p><p>After {new Date(status.pending.due).toLocaleTimeString()}</p><button onClick={() => void act({ type: 'cancelAuto' })}>Cancel and pause</button></div>}
        {panel === 'stickers' ? <Stickers status={status} act={act} navigation={stickerNavigation}/> : <Settings key={`${panel}-${panel === 'chat' ? status.chat.settingsId : 'global'}`} status={status} act={act} close={close}/>}
      </aside>}
    </div>
    {shield.layer}
  </>;
}
createRoot(document.getElementById('root')!).render(<App/>);

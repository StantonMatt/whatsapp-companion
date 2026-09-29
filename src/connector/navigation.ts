import type { Panel } from '../shared/model';
import type { RemoteEvent } from '../shared/connector';

const icons = {
  settings: '<path d="m9 3-.6 2.2-2 .9-2-.6-2 3.5 1.5 1.6v2.3L2.4 15l2 3.5 2-.6 2 .9L9 21h4l.6-2.2 2-.9 2 .6 2-3.5-1.5-1.6v-2.3l1.5-1.6-2-3.5-2 .6-2-.9L13 3z"/><circle cx="11" cy="12" r="3"/>',
  stickers: '<path d="M20 13V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h7zm-7 7v-4a3 3 0 0 1 3-3h4"/><path d="M7 8h.01M13 8h.01M7 12q3 3 6 0"/>',
  chat: '<path d="M4 5h16M4 12h16M4 19h16"/><circle cx="9" cy="5" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="19" r="2"/>'
};
const css = `:host{--ink:#a6aaaa;--hover:#ffffff12;--active:#103b2b;--green:#21c063}*{box-sizing:border-box}button{width:40px;height:40px;padding:9px;border:0;border-radius:50%;display:grid;place-items:center;background:transparent;color:var(--ink);cursor:pointer}button:hover{background:var(--hover)}button:focus-visible{outline:2px solid var(--green);outline-offset:2px}button[aria-pressed=true]{background:var(--active);color:var(--green)}svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.65;stroke-linecap:round;stroke-linejoin:round}.rail{position:fixed;pointer-events:auto}.cancel{position:fixed;pointer-events:auto;width:auto;height:30px;padding:5px 12px;border-radius:16px;background:#492f20;color:#ffe2b6;font:12px system-ui}[hidden]{display:none!important}`;

// Navigation events only. No settings, credentials, or send permission enter the remote page.
export class Navigation {
  theme: 'dark' | 'light' = 'dark';
  readonly host: HTMLElement;
  readonly chatHost: HTMLElement;
  private buttons: Record<'settings' | 'stickers' | 'chat', HTMLButtonElement>;
  private cancel: HTMLButtonElement;
  private lastGeometry = '';
  constructor(private doc: Document, private emit: (event: RemoteEvent) => void) {
    this.host = doc.createElement('div'); this.host.id = 'companion-navigation';
    this.host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483645';
    this.chatHost = doc.createElement('div'); this.chatHost.id = 'companion-chat-settings';
    this.chatHost.style.cssText = 'flex:0 0 40px;width:40px;height:40px;margin-inline:8px;align-self:center';
    const railRoot = this.host.attachShadow({ mode: 'closed' });
    const chatRoot = this.chatHost.attachShadow({ mode: 'closed' });
    for (const root of [railRoot, chatRoot]) { const style = doc.createElement('style'); style.textContent = css; root.append(style); }
    const button = (key: keyof typeof icons, label: string) => {
      const b = doc.createElement('button'); b.title = label; b.setAttribute('aria-label', label); b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[key]}</svg>`;
      b.addEventListener('click', e => { if (e.isTrusted) { e.stopPropagation(); this.emit({ type: 'navigate', panel: key }); } });
      (key === 'chat' ? chatRoot : railRoot).append(b); if (key !== 'chat') b.className = 'rail'; return b;
    };
    this.buttons = { settings: button('settings', 'AI settings'), stickers: button('stickers', 'Sticker library'), chat: button('chat', 'Chat AI settings') };
    this.cancel = doc.createElement('button'); this.cancel.className = 'cancel'; this.cancel.textContent = 'Cancel automatic reply'; this.cancel.hidden = true;
    this.cancel.addEventListener('click', e => { if (e.isTrusted) this.emit({ type: 'cancelAuto' }); }); railRoot.append(this.cancel);
    doc.documentElement.append(this.host);
    doc.addEventListener('pointerdown', this.nativeNavigation, true);
  }
  private nativeNavigation = (event: Event) => {
    if (event.isTrusted && event.target instanceof Element && event.target.closest('[data-navbar-item]')) this.emit({ type: 'navigate', panel: null });
  };
  update(panel: Panel, pending: boolean) {
    for (const [key, b] of Object.entries(this.buttons)) b.setAttribute('aria-pressed', String(key === panel));
    this.cancel.hidden = !pending;
  }
  refresh(ready: boolean) {
    const items = [...this.doc.querySelectorAll<HTMLElement>('[data-navbar-item]')].filter(e => e.getBoundingClientRect().width > 0);
    const top = items[0]?.getBoundingClientRect();
    const bottom = items.filter(e => e.getBoundingClientRect().top > this.doc.documentElement.clientHeight / 2)[0]?.getBoundingClientRect();
    const side = this.doc.querySelector('#pane-side')?.getBoundingClientRect();
    const header = this.doc.querySelector<HTMLElement>('#main header');
    if (header && ready) {
      if (this.chatHost.parentElement !== header) header.insertBefore(this.chatHost, header.lastElementChild);
    } else this.chatHost.remove();
    const darkColor = getComputedStyle(header ?? this.doc.body).backgroundColor.match(/[\d.]+/g)?.map(Number);
    const dark = !darkColor || (darkColor[3] === 0) || darkColor.slice(0, 3).reduce((a, b) => a + b, 0) < 380;
    this.theme = dark ? 'dark' : 'light';
    for (const host of [this.host, this.chatHost]) {
      host.style.setProperty('--ink', dark ? '#a6aaaa' : '#54656f');
      host.style.setProperty('--hover', dark ? '#ffffff12' : '#0000000d');
      host.style.setProperty('--active', dark ? '#103b2b' : '#d9fdd3');
    }
    const rail = Math.round(side?.left && side.left <= 100 ? side.left : top ? top.right + top.left : 64);
    const listWidth = Math.round(side?.width ?? 430);
    const y = bottom ? bottom.top - 88 : this.doc.documentElement.clientHeight - 156;
    for (const [key, offset] of [['stickers', 0], ['settings', 44]] as const) {
      const b = this.buttons[key]; b.hidden = !top;
      b.style.left = `${top?.left ?? 12}px`; b.style.top = `${y + offset}px`;
    }
    const editor = this.doc.querySelector('#main footer')?.getBoundingClientRect();
    this.cancel.style.right = '20px'; this.cancel.style.top = `${Math.max(0, (editor?.top ?? 70) - 34)}px`;
    const geometry = JSON.stringify([rail, listWidth, dark]);
    if (geometry !== this.lastGeometry) { this.lastGeometry = geometry; this.emit({ type: 'chrome', rail, listWidth, theme: dark ? 'dark' : 'light' }); }
  }
  contains(event: Event) { return event.composedPath().includes(this.host) || event.composedPath().includes(this.chatHost); }
  stop() { this.doc.removeEventListener('pointerdown', this.nativeNavigation, true); this.host.remove(); this.chatHost.remove(); }
}

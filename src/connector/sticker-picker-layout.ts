export type PanelBounds = { left: number; right: number };

// The native picker is portalled outside #main and can straddle the chat list.
// A DOM z-index cannot raise it above our separate native WebContentsView.
export class StickerPickerLayout {
  private bounds: PanelBounds | null = null;
  private side: 'left' | 'right' = 'left';
  private adjusted?: { element: HTMLElement; shift: number; maxWidth: string; properties: Map<string, { value: string; priority: string; applied: string }> };
  constructor(private doc: Document) {}
  update(bounds: PanelBounds | null, side: 'left' | 'right') { this.bounds = bounds; this.side = side; this.refresh(); }
  private restore() {
    if (!this.adjusted) return;
    const { element, properties } = this.adjusted;
    for (const [key, saved] of properties) {
      if (element.style.getPropertyValue(key) !== saved.applied) continue;
      if (saved.value) element.style.setProperty(key, saved.value, saved.priority);
      else element.style.removeProperty(key);
    }
    this.adjusted = undefined;
  }
  refresh() {
    const panel = this.doc.querySelector<HTMLElement>('[data-testid="expressions-panel"]');
    const main = this.doc.querySelector('#main')?.getBoundingClientRect();
    let element = panel;
    // Current WhatsApp has a positioned, animated wrapper inside this portal.
    const portal = panel?.closest('#expressions-panel-container');
    if (portal) while (element && element !== portal && !['absolute', 'fixed'].includes(getComputedStyle(element).position)) element = element.parentElement;
    if (!this.bounds || !main?.width || !element || element === portal || !['absolute', 'fixed'].includes(getComputedStyle(element).position)) { this.restore(); return; }
    if (element !== this.adjusted?.element) { this.restore(); this.adjusted = { element, shift: 0, maxWidth: getComputedStyle(element).maxWidth, properties: new Map() }; }
    const adjusted = this.adjusted!;
    const set = (key: string, value: string) => {
      let saved = adjusted.properties.get(key);
      if (!saved || element.style.getPropertyValue(key) !== saved.applied) {
        saved = { value: element.style.getPropertyValue(key), priority: element.style.getPropertyPriority(key), applied: '' };
        adjusted.properties.set(key, saved);
      }
      if (element.style.getPropertyValue(key) !== value) element.style.setProperty(key, value, 'important');
      saved.applied = element.style.getPropertyValue(key);
    };
    const onLeft = this.side === 'left';
    let left = Math.max(0, main.left, onLeft ? this.bounds.right : 0) + 8;
    const right = Math.min(this.doc.documentElement.clientWidth, main.right, onLeft ? Infinity : this.bounds.left) - 8;
    // Right-hand settings can cover almost the entire chat at the minimum window
    // width. Its chat list is uncovered, so use that space instead of crushing the
    // native picker into a sliver. Keep the navigation rail accessible.
    if (!onLeft && right - left < 320) left = Math.max(0, Math.min(100, this.doc.querySelector('#pane-side')?.getBoundingClientRect().left ?? 0)) + 8;
    if (right <= left) { this.restore(); return; }
    set('max-width', adjusted.maxWidth && adjusted.maxWidth !== 'none' ? `min(${adjusted.maxWidth}, ${right - left}px)` : `${right - left}px`);
    // Keep WhatsApp's scale animation/position intact; translate only the overflow.
    const previousShift = element.style.getPropertyValue('translate') === adjusted.properties.get('translate')?.applied ? adjusted.shift : 0;
    const rect = element.getBoundingClientRect(), width = element.offsetWidth;
    const origin = parseFloat(getComputedStyle(element).transformOrigin) || 0;
    // Clamp the full-size popup, not an intermediate scale-animation frame.
    const naturalLeft = rect.left - previousShift - (width ? (width - rect.width) * origin / width : 0);
    const shift = Math.max(left, Math.min(naturalLeft, right - width)) - naturalLeft;
    set('translate', `${shift}px 0px`); adjusted.shift = shift;
  }
  stop() { this.restore(); }
}

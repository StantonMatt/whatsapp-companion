export class RecorderLayout {
  private adjusted?: { element: HTMLElement; value: string; priority: string };
  constructor(private doc: Document) {}
  private restore() {
    if (!this.adjusted) return;
    const { element, value, priority } = this.adjusted;
    if (element.style.maxWidth === 'none' && element.style.getPropertyPriority('max-width') === 'important') {
      if (value) element.style.setProperty('max-width', value, priority);
      else element.style.removeProperty('max-width');
    }
    this.adjusted = undefined;
  }
  private recorder(): HTMLElement | null {
    const timer = this.doc.querySelector<HTMLElement>('#main footer [role="timer"]'), footer = timer?.closest('footer');
    if (!timer || !footer) return null;
    for (let node: HTMLElement | null = timer; node; node = node.parentElement) {
      const css = getComputedStyle(node);
      if (node.hidden || css.display === 'none' || ['hidden', 'collapse'].includes(css.visibility)) return null;
      if (node === footer) break;
    }
    for (let element = timer.parentElement; element && element !== footer; element = element.parentElement) {
      const css = getComputedStyle(element);
      // Our override removes the computed cap; keep recognizing the same row.
      const applied = element === this.adjusted?.element && element.style.maxWidth === 'none' && element.style.getPropertyPriority('max-width') === 'important';
      if ((!css.maxWidth || css.maxWidth === 'none') && !applied) continue;
      const send = element.lastElementChild;
      if (css.display !== 'flex' || !['', 'row', 'row-reverse'].includes(css.flexDirection) || !send?.matches('button, [role="button"]') || !(send.matches('button') || send.querySelector('button'))) return null;
      return [...element.children].some(child => child.contains(timer) && parseFloat(getComputedStyle(child).flexGrow) > 0) ? element : null;
    }
    return null;
  }
  refresh() {
    const element = this.recorder();
    if (element !== this.adjusted?.element) this.restore();
    if (!element) return;
    if (!this.adjusted || element.style.maxWidth !== 'none' || element.style.getPropertyPriority('max-width') !== 'important') {
      this.adjusted = { element, value: element.style.getPropertyValue('max-width'), priority: element.style.getPropertyPriority('max-width') };
    }
    if (element.style.maxWidth !== 'none' || element.style.getPropertyPriority('max-width') !== 'important') element.style.setProperty('max-width', 'none', 'important');
  }
  stop() { this.restore(); }
}

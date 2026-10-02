import {
  PICKER_ATTRIBUTES, PICKER_CAPTURE_VERSION, PICKER_MAX_ATTRIBUTE_LENGTH, PICKER_MAX_DEPTH, PICKER_MAX_NODES, PICKER_UI_WORDS,
  type PickerAncestor, type PickerCaptureNode, type PickerLayoutResult, type RedactedPickerText
} from '../shared/sticker-picker-capture';

const uiWords = new Set<string>(PICKER_UI_WORDS);
export function redactPickerText(value: string): RedactedPickerText {
  return { length: Math.min(value.length, 10_000_000), words: [...new Set(value.slice(0, 100_000).toLowerCase().match(/[\p{L}]+/gu) ?? [])].filter(word => uiWords.has(word)) as RedactedPickerText['words'] };
}

// Do not use the transfer adapter: locating a sticker there can open tabs,
// scroll grids and focus controls. This path only reads mounted DOM/layout.
export function captureStickerPicker(doc: Document): PickerLayoutResult {
  const view = doc.defaultView;
  if (!view) return { status: 'no-picker-open' };
  const picker = [...doc.querySelectorAll<HTMLElement>('[data-testid="expressions-panel"]')].find(element =>
    element.checkVisibility({ visibilityProperty: true }) && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
  if (!picker) return { status: 'no-picker-open' };
  let nodeCount = 0, truncated = false;
  const short = (value: string) => {
    if (value.length > PICKER_MAX_ATTRIBUTE_LENGTH) truncated = true;
    return value.slice(0, PICKER_MAX_ATTRIBUTE_LENGTH);
  };
  const number = (value: number) => {
    if (!Number.isFinite(value) || Math.abs(value) > 10_000_000) truncated = true;
    return Number.isFinite(value) ? Math.max(-10_000_000, Math.min(10_000_000, Math.round(value))) : 0;
  };
  const redact = (value: string) => {
    if (value.length > 100_000) truncated = true;
    return redactPickerText(value);
  };
  const ancestors: PickerAncestor[] = [];
  for (let parent = picker.parentElement; parent; parent = parent.parentElement) {
    if (ancestors.length === PICKER_MAX_DEPTH) { truncated = true; break; }
    ancestors.push({ tagName: parent.tagName.toLowerCase(), ...(parent.hasAttribute('role') ? { role: short(parent.getAttribute('role')!) } : {}), ...(parent.hasAttribute('data-testid') ? { testid: short(parent.getAttribute('data-testid')!) } : {}) });
    if (parent === doc.body) break;
  }
  const serialize = (element: Element, depth: number, hidden: boolean): PickerCaptureNode => {
    nodeCount++;
    const style = view.getComputedStyle(element), rect = element.getBoundingClientRect();
    hidden ||= style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || ['SCRIPT', 'STYLE', 'TEMPLATE'].includes(element.tagName);
    const attributes: PickerCaptureNode['attributes'] = {};
    for (const key of PICKER_ATTRIBUTES) if (element.hasAttribute(key)) attributes[key] = short(element.getAttribute(key)!);
    const labels: PickerCaptureNode['labels'] = {};
    for (const key of ['aria-label', 'title', 'alt'] as const) if (element.hasAttribute(key)) labels[key] = redact(element.getAttribute(key)!);
    // Direct text only: do not aggregate entire subtrees or read beyond the cap.
    let text = '', textLength = 0;
    if (!hidden) for (const child of element.childNodes) if (child.nodeType === 3) {
      const value = child.textContent ?? '';
      textLength += value.length;
      text += value.slice(0, Math.max(0, 100_000 - text.length));
    }
    if (textLength > 100_000) truncated = true;
    const textSummary = text.trim() ? { length: number(textLength), words: redactPickerText(text).words } : undefined;
    const overflow = (value: string): PickerCaptureNode['overflowX'] => ['hidden', 'clip', 'scroll', 'auto', 'overlay'].includes(value) ? value as PickerCaptureNode['overflowX'] : 'visible';
    const node: PickerCaptureNode = {
      tagName: element.tagName.toLowerCase().slice(0, 80), ...(element.hasAttribute('role') ? { role: short(element.getAttribute('role')!) } : {}),
      attributes, classCount: number(element.classList.length), labels, ...(textSummary ? { text: textSummary } : {}),
      rect: { x: number(rect.x), y: number(rect.y), top: number(rect.top), right: number(rect.right), bottom: number(rect.bottom), left: number(rect.left), width: number(rect.width), height: number(rect.height) },
      direction: style.direction === 'rtl' ? 'rtl' : 'ltr', overflowX: overflow(style.overflowX), overflowY: overflow(style.overflowY),
      truncated: false, children: []
    };
    if (node.overflowX !== 'visible' || node.overflowY !== 'visible' || element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight) {
      node.scroll = { scrollWidth: number(element.scrollWidth), scrollHeight: number(element.scrollHeight), clientWidth: number(element.clientWidth), clientHeight: number(element.clientHeight), scrollLeft: number(element.scrollLeft), scrollTop: number(element.scrollTop) };
    }
    if (element.tagName.toLowerCase() === 'img') {
      const image = element as HTMLImageElement;
      const scheme = /^(blob|data|https):/i.exec(image.currentSrc || image.getAttribute('src') || '')?.[1].toLowerCase() as 'blob' | 'data' | 'https' | undefined;
      node.image = { scheme: scheme ?? null, naturalWidth: number(image.naturalWidth), naturalHeight: number(image.naturalHeight), renderedWidth: number(rect.width), renderedHeight: number(rect.height) };
    }
    for (const child of element.children) {
      if (depth === PICKER_MAX_DEPTH || nodeCount === PICKER_MAX_NODES) { node.truncated = truncated = true; break; }
      node.children.push(serialize(child, depth + 1, hidden));
    }
    return node;
  };
  const tree = serialize(picker, 0, false);
  const viewport = { width: number(view.innerWidth), height: number(view.innerHeight) };
  return { status: 'captured', capturedAt: new Date().toISOString(), connectorVersion: PICKER_CAPTURE_VERSION, viewport, ancestors, tree, nodeCount, truncated };
}

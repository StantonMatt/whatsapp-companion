export function peerFromMessageId(id: string): string | null {
  return /^(?:true|false)_([\d-]+@(?:c\.us|s\.whatsapp\.net|g\.us|lid))_/.exec(id)?.[1] ?? null;
}
// Quotes are context belonging to another message, never authorship/direction of this one.
export const quoteSelector = '[data-testid="quoted-message"], [data-testid="quoted-message-container"], [data-testid="quoted-msg"], [data-testid="reply-context"]';
export function ownElements(node: HTMLElement, selector: string) {
  return [...node.querySelectorAll<HTMLElement>(selector)].filter(el => {
    const quote = el.closest(quoteSelector);
    return !quote || quote === node;
  });
}
function localDirection(node: HTMLElement, id: string): boolean | null {
  if (peerFromMessageId(id)) return id.startsWith('true_');
  if (node.matches('.message-out') || ownElements(node, '[data-icon="tail-out"], [data-testid="tail-out"], .message-out').length) return true;
  if (node.matches('.message-in') || ownElements(node, '[data-icon="tail-in"], [data-testid="tail-in"], .message-in').length) return false;
  const labels = ownElements(node, '[aria-label]').map(el => el.getAttribute('aria-label')?.trim() ?? '');
  if (labels.some(label => /^(You|Tú|Você):$/.test(label))) return true;
  // The visible group-author header identifies another participant, including media without tails.
  if (ownElements(node, '[data-testid="author"]').length) return false;
  // Copy metadata names alone do not establish whether a sender is the account owner.
  return null;
}

export function messageDirection(node: HTMLElement, id = node.dataset.id ?? ''): boolean | null {
  const own = localDirection(node, id);
  if (own !== null || node.closest(quoteSelector)) return own;
  // Grouped sticker items own their identity, while authorship may live on
  // the surrounding native message wrapper (outside the item itself).
  for (let wrapper = node.parentElement; wrapper && wrapper.id !== 'main'; wrapper = wrapper.parentElement) {
    if (!wrapper.matches('.message-out, .message-in, [data-testid="msg-container"], [data-testid^="conv-msg-"], [data-id]')) continue;
    const direction = localDirection(wrapper, wrapper.dataset.id ?? '');
    if (direction !== null) return direction;
  }
  return null;
}

function bounds(element: Element, geometry?: Map<Element, DOMRect>) {
  const cached = geometry?.get(element);
  if (cached) return cached;
  const rect = element.getBoundingClientRect(); geometry?.set(element, rect); return rect;
}
function bubbleBounds(node: HTMLElement, geometry?: Map<Element, DOMRect>) {
  return bounds((ownElements(node, '[data-testid="msg-container"]')[0] ?? node), geometry);
}
function measurable(rect: DOMRect) {
  return rect.width > 0 && rect.height > 0 && [rect.left, rect.right].every(Number.isFinite);
}
/** Suggestion-only inference. Never use this to authorize automatic sending. */
export function fallbackDirection(node: HTMLElement, pane: HTMLElement, preceding?: { node: HTMLElement; direction: boolean | null }, geometry?: Map<Element, DOMRect>): boolean | null {
  if (node.closest(quoteSelector)) return null;
  const rect = bubbleBounds(node, geometry), viewport = bounds(pane, geometry);
  if (!measurable(rect) || !measurable(viewport)) return null;
  // Walk only empty wrapper boundaries. A divider/system row, even without an
  // ID, breaks the run; never search backwards past it for a convenient author.
  let row = node;
  const precedingText = (element: HTMLElement) => {
    for (let sibling = element.previousSibling; sibling; sibling = sibling.previousSibling)
      if (sibling.nodeType === 3 && sibling.textContent?.trim()) return true;
    return false;
  };
  while (!row.previousElementSibling && !precedingText(row) && row.parentElement && row.parentElement !== pane && row.parentElement.id !== 'main') row = row.parentElement;
  const sibling = row.previousElementSibling;
  const previous = sibling?.matches('[data-id]') ? sibling as HTMLElement : sibling?.querySelector<HTMLElement>('[data-id]');
  if (previous && !precedingText(row) && !sibling?.matches('[data-testid*="system"], [data-testid*="date"], [role="separator"]') &&
      !sibling?.querySelector('[data-testid*="system"], [data-testid*="date"], [role="separator"]') &&
      (!sibling?.querySelectorAll('[data-id]').length || sibling.querySelectorAll('[data-id]').length === 1)) {
    const before = bubbleBounds(previous, geometry);
    const direction = messageDirection(previous) ?? (preceding?.node === previous ? preceding.direction : null);
    if (measurable(before) && direction != null &&
        Math.abs((direction ? rect.right : rect.left) - (direction ? before.right : before.left)) <= 12 &&
        Math.abs((rect.left + rect.right) / 2 - (before.left + before.right) / 2) < viewport.width / 4)
      return direction;
  }
  // Require a clear gap difference, so wide/centred/partially mounted bubbles
  // and zero-sized placeholders stay unknown.
  const left = rect.left - viewport.left, right = viewport.right - rect.right;
  const margin = Math.max(24, viewport.width * 0.08);
  if (left < -12 || right < -12 || Math.abs(left - right) < margin) return null;
  return left > right;
}

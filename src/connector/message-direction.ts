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

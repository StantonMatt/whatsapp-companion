// Self-contained: main also serializes this fixed helper into the remote page.
export function readChatTitle(value: Node | string | null | undefined): string {
  const text = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return '';
    const element = node as Element;
    if (element.matches('img, .emoji, [data-testid="emoji"], span[alt], span[data-plain-text], span[data-emoji]')) {
      const emoji = element.getAttribute('data-plain-text') || element.getAttribute('alt') || element.getAttribute('data-emoji');
      if (emoji) return emoji;
    }
    return [...node.childNodes].map(text).join('');
  };
  // Drop bidi marks and emoji presentation selectors (WA's emoji alt may be fully
  // qualified while the stored name is not); keep joiners and letters/marks.
  return (typeof value === 'string' ? value : value ? text(value) : '')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufe0e\ufe0f\ufeff]/g, '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

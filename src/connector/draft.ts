export function readDraft(editor: HTMLElement): string {
  // Native editors keep framework sentinels and placeholder markup even when
  // there is no draft. Normalize only a structurally empty editable composer.
  if (composerProvablyEmpty(editor, false)) return '';
  const serialize = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    const tag = node.tagName.toUpperCase();
    if (tag === 'BR') return '\n';
    if (tag === 'IMG') return node.getAttribute('data-plain-text') || node.getAttribute('alt') || '\ufffc';
    if (['SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT'].includes(tag)) return '\ufffc';
    let text = '';
    for (const child of node.childNodes) {
      const block = child instanceof Element && ['DIV', 'P', 'LI'].includes(child.tagName);
      if (block && text && !text.endsWith('\n')) text += '\n';
      text += serialize(child);
      if (block && child.nextSibling && !text.endsWith('\n')) text += '\n';
    }
    return text || (node.getAttribute('contenteditable') === 'false' ? '\ufffc' : '');
  };
  return serialize(editor).replace(/\u200b/g, '').replace(/\n$/, '');
}

// Only these editor sentinels are empty: do not trim spaces/newlines or other
// invisible characters that could be actual user content.
const withoutSentinels = (text: string) => text.replace(/[\u200b\ufeff]/g, '');
const placeholder = (element: Element) => element.matches('[data-lexical-placeholder="true"], [data-placeholder="true"]') &&
  (element.getAttribute('contenteditable') === 'false' || element.getAttribute('aria-hidden') === 'true');

// Sending checks the DOM as well as serialized text, so mentions, embeds and
// extra blank lines cannot disappear during normalization.
export function composerProvablyEmpty(editor: HTMLElement | null, composing: boolean): boolean {
  if (!editor?.isConnected || composing || editor.getAttribute('contenteditable') !== 'true') return false;
  if (editor.querySelector('img, svg, canvas, video, audio, iframe, object, embed, [data-mention], [data-plain-text], .mention, [data-testid*="mention"]')) return false;
  const elements: Element[] = [];
  const empty = (node: Node): boolean => {
    if (node.nodeType === 3) return withoutSentinels(node.textContent ?? '') === '';
    if (!(node instanceof Element)) return node.nodeType === 8; // framework comments
    if (!['P', 'DIV', 'SPAN', 'BR'].includes(node.tagName)) return false;
    if (placeholder(node)) return true;
    if (node.getAttribute('contenteditable') === 'false' && !node.matches('span[data-lexical-text="true"]')) return false;
    elements.push(node);
    return [...node.childNodes].every(empty);
  };
  if (![...editor.childNodes].every(empty)) return false;
  // A sole BR in an otherwise empty paragraph is the native empty placeholder.
  // Multiple breaks or blocks represent a newline draft, even with no text.
  const breaks = elements.filter(el => el.tagName === 'BR');
  if (breaks.length > 1) return false;
  const blocks = elements.filter(el => ['P', 'DIV'].includes(el.tagName));
  // Empty framework spans can sit beside the paragraph. All actual blocks
  // must still form one nested line, including a sole placeholder BR.
  if (blocks.some(block => blocks.some(other => !block.contains(other) && !other.contains(block)) || (breaks[0] && !block.contains(breaks[0])))) return false;
  return true;
}

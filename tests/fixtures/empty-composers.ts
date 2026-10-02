// R1-static-step-1/2 structure: conversation-compose-box-input -> P -> BR.
// Include Lexical's equivalent empty text/placeholder states; actual text is
// deliberately absent except for the explicitly noneditable placeholder.
export const emptyComposers = {
  bare: '',
  paragraph: '<p class="selectable-text copyable-text"><br></p>',
  break: '<br>',
  emptyParagraph: '<p class="selectable-text copyable-text"></p>',
  lexical: '<p class="selectable-text copyable-text" dir="auto"><span data-lexical-text="true">\u200b</span><br></p>',
  bom: '<p class="selectable-text copyable-text"><span data-lexical-text="true">\ufeff</span><br></p>',
  sentinel: '\u200b\ufeff',
  lexicalNoneditable: '<p><span data-lexical-text="true" contenteditable="false">\u200b</span><br></p>',
  trailingSentinel: '<p class="selectable-text copyable-text"><br></p><span data-lexical-text="true">\ufeff</span>',
  placeholder: '<span data-lexical-placeholder="true" contenteditable="false" aria-hidden="true">Type a message</span><p class="selectable-text copyable-text"><br></p>',
  emptyPlaceholder: '<p><span data-placeholder="true" contenteditable="false"></span><br></p>',
  comments: '<!-- lexical --><p><span data-lexical-text="true"></span><br></p>'
};

// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { DomConnector } from '../src/connector/dom';
import { fallbackDirection, messageDirection } from '../src/connector/message-direction';
import { autoDecision } from '../src/core/auto-reply';
import { snapshotKey, suggestionKey } from '../src/core/suggestions';
import { defaultAuto, emptySnapshot, snapshotSchema } from '../src/shared/model';
import { displayAckSchema, dismissEventSchema } from '../src/shared/connector';

const rect = (left: number, width: number, height = 40) => ({ left, right: left + width, width, height, top: 10, bottom: 10 + height } as DOMRect);
function pane() {
  document.body.innerHTML = '<div id="pane-side"><div aria-selected="true">Chat</div></div><div id="main"><header><span data-testid="conversation-info-header-chat-title">Chat</span></header><section></section><footer><div contenteditable="true" role="textbox"></div></footer></div>';
  const main = document.querySelector<HTMLElement>('#main')!;
  main.getBoundingClientRect = () => rect(0, 800, 600);
  document.querySelector<HTMLElement>('[role="textbox"]')!.getBoundingClientRect = () => rect(40, 600);
  return main;
}
function bubble(html: string, left = 350, width = 100) {
  const row = document.createElement('div'), id = `OPAQUE_${document.querySelectorAll('[data-id]').length}`;
  row.dataset.id = id; row.dataset.testid = `conv-msg-${id}`; row.innerHTML = `<div data-testid="msg-container">${html}</div>`;
  row.querySelector<HTMLElement>('[data-testid="msg-container"]')!.getBoundingClientRect = () => rect(left, width);
  document.querySelector('section')!.append(row); return row;
}
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

test('consecutive opaque incoming bubbles inherit the first tail even when geometry is ambiguous', () => {
  const main = pane(); const first = bubble('<span data-icon="tail-in"></span><span data-testid="msg-text">First</span>');
  const second = bubble('<span data-testid="msg-text">Second</span>');
  bubble('<span data-testid="msg-text">Third</span>');
  expect(messageDirection(first)).toBe(false); expect(messageDirection(second)).toBeNull();
  expect(fallbackDirection(second, main)).toBe(false);
  const messages = snapshotSchema.parse(new DomConnector(document, () => {}).read()).messages;
  expect(messages.map(m => m.outgoing)).toEqual([false, false, false]);
  expect(messages.map(m => m.directionFallback)).toEqual([undefined, true, true]);
});
test.each(['<div data-testid="date-divider">Today</div>', '<div role="separator"></div>', '<div data-testid="system-message">Security code changed</div>', '<div>Yesterday</div>'])('a divider/system row breaks inheritance: %s', divider => {
  const main = pane(); bubble('<span data-icon="tail-in"></span>');
  document.querySelector('section')!.insertAdjacentHTML('beforeend', divider);
  const last = bubble('<span data-testid="msg-text">Last</span>');
  expect(fallbackDirection(last, main)).toBeNull(); expect(new DomConnector(document, () => {}).read().messages.at(-1)!.outgoing).toBeNull();
});
test('a bare date text node at a wrapper boundary breaks inheritance', () => {
  const main = pane(); bubble('<span data-icon="tail-in"></span>');
  const last = bubble('Last'), wrapper = document.createElement('div');
  last.before(wrapper); wrapper.append('Yesterday', last);
  expect(fallbackDirection(last, main)).toBeNull();
});
test.each([[60, 100, false], [640, 100, true], [350, 100, null], [10, 780, null], [60, 0, null], [60, 100, null, 0], [-50, 100, null]] as Array<[number, number, boolean | null, number?]>)('geometry left=%s width=%s yields %s', (left, width, direction, height = 40) => {
  const main = pane(), row = bubble('<span data-testid="msg-text">No tail</span>', left, width);
  row.querySelector<HTMLElement>('[data-testid="msg-container"]')!.getBoundingClientRect = () => rect(left, width, height);
  expect(fallbackDirection(row, main)).toBe(direction);
});
test('opposite sides break inheritance, geometry still identifies the new incoming bubble', () => {
  const main = pane(); bubble('<span data-icon="tail-out"></span>', 640); const last = bubble('Incoming', 60);
  expect(fallbackDirection(last, main)).toBe(false);
});
test('explicit ID and tail signals precede suggestion-only geometry and quoted tails cannot establish direction', () => {
  pane(); const row = bubble('<span data-icon="tail-out"></span>', 60);
  expect(new DomConnector(document, () => {}).read().messages.at(-1)!.outgoing).toBe(true);
  row.dataset.id = 'false_123@c.us_verified';
  expect(new DomConnector(document, () => {}).read().messages.at(-1)!.outgoing).toBe(false);
  row.dataset.id = 'OPAQUE_0'; row.innerHTML = '<div data-testid="msg-container"><div data-testid="quoted-message"><span data-icon="tail-out"></span></div></div>';
  row.querySelector<HTMLElement>('[data-testid="msg-container"]')!.getBoundingClientRect = () => rect(350, 100);
  expect(new DomConnector(document, () => {}).read().messages.at(-1)!.outgoing).toBeNull();
});
test('inferred incoming messages allow inline suggestions but cannot authorize automatic sending', () => {
  pane(); bubble('<span data-testid="msg-text">Question</span>', 60);
  const message = new DomConnector(document, () => {}).read().messages[0];
  expect(message).toMatchObject({ outgoing: false, directionFallback: true });
  const snapshot = { ...emptySnapshot, chatId: '123@c.us', ready: true, atBottom: true, messages: [message] };
  const rules = { ...defaultAuto, enabled: true, paused: false, startHour: 0, endHour: 0 };
  expect(autoDecision(rules, snapshot, [], new Date())).toBe('No new incoming text');
  const explicit = { ...snapshot, messages: [{ ...message, directionFallback: undefined }] };
  expect(autoDecision(rules, explicit, [], new Date())).toBeNull();
  expect(snapshotKey(explicit)).not.toBe(snapshotKey(snapshot)); expect(suggestionKey(explicit)).toBe(suggestionKey(snapshot));
});
test.each(['<img alt="🫢">', '<span data-plain-text="🫢"></span>', '<span data-testid="msg-text"><img alt="🫢"></span>'])('jumbo emoji text is readable with %s', html => {
  pane(); bubble(html); expect(new DomConnector(document, () => {}).read().messages[0].text).toBe('🫢');
});
test('emoji extraction omits quote, reaction, author and media alt labels', () => {
  pane(); bubble('<span data-testid="msg-text">Body <img alt="😂"></span><img alt="🫢"><div data-testid="quoted-message"><img alt="😍"></div><span data-testid="author"><img alt="🤗"></span><div data-testid="reaction"><img alt="😡"></div><div data-testid="image-thumb"><img alt="Photo 😀"></div><img alt="Photo 😀">');
  expect(new DomConnector(document, () => {}).read().messages[0].text).toBe('Body 😂\n🫢');
});
test('display and dismissal IPC schemas reject malformed, extra and authority-bearing fields', () => {
  const id = '0b3455de-8a13-4f0c-ade8-f5c123456789';
  const ack = { type: 'displayAck', suggestionId: id, key: 'key', reason: 'key' };
  expect(displayAckSchema.safeParse(ack).success).toBe(true);
  for (const value of [{ ...ack, reason: 'send' }, { ...ack, suggestionId: 'untrusted' }, { ...ack, automatic: true }, { ...ack, text: 'private' }]) expect(displayAckSchema.safeParse(value).success).toBe(false);
  expect(dismissEventSchema.safeParse({ type: 'dismiss', suggestionId: id, key: 'key' }).success).toBe(true);
  expect(dismissEventSchema.safeParse({ type: 'dismiss', requestId: id }).success).toBe(true);
  expect(dismissEventSchema.safeParse({ type: 'dismiss', requestId: 'forged' }).success).toBe(false);
  expect(dismissEventSchema.safeParse({ type: 'dismiss', requestId: id, suggestionId: id, key: 'key' }).success).toBe(false);
  expect(dismissEventSchema.safeParse({ type: 'dismiss', suggestionId: id }).success).toBe(false);
  expect(dismissEventSchema.safeParse({ type: 'dismiss', key: 'key' }).success).toBe(false);
});
test('a full-width virtualized placeholder after a wide incoming bubble keeps its observed message and direction', () => {
  pane(); bubble('<span data-icon="tail-in"></span><span data-testid="msg-text">Wide first</span>', 10, 700);
  const second = bubble('<span data-testid="msg-text">Readable second</span>', 10, 700);
  const connector = new DomConnector(document, () => {});
  const observed = connector.read().messages.at(-1)!;
  expect(observed).toMatchObject({ text: 'Readable second' });
  second.innerHTML = '<div style="height:150px"></div>';
  second.getBoundingClientRect = () => rect(0, 800, 150);
  expect(connector.read().messages.at(-1)).toEqual(observed);
});
test('an unobserved placeholder is never relabelled by inference', () => {
  pane(); bubble('<span data-icon="tail-in"></span><span data-testid="msg-text">Wide first</span>', 10, 700);
  const second = bubble('', 10, 700); second.innerHTML = '<div style="height:150px"></div>';
  second.getBoundingClientRect = () => rect(0, 800, 150);
  expect(new DomConnector(document, () => {}).read().messages.at(-1)).toMatchObject({ text: '', outgoing: null });
});

test.each(['message-in', 'message-out', 'author', 'own-label', 'wrapper-id'])('cached placeholders use current external direction evidence: %s', evidence => {
  vi.useFakeTimers(); pane();
  const row = bubble('<span data-icon="tail-in"></span><span data-testid="msg-text">Observed</span>');
  const wrapper = document.createElement('article'); wrapper.dataset.testid = 'msg-container';
  row.before(wrapper); wrapper.append(row);
  const cached = new DomConnector(document, () => {}), fresh = new DomConnector(document, () => {});
  const observer = new MutationObserver(() => {});
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  const compare = () => {
    cached['mutations'](observer.takeRecords(), false);
    const snapshot = cached.read(false); expect(snapshot).toEqual(fresh.read()); return snapshot;
  };
  try {
    compare(); row.innerHTML = '<div style="height:150px"></div>';
    expect(compare().messages[0].text).toBe('Observed');
    if (evidence.startsWith('message-')) wrapper.className = evidence;
    if (evidence === 'author') wrapper.insertAdjacentHTML('afterbegin', '<span data-testid="author">Someone</span>');
    if (evidence === 'own-label') wrapper.insertAdjacentHTML('afterbegin', '<span aria-label="You:"></span>');
    if (evidence === 'wrapper-id') wrapper.dataset.id = 'true_123@c.us_wrapper';
    expect(compare().messages.at(-1)).toMatchObject({ text: '', outgoing: !['message-in', 'author'].includes(evidence) });
    wrapper.className = ''; wrapper.removeAttribute('data-id');
    wrapper.querySelector('[data-testid="author"], [aria-label]')?.remove();
    compare();
  } finally { observer.disconnect(); }
});

test('extraction rejects cached entries when connection state changes before observer delivery', () => {
  pane(); const row = bubble('<span data-testid="msg-text"><img alt="😂"></span>');
  const connector = new DomConnector(document, () => {});
  const mounted = connector['extractMessage'](row, false);
  row.remove(); row.querySelector('img')!.alt = '😀';
  const detached = connector['extractMessage'](row, false);
  expect(detached).not.toBe(mounted); expect(detached.content.text).toBe('😀');
  row.querySelector('img')!.alt = '🫢'; document.querySelector('section')!.append(row);
  const reattached = connector['extractMessage'](row, false);
  expect(reattached).not.toBe(detached); expect(reattached.content.text).toBe('🫢');
});

test.each([1, 17, 42, 101, 2026, 65535])('cached and fresh snapshots agree through randomized evidence changes and node reuse (seed=%s)', async seed => {
  vi.useFakeTimers(); const main = pane(), section = main.querySelector('section')!;
  let state = seed;
  const random = (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
  let paneLeft = 0, paneWidth = 800;
  main.getBoundingClientRect = () => rect(paneLeft, paneWidth, 600);
  const rows = Array.from({ length: 4 }, (_, index) => {
    const node = bubble(`<span data-testid="msg-text">Message ${index}</span>`, 350);
    const wrapper = document.createElement('article'); wrapper.dataset.testid = 'msg-container';
    const header = document.createElement('aside');
    node.before(wrapper); wrapper.append(header, node);
    const geometry = { left: 350, width: 100 };
    node.getBoundingClientRect = () => rect(geometry.left, geometry.width);
    node.querySelector<HTMLElement>('[data-testid="msg-container"]')!.getBoundingClientRect = node.getBoundingClientRect;
    return { node, wrapper, header, geometry };
  });
  const cached = new DomConnector(document, () => {}), fresh = new DomConnector(document, () => {});
  const observer = new MutationObserver(() => {});
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  const compare = (step: number | string) => {
    cached['mutations'](observer.takeRecords(), false);
    expect(cached.read(false), `seed ${seed}, step ${step}`).toEqual(fresh.read());
  };
  try {
    compare(-1);
    for (let step = 0; step < 180; step++) {
      const { node, wrapper, header, geometry } = rows[random(rows.length)];
      // Cycle operation classes for coverage, randomize the affected bubble and
      // evidence. Geometry-only changes deliberately generate no DOM records.
      switch (step % 18) {
        case 0: wrapper.className = ['', 'message-in', 'message-out'][random(3)]; break;
        case 1: wrapper.dataset.testid = ['msg-container', 'neutral-wrapper', 'conv-msg-wrapper'][random(3)]; break;
        case 2: header.innerHTML = ['', '<span data-testid="author">Peer</span>', '<span data-pre-plain-text="[10:00] Peer: ">Peer</span>'][random(3)]; break;
        case 3: header.innerHTML = ['', '<span aria-label="You:"></span>', '<span data-icon="tail-in"></span>', '<span data-icon="tail-out"></span>'][random(4)]; break;
        case 4: node.innerHTML = random(2) ? '<div style="height:150px"></div>' : `<span data-testid="msg-text">Message ${random(10)}</span>`; break;
        case 5: {
          for (const sibling of [...section.childNodes]) if (!rows.some(row => row.wrapper === sibling)) sibling.remove();
          const divider = document.createElement('div');
          divider.innerHTML = ['<span data-testid="date-divider">Today</span>', '<span role="separator"></span>', 'Yesterday', ''][random(4)];
          wrapper.before(divider); break;
        }
        case 6: wrapper.dataset.testid = random(2) ? 'quoted-message' : 'msg-container'; break;
        case 7: geometry.left = [10, 60, 350, 640][random(4)]; geometry.width = [0, 100, 700][random(3)]; break;
        case 8: paneLeft = [0, -600, 100][random(3)]; paneWidth = [0, 800, 1200][random(3)]; break;
        case 9: section.append(wrapper); break;
        case 10: {
          header.innerHTML = '<div data-testid="quoted-message"><span data-testid="author">Peer</span><span data-icon="tail-out"></span></div>';
          header.firstElementChild!.setAttribute('data-testid', random(2) ? 'quoted-message' : 'native-header'); break;
        }
        case 11: {
          node.innerHTML = '<span data-testid="msg-text">Body</span><div data-testid="quoted-message"><span data-testid="author">Peer</span><span data-testid="msg-text">Quote</span></div>';
          node.lastElementChild!.setAttribute('data-testid', random(2) ? 'quoted-message' : 'native-body'); break;
        }
        case 12:
        case 13:
        case 14: {
          // Drain removal records and let transient subtree observation end
          // before editing, so the edits genuinely happen outside the observer.
          wrapper.dataset.testid = 'msg-container';
          node.innerHTML = '<span data-testid="msg-text">Body <img alt="😂"></span>';
          compare(`${step} mounted`);
          const removed = step % 18 === 13 ? wrapper : node;
          removed.remove(); compare(`${step} detached`); await Promise.resolve();
          if (step % 18 === 12) node.querySelector('img')!.alt = ['😀', '😍', '🫢'][random(3)];
          if (step % 18 === 13) node.querySelector('span')!.firstChild!.textContent = `Detached ${random(10)} `;
          if (step % 18 === 14) {
            node.dataset.id = `REUSED_${seed}_${step}`; node.dataset.testid = `conv-msg-${node.dataset.id}`;
            node.querySelector('img')!.alt = '🫢';
          }
          compare(`${step} edited while detached`);
          if (removed === wrapper) section.append(wrapper); else wrapper.append(node);
          break;
        }
        case 15: {
          wrapper.dataset.testid = 'msg-container';
          node.innerHTML = '<span data-testid="msg-text"><img alt="😂"></span>';
          compare(`${step} before move`);
          const destination = document.createElement('div'); destination.className = 'message-out';
          section.append(destination); destination.append(node);
          compare(`${step} in other container`);
          node.remove(); compare(`${step} detached from other container`); await Promise.resolve();
          node.querySelector('img')!.alt = '😍';
          compare(`${step} edited after move`);
          wrapper.append(node); destination.remove(); break;
        }
        case 16: {
          wrapper.dataset.testid = 'msg-container';
          node.innerHTML = '<span data-testid="msg-text"><img alt="😂"></span>';
          compare(`${step} before nested reattachment`);
          wrapper.remove(); compare(`${step} wrapper detached`); await Promise.resolve();
          // Seed a detached entry as well: added subtree invalidation must find
          // cached descendants even when recycling removed their old selector.
          cached['extractMessage'](node, false);
          const id = node.dataset.id!; node.removeAttribute('data-id');
          node.querySelector('img')!.alt = '🫢';
          compare(`${step} recycled while detached`);
          const outer = document.createElement('div'); outer.append(wrapper); section.append(outer);
          compare(`${step} reattached without ID`);
          expect(cached['messageCache'].has(node)).toBe(false);
          node.dataset.id = id; section.append(wrapper); outer.remove(); break;
        }
        case 17: {
          wrapper.dataset.testid = 'msg-container';
          node.innerHTML = '<span data-testid="msg-text"><img alt="😂"></span>';
          compare(`${step} before same-turn reuse`);
          node.remove(); node.querySelector('img')!.alt = '😀'; wrapper.append(node);
          // Connection state matches the old entry when these records arrive.
          break;
        }
      }
      compare(step);
    }
  } finally { observer.disconnect(); }
});

test('fallback geometry is shared within one read and refreshed for the next authorization read', () => {
  const main = pane();
  const rows = Array.from({ length: 10 }, (_, index) => bubble(`<span data-testid="msg-text">${index}</span>`, 60, 100));
  const paneRect = vi.spyOn(main, 'getBoundingClientRect');
  const bubbleRects = rows.map(row => vi.spyOn(row.querySelector<HTMLElement>('[data-testid="msg-container"]')!, 'getBoundingClientRect'));
  const connector = new DomConnector(document, () => {});
  expect(connector.read().messages.every(message => message.outgoing === false && message.directionFallback)).toBe(true);
  // One pane visibility read and one shared direction viewport read.
  expect(paneRect).toHaveBeenCalledTimes(2);
  expect(bubbleRects.every(read => read.mock.calls.length === 1)).toBe(true);
  paneRect.mockClear(); bubbleRects.forEach(read => read.mockClear());
  main.getBoundingClientRect = vi.fn(() => rect(-600, 800, 600));
  expect(connector.read().messages[0].outgoing).toBe(true);
  expect(bubbleRects.every(read => read.mock.calls.length === 1)).toBe(true);
});

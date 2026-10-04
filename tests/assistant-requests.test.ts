import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { emptySnapshot, initialState, defaultAuto, type Snapshot, type State } from '../src/shared/model';
import { Conversations } from '../src/main/conversations';
import { Assistant } from '../src/main/assistant';
import { suggestionKey } from '../src/core/suggestions';
import { ProviderError, type generate } from '../src/main/providers';
import type { Store } from '../src/main/store';
import type { Vault } from '../src/main/vault';
import type { RemoteCommand } from '../src/shared/connector';

const a = '123@c.us', b = '456@c.us';
const snap = (patch: Partial<Snapshot> = {}): Snapshot => ({ ...emptySnapshot, chatId: a, settingsId: a, name: 'A', revision: '1',
  ready: true, conversationOpen: true, focused: true, caretAtEnd: true, messages: [{ id: 'last', text: 'Hello', outgoing: false }], ...patch });
function setup(generator = vi.fn<typeof generate>().mockResolvedValue('Reply')) {
  const state = initialState(); state.global.suggestions = true; state.global.shareContext = true;
  const store = { state, update: (change: (state: State) => void) => change(state) } as Store;
  const commands: RemoteCommand[] = [];
  const assistant = new Assistant(store, { get: () => 'synthetic' } as unknown as Vault, { send: c => commands.push(c), focus() {} }, () => {}, false, generator);
  const fresh = (snapshot = assistant.snapshot) => {
    const command = commands.filter((c): c is Extract<RemoteCommand, { type: 'snapshot' }> => c.type === 'snapshot').at(-1)!;
    assistant.receive(snapshot, false, command.nonce);
  };
  const offer = () => commands.filter((c): c is Extract<RemoteCommand, { type: 'suggestion' }> => c.type === 'suggestion').at(-1)!;
  return { assistant, generator, commands, state, store, fresh, offer };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('automatic suggestion requests', () => {
  test('open once, six A/B switches, revisions and history loading reuse the latest-message cache', async () => {
    const { assistant, generator, offer } = setup();
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 3; i++) {
      assistant.receive(snap({ chatId: b, settingsId: b, revision: `b${i}`, name: 'B' })); await vi.advanceTimersByTimeAsync(1000);
      assistant.receive(snap({ revision: `a${i}` })); await vi.advanceTimersByTimeAsync(1000);
    }
    expect(generator).toHaveBeenCalledTimes(2); expect(offer()).toMatchObject({ text: 'Reply', key: expect.stringContaining('a2') });
    assistant.receive(snap({ revision: 'a2', messages: [{ id: 'history', text: 'Older', outgoing: true }, ...snap().messages] }));
    await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledTimes(2); assistant.cancel();
  });
  test('a new incoming latest message gets one request and outgoing/unknown latest messages get none', async () => {
    const { assistant, generator } = setup();
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap({ messages: [{ id: 'new', text: 'Another question', outgoing: false }] })); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(2); expect(generator.mock.calls[1][0].reason).toBe('incoming message');
    for (const outgoing of [true, null]) {
      assistant.receive(snap({ messages: [{ id: `own-${outgoing}`, text: 'My reply', outgoing }] })); await vi.advanceTimersByTimeAsync(2000);
    }
    expect(generator).toHaveBeenCalledTimes(2);
    await assistant.request(); expect(generator).toHaveBeenCalledTimes(3); assistant.cancel();
  });
  test('five-message burst resets the one-second debounce and dispatches only its final snapshot', async () => {
    const { assistant, generator } = setup();
    assistant.receive(snap());
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(300);
      assistant.receive(snap({ messages: [{ id: `${i}`, text: `Question ${i}`, outgoing: false }] }));
    }
    await vi.advanceTimersByTimeAsync(999); expect(generator).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(generator).toHaveBeenCalledOnce();
    expect(JSON.parse(generator.mock.calls[0][0].input).context[0].text).toBe('Question 4'); assistant.cancel();
  });
  test('dismissal survives revisit but explicit suggest bypasses it', async () => {
    const { assistant, generator, commands } = setup();
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000); assistant.dismiss();
    assistant.receive(snap({ chatId: b, settingsId: b })); await vi.advanceTimersByTimeAsync(1000);
    const count = commands.filter(c => c.type === 'suggestion').length;
    assistant.receive(snap({ revision: '2' })); await vi.advanceTimersByTimeAsync(2000);
    expect(generator).toHaveBeenCalledTimes(2); expect(commands.filter(c => c.type === 'suggestion')).toHaveLength(count);
    await assistant.request(); expect(generator).toHaveBeenCalledTimes(3); assistant.cancel();
  });
  test('failures retry once per visit, show a live notice, and become eligible on revisit', async () => {
    const { assistant, generator, commands } = setup(vi.fn<typeof generate>().mockRejectedValue(new ProviderError('Transient', true)));
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1999); expect(generator).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(generator).toHaveBeenCalledTimes(2);
    expect(commands.at(-1)).toMatchObject({ type: 'notice', text: 'Transient', retryKey: expect.any(String) });
    assistant.receive(snap({ activity: 1 })); await vi.advanceTimersByTimeAsync(10000); expect(generator).toHaveBeenCalledTimes(2);
    generator.mockResolvedValue('Recovered'); await assistant.request(undefined, false, { operation: 'retry', key: suggestionKey(assistant.snapshot) });
    expect(generator).toHaveBeenCalledTimes(3); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Recovered' });
    assistant.receive(snap({ messages: [{ id: 'new', text: 'New', outgoing: false }] })); generator.mockRejectedValue(new ProviderError('Rejected'));
    await vi.advanceTimersByTimeAsync(1000); const calls = generator.mock.calls.length;
    assistant.receive(snap({ chatId: b, settingsId: b, messages: [] })); assistant.receive(snap({ revision: 'return', messages: [{ id: 'new', text: 'New', outgoing: false }] }));
    expect(commands.at(-1)).toMatchObject({ type: 'clear' }); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(calls + 1); expect(commands.at(-1)).toMatchObject({ type: 'notice', text: 'Rejected' }); assistant.cancel(true);
  });
  test('cache is bounded to 50 LRU entries', async () => {
    const { assistant, generator } = setup();
    for (let i = 0; i < 50; i++) {
      assistant.receive(snap({ chatId: `${i}@c.us`, settingsId: `${i}@c.us` })); await vi.advanceTimersByTimeAsync(1000);
    }
    assistant.receive(snap({ chatId: '0@c.us', settingsId: '0@c.us' }));
    assistant.receive(snap({ chatId: '50@c.us', settingsId: '50@c.us' })); await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap({ chatId: '0@c.us', settingsId: '0@c.us' })); await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledTimes(51);
    assistant.receive(snap({ chatId: '1@c.us', settingsId: '1@c.us' })); await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledTimes(52); assistant.cancel();
  });
});

describe('draft continuations', () => {
  test('short pauses coalesce and whitespace-only changes do not repeat a continuation', async () => {
    const { assistant, generator } = setup();
    for (const draft of ['Hi', 'Hi there', 'Hi there friend']) {
      assistant.receive(snap({ draft })); await vi.advanceTimersByTimeAsync(300);
    }
    expect(generator).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(700); expect(generator).toHaveBeenCalledOnce();
    assistant.receive(snap({ draft: ' Hi  there friend  ', editRevision: 1 })); await vi.advanceTimersByTimeAsync(2000); expect(generator).toHaveBeenCalledOnce();
    assistant.receive(snap({ draft: 'Hi there friend!', editRevision: 2 })); await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledTimes(2); assistant.cancel();
  });
  test.each(['accept', 'refine'])('%s suppresses continuation until the user makes a meaningful edit', async action => {
    const { assistant, generator, offer } = setup();
    const original = action === 'accept' ? '' : 'Original draft';
    assistant.receive(snap({ draft: original }));
    if (action === 'accept') await vi.advanceTimersByTimeAsync(1000); else await assistant.request('Warmer');
    const source = offer(); assistant.applied({ key: source.key, suggestionId: source.id! }); assistant.activity(true);
    assistant.receive(snap({ draft: 'Reply', editRevision: 1 })); await vi.advanceTimersByTimeAsync(2000); expect(generator).toHaveBeenCalledOnce();
    assistant.receive(snap({ draft: ' Reply ', editRevision: 2 })); await vi.advanceTimersByTimeAsync(2000); expect(generator).toHaveBeenCalledOnce();
    assistant.receive(snap({ draft: 'Reply!', editRevision: 3 })); await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledTimes(2); assistant.cancel();
  });
  test('applied events with a forged offer ID cannot suppress legitimate user edits', async () => {
    const { assistant, generator } = setup();
    assistant.receive(snap()); assistant.applied({ key: 'forged', suggestionId: 'forged' });
    assistant.receive(snap({ draft: 'User draft' })); await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledOnce(); assistant.cancel();
  });
});

describe('fresh configuration and navigation', () => {
  test.each(['tone', 'model', 'provider', 'reasoning', 'profile', 'key'])('a relevant %s change cancels and waits for a fresh snapshot before one new request', async change => {
    const { assistant, state, generator, fresh } = setup();
    state.global.style = 'general'; assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    if (change === 'tone') state.global.tone = 'friendly';
    if (change === 'model') state.models.openai = 'gpt-6-sol';
    if (change === 'provider') state.provider = 'anthropic';
    if (change === 'reasoning') state.reasoning.openai[state.models.openai] = 'high';
    if (change === 'profile') state.profiles.general = { description: 'Edited style', samples: 5, source: 'edited', updatedAt: 0 };
    assistant.reconfigure(change === 'key' ? { keyProvider: 'openai' } : {});
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(2000); expect(generator).toHaveBeenCalledOnce();
    fresh(snap()); await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledTimes(2); assistant.cancel();
  });
  test('irrelevant preferences and profile metadata/learning saves request nothing', async () => {
    const { assistant, state, generator, commands } = setup();
    state.global.style = 'general'; state.profiles.general = { description: 'Style', samples: 5, source: 'selected', updatedAt: 0 };
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    state.global.learnFromSent = true; state.global.directStickerSend = true; state.profiles.general.updatedAt = 100; state.profiles.general.samples = 10;
    assistant.reconfigure(); await vi.advanceTimersByTimeAsync(2000);
    expect(commands.some(c => c.type === 'snapshot')).toBe(false); expect(generator).toHaveBeenCalledOnce();
    state.profiles.general.description = 'New learned style'; assistant.reconfigure({ learning: true });
    assistant.receive(snap({ activity: 1 })); await vi.advanceTimersByTimeAsync(2000); expect(generator).toHaveBeenCalledOnce(); assistant.cancel();
  });
  test('navigation discards the prior snapshot and rejects queued document snapshots', async () => {
    const { assistant, generator, fresh } = setup();
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000); assistant.suspend();
    await assistant.request(); assistant.receive(snap()); await vi.advanceTimersByTimeAsync(2000); expect(generator).toHaveBeenCalledOnce();
    assistant.refresh(true); assistant.receive(snap()); fresh(snap({ chatId: b, settingsId: b, revision: 'new' }));
    await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledTimes(2);
    assistant.suspend(); assistant.refresh(true); fresh(snap({ ready: false })); await vi.advanceTimersByTimeAsync(2000); expect(generator).toHaveBeenCalledTimes(2);
    assistant.receive(snap({ ready: true, revision: 'reloaded' })); await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledTimes(2); assistant.cancel();
  });
  test('an unavailable nonce-tagged snapshot (failed identification) completes the refresh', async () => {
    const { assistant, generator, fresh } = setup();
    assistant.refresh(); fresh(snap({ settingsId: null, ready: false }));
    assistant.receive(snap({ messages: [{ id: 'after', text: 'Still there?', outgoing: false }] }));
    await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledOnce(); assistant.cancel();
  });
});

test('explicit refine and translate retain their reasons and bypass automatic author/draft suppression', async () => {
  const { assistant, generator, offer } = setup();
  assistant.receive(snap({ messages: [{ id: 'own', text: 'Own message', outgoing: true }] }));
  await assistant.request(); const source = offer();
  await assistant.request('Warmer', false, { key: source.key, suggestionId: source.id });
  const revised = offer();
  await assistant.request('Translate the draft to Spanish.', false, { key: revised.key, suggestionId: revised.id, operation: 'translate' });
  expect(generator.mock.calls.map(([r]) => r.reason)).toEqual(['explicit suggest', 'refine', 'translate']);
  assistant.applied({ key: offer().key, suggestionId: offer().id! });
  assistant.receive(snap({ draft: 'Reply', editRevision: 1 }));
  await assistant.request('Shorter'); expect(generator).toHaveBeenCalledTimes(4); assistant.cancel();
});

test('changes to another chat preserve the active cached suggestion and do not request a fresh snapshot', async () => {
  const { assistant, state, generator, commands } = setup();
  assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
  state.chats[b] = { tone: 'friendly' }; assistant.reconfigure();
  assistant.receive(snap({ revision: '2' })); await vi.advanceTimersByTimeAsync(1000);
  expect(generator).toHaveBeenCalledOnce(); expect(commands.some(c => c.type === 'snapshot')).toBe(false); assistant.cancel();
});

test('observed learning updates and explicit draft-learning saves never regenerate unchanged text', async () => {
  const { assistant, state, generator } = setup(); state.global.style = 'conversation'; state.global.learnFromSent = true;
  assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
  const history = Array.from({ length: 5 }, (_, i) => ({ id: `own-${i}`, text: 'An owner example', outgoing: true }));
  assistant.receive(snap({ messages: [...history, ...snap().messages] })); await vi.advanceTimersByTimeAsync(1000);
  expect(generator).toHaveBeenCalledOnce(); expect(state.profiles[a].source).toBe('observed');
  assistant.receive(snap({ draft: 'A user draft' })); await vi.advanceTimersByTimeAsync(1000);
  state.profiles[a] = { description: 'Learned from selection', source: 'selected', samples: 5, updatedAt: 0 };
  assistant.reconfigure({ learning: true }); assistant.receive(snap({ draft: 'A user draft', activity: 1 }));
  await vi.advanceTimersByTimeAsync(2000); expect(generator).toHaveBeenCalledTimes(2); assistant.cancel();
});


test('an explicitly generated own-message follow-up is not offered unsolicited on a later visit', async () => {
  const { assistant, generator, commands } = setup();
  const own = snap({ messages: [{ id: 'own', text: 'My reply', outgoing: true }] });
  assistant.receive(own); await assistant.request();
  const offered = commands.filter(c => c.type === 'suggestion').length;
  assistant.receive(snap({ chatId: b, settingsId: b, messages: [] })); assistant.receive({ ...own, revision: '2' });
  await vi.advanceTimersByTimeAsync(2000); expect(generator).toHaveBeenCalledOnce();
  expect(commands.filter(c => c.type === 'suggestion')).toHaveLength(offered); assistant.cancel();
});

describe('draft lifetime', () => {
  test.each(['cleared', 'sent', 'suggestions disabled'])('the same text gets a new continuation after the previous draft is %s', async end => {
    const { assistant, generator, state, fresh } = setup();
    const draft = snap({ draft: 'Thanks' });
    assistant.receive(draft); await vi.advanceTimersByTimeAsync(1000);
    if (end === 'suggestions disabled') { state.global.suggestions = false; assistant.reconfigure(); fresh(draft); }
    assistant.receive(snap({ draft: end === 'cleared' ? '  ' : '', messages: [{ id: 'own', text: 'Thanks', outgoing: true }] }));
    if (end === 'suggestions disabled') { state.global.suggestions = true; assistant.reconfigure(); fresh(assistant.snapshot); }
    assistant.receive(snap({ draft: 'Thanks', editRevision: 2, messages: [{ id: 'new', text: 'Another question', outgoing: false }] }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(2); assistant.cancel();
  });
  test.each(['accept', 'refine'])('%s suppression ends with its draft, including while suggestions are disabled', async action => {
    const { assistant, generator, offer, state, fresh } = setup();
    assistant.receive(snap({ draft: action === 'refine' ? 'Original' : '' }));
    await assistant.request(action === 'refine' ? 'Warmer' : undefined);
    const source = offer(); assistant.applied({ key: source.key, suggestionId: source.id! });
    assistant.receive(snap({ draft: 'Reply', editRevision: 1 }));
    state.global.suggestions = false; assistant.reconfigure(); fresh(assistant.snapshot);
    assistant.receive(snap({ draft: '', messages: [{ id: 'sent', text: 'Reply', outgoing: true }] }));
    state.global.suggestions = true; assistant.reconfigure(); fresh(assistant.snapshot);
    assistant.receive(snap({ draft: 'Reply', editRevision: 2 })); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(2); assistant.cancel();
  });
  test('draft dismissals survive new context and revisits, then end on a meaningful edit or clear', async () => {
    const { assistant, generator } = setup();
    assistant.receive(snap({ draft: 'Thanks' })); assistant.dismiss();
    assistant.receive(snap({ chatId: b, settingsId: b, messages: [] }));
    assistant.receive(snap({ draft: ' Thanks ', revision: '2', messages: [{ id: 'new', text: 'New question', outgoing: false }] }));
    await vi.advanceTimersByTimeAsync(2000); expect(generator).not.toHaveBeenCalled();
    assistant.receive(snap({ draft: 'Thanks!', editRevision: 1 })); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledOnce(); assistant.dismiss();
    assistant.receive(snap({ draft: '', messages: [] }));
    assistant.receive(snap({ draft: 'Thanks!', editRevision: 2 })); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(2); assistant.cancel();
  });
  test('a transient unready composer does not end an unchanged ongoing draft', async () => {
    const { assistant, generator } = setup();
    assistant.receive(snap({ draft: 'Thanks' })); await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap({ ready: false, draft: '' }));
    assistant.receive(snap({ draft: 'Thanks', revision: '2' })); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledOnce(); assistant.cancel();
  });
  test('an incoming message keeps suppression for an unchanged ongoing draft', async () => {
    const { assistant, generator } = setup();
    assistant.receive(snap({ draft: 'Thanks' })); await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap({ draft: 'Thanks', messages: [{ id: 'new', text: 'New question', outgoing: false }] }));
    await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledOnce(); assistant.cancel();
  });
});

describe.each(['chat override', 'global inherited change'])('conversation-scoped invalidation: %s', scope => {
  test.each(['reply', 'dismissal', 'continuation', 'draft dismissal', 'applied refinement'])('preserves another chat’s %s', async entry => {
    const generator = vi.fn<typeof generate>();
    generator.mockResolvedValue('Reply');
    const { assistant, state, fresh, offer, commands } = setup(generator);
    if (scope === 'global inherited change') state.chats[b] = { tone: 'professional' };
    let saved = snap({ chatId: b, settingsId: b, name: 'B', draft: ['continuation', 'draft dismissal', 'applied refinement'].includes(entry) ? 'Thanks' : '' });
    assistant.receive(saved);
    if (entry === 'draft dismissal') assistant.dismiss();
    else if (entry === 'applied refinement') {
      await assistant.request('Warmer'); const source = offer(); assistant.applied({ key: source.key, suggestionId: source.id! });
      saved = { ...saved, draft: 'Reply', editRevision: 1 }; assistant.receive(saved);
    } else {
      await vi.advanceTimersByTimeAsync(1000);
      if (entry === 'dismissal') assistant.dismiss();
    }
    const calls = generator.mock.calls.length, offers = commands.filter(c => c.type === 'suggestion').length;
    assistant.receive(snap({ messages: [] }));
    if (scope === 'chat override') state.chats[a] = { tone: 'friendly' }; else state.global.tone = 'friendly';
    assistant.reconfigure(); fresh(assistant.snapshot);
    assistant.receive({ ...saved, revision: 'revisited' }); await vi.advanceTimersByTimeAsync(3000);
    expect(generator).toHaveBeenCalledTimes(calls);
    if (entry === 'dismissal' || entry === 'draft dismissal') expect(commands.filter(c => c.type === 'suggestion')).toHaveLength(offers);
    assistant.cancel();
  });
});

describe('learning keeps every request record stable', () => {
  test.each(['reply', 'dismissal', 'continuation', 'draft dismissal', 'applied refinement'])('replacing a general fallback preserves %s', async entry => {
    const generator = vi.fn<typeof generate>();
    generator.mockResolvedValue('Reply');
    const { assistant, state, offer, commands } = setup(generator);
    state.global.style = 'conversation'; state.global.learnFromSent = true;
    state.profiles.general = { description: 'Approved general style', samples: 5, source: 'edited', updatedAt: 0 };
    let saved = snap({ draft: ['continuation', 'draft dismissal', 'applied refinement'].includes(entry) ? 'Thanks' : '' });
    assistant.receive(saved);
    if (entry === 'draft dismissal') assistant.dismiss();
    else if (entry === 'applied refinement') {
      await assistant.request('Warmer'); const source = offer(); assistant.applied({ key: source.key, suggestionId: source.id! });
      saved = { ...saved, draft: 'Reply', editRevision: 1 }; assistant.receive(saved);
    } else { await vi.advanceTimersByTimeAsync(1000); if (entry === 'dismissal') assistant.dismiss(); }
    const calls = generator.mock.calls.length, offers = commands.filter(c => c.type === 'suggestion').length;
    const history = Array.from({ length: 5 }, (_, i) => ({ id: `own-${i}`, text: 'An owner style sample', outgoing: true }));
    saved = { ...saved, messages: [...history, ...saved.messages] };
    assistant.receive(saved); await vi.advanceTimersByTimeAsync(2000);
    expect(state.profiles[a]?.source).toBe('observed');
    assistant.receive(snap({ chatId: b, settingsId: b, messages: [] }));
    assistant.receive({ ...saved, revision: 'revisited' }); await vi.advanceTimersByTimeAsync(2000);
    // An unrelated save after learning must not rediscover the profile transition.
    state.global.directStickerSend = true; assistant.reconfigure();
    expect(generator).toHaveBeenCalledTimes(calls);
    if (entry === 'dismissal' || entry === 'draft dismissal') expect(commands.filter(c => c.type === 'suggestion')).toHaveLength(offers);
    assistant.cancel();
  });
  test.each(['reply', 'dismissal', 'continuation'])('explicit learning preserves inactive %s state', async entry => {
    const generator = vi.fn<typeof generate>();
    generator.mockResolvedValue('Reply');
    const { assistant, state, commands } = setup(generator);
    state.global.style = 'general'; state.profiles.general = { description: 'Old style', samples: 5, source: 'selected', updatedAt: 0 };
    const saved = snap({ chatId: b, settingsId: b, draft: entry === 'continuation' ? 'Thanks' : '' });
    assistant.receive(saved); await vi.advanceTimersByTimeAsync(1000); if (entry === 'dismissal') assistant.dismiss();
    assistant.receive(snap({ messages: [] }));
    state.profiles.general = { description: 'New learned style', samples: 10, source: 'selected', updatedAt: 1 };
    assistant.reconfigure({ learning: true });
    expect(commands.some(c => c.type === 'snapshot')).toBe(false);
    assistant.receive({ ...saved, revision: '2' }); await vi.advanceTimersByTimeAsync(2000);
    expect(generator).toHaveBeenCalledOnce(); assistant.cancel();
  });
});

describe('timers and explicit configuration changes', () => {
  test.each(['empty debounce', 'draft debounce', 'retry'])('unrelated chat settings and learning do not restart a pending %s', async phase => {
    const generator = vi.fn<typeof generate>().mockResolvedValue('Reply');
    if (phase === 'retry') generator.mockRejectedValueOnce(new ProviderError('Transient', true));
    const { assistant, state, commands } = setup(generator);
    state.global.style = 'general'; state.profiles.general = { description: 'Old style', samples: 5, source: 'selected', updatedAt: 0 };
    assistant.receive(snap({ draft: phase === 'draft debounce' ? 'Thanks' : '' }));
    if (phase === 'retry') await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(500);
    state.chats[b] = { tone: 'friendly' }; assistant.reconfigure();
    state.profiles.general.description = 'Learned style'; assistant.reconfigure({ learning: true });
    expect(commands.some(c => c.type === 'snapshot')).toBe(false);
    await vi.advanceTimersByTimeAsync(phase === 'retry' ? 1499 : 499);
    expect(generator).toHaveBeenCalledTimes(phase === 'retry' ? 1 : 0);
    await vi.advanceTimersByTimeAsync(1); expect(generator).toHaveBeenCalledTimes(phase === 'retry' ? 2 : 1); assistant.cancel();
  });
  test.each(['draft dismissal', 'continuation'])('effective changes expire %s controls while preserving requested-draft suppression', async entry => {
    const { assistant, state, generator } = setup();
    const saved = snap({ chatId: b, settingsId: b, draft: 'Thanks' });
    assistant.receive(saved);
    if (entry === 'draft dismissal') assistant.dismiss(); else await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap({ messages: [] })); state.chats[b] = { tone: 'friendly' }; assistant.reconfigure();
    assistant.receive({ ...saved, revision: '2' }); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(entry === 'draft dismissal' ? 0 : 1); assistant.cancel();
  });
  test.each(['edit', 'reset'])('an explicit observed-profile %s invalidates replies and preserves unchanged-draft suppression', async action => {
    const { assistant, state, generator, fresh } = setup();
    state.global.style = 'conversation'; state.profiles[a] = { description: 'Observed style', source: 'observed', samples: 5, updatedAt: 0 };
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap({ draft: 'Thanks' })); await vi.advanceTimersByTimeAsync(1000);
    if (action === 'reset') delete state.profiles[a];
    else state.profiles[a] = { description: 'Edited style', source: 'edited', samples: 5, updatedAt: 1 };
    assistant.reconfigure(); fresh(assistant.snapshot); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(2);
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(3); assistant.cancel();
  });
  test('an explicit general-profile edit affects fallbacks but preserves a conversation override', async () => {
    const { assistant, state, generator, fresh } = setup();
    state.global.style = 'conversation'; state.profiles.general = { description: 'General', source: 'edited', samples: 5, updatedAt: 0 };
    state.profiles[b] = { description: 'Conversation', source: 'observed', samples: 5, updatedAt: 0 };
    assistant.receive(snap({ chatId: b, settingsId: b })); await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    state.profiles.general.description = 'Edited general'; assistant.reconfigure(); fresh(assistant.snapshot);
    await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledTimes(3);
    assistant.receive(snap({ chatId: b, settingsId: b, revision: '2' })); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(3); assistant.cancel();
  });
  test('changed output settings preserve accepted text until a user edit', async () => {
    const { assistant, state, generator, fresh, offer } = setup();
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    const source = offer(); assistant.applied({ key: source.key, suggestionId: source.id! }); assistant.receive(snap({ draft: 'Reply' }));
    state.global.tone = 'friendly'; assistant.reconfigure(); fresh(assistant.snapshot);
    await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledOnce();
    assistant.receive(snap({ draft: 'Reply!', editRevision: 1 })); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(2); assistant.cancel();
  });
  test('reordered quote properties do not miss the latest-message cache', async () => {
    const { assistant, generator } = setup();
    assistant.receive(snap({ messages: [{ id: 'last', text: 'Hello', outgoing: false, quoted: { sender: 'Owner', text: 'Earlier', attachment: 'document', attachmentName: 'notes.pdf' } }] }));
    await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap({ chatId: b, settingsId: b, messages: [] }));
    assistant.receive(snap({ revision: '2', messages: [{ id: 'last', text: 'Hello', outgoing: false, quoted: { attachmentName: 'notes.pdf', attachment: 'document', text: 'Earlier', sender: 'Owner' } }] }));
    await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledOnce(); assistant.cancel();
  });
});

describe('application lifetime evidence (A3)', () => {
  test.each(['accept', 'refine', 'translate'])('%s then send without an inserted-draft snapshot permits a later identical draft', async action => {
    const { assistant, generator, commands, offer } = setup();
    assistant.receive(snap({ draft: action === 'accept' ? '' : 'Original' }));
    if (action === 'accept') await vi.advanceTimersByTimeAsync(1000);
    else await assistant.request('Change', false, action === 'translate' ? { operation: 'translate' } : undefined);
    assistant.applied({ key: offer().key, suggestionId: offer().id! });
    const sent = [...snap().messages, { id: 'sent', text: 'Reply', outgoing: true }];
    assistant.receive(snap({ draft: '', messages: sent }));
    assistant.receive(snap({ draft: 'Reply', messages: [...sent, { id: 'incoming', text: 'Next', outgoing: false }], editRevision: 1 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(2); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Reply' }); assistant.cancel();
  });
  test('clearing before any inserted-draft snapshot ends application suppression', async () => {
    const { assistant, commands, generator, offer } = setup();
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    assistant.applied({ key: offer().key, suggestionId: offer().id! });
    assistant.receive(snap({ draft: '', editRevision: 2 }));
    assistant.receive(snap({ draft: 'Reply', editRevision: 3 })); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(2); expect(commands.at(-1)).toMatchObject({ type: 'suggestion' }); assistant.cancel();
  });
});

describe('unsolicited continuation dispatch eligibility (A4)', () => {
  test.each(['focus', 'caret'])('losing %s during debounce defers automatic dispatch; explicit actions remain available', async change => {
    const { assistant, generator, commands } = setup();
    assistant.receive(snap({ draft: 'Thanks' })); await vi.advanceTimersByTimeAsync(500);
    assistant.receive(snap({ draft: 'Thanks', ...(change === 'focus' ? { focused: false } : { caretAtEnd: false }) }));
    await vi.advanceTimersByTimeAsync(1000); expect(generator).not.toHaveBeenCalled();
    await assistant.request('Warmer'); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', replace: true });
    expect(generator).toHaveBeenCalledOnce(); assistant.cancel();
  });
  test('blur during retry backoff cancels into visible Try again', async () => {
    const { assistant, generator, commands } = setup(vi.fn<typeof generate>().mockRejectedValue(new ProviderError('Transient', true)));
    assistant.receive(snap({ draft: 'Thanks' })); await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap({ draft: 'Thanks', focused: false })); await vi.advanceTimersByTimeAsync(2000);
    expect(generator).toHaveBeenCalledOnce(); expect(commands.at(-1)).toMatchObject({ type: 'notice', retryKey: expect.any(String) }); assistant.cancel();
  });
});

describe('automatic-send settings preserve inline assistance (A6)', () => {
  describe.each(['debounce', 'generation', 'display'])('%s', phase => {
    test.each(['rule', 'enable', 'pause', 'disable', 'resume'] as const)('%s changes preserve the inline result and deadline', async change => {
      let finish!: (text: string) => void;
      const generator = vi.fn<typeof generate>().mockResolvedValue('Reply');
      if (phase === 'generation') generator.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const { assistant, commands, state } = setup(generator);
      state.auto[a] = { ...defaultAuto, enabled: true };
      assistant.receive(snap()); await vi.advanceTimersByTimeAsync(phase === 'debounce' ? 500 : 1000);
      const count = commands.length;
      if (change === 'rule') assistant.updateAutoRules(a, { delaySeconds: 30 });
      else assistant.changeAutoPermission(a, change);
      expect(commands.slice(count).some(c => c.type === 'clear' || c.type === 'snapshot')).toBe(false);
      if (phase === 'generation') { expect(generator.mock.calls[0][0].signal?.aborted).toBe(false); finish('Reply'); }
      if (phase === 'debounce') { await vi.advanceTimersByTimeAsync(499); expect(generator).not.toHaveBeenCalled(); }
      await vi.advanceTimersByTimeAsync(1);
      expect(generator).toHaveBeenCalledOnce(); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Reply' }); assistant.cancel();
    });
  });
});

test('reconfiguration during slow navigation defers refresh and rejects old-document acknowledgements (B2)', async () => {
  const { assistant, commands, state, generator, fresh } = setup();
  assistant.receive(snap()); assistant.refresh();
  const oldNonce = commands.filter(c => c.type === 'snapshot').at(-1)!.nonce;
  assistant.suspend(); const start = commands.length;
  state.global.tone = 'friendly'; assistant.reconfigure();
  expect(commands.slice(start).some(c => c.type === 'snapshot')).toBe(false);
  assistant.receive(snap({ revision: 'old-document' }), false, oldNonce);
  assistant.receive(snap({ revision: 'old-document' })); await assistant.request(); await vi.advanceTimersByTimeAsync(2000);
  expect(generator).not.toHaveBeenCalled(); expect(assistant.snapshot.ready).toBe(false);
  assistant.refresh(true);
  assistant.receive(snap({ revision: 'old-document' }), false, oldNonce); expect(assistant.snapshot.ready).toBe(false);
  fresh(snap({ revision: 'new-document' })); await vi.advanceTimersByTimeAsync(1000);
  expect(generator).toHaveBeenCalledOnce(); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', key: expect.stringContaining('new-document') }); assistant.cancel();
});

describe('document-scoped unidentified applications (B3)', () => {
  test.each(['accept', 'refine', 'translate'])('%s suppresses an unchanged unidentified draft and clears on navigation', async action => {
    const { assistant, store, state, generator, commands, offer, fresh } = setup();
    state.conversations = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`local:${i}`, ['saved-anchor']]));
    const unresolved = snap({ chatId: null, settingsId: null, name: 'Modern', draft: action === 'accept' ? '' : 'Original' });
    expect(new Conversations(store).identify(unresolved)).toBeNull();
    assistant.receive(unresolved);
    if (action === 'accept') await vi.advanceTimersByTimeAsync(1000);
    else await assistant.request('Change', false, action === 'translate' ? { operation: 'translate' } : undefined);
    assistant.applied({ key: offer().key, suggestionId: offer().id! }); assistant.activity(true);
    const applied = { ...unresolved, draft: 'Reply', editRevision: 1 }; assistant.receive(applied);
    await vi.advanceTimersByTimeAsync(2000); expect(generator).toHaveBeenCalledOnce();
    assistant.receive({ ...applied, draft: ' Reply ', editRevision: 2 }); await vi.advanceTimersByTimeAsync(2000); expect(generator).toHaveBeenCalledOnce();
    assistant.receive({ ...applied, draft: 'Reply!', editRevision: 3 }); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(2); expect(commands.at(-1)).toMatchObject({ type: 'suggestion' });
    assistant.suspend(); assistant.refresh(true); fresh({ ...applied, revision: 'new-document' }); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(3); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', key: expect.stringContaining('new-document') }); assistant.cancel();
  });
});

describe('attempt lifecycle siblings', () => {
  test('history loading during backoff preserves the retry and shows its current-key result', async () => {
    const { assistant, commands, generator } = setup(vi.fn<typeof generate>().mockRejectedValueOnce(new ProviderError('Transient', true)).mockResolvedValue('Recovered'));
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap({ messages: [{ id: 'older', text: 'Older', outgoing: true }, ...snap().messages] }));
    expect(generator.mock.calls[0][0].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(generator).toHaveBeenCalledTimes(2); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Recovered', key: expect.stringContaining('older') }); assistant.cancel();
  });
});

describe('live continuation boundaries', () => {
  test.each([['Thank', 's!'], ['Thanks', ' for coming']])('%s + %s is discarded after whitespace edits, including when the exact draft returns', async (draft, suffix) => {
    const { assistant, generator, commands, fresh } = setup(vi.fn<typeof generate>().mockResolvedValue(suffix));
    try {
      assistant.receive(snap({ draft })); await vi.advanceTimersByTimeAsync(1000);
      expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: suffix });
      const start = commands.length;
      const edited = snap({ draft: draft + ' ', editRevision: 1 });
      assistant.receive(edited); expect(commands.at(-1)).toMatchObject({ type: 'clear' });
      assistant.refresh(); fresh(edited);
      assistant.receive({ ...edited, messages: [{ id: 'older', text: 'History', outgoing: true }, ...edited.messages] });
      assistant.receive(snap({ chatId: b, settingsId: b, messages: [] })); assistant.receive({ ...edited, revision: 'return' });
      assistant.receive({ ...edited, draft, editRevision: 2, revision: 'return' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(generator).toHaveBeenCalledOnce();
      expect(commands.slice(start).some(c => c.type === 'suggestion' || c.type === 'notice')).toBe(false);
      assistant.receive({ ...edited, draft: draft + ' you', editRevision: 3, revision: 'return' });
      await vi.advanceTimersByTimeAsync(1000); expect(generator).toHaveBeenCalledTimes(2);
    } finally { assistant.cancel(); }
  });
  test('whitespace changed while a continuation is pending discards its result permanently', async () => {
    let finish!: (text: string) => void;
    const generator = vi.fn<typeof generate>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { assistant, commands } = setup(generator);
    try {
      assistant.receive(snap({ draft: 'Thank' })); await vi.advanceTimersByTimeAsync(1000);
      const start = commands.length;
      assistant.receive(snap({ draft: 'Thank ', editRevision: 1 })); finish('s!'); await vi.advanceTimersByTimeAsync(0);
      assistant.receive(snap({ draft: 'Thank', editRevision: 2 })); await vi.advanceTimersByTimeAsync(3000);
      expect(commands.at(-1)).toMatchObject({ type: 'clear' });
      expect(generator).toHaveBeenCalledOnce();
      expect(commands.slice(start).some(c => c.type === 'suggestion' || c.type === 'notice')).toBe(false);
    } finally { assistant.cancel(); }
  });
});

describe('result redisplay validity', () => {
  test.each(['latest message', 'latest text', 'refresh', 'revisit'])('completed continuations never redisplay after %s changes', async change => {
    const { assistant, commands, generator, fresh } = setup(vi.fn<typeof generate>().mockResolvedValue(' on Monday.'));
    try {
      const original = snap({ draft: 'Yes' });
      assistant.receive(original); await vi.advanceTimersByTimeAsync(1000);
      expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: ' on Monday.' });
      const start = commands.length;
      if (change === 'refresh') { assistant.refresh(); fresh(original); }
      else if (change === 'revisit') {
        assistant.receive(snap({ chatId: b, settingsId: b, messages: [] }));
        assistant.receive({ ...original, revision: 'return' });
      } else assistant.receive({ ...original, messages:
        [{ id: change === 'latest text' ? 'last' : 'correction', text: 'Actually Tuesday', outgoing: false }] });
      await vi.advanceTimersByTimeAsync(3000);
      expect(generator).toHaveBeenCalledOnce();
      expect(commands.slice(start).some(c => c.type === 'suggestion' || c.type === 'notice')).toBe(false);
      expect(commands.at(-1)).toMatchObject({ type: 'clear' });
    } finally { assistant.cancel(); }
  });

  test.each(['', 'Other draft'])('a continuation failure never offers stale recovery for draft %j', async draft => {
    const { assistant, commands, generator } = setup(vi.fn<typeof generate>().mockRejectedValue(new ProviderError('Rejected')));
    try {
      assistant.receive(snap({ draft: 'Thanks' })); await vi.advanceTimersByTimeAsync(1000);
      const notice = commands.at(-1);
      if (notice?.type !== 'notice') throw new Error('Expected recovery notice');
      const start = commands.length;
      assistant.receive(snap({ draft, editRevision: 1 }));
      expect(commands.at(-1)).toMatchObject({ type: 'clear' });
      await assistant.request(undefined, false, { operation: 'retry', key: notice.retryKey });
      expect(generator).toHaveBeenCalledOnce();
      expect(commands.slice(start).some(c => c.type === 'notice')).toBe(false);
    } finally { assistant.cancel(); }
  });

});

describe('empty requests finish across view changes (A1, B1)', () => {
  test.each(['finish on return', 'finish away'])('A→B→A three times with %s costs two requests and offers only the current chat', async finishWhen => {
    const completions: ((text: string) => void)[] = [];
    const generator = vi.fn<typeof generate>().mockImplementation(() => new Promise(resolve => completions.push(resolve)));
    const { assistant, commands } = setup(generator);
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 3; i++) {
      assistant.receive(snap({ chatId: b, settingsId: b, name: 'B', revision: `b${i}` })); await vi.advanceTimersByTimeAsync(1000);
      assistant.receive(snap({ revision: `a${i}` })); await vi.advanceTimersByTimeAsync(1000);
    }
    expect(generator).toHaveBeenCalledTimes(2);
    expect(generator.mock.calls.every(([request]) => !request.signal?.aborted)).toBe(true);
    if (finishWhen === 'finish away') assistant.receive(snap({ chatId: b, settingsId: b, name: 'B', revision: 'away' }));
    const start = commands.length;
    completions[0]('A reply'); await vi.advanceTimersByTimeAsync(0);
    if (finishWhen === 'finish away') {
      expect(commands.slice(start).some(command => command.type === 'suggestion' || command.type === 'notice')).toBe(false);
      assistant.receive(snap({ revision: 'return' }));
    }
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'A reply', key: suggestionKey(assistant.snapshot) });
    completions[1]('B reply'); await vi.advanceTimersByTimeAsync(0);
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'A reply' });
    assistant.receive(snap({ chatId: b, settingsId: b, name: 'B', revision: 'return-b' }));
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'B reply' });
    expect(generator).toHaveBeenCalledTimes(2); assistant.cancel(true);
  });
  test.each(['empty reply', 'continuation', 'refinement'])('older history preserves pending %s and emits a usable current-key result', async kind => {
    let finish!: (text: string) => void;
    const generator = vi.fn<typeof generate>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { assistant, commands } = setup(generator);
    const original = snap({ draft: kind === 'empty reply' ? '' : 'Thank' }); assistant.receive(original);
    let pending: Promise<void> | undefined;
    if (kind === 'refinement') pending = assistant.request('Warmer'); else await vi.advanceTimersByTimeAsync(1000);
    const history = { ...original, messages: [{ id: 'old', text: 'Old', outgoing: true }, ...original.messages] };
    assistant.receive(history); expect(generator.mock.calls[0][0].signal?.aborted).toBe(false);
    finish(kind === 'continuation' ? 's!' : 'Revised'); await pending; await vi.advanceTimersByTimeAsync(0);
    expect(generator).toHaveBeenCalledOnce();
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', key: suggestionKey(history), replace: kind === 'refinement' }); assistant.cancel(true);
  });
  test('navigation during backoff preserves exactly one retry and offers it on return', async () => {
    const { assistant, commands, generator } = setup(vi.fn<typeof generate>().mockRejectedValueOnce(new ProviderError('Transient', true)).mockResolvedValue('Recovered'));
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap({ chatId: b, settingsId: b, messages: [] })); const start = commands.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(generator).toHaveBeenCalledTimes(2); expect(commands.slice(start).some(c => c.type === 'suggestion' || c.type === 'notice')).toBe(false);
    assistant.receive(snap({ revision: 'return' }));
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Recovered' }); assistant.cancel(true);
  });
  test.each(['suspend', 'key', 'quit'])('%s aborts pending work without leaving a failed-attempt cache entry', async event => {
    let finish!: (text: string) => void;
    const generator = vi.fn<typeof generate>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue('Fresh');
    const { assistant, commands, fresh } = setup(generator);
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    if (event === 'suspend') { assistant.suspend(); assistant.refresh(true); }
    else if (event === 'key') assistant.reconfigure({ keyProvider: 'openai' });
    else { assistant.cancel(true); assistant.refresh(); }
    expect(generator.mock.calls[0][0].signal?.aborted).toBe(true);
    const start = commands.length; finish('Stale'); await vi.advanceTimersByTimeAsync(0);
    expect(commands.slice(start).some(c => c.type === 'suggestion' || c.type === 'notice')).toBe(false);
    fresh(snap({ revision: 'new-document' })); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(2); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Fresh' }); assistant.cancel(true);
  });
  test('dismissal during an empty request keeps it un-aborted, hides the completion, and suppresses revisits', async () => {
    let finish!: (text: string) => void;
    const { assistant, generator, commands } = setup(vi.fn<typeof generate>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })));
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000); assistant.dismiss();
    expect(generator.mock.calls[0][0].signal?.aborted).toBe(false);
    const start = commands.length; finish('Dismissed'); await vi.advanceTimersByTimeAsync(0);
    assistant.receive(snap({ chatId: b, settingsId: b, messages: [] })); assistant.receive(snap({ revision: 'return' })); await vi.advanceTimersByTimeAsync(3000);
    expect(generator).toHaveBeenCalledOnce(); expect(commands.slice(start).some(c => c.type === 'suggestion' || c.type === 'notice')).toBe(false); assistant.cancel(true);
  });
});

describe('live request semantics and suppression (A2, A5, reviews 4–6)', () => {
  test.each(['refine', 'translate'])('%s failure retries its original instruction and replacement semantics', async operation => {
    const generator = vi.fn<typeof generate>().mockRejectedValueOnce(new ProviderError('Rejected')).mockResolvedValue('Rewritten');
    const { assistant, commands, state } = setup(generator); state.global.suggestions = false;
    assistant.receive(snap({ draft: 'Original' })); await assistant.request('Original instruction', false, operation === 'translate' ? { operation } : undefined);
    const notice = commands.at(-1); expect(notice).toMatchObject({ type: 'notice', retryKey: expect.any(String) });
    if (notice?.type !== 'notice') throw new Error('Expected notice');
    await assistant.request(undefined, false, { operation: 'retry', key: notice.retryKey });
    expect(generator.mock.calls[1][0]).toMatchObject({ input: generator.mock.calls[0][0].input, system: generator.mock.calls[0][0].system, reason: 'retry' });
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Rewritten', replace: true }); assistant.cancel(true);
  });
  test.each(['Try again', 'backoff'])('continuation %s uses the current exact whitespace boundary', async recovery => {
    const generator = vi.fn<typeof generate>().mockRejectedValueOnce(new ProviderError('Interrupted', recovery === 'backoff')).mockResolvedValue('for coming');
    const { assistant, commands } = setup(generator);
    assistant.receive(snap({ draft: 'Thanks' })); await vi.advanceTimersByTimeAsync(1000);
    assistant.activity(true);
    assistant.receive(snap({ draft: 'Thanks ', editRevision: 1 }));
    if (recovery === 'backoff') await vi.advanceTimersByTimeAsync(2000);
    else await assistant.request(undefined, false, { operation: 'retry', key: suggestionKey(assistant.snapshot) });
    expect(generator).toHaveBeenCalledTimes(2); expect(JSON.parse(generator.mock.calls[1][0].input).draft).toBe('Thanks ');
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'for coming', replace: false }); assistant.cancel(true);
  });
  test.each(['refine', 'translate'])('%s results and failures are never restored after navigation or dismissal', async operation => {
    for (const outcome of ['completed', 'failed'] as const) for (const end of ['dismiss', 'navigation'] as const) {
      const generator = vi.fn<typeof generate>();
      if (outcome === 'failed') generator.mockRejectedValue(new ProviderError('Rejected')); else generator.mockResolvedValue('Rewritten');
      const { assistant, commands, state } = setup(generator); state.global.suggestions = false;
      const original = snap({ draft: 'Original' }); assistant.receive(original);
      await assistant.request('Instruction', false, operation === 'translate' ? { operation } : undefined);
      if (end === 'dismiss') assistant.dismiss();
      else assistant.receive(snap({ chatId: b, settingsId: b, messages: [] }));
      const start = commands.length;
      assistant.receive({ ...original, activity: 1, revision: end === 'navigation' ? 'return' : '1' });
      assistant.receive({ ...assistant.snapshot, messages: [{ id: 'old', text: 'Old', outgoing: true }, ...original.messages] });
      await vi.advanceTimersByTimeAsync(3000);
      expect(generator).toHaveBeenCalledOnce(); expect(commands.slice(start).some(c => c.type === 'suggestion' || c.type === 'notice')).toBe(false);
      await assistant.request('New instruction', false, operation === 'translate' ? { operation } : undefined);
      expect(generator).toHaveBeenCalledTimes(2); assistant.cancel(true);
    }
  });
  test.each(['refine', 'translate'])('%s pending work rejects changed exact draft or latest-message context', async operation => {
    for (const change of ['draft', 'context'] as const) {
      let finish!: (text: string) => void;
      const generator = vi.fn<typeof generate>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const { assistant, commands, state } = setup(generator); state.global.suggestions = false;
      const original = snap({ draft: 'Original' }); assistant.receive(original);
      const work = assistant.request('Instruction', false, operation === 'translate' ? { operation } : undefined);
      assistant.receive({ ...original, ...(change === 'draft' ? { draft: 'Original ', editRevision: 1 } : { messages: [{ id: 'new', text: 'Tuesday', outgoing: false }] }) });
      const start = commands.length; finish('Stale rewrite'); await work;
      expect(commands.slice(start).some(c => c.type === 'suggestion' || c.type === 'notice')).toBe(false); expect(generator).toHaveBeenCalledOnce(); assistant.cancel(true);
    }
  });
  test.each(['automatic', 'explicit'])('%s continuation establishes suppression; revisit restores neither result nor failure', async mode => {
    for (const outcome of ['completed', 'failed', 'pending'] as const) {
      let finish!: (text: string) => void;
      const generator = vi.fn<typeof generate>();
      if (outcome === 'pending') generator.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      else if (outcome === 'failed') generator.mockRejectedValue(new ProviderError('Rejected')); else generator.mockResolvedValue('s!');
      const { assistant, commands } = setup(generator);
      const original = snap({ draft: 'Thank' }); assistant.receive(original);
      const work = mode === 'explicit' ? assistant.request() : undefined;
      if (mode === 'automatic') await vi.advanceTimersByTimeAsync(1000); else if (outcome !== 'pending') await work;
      assistant.receive(snap({ chatId: b, settingsId: b, messages: [] })); const start = commands.length;
      if (outcome === 'pending') { expect(generator.mock.calls[0][0].signal?.aborted).toBe(true); finish('Stale'); await work; }
      assistant.receive({ ...original, draft: ' Thank ', revision: 'return' }); await vi.advanceTimersByTimeAsync(3000);
      expect(generator).toHaveBeenCalledOnce(); expect(commands.at(-1)).toMatchObject({ type: 'clear' });
      expect(commands.slice(start).some(c => c.type === 'suggestion' || c.type === 'notice')).toBe(false);
      assistant.receive({ ...original, draft: 'Thank you', revision: 'return', editRevision: 1 }); generator.mockResolvedValue('!'); await vi.advanceTimersByTimeAsync(1000);
      expect(generator).toHaveBeenCalledTimes(2); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: '!' }); assistant.cancel(true);
    }
  });
  test.each(['', 'Original'])('failed insertion of draft %j shows live recovery without application suppression', async draft => {
    const { assistant, commands, generator, offer } = setup();
    assistant.receive(snap({ draft })); await assistant.request(draft ? 'Warmer' : undefined);
    assistant.applied({ key: offer().key, suggestionId: offer().id!, success: false }); assistant.activity(false);
    assistant.receive({ ...assistant.snapshot, activity: 1 });
    expect(commands.at(-1)).toMatchObject({ type: 'notice', text: 'Could not insert the suggestion. Try again.' });
    await assistant.request(undefined, false, { operation: 'retry', key: suggestionKey(assistant.snapshot) });
    expect(generator).toHaveBeenCalledTimes(2); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', replace: Boolean(draft) }); assistant.cancel(true);
  });
});

test('unidentified requested drafts survive transient unready snapshots within the same document/chat', async () => {
  const { assistant, generator, commands } = setup();
  const unknown = snap({ chatId: null, settingsId: null, draft: 'Thanks' });
  assistant.receive(unknown); await vi.advanceTimersByTimeAsync(1000);
  assistant.receive({ ...unknown, ready: false, draft: '' }); assistant.receive(unknown); await vi.advanceTimersByTimeAsync(2000);
  expect(generator).toHaveBeenCalledOnce(); expect(commands.at(-1)).toMatchObject({ type: 'clear' }); assistant.cancel(true);
});

test('a restored empty offer can recover from failed insertion without storing attempts', async () => {
  const { assistant, generator, offer, commands } = setup();
  assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
  assistant.receive(snap({ chatId: b, settingsId: b, messages: [] })); assistant.receive(snap({ revision: 'return' }));
  assistant.applied({ key: offer().key, suggestionId: offer().id!, success: false });
  await assistant.request(undefined, false, { operation: 'retry', key: suggestionKey(assistant.snapshot) });
  expect(generator).toHaveBeenCalledTimes(2); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Reply' }); assistant.cancel(true);
});

test('three meaningful one-second typing pauses dispatch three continuations, and acceptance adds none until another edit', async () => {
  const { assistant, generator, commands, offer } = setup(vi.fn<typeof generate>().mockResolvedValue('!'));
  for (const [editRevision, draft] of ['Hi', 'Hi there', 'Hi there friend'].entries()) {
    assistant.receive(snap({ draft, editRevision })); await vi.advanceTimersByTimeAsync(1000);
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: '!', replace: false });
  }
  expect(generator).toHaveBeenCalledTimes(3);
  assistant.applied({ key: offer().key, suggestionId: offer().id! }); assistant.activity(true);
  assistant.receive(snap({ draft: 'Hi there friend!', editRevision: 3 })); await vi.advanceTimersByTimeAsync(2000);
  expect(generator).toHaveBeenCalledTimes(3); expect(commands.at(-1)).toMatchObject({ type: 'clear' });
  assistant.receive(snap({ draft: ' Hi  there friend! ', editRevision: 4 })); await vi.advanceTimersByTimeAsync(2000);
  expect(generator).toHaveBeenCalledTimes(3);
  assistant.receive(snap({ draft: 'Hi there friend! Bye', editRevision: 5 })); await vi.advanceTimersByTimeAsync(1000);
  expect(generator).toHaveBeenCalledTimes(4); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: '!' }); assistant.cancel(true);
});

test('a detached completion cannot repopulate an expired output fingerprint', async () => {
  let finish!: (text: string) => void;
  const generator = vi.fn<typeof generate>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue('Fresh');
  const { assistant, state, commands, fresh } = setup(generator);
  assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
  state.global.tone = 'friendly'; assistant.reconfigure();
  expect(generator.mock.calls[0][0].signal?.aborted).toBe(false);
  finish('Stale'); await vi.advanceTimersByTimeAsync(0);
  fresh(snap({ revision: 'current' })); await vi.advanceTimersByTimeAsync(1000);
  expect(generator).toHaveBeenCalledTimes(2); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Fresh' }); assistant.cancel(true);
});

test('requested-draft suppression is bounded with the conversation LRU', async () => {
  const { assistant, generator, commands } = setup();
  for (let i = 0; i < 51; i++) {
    assistant.receive(snap({ chatId: `${i}@c.us`, settingsId: `${i}@c.us`, draft: 'Thanks' }));
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(generator).toHaveBeenCalledTimes(51);
  assistant.receive(snap({ chatId: '0@c.us', settingsId: '0@c.us', draft: 'Thanks', revision: 'return' })); await vi.advanceTimersByTimeAsync(1000);
  expect(generator).toHaveBeenCalledTimes(52); expect(commands.at(-1)).toMatchObject({ type: 'suggestion' }); assistant.cancel(true);
});

test.each(['editing', 'refresh'])('%s detaches an empty request; completion stays cached and invisible until an eligible fresh view', async event => {
  let finish!: (text: string) => void;
  const generator = vi.fn<typeof generate>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { assistant, commands, fresh } = setup(generator);
  assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
  if (event === 'editing') { assistant.activity(true); assistant.receive(snap({ draft: 'User', focused: false, editRevision: 1 })); }
  else assistant.refresh();
  expect(generator.mock.calls[0][0].signal?.aborted).toBe(false);
  const start = commands.length; finish('Cached'); await vi.advanceTimersByTimeAsync(0);
  expect(commands.slice(start).some(c => c.type === 'suggestion' || c.type === 'notice')).toBe(false);
  if (event === 'refresh') fresh(snap({ revision: 'fresh' }));
  else assistant.receive(snap({ editRevision: 2 }));
  expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Cached', key: suggestionKey(assistant.snapshot) });
  expect(generator).toHaveBeenCalledOnce(); assistant.cancel(true);
});


describe('round-two fingerprint and admission regressions', () => {
  test.each(['conversation', 'general'] as const)('eviction plus a %s profile edit discards the old completion (C1/D4)', async style => {
    for (const editBeforeEviction of [false, true]) {
      let finish!: (text: string) => void;
      const generator = vi.fn<typeof generate>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue('NEW');
      const { assistant, state, commands, fresh } = setup(generator);
      state.global.style = style;
      const profileId = style === 'general' ? 'general' : a;
      state.profiles[profileId] = { description: 'OLD', samples: 5, source: 'edited', updatedAt: 1 };
      assistant.reconfigure();
      // The initial settings refresh must be acknowledged before dispatch.
      const refresh = commands.filter(c => c.type === 'snapshot').at(-1);
      assistant.receive(snap(), false, refresh?.type === 'snapshot' ? refresh.nonce : undefined);
      await vi.advanceTimersByTimeAsync(1000);
      assistant.receive(snap({ chatId: b, settingsId: b, messages: [] }));
      const edit = () => { state.profiles[profileId].description = 'NEW'; assistant.reconfigure(); fresh(); };
      if (editBeforeEviction) edit();
      for (let i = 0; i < 55; i++) assistant.receive(snap({ chatId: `evict${i}@c.us`, settingsId: `evict${i}@c.us`, messages: [] }));
      if (!editBeforeEviction) edit();
      const start = commands.length; finish('OLD RESULT'); await vi.advanceTimersByTimeAsync(0);
      expect(commands.slice(start).some(c => c.type === 'suggestion' || c.type === 'notice')).toBe(false);
      assistant.receive(snap({ revision: 'revisit' })); await vi.advanceTimersByTimeAsync(1000);
      expect(generator).toHaveBeenCalledTimes(2); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'NEW' });
      assistant.cancel(true);
    }
  });

  test('detached completion validation cannot evict active draft suppression (C4)', async () => {
    const finishes: ((text: string) => void)[] = [];
    const generator = vi.fn<typeof generate>().mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
    const { assistant, commands } = setup(generator);
    for (let i = 0; i < 5; i++) {
      assistant.receive(snap({ chatId: `pending${i}@c.us`, settingsId: `pending${i}@c.us` }));
      await vi.advanceTimersByTimeAsync(1000);
    }
    assistant.receive(snap({ draft: 'Thanks' })); await vi.advanceTimersByTimeAsync(1000);
    finishes[5]('!'); await vi.advanceTimersByTimeAsync(0);
    // Observation alone evicts old detached records, without generating work.
    for (let i = 0; i < 55; i++) assistant.receive(snap({ chatId: `observe${i}@c.us`, settingsId: `observe${i}@c.us`, messages: [] }));
    assistant.receive(snap({ draft: 'Thanks', revision: 'return' })); await vi.advanceTimersByTimeAsync(1000);
    finishes[6]('!'); await vi.advanceTimersByTimeAsync(0);
    const order = [...assistant['conversations'].keys()];
    for (const finish of finishes.slice(0, 5).reverse()) finish('Detached');
    await vi.advanceTimersByTimeAsync(0);
    expect([...assistant['conversations'].keys()]).toEqual(order);
    expect(assistant['requested'].get(a)).toBe('Thanks');
    assistant.activity(true); assistant.receive(snap({ draft: 'Thanks ', revision: 'return', editRevision: 1 }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(generator).toHaveBeenCalledTimes(7); expect(commands.at(-1)).toMatchObject({ type: 'clear' }); assistant.cancel(true);
  });

  test('five pending empty requests saturate admission; freed capacity admits the skipped key later (C5/D5)', async () => {
    const finishes: ((text: string) => void)[] = [];
    const generator = vi.fn<typeof generate>().mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
    const { assistant, commands } = setup(generator);
    for (let i = 0; i < 8; i++) {
      assistant.receive(snap({ chatId: `cap${i}@c.us`, settingsId: `cap${i}@c.us` }));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(generator).toHaveBeenCalledTimes(5); expect(assistant['inFlight'].size).toBe(5);
    expect(assistant['live']).toBeUndefined(); expect(assistant['cache'].size).toBe(0);
    expect(generator.mock.calls.every(([input]) => !input.signal?.aborted)).toBe(true);
    finishes[0]('Completed elsewhere'); await vi.advanceTimersByTimeAsync(0);
    expect(commands.at(-1)).toMatchObject({ type: 'clear' });
    assistant.receive({ ...assistant.snapshot, activity: 1 }); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(6); expect(assistant['inFlight'].size).toBe(5);
    finishes[5]('Admitted later'); await vi.advanceTimersByTimeAsync(0);
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Admitted later' }); assistant.cancel(true);
  });

  test('unidentified chat switches are open/revisit requests (C6)', async () => {
    const { assistant, generator } = setup();
    assistant.receive(snap({ chatId: null, settingsId: undefined, kind: 'unknown', name: 'A' }));
    await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap({ chatId: null, settingsId: undefined, kind: 'unknown', name: 'B', revision: '2' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(generator.mock.calls.map(([input]) => input.reason)).toEqual(['open/revisit', 'open/revisit']); assistant.cancel(true);
  });

  test('a reverted effective setting cannot revive an earlier fingerprint', async () => {
    let finish!: (text: string) => void;
    const { assistant, state, commands, generator, fresh } = setup(vi.fn<typeof generate>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue('Current'));
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    state.global.tone = 'friendly'; assistant.reconfigure(); state.global.tone = 'natural'; assistant.reconfigure();
    finish('Before edits'); await vi.advanceTimersByTimeAsync(0);
    fresh(snap({ revision: 'fresh' })); await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(2); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Current' }); assistant.cancel(true);
  });
});


describe('explicit requests supersede automatic work for the same context', () => {
  test.each(['suggest', 'refine', 'translate'] as const)('slow explicit %s cancels an empty-request backoff', async operation => {
    let finish!: (text: string) => void;
    const generator = vi.fn<typeof generate>().mockRejectedValueOnce(new ProviderError('Interrupted', true))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { assistant, commands } = setup(generator);
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(500);
    if (operation !== 'suggest') assistant.receive(snap({ draft: 'User draft', focused: false, editRevision: 1 }));
    const pending = assistant.request(operation === 'suggest' ? undefined : 'Instruction', false,
      operation === 'translate' ? { operation } : undefined);
    await vi.advanceTimersByTimeAsync(4000);
    expect(generator.mock.calls.map(([request]) => request.reason)).toEqual(['open/revisit', operation === 'suggest' ? 'explicit suggest' : operation]);
    expect(commands.filter(c => c.type === 'suggestion')).toHaveLength(0);
    finish('Explicit reply'); await pending;
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Explicit reply', replace: operation !== 'suggest' }); assistant.cancel(true);
  });

  test.each(['before', 'after'] as const)('an older automatic completion arriving %s the explicit result cannot overwrite the view or cache', async order => {
    const completions: ((text: string) => void)[] = [];
    const generator = vi.fn<typeof generate>().mockImplementation(() => new Promise(resolve => completions.push(resolve)));
    const { assistant, commands } = setup(generator);
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    const pending = assistant.request();
    if (order === 'before') {
      completions[0]('Old automatic reply'); await vi.advanceTimersByTimeAsync(0);
      expect(commands.filter(c => c.type === 'suggestion')).toHaveLength(0);
    }
    completions[1]('Explicit reply'); await pending;
    if (order === 'after') { completions[0]('Old automatic reply'); await vi.advanceTimersByTimeAsync(0); }
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Explicit reply' });
    assistant.receive(snap({ chatId: b, settingsId: b, messages: [] })); assistant.receive(snap({ revision: 'return' }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(generator).toHaveBeenCalledTimes(2); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Explicit reply' }); assistant.cancel(true);
  });

  test.each(['suggest', 'refine', 'translate'] as const)('explicit %s cancels a continuation backoff', async operation => {
    let finish!: (text: string) => void;
    const generator = vi.fn<typeof generate>().mockRejectedValueOnce(new ProviderError('Interrupted', true))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { assistant, commands } = setup(generator);
    assistant.receive(snap({ draft: 'Thanks' })); await vi.advanceTimersByTimeAsync(1000);
    const pending = assistant.request(operation === 'suggest' ? undefined : 'Instruction', false,
      operation === 'translate' ? { operation } : undefined);
    await vi.advanceTimersByTimeAsync(4000); expect(generator).toHaveBeenCalledTimes(2);
    finish(operation === 'suggest' ? ' for coming' : 'Explicit rewrite'); await pending;
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: operation === 'suggest' ? ' for coming' : 'Explicit rewrite' }); assistant.cancel(true);
  });

  test.each(['suggest', 'refine', 'translate'] as const)('a superseded in-flight result cannot populate the cache when explicit %s fails', async operation => {
    let finishOld!: (text: string) => void;
    let failExplicit!: (error: Error) => void;
    const generator = vi.fn<typeof generate>().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise((_, reject) => { failExplicit = reject; })).mockResolvedValue('Fresh automatic reply');
    const { assistant, commands } = setup(generator);
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    if (operation !== 'suggest') assistant.receive(snap({ draft: 'User draft', focused: false, editRevision: 1 }));
    const pending = assistant.request(operation === 'suggest' ? undefined : 'Instruction', false,
      operation === 'translate' ? { operation } : undefined);
    // Synthetic providers deliberately ignore abort to exercise completion ordering.
    finishOld('Old automatic reply'); await vi.advanceTimersByTimeAsync(0);
    expect(commands.filter(c => c.type === 'suggestion')).toHaveLength(0);
    failExplicit(new ProviderError('Explicit failed')); await pending;
    expect(commands.at(-1)).toMatchObject({ type: 'notice', text: 'Explicit failed' });
    assistant.receive(snap({ chatId: b, settingsId: b, messages: [] })); assistant.receive(snap({ revision: 'return' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(generator).toHaveBeenCalledTimes(3); expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Fresh automatic reply' }); assistant.cancel(true);
  });

  test('superseding A and using Try again preserves B’s detached retry', async () => {
    const generator = vi.fn<typeof generate>().mockRejectedValueOnce(new ProviderError('A interrupted', true))
      .mockRejectedValueOnce(new ProviderError('B interrupted', true)).mockRejectedValueOnce(new ProviderError('Explicit failed'))
      .mockResolvedValueOnce('Explicit recovery').mockResolvedValueOnce('B recovery');
    const { assistant, commands } = setup(generator);
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap({ chatId: b, settingsId: b, name: 'B' })); await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap({ revision: 'return-a' })); await assistant.request();
    expect(commands.at(-1)).toMatchObject({ type: 'notice', text: 'Explicit failed', retryKey: suggestionKey(assistant.snapshot) });
    await assistant.request(undefined, false, { operation: 'retry', key: suggestionKey(assistant.snapshot) });
    await vi.advanceTimersByTimeAsync(3000);
    expect(generator.mock.calls.map(([request]) => request.reason)).toEqual(['open/revisit', 'open/revisit', 'explicit suggest', 'retry', 'retry']);
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Explicit recovery' });
    assistant.receive(snap({ chatId: b, settingsId: b, name: 'B', revision: 'return-b' }));
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'B recovery' }); assistant.cancel(true);
  });

  test('an explicit request supersedes the automatic debounce', async () => {
    const { assistant, generator, commands } = setup();
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(500); await assistant.request();
    await vi.advanceTimersByTimeAsync(3000);
    expect(generator.mock.calls.map(([request]) => request.reason)).toEqual(['explicit suggest']);
    expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Reply' }); assistant.cancel(true);
  });
});

test('continuation backoff waits for the post-activity snapshot before dispatching at its exact boundary', async () => {
  const generator = vi.fn<typeof generate>().mockRejectedValueOnce(new ProviderError('Interrupted', true)).mockResolvedValue('for coming');
  const { assistant, commands } = setup(generator);
  assistant.receive(snap({ draft: 'Thanks' })); await vi.advanceTimersByTimeAsync(1000);
  assistant.activity(true); await vi.advanceTimersByTimeAsync(2500);
  expect(generator).toHaveBeenCalledOnce(); expect(commands.at(-1)).toMatchObject({ type: 'clear' });
  assistant.receive(snap({ draft: 'Thanks ', editRevision: 1 })); await vi.advanceTimersByTimeAsync(0);
  expect(generator).toHaveBeenCalledTimes(2); expect(JSON.parse(generator.mock.calls[1][0].input).draft).toBe('Thanks ');
  expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'for coming' }); assistant.cancel(true);
});

// Providers intentionally ignore abort so every late completion exercises main's ownership checks.
describe('completion between editing activity and its snapshot', () => {
  test.each(['continuation', 'refine'] as const)('%s validates deferred success and failure against the next exact draft', async operation => {
    for (const outcome of ['success', 'error', 'retryable error'] as const) for (const edit of ['whitespace', 'meaningful', 'same', 'context'] as const) {
      let finish!: (text: string) => void, fail!: (error: Error) => void;
      const generator = vi.fn<typeof generate>().mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }))
        .mockResolvedValue('Fresh');
      const { assistant, commands } = setup(generator);
      const original = snap({ draft: 'Thanks' }); assistant.receive(original);
      const pending = operation === 'refine' ? assistant.request('Warmer') : undefined;
      if (operation === 'continuation') await vi.advanceTimersByTimeAsync(1000);
      assistant.activity(true); const start = commands.length;
      if (outcome === 'success') finish(' for coming'); else fail(new ProviderError('Rejected', outcome === 'retryable error'));
      await pending; await vi.advanceTimersByTimeAsync(0);
      expect(assistant['live']?.deferred).toBeDefined(); expect(assistant['live']?.running).toBe(false);
      expect(commands.slice(start).some(c => c.type === 'suggestion' || c.type === 'notice')).toBe(false);
      assistant.receive({ ...original, editRevision: 1, draft: edit === 'whitespace' ? 'Thanks ' : edit === 'meaningful' ? 'Thanks again' : 'Thanks',
        ...(edit === 'context' ? { messages: [{ id: 'new', text: 'Different context', outgoing: false }] } : {}) });
      if (edit === 'same') {
        expect(commands.at(-1)).toMatchObject(outcome === 'success' ? { type: 'suggestion', text: operation === 'refine' ? 'for coming' : ' for coming', replace: operation === 'refine' }
          : { type: 'notice', text: 'Rejected', retryKey: suggestionKey(assistant.snapshot) });
        expect(assistant.message).toBe(outcome === 'success' ? 'Tab to accept · Esc to dismiss' : 'Rejected');
        if (outcome !== 'success') {
          await assistant.request(undefined, false, { operation: 'retry', key: suggestionKey(assistant.snapshot) });
          expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Fresh', replace: operation === 'refine' });
        }
      } else {
        expect(assistant.message).toBe('Ready');
        expect(commands.at(-1)).toMatchObject({ type: 'clear' });
        expect(commands.slice(start).some(c => c.type === 'suggestion' || c.type === 'notice')).toBe(false);
        await vi.advanceTimersByTimeAsync(2000);
        expect(generator).toHaveBeenCalledTimes(edit === 'meaningful' ? 2 : 1);
        if (edit === 'meaningful') expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Fresh' });
        else expect(assistant['live']).toBeUndefined();
      }
      assistant.cancel(true);
    }
  });

  test.each(['suspend', 'refresh', 'dismiss', 'supersede'] as const)('late completions after %s cannot strand or overwrite the live view', async event => {
    for (const outcome of ['success', 'error'] as const) {
      let finish!: (text: string) => void, fail!: (error: Error) => void;
      const generator = vi.fn<typeof generate>().mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }))
        .mockResolvedValue('New rewrite');
      const { assistant, commands } = setup(generator);
      assistant.receive(snap({ draft: 'Thanks' })); const pending = assistant.request('Warmer');
      assistant.activity(true);
      if (event === 'suspend') assistant.suspend();
      else if (event === 'refresh') assistant.refresh();
      else if (event === 'dismiss') assistant.dismiss();
      else await assistant.request('Shorter');
      const start = commands.length;
      if (outcome === 'success') finish('Old rewrite'); else fail(new ProviderError('Old error'));
      await pending; await vi.advanceTimersByTimeAsync(3000);
      expect(commands.slice(start).some(c => c.type === 'suggestion' || c.type === 'notice')).toBe(false);
      expect(assistant.message).toBe(event === 'supersede' ? 'Tab to accept · Esc to dismiss' : 'Ready');
      expect(Boolean(assistant['live'])).toBe(event === 'supersede'); assistant.cancel(true);
    }
  });

  test('hiding a completed offer retires its outcome-free slot, without redispatching an unchanged draft', async () => {
    const { assistant, generator, commands } = setup();
    assistant.receive(snap({ draft: 'Thanks' })); await vi.advanceTimersByTimeAsync(1000);
    assistant.activity(true);
    expect(assistant['live']).toBeUndefined(); expect(assistant.message).toBe('Ready');
    assistant.receive(snap({ draft: 'Thanks ', editRevision: 1 })); await vi.advanceTimersByTimeAsync(3000);
    expect(generator).toHaveBeenCalledOnce(); expect(commands.at(-1)).toMatchObject({ type: 'clear' }); assistant.cancel(true);
  });

  test.each(['continuation', 'refine'] as const)('%s errors arriving after an incompatible exact draft snapshot are retired too', async operation => {
    let fail!: (error: Error) => void;
    const generator = vi.fn<typeof generate>().mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const { assistant, commands } = setup(generator);
    assistant.receive(snap({ draft: 'Thanks' }));
    const pending = operation === 'refine' ? assistant.request('Warmer') : undefined;
    if (operation === 'continuation') await vi.advanceTimersByTimeAsync(1000);
    assistant.receive(snap({ draft: 'Thanks ', editRevision: 1 })); const start = commands.length;
    fail(new ProviderError('Stale failure')); await pending; await vi.advanceTimersByTimeAsync(3000);
    expect(assistant['live']).toBeUndefined(); expect(assistant.message).toBe('Ready');
    expect(generator).toHaveBeenCalledOnce(); expect(commands.at(-1)).toMatchObject({ type: 'clear' });
    expect(commands.slice(start).some(c => c.type === 'notice' || c.type === 'suggestion')).toBe(false); assistant.cancel(true);
  });

  test('interleaved events preserve live ownership, outcomes, timers and visible status after every transition', async () => {
    const completions: { finish: (text: string) => void; fail: (error: Error) => void }[] = [];
    const generator = vi.fn<typeof generate>().mockImplementation(() => new Promise((finish, fail) => completions.push({ finish, fail })));
    const { assistant, commands, state, fresh } = setup(generator);
    const invariant = () => {
      const work = assistant['live'];
      if (!work) {
        expect(assistant.message).not.toMatch(/^(Thinking|Connection interrupted|Tab to accept)/);
        return;
      }
      expect(work.controller.signal.aborted).toBe(false);
      expect(assistant['suspended']).toBe(false); expect(assistant['refreshNonce']).toBeUndefined();
      const phase = work.running ? 'running' : work.awaitingSnapshot ? 'deferred' : work.run ? 'scheduled' : work.error ? 'failed' : work.offer ? 'offered' : 'invalid';
      expect(phase).not.toBe('invalid');
      if (phase === 'running') expect(assistant.message).toBe('Thinking…');
      if (phase === 'deferred') {
        expect(work.deferred || work.run || work.error).toBeTruthy(); expect(work.running).toBe(false);
        expect(assistant.message).toBe(work.deferred ? 'Thinking…' : 'Ready');
        if (work.deferred) expect(work.run).toBeUndefined();
      }
      if (phase === 'scheduled') {
        expect(work.due).toEqual(expect.any(Number));
        expect(assistant['timer']).toBeDefined();
        expect(assistant.message).toBe(work.request ? 'Connection interrupted. Retrying suggestion…' : 'Ready');
      }
      if (phase === 'failed') {
        expect(work.request).toBeDefined();
        expect(assistant.message).toBe(work.awaitingSnapshot ? 'Ready' : work.error);
        if (!work.awaitingSnapshot) expect(commands.filter(c => c.type === 'notice').at(-1)).toMatchObject({ text: work.error, retryKey: suggestionKey(assistant.snapshot) });
      }
      if (phase === 'offered') expect(assistant.message).toBe('Tab to accept · Esc to dismiss');
    };
    // Seeded event selection makes failures reproducible while mixing timer,
    // snapshot, cancellation, settings and ignored-abort completion boundaries.
    let seed = 8, revision = 0;
    const events = new Set<number>();
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    assistant.receive(snap({ draft: 'Thanks' })); invariant();
    for (let i = 0; i < 240; i++) {
      const event = next() % 12; events.add(event);
      switch (event) {
        case 0: assistant.activity(true); break;
        case 1: assistant.receive({ ...assistant.snapshot, draft: assistant.snapshot.draft + ' ', editRevision: ++revision }); break;
        case 2: assistant.receive(snap({ draft: `Draft ${revision++}`, editRevision: revision })); break;
        case 3: void assistant.request('Warmer'); break;
        case 4: await vi.advanceTimersByTimeAsync(1000); break;
        case 5: completions.shift()?.finish('Result'); break;
        case 6: completions.shift()?.fail(new ProviderError('Interrupted', Boolean(next() % 2))); break;
        case 7: assistant.dismiss(); break;
        case 8: assistant.refresh(); break;
        case 9: state.global.tone = state.global.tone === 'natural' ? 'friendly' : 'natural'; assistant.reconfigure(); break;
        case 10: assistant.suspend(); assistant.refresh(true); break;
        case 11:
          if (assistant['refreshNonce']) fresh(snap({ draft: 'Thanks', revision: String(++revision) }));
          else assistant.receive({ ...assistant.snapshot, activity: revision++ });
          break;
      }
      invariant(); await vi.advanceTimersByTimeAsync(0); invariant();
    }
    expect(events.size).toBe(12); expect(generator.mock.calls.length).toBeGreaterThan(5);
    assistant.cancel(true); for (const completion of completions) completion.finish('Late result');
    await vi.advanceTimersByTimeAsync(5000); invariant(); expect(vi.getTimerCount()).toBe(0);
  });
});

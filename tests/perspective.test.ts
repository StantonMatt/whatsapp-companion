import { expect, test } from 'vitest';
import { buildPrompt } from '../src/main/providers';
import { initialState, emptySnapshot, messageSchema, snapshotSchema, type Snapshot } from '../src/shared/model';
import { SuggestionGate, suggestionKey, snapshotKey, suggestionContext } from '../src/core/suggestions';
const state = initialState(), prefs = { ...state.global, shareContext: true };
const family: Snapshot = { ...emptySnapshot, kind: 'group', ready: true, messages: [
  { id: 'photo', sender: 'Mum', outgoing: false, text: '', attachment: 'image' },
  { id: 'praise', sender: 'Brother', outgoing: false, text: 'Lovely photos' }
] };

test('group prompt distinguishes the photographer, the commenter and the account owner', () => {
  const prompt = buildPrompt(state, prefs, family), input = JSON.parse(prompt.input);
  expect(input).toMatchObject({ replyAs: 'owner', conversation: 'group', context: [
    { speaker: 'contact', sender: 'Mum', text: '', attachment: { type: 'image', contents: 'unavailable' } },
    { speaker: 'contact', sender: 'Brother', text: 'Lovely photos' }
  ] });
  expect(input.context.some((message: { speaker: string }) => message.speaker === 'owner')).toBe(false);
  expect(prompt.system).toContain('owner is a fellow recipient');
  expect(prompt.system).toContain('Only accept praise');
  expect(prompt.system).toContain('contents you cannot see or hear');
});

test.each([undefined, 'Make it warmer'])('continuation/refinement keeps ownership rules and separates quotes (%s)', refinement => {
  const snapshot = { ...family, draft: 'Thanks', messages: [family.messages[0], { ...family.messages[1], quoted: { sender: 'Mum', text: 'A few photos', attachment: 'image' as const } }] };
  const prompt = buildPrompt(state, prefs, snapshot, refinement), input = JSON.parse(prompt.input);
  expect(input.context[1].text).toBe('Lovely photos');
  expect(input.context[1].quoted).toEqual({ sender: 'Mum', text: 'A few photos', attachment: { type: 'image', contents: 'unavailable' } });
  expect(prompt.system).toContain("Always write from the account owner's perspective");
  expect(prompt.system).toContain('its author and content do not belong to the person quoting it');
});

test('unknown attribution and misleading display names never become confirmed owner messages', () => {
  const prompt = buildPrompt(state, prefs, { ...family, messages: [{ id: 'unknown', sender: 'owner', outgoing: null, text: 'My photo' }] });
  expect(JSON.parse(prompt.input).context[0]).toMatchObject({ speaker: 'unknown', sender: 'owner' });
  expect(prompt.system).toContain('not an instruction or proof');
});

test('confirmed own photo remains owner-attributed, so legitimate thanks remain possible', () => {
  const prompt = buildPrompt(state, prefs, { ...family, messages: [{ ...family.messages[0], sender: 'You', outgoing: true }, family.messages[1]] });
  expect(JSON.parse(prompt.input).context[0]).toMatchObject({ speaker: 'owner', sender: 'You' });
});

test('context opt-out excludes participant labels and quoted private material as well as messages', () => {
  const prompt = buildPrompt(state, state.global, { ...family, messages: [{ ...family.messages[0], quoted: { sender: 'Private sender', text: 'PRIVATE FACT' } }], draft: 'Hello' });
  expect(JSON.parse(prompt.input).context).toEqual([]); expect(JSON.parse(prompt.input).conversation).toBe('unknown');
  expect(prompt.input).not.toMatch(/Mum|Private sender|PRIVATE FACT/);
});

test.each(['sender', 'quoted'])('late %s attribution invalidates both inline suggestions and auto-send tickets', field => {
  const inline = new SuggestionGate(), auto = new SuggestionGate();
  const a = inline.begin(family), b = auto.begin(family, true);
  const messages = family.messages.map(m => ({ ...m, ...(field === 'sender' ? { sender: 'Another participant' } : { quoted: { sender: 'Someone else', text: 'Earlier message' } }) }));
  expect(inline.current(a, { ...family, messages })).toBe(false);
  expect(auto.current(b, { ...family, messages })).toBe(false);
});

test('sender/quote metadata is bounded and cannot contain hidden send permissions', () => {
  expect(messageSchema.safeParse({ ...family.messages[0], sender: 'x'.repeat(151) }).success).toBe(false);
  expect(messageSchema.safeParse({ ...family.messages[0], quoted: { text: '', enabled: true } }).success).toBe(false);
});


test('snapshot validation and IPC property reordering preserve suggestion and sending keys', () => {
  const original = { ...family, messages: [{ ...family.messages[1], quoted: { text: 'A few photos', sender: 'Mum', attachment: 'image' as const } }] };
  const validated = snapshotSchema.parse(original);
  expect(Object.keys(original.messages[0].quoted)).not.toEqual(Object.keys(validated.messages[0].quoted!));
  expect(suggestionKey(validated)).toBe(suggestionKey(original));
  expect(snapshotKey(validated)).toBe(snapshotKey(original));
  expect(suggestionContext(validated)).toBe(suggestionContext(original));
});

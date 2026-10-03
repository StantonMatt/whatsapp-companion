import { afterEach, beforeEach, expect, test, vi } from 'vitest';
// @ts-expect-error jsdom is the existing Vitest DOM dependency; its typings are not installed.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { File as NodeFile } from 'node:buffer';
import { directStickerScript } from '../src/main/direct-sticker-page';
import { directResolveSchema, directSendSchema, type DirectArguments } from '../src/shared/direct-sticker';

const nonce = '550e8400-e29b-41d4-a716-446655440000';
let dom: JSDOM, page: any, urls: string[];
beforeEach(() => {
  dom = new JSDOM(readFileSync('tests/fixtures/whatsapp.html', 'utf8'), { runScripts: 'dangerously', url: 'https://web.whatsapp.com/' });
  page = dom.window; urls = [];
  page.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(page, 'crypto', { value: webcrypto });
  page.File = NodeFile; page.Blob = Blob;
  page.URL.createObjectURL = (blob: Blob) => { const url = URL.createObjectURL(blob); urls.push(url); return url; };
});
afterEach(() => { dom.window.close(); urls.forEach(url => URL.revokeObjectURL(url)); vi.useRealTimers(); vi.restoreAllMocks(); });
function webp(animated: boolean) {
  const bytes = Buffer.alloc(animated ? 44 : 30); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WEBP', 8);
  bytes.write('VP8X', 12); bytes.writeUInt32LE(10, 16); bytes[24] = bytes[27] = 159;
  if (animated) { bytes.write('ANIM', 30); bytes.writeUInt32LE(6, 34); }
  return { bytes, base64: bytes.toString('base64'), expectedHash: createHash('sha256').update(bytes).digest('hex') };
}
async function prepare(animated = false) {
  const resolved = directResolveSchema.parse(await page.eval(directStickerScript({ phase: 'resolve', nonce, deadline: Date.now() + 2500 })));
  if (resolved.status !== 'resolved') throw new Error('fixture did not resolve');
  const sticker = webp(animated);
  return { sticker, args: { phase: 'send', nonce, deadline: Date.now() + 25_000, destination: resolved.destination, fingerprint: resolved.fingerprint, base64: sticker.base64, expectedHash: sticker.expectedHash } as DirectArguments };
}
const send = async (args: DirectArguments) => directSendSchema.parse(await page.eval(directStickerScript(args)));
const resolve = async () => directResolveSchema.parse(await page.eval(directStickerScript({ phase: 'resolve', nonce, deadline: Date.now() + 2500 })));
function deferred() {
  let resolve!: (value: any) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function deadlineClock() {
  vi.useFakeTimers();
  page.Date.now = () => Date.now();
  // Keep the real event loop out of deadline tests; hashing is tested above
  // against real WebCrypto in all ordinary successful sends.
  vi.spyOn(webcrypto.subtle, 'digest').mockImplementation(async (_algorithm, input) =>
    Uint8Array.from(createHash('sha256').update(Buffer.from(input as ArrayBuffer)).digest()).buffer);
}

test.each(['upload', 'key', 'ephemeral', 'send', 'registration', 'observation'])('stalled %s expires on the call deadline and releases all page resources', async stage => {
  const { args } = await prepare();
  deadlineClock();
  const duration = stage === 'upload' ? 23_000 : 1000;
  args.deadline = Date.now() + duration;
  const held = deferred(), disconnect = vi.spyOn(page.MutationObserver.prototype, 'disconnect');
  const upload = page.require('WAWebUploadManager'), sender = page.require('WAWebSendMsgChatAction');
  const uploadSpy = vi.spyOn(upload, 'encryptAndUpload'), sendSpy = vi.spyOn(sender, 'addAndSendMsgToChat');
  let signal: AbortSignal | undefined;
  if (stage === 'upload') uploadSpy.mockImplementationOnce((options: any) => { signal = options.signal; return held.promise; });
  else if (stage === 'key') vi.spyOn(page.require('WAWebMsgKey'), 'newId').mockReturnValueOnce(held.promise);
  else if (stage === 'ephemeral') vi.spyOn(page.require('WAWebGetEphemeralFieldsMsgActionsUtils'), 'getEphemeralFields').mockReturnValueOnce(held.promise);
  else if (stage === 'send') sendSpy.mockReturnValueOnce(held.promise);
  else sendSpy.mockReturnValueOnce(stage === 'registration' ? [held.promise, Promise.resolve(true)] : [Promise.resolve({}), held.promise]);
  const pending = send(args);
  await vi.advanceTimersByTimeAsync(0);
  expect(uploadSpy).toHaveBeenCalledTimes(1);
  const attempted = ['send', 'registration', 'observation'].includes(stage);
  expect(sendSpy).toHaveBeenCalledTimes(attempted ? 1 : 0);
  expect(page.__whatsappCompanionDirectStickerInFlight).toEqual({ nonce, deadline: args.deadline });
  await vi.advanceTimersByTimeAsync(duration - 1);
  expect(disconnect).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ status: 'finished', outcome: 'unknown', code: 'timeout', phase: attempted ? 'send-invoked' : 'uploaded', uploaded: true, attempted });
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(stage === 'upload' ? true : undefined);
  expect(page.__whatsappCompanionDirectStickerInFlight).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  // Late settlement cannot resume the expired execution or invoke send again.
  held.resolve(stage === 'send' ? [Promise.reject(new Error('late registration failure')), Promise.reject(new Error('late send failure'))] : {});
  await vi.advanceTimersByTimeAsync(0);
  expect(sendSpy).toHaveBeenCalledTimes(attempted ? 1 : 0);
  expect(disconnect).toHaveBeenCalledTimes(1);
  const next = { ...args, nonce: '550e8400-e29b-41d4-a716-446655440001', deadline: Date.now() + 1000 };
  expect(await send(next)).toMatchObject({ outcome: 'confirmed' });
  expect(sendSpy).toHaveBeenCalledTimes(attempted ? 2 : 1);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['bytes', 'digest'])('stalled %s preparation expires before upload', async stage => {
  const { args } = await prepare();
  deadlineClock(); args.deadline = Date.now() + 1000;
  const held = deferred(), disconnect = vi.spyOn(page.MutationObserver.prototype, 'disconnect');
  if (stage === 'bytes') vi.spyOn(NodeFile.prototype, 'arrayBuffer').mockReturnValueOnce(held.promise);
  else vi.mocked(webcrypto.subtle.digest).mockReturnValueOnce(held.promise);
  const pending = send(args);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ outcome: 'unknown', code: 'timeout', phase: 'pre-upload', uploaded: false, attempted: false });
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(page.__whatsappCompanionDirectStickerInFlight).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  held.reject(new Error('late failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(page.fixtureDirectUploads).toHaveLength(0);
});

test('overlapping calls cannot replace another nonce or release its token, even when its timer is overdue', async () => {
  const { args } = await prepare();
  deadlineClock(); args.deadline = Date.now() + 1000;
  const held = deferred(), uploadSpy = vi.spyOn(page.require('WAWebUploadManager'), 'encryptAndUpload').mockReturnValueOnce(held.promise);
  const pending = send(args);
  await vi.advanceTimersByTimeAsync(0);
  const token = page.__whatsappCompanionDirectStickerInFlight;
  const next = { ...args, nonce: '550e8400-e29b-41d4-a716-446655440001', deadline: Date.now() + 5000 };
  for (const overlapping of [args, next]) {
    expect(await send(overlapping)).toMatchObject({ outcome: 'unknown', code: 'in-flight', phase: 'pre-upload', uploaded: false, attempted: false });
    expect(page.__whatsappCompanionDirectStickerInFlight).toBe(token);
  }
  expect(await resolve()).toMatchObject({ status: 'unavailable', code: 'in-flight' });
  // Advance wall time without firing the old deadline timer. Ownership must
  // survive until the suspended execution actually cleans up.
  vi.setSystemTime(Date.now() + 1001);
  expect(await send(next)).toMatchObject({ outcome: 'unknown', code: 'in-flight' });
  expect(uploadSpy).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ outcome: 'unknown', code: 'timeout' });
  expect(page.__whatsappCompanionDirectStickerInFlight).toBeUndefined();
  const current = send({ ...next, deadline: Date.now() + 1000 });
  held.reject(new Error('old nonce late rejection'));
  expect(await current).toMatchObject({ outcome: 'confirmed', nonce: next.nonce });
  expect(page.fixtureDirectSent).toHaveLength(1);
  expect(uploadSpy).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test('a call whose deadline already elapsed does not start page work', async () => {
  const { args } = await prepare();
  expect(await send({ ...args, deadline: Date.now() - 1 })).toMatchObject({ outcome: 'unknown', code: 'timeout', phase: 'pre-upload', uploaded: false, attempted: false });
  expect(await page.eval(directStickerScript({ phase: 'resolve', nonce, deadline: Date.now() - 1 }))).toMatchObject({ status: 'unavailable', code: 'timeout' });
  expect(page.fixtureDirectUploads).toHaveLength(0);
  expect(page.__whatsappCompanionDirectStickerInFlight).toBeUndefined();
});

test.each(['getActive', 'active-model', 'active-array', 'getModelsArray', 'models'])('active chat resolves and stays bound through %s', async source => {
  const chats = page.require('WAWebCollections').Chat;
  const models = chats.getModelsArray(), current = chats.getActive();
  expect(chats.active).toBeUndefined(); // Regression: the old resolver rejected this fixture.
  if (source !== 'getActive') delete chats.getActive;
  if (source.startsWith('active-')) chats.active = () => source === 'active-array' ? [current] : current;
  if (source === 'models') { chats.models = models; delete chats.getModelsArray; }
  const { args } = await prepare();
  expect(await send(args)).toMatchObject({ outcome: 'confirmed', to: '123456@c.us' });
  expect(page.fixtureDirectSent).toHaveLength(1);
});

test.each(['name', 'contact.name', 'formattedTitle-mismatch'])('title fallback %s must match the visible header', async source => {
  const chat = page.require('WAWebCollections').Chat.getActive();
  Object.defineProperty(chat, 'formattedTitle', { value: source === 'formattedTitle-mismatch' ? 'Different internal title' : undefined });
  Object.defineProperty(chat, 'name', { value: source === 'contact.name' ? undefined : 'Alex' });
  const { args } = await prepare();
  expect((args as any).destination.title).toBe('Alex');
  expect(await send(args)).toMatchObject({ outcome: 'confirmed' });
});

test.each([
  ['emoji img', 'Alex 😀', 'Alex <img class="emoji" alt="😀">', 'Alex 😀'],
  ['emoji span alt', 'Alex 😀', 'Alex <span alt="😀" style="background-image:url(emoji.png)"></span>', 'Alex 😀'],
  ['emoji plain text', 'Alex 👩🏽‍💻', 'Alex <span data-testid="emoji" data-plain-text="👩🏽‍💻"></span>', 'Alex 👩🏽‍💻'],
  ['emoji data attribute', 'Alex 😀', 'Alex <span class="emoji" data-emoji="😀"></span>', 'Alex 😀'],
  ['emoji presentation selector', 'Alex \u2764', 'Alex <img class="emoji" alt="\u2764\ufe0f">', 'Alex \u2764'],
  ['bidi marks', '\u200eAlex\u202c', '\u200f\u202aAlex\u202b\u202d\u202e\u2066\u2067\u2068\u2069\ufeff\u061c', 'Alex'],
  ['whitespace', ' Alex\u00a0\u00a0 Smith  ', '  Alex\u00a0 <span> \tSmith\n</span>', 'Alex Smith'],
  ['Unicode NFC', 'Jose\u0301', 'José', 'José'],
  ['Unicode NFD', 'José', 'Jose\u0301', 'José'],
  ['Unicode with embedded bidi', 'Jose\u200e\u0301', 'José', 'José'],
  ['long title', 'A'.repeat(200), 'A'.repeat(200), 'A'.repeat(200)],
  ['raw title over limit', `Alex${' '.repeat(1024)}Smith`, 'Alex Smith', 'Alex Smith']
])('normalized %s title resolves and stays bound through send', async (_kind, modelTitle, html, expected) => {
  const chat = page.require('WAWebCollections').Chat.getActive();
  Object.defineProperty(chat, 'formattedTitle', { value: modelTitle });
  const node = page.document.querySelector('[data-testid="conversation-info-header-chat-title"]');
  node.removeAttribute('title'); node.innerHTML = html;
  const { args } = await prepare();
  expect((args as any).destination).toMatchObject({ wid: '123456@c.us', title: expected });
  expect(await send(args)).toMatchObject({ outcome: 'confirmed', to: '123456@c.us' });
  expect(page.fixtureDirectSent).toHaveLength(1);
});

test('group subject is a title cross-check only for the already-active group model', async () => {
  page.fixtureDirectSetPeer('999999@g.us');
  const chat = page.require('WAWebCollections').Chat.getActive();
  for (const property of ['formattedTitle', 'name', 'contact']) Object.defineProperty(chat, property, { value: undefined });
  chat.groupMetadata = { subject: 'Weekend 😀' };
  const node = page.document.querySelector('[data-testid="conversation-info-header-chat-title"]');
  node.removeAttribute('title'); node.innerHTML = 'Weekend <img alt="😀" class="emoji">';
  const { args } = await prepare();
  expect((args as any).destination).toEqual({ wid: '999999@g.us', title: 'Weekend 😀', type: 'group' });
  expect(await send(args)).toMatchObject({ outcome: 'confirmed', to: '999999@g.us' });
});

test.each(['Other chat', 'Alex Smith', 'alex', 'Álex', 'Ａlex'])('different visible title %s fails in both phases even with a matching title attribute', async text => {
  const { args } = await prepare();
  const node = page.document.querySelector('[data-testid="conversation-info-header-chat-title"]');
  node.textContent = text; // Leave title="Alex": the visible content must match.
  expect(await resolve()).toMatchObject({ status: 'unavailable', code: 'chat-unavailable', detail: 'Chat.title mismatch' });
  expect(await send(args)).toMatchObject({ status: 'finished', outcome: 'not-sent', code: 'chat-changed', detail: 'Chat.title mismatch', uploaded: false, attempted: false });
  expect(page.fixtureDirectUploads).toHaveLength(0); expect(page.fixtureDirectSent).toHaveLength(0);
});

test.each(['missing', 'empty', 'format-only'])('%s header title fails closed in both phases', async kind => {
  const { args } = await prepare();
  const node = page.document.querySelector('[data-testid="conversation-info-header-chat-title"]');
  if (kind === 'missing') node.remove();
  else node.textContent = kind === 'empty' ? '' : '\u200e\u2066\u2069';
  expect(await resolve()).toMatchObject({ status: 'unavailable', code: 'chat-unavailable', detail: 'Chat.header title missing' });
  expect(await send(args)).toMatchObject({ status: 'finished', outcome: 'not-sent', code: 'chat-changed', detail: 'Chat.header title missing', uploaded: false, attempted: false });
  expect(page.fixtureDirectUploads).toHaveLength(0); expect(page.fixtureDirectSent).toHaveLength(0);
});

test('emoji alt changing away and back during upload still revokes the bound chat', async () => {
  const chat = page.require('WAWebCollections').Chat.getActive();
  Object.defineProperty(chat, 'formattedTitle', { value: 'Alex 😀' });
  const node = page.document.querySelector('[data-testid="conversation-info-header-chat-title"]');
  node.removeAttribute('title'); node.innerHTML = 'Alex <img class="emoji" alt="😀">';
  const { args } = await prepare();
  const upload = page.require('WAWebUploadManager'), original = upload.encryptAndUpload;
  vi.spyOn(upload, 'encryptAndUpload').mockImplementationOnce(async options => {
    const result = await original(options), emoji = node.querySelector('img');
    emoji.alt = '😎'; emoji.alt = '😀';
    return result;
  });
  expect(await send(args)).toMatchObject({ outcome: 'not-sent', code: 'chat-changed', phase: 'uploaded', uploaded: true, attempted: false });
  expect(page.fixtureDirectSent).toHaveLength(0);
});

test('LID-only own-identity getter is supported, as on the working spike', async () => {
  delete page.require('WAWebUserPrefsMeUser').getMaybeMePnUser;
  page.fixtureDirectSetPeer('777777@lid');
  const { args } = await prepare();
  expect(await send(args)).toMatchObject({ outcome: 'confirmed', to: '777777@lid' });
});

test('an invalid optional LID identity falls back to PN without a stale failure detail', async () => {
  page.require('WAWebUserPrefsMeUser').getMaybeMeLidUser = () => ({ toString: () => 'PRIVATE-IDENTITY' });
  const { args } = await prepare();
  expect(await send(args)).toMatchObject({ outcome: 'confirmed', code: 'none', detail: null });
});

test.each([
  ['WAWebUserPrefsMeUser', 'getters', 'WAWebUserPrefsMeUser.identity getters missing'],
  ['WAWebWidFactory', 'createWid', 'WAWebWidFactory.createWid missing'],
  ['WAWebCollections', 'Chat.get', 'Collections.Chat.get missing'],
  ['WAWebCollections', 'Msg.get', 'Collections.Msg.get missing'],
  ['WAWebCollections', 'active-accessors', 'Collections.Chat.getActive/active/models missing'],
  ['WAWebUploadManager', 'encryptAndUpload', 'WAWebUploadManager.encryptAndUpload missing'],
  ['WAWebStartMediaUploadQpl', 'startMediaUploadQpl', 'WAWebStartMediaUploadQpl.startMediaUploadQpl missing'],
  ['WAWebSendMsgChatAction', 'addAndSendMsgToChat', 'WAWebSendMsgChatAction.addAndSendMsgToChat missing'],
  ['WAWebMsgKey', 'constructor', 'WAWebMsgKey constructor missing'],
  ['WAWebMsgKey', 'newId', 'WAWebMsgKey.newId missing'],
  ['WAWebGetEphemeralFieldsMsgActionsUtils', 'getEphemeralFields', 'WAWebGetEphemeralFieldsMsgActionsUtils.getEphemeralFields missing']
])('shape failure identifies %s.%s without page data', async (module, property, detail) => {
  const value = page.require(module);
  if (property === 'getters') { for (const key of Object.keys(value)) delete value[key]; }
  else if (property === 'active-accessors') { delete value.Chat.getActive; delete value.Chat.getModelsArray; }
  else if (property === 'constructor') {
    const original = page.require;
    page.require = (name: string) => name === module ? {} : original(name);
  } else {
    const parts = property.split('.');
    delete (parts.length === 2 ? value[parts[0]] : value)[parts.at(-1)!];
  }
  expect(await resolve()).toMatchObject({ status: 'unavailable', code: 'module-shape', detail, fingerprint: null });
  expect(page.fixtureDirectUploads).toHaveLength(0);
  expect(page.fixtureDirectSent).toHaveLength(0);
});

test.each(['getActive', 'active', 'getModelsArray'])('invalid %s result reports the specific accessor', async source => {
  const chats = page.require('WAWebCollections').Chat;
  if (source !== 'getActive') delete chats.getActive;
  chats[source] = () => 'PRIVATE-CHAT-DATA';
  expect(await resolve()).toMatchObject({ status: 'unavailable', code: 'module-shape', detail: `Collections.Chat.${source} result invalid` });
});

test.each(['getActive', 'active', 'getModelsArray', 'models'])('ambiguous active models fail closed (%s)', async source => {
  const chats = page.require('WAWebCollections').Chat;
  const models = chats.getModelsArray();
  for (const chat of models) Object.defineProperty(chat, 'active', { value: true });
  if (source !== 'getActive') delete chats.getActive;
  if (source === 'getActive' || source === 'active') chats[source] = () => models;
  if (source === 'models') { chats.models = models; delete chats.getModelsArray; }
  expect(await resolve()).toMatchObject({ status: 'unavailable', code: 'chat-unavailable', detail: 'Collections.Chat.active ambiguous' });
  expect(page.fixtureDirectUploads).toHaveLength(0);
});

test('no active chat, no usable title, mismatched title or unregistered model fail closed', async () => {
  const chats = page.require('WAWebCollections').Chat, chat = chats.getActive();
  chats.getActive = () => null;
  expect(await resolve()).toMatchObject({ status: 'unavailable', code: 'chat-unavailable' });
  chats.getActive = () => chat;
  for (const property of ['formattedTitle', 'name', 'contact']) Object.defineProperty(chat, property, { value: undefined, configurable: true });
  expect(await resolve()).toMatchObject({ status: 'unavailable', detail: 'Chat.title unavailable' });
  Object.defineProperty(chat, 'name', { value: 'PRIVATE-MODEL-TITLE', configurable: true });
  const mismatch = await resolve();
  expect(mismatch).toMatchObject({ status: 'unavailable', detail: 'Chat.title mismatch' });
  expect(JSON.stringify(mismatch)).not.toContain('PRIVATE-MODEL-TITLE');
  Object.defineProperty(chat, 'name', { value: 'Alex' });
  chats.get = () => undefined;
  expect(await resolve()).toMatchObject({ status: 'unavailable', detail: 'Chat.id invalid' });
});

test('model-list fallback rechecks active flags during upload even with identical titles', async () => {
  delete page.require('WAWebCollections').Chat.getActive;
  const { args } = await prepare(); page.fixtureDirectUploadDelay = 30;
  const pending = send(args);
  while (!page.fixtureDirectUploads.length) await new Promise(resolve => setTimeout(resolve, 1));
  // Change internal active identity without changing the header or DOM.
  const models = page.require('WAWebCollections').Chat.getModelsArray();
  for (const chat of models) Object.defineProperty(chat, 'active', { value: chat.id.toString() === '777777@lid' });
  expect(await pending).toMatchObject({ outcome: 'not-sent', code: 'chat-changed', phase: 'uploaded', uploaded: true, attempted: false });
  expect(page.fixtureDirectSent).toHaveLength(0);
});

test.each(['identity', 'ephemeral'])('runtime shape failure retains its non-PII detail (%s)', async target => {
  const { args } = await prepare();
  if (target === 'identity') {
    const user = page.require('WAWebUserPrefsMeUser');
    for (const key of Object.keys(user)) user[key] = () => null;
  } else page.require('WAWebGetEphemeralFieldsMsgActionsUtils').getEphemeralFields = () => null;
  expect(await send(args)).toMatchObject({ code: 'module-shape', phase: target === 'identity' ? 'pre-upload' : 'uploaded', uploaded: target !== 'identity', attempted: false,
    detail: target === 'identity' ? 'WAWebUserPrefsMeUser.identity unavailable' : 'WAWebGetEphemeralFieldsMsgActionsUtils.getEphemeralFields result invalid' });
  expect(page.fixtureDirectSent).toHaveLength(0);
});

test.each(['module-shape', 'chat-unavailable'] as const)('%s while rechecking chat after upload reports the uploaded phase', async code => {
  const { args } = await prepare();
  const upload = page.require('WAWebUploadManager'), original = upload.encryptAndUpload;
  vi.spyOn(upload, 'encryptAndUpload').mockImplementationOnce(async options => {
    const result = await original(options);
    page.require('WAWebCollections').Chat.getActive = () => code === 'module-shape' ? 'invalid' : null;
    return result;
  });
  expect(await send(args)).toMatchObject({ status: 'finished', code, phase: 'uploaded', outcome: 'not-sent', uploaded: true, attempted: false });
  expect(page.fixtureDirectUploads).toHaveLength(1);
  expect(page.fixtureDirectSent).toHaveLength(0);
});

test('invalid message key after upload reports key-shape in the uploaded phase', async () => {
  const { args } = await prepare();
  const require = page.require, Original = require('WAWebMsgKey');
  class InvalidKey extends Original { constructor(options: any) { super(options); this.fromMe = false; } }
  page.require = (name: string) => name === 'WAWebMsgKey' ? InvalidKey : require(name);
  expect(await send(args)).toMatchObject({ status: 'finished', code: 'key-shape', phase: 'uploaded', outcome: 'not-sent', uploaded: true, attempted: false });
  expect(page.fixtureDirectUploads).toHaveLength(1);
  expect(page.fixtureDirectSent).toHaveLength(0);
});

test.each([
  ['WAWebStartMediaUploadQpl', 'startMediaUploadQpl', 'uploaded', 'upload-failed'],
  ['WAWebUploadManager', 'encryptAndUpload', 'uploaded', 'upload-failed'],
  ['WAWebSendMsgChatAction', 'addAndSendMsgToChat', 'send-invoked', 'send-failed']
] as const)('a synchronous throw from %s.%s preserves the side-effect phase', async (module, method, phase, code) => {
  const { args } = await prepare();
  const invocation = vi.spyOn(page.require(module), method).mockImplementationOnce(() => { throw new Error('private failure'); });
  expect(await send(args)).toMatchObject({ status: 'finished', code, phase, outcome: phase === 'send-invoked' ? 'unknown' : 'not-sent', uploaded: true, attempted: phase === 'send-invoked' });
  expect(invocation).toHaveBeenCalledTimes(1);
});

test.each([false, true])('bundled main-world code uploads original bytes and sends exactly once, preserving draft (%s)', async animated => {
  const { args, sticker } = await prepare(animated), composer = page.document.querySelector('[role=textbox]');
  composer.innerHTML = 'Keep <span contenteditable="false" data-mention="true">@Alex</span> draft'; const original = composer.innerHTML;
  const result = await send(args);
  expect(result).toMatchObject({ status: 'finished', outcome: 'confirmed', phase: 'send-invoked', uploaded: true, attempted: true, ack: 1, type: 'sticker', to: '123456@c.us' });
  expect(page.fixtureDirectSent).toHaveLength(1); expect(page.fixtureDirectUploads).toHaveLength(1);
  expect(page.fixtureDirectSent[0].isAnimated).toBe(animated);
  expect(Buffer.from(await page.fixtureDirectSent[0].file.arrayBuffer())).toEqual(sticker.bytes);
  expect(composer.innerHTML).toBe(original); expect(page.fixtureMakerOpens).toBe(0);
  expect(page.document.querySelector('#expressions-panel-container, #fixture-sticker-editor')).toBeNull();
  expect(page.__animatedSelfSpike).toBeUndefined();
});
test('exact LID and group chat models resolve and send without PN/name lookup', async () => {
  for (const peer of ['777777@lid', '999999@g.us']) {
    page.fixtureDirectSetPeer(peer); const { args } = await prepare();
    expect((args as any).destination.wid).toBe(peer);
    expect(await send(args)).toMatchObject({ outcome: 'confirmed', to: peer });
  }
});
test.each(['fixtureDirectModulesMissing', 'fixtureDirectShapeMismatch'])('missing or changed modules are unavailable before upload (%s)', async flag => {
  page[flag] = true;
  expect(directResolveSchema.parse(await page.eval(directStickerScript({ phase: 'resolve', nonce, deadline: Date.now() + 2500 })))).toMatchObject({ status: 'unavailable' });
  expect(page.fixtureDirectUploads).toHaveLength(0); expect(page.fixtureDirectSent).toHaveLength(0);
});
test('module loss between resolve and send reports safe unavailable, never uploads', async () => {
  const { args } = await prepare(); page.fixtureDirectModulesMissing = true;
  expect(await send(args)).toMatchObject({ status: 'unavailable', outcome: 'not-sent', phase: 'pre-upload', uploaded: false, attempted: false });
});
test('chat switched between resolve and send aborts; identical display titles cannot retarget', async () => {
  const { args } = await prepare(); page.fixtureDirectSetPeer('777777@lid');
  expect(await send(args)).toMatchObject({ outcome: 'not-sent', code: 'chat-changed', phase: 'pre-upload', uploaded: false, attempted: false });
  expect(page.fixtureDirectSent).toHaveLength(0);
});
test('chat switched during upload aborts without attempting send or fallback', async () => {
  const { args } = await prepare(); page.fixtureDirectSwitchDuringUpload = true;
  expect(await send(args)).toMatchObject({ status: 'finished', outcome: 'not-sent', code: 'chat-changed', phase: 'uploaded', uploaded: true, attempted: false });
  expect(page.fixtureDirectSent).toHaveLength(0);
});
test('switch away and back during upload still aborts', async () => {
  const { args } = await prepare(); page.fixtureDirectUploadDelay = 50;
  const pending = send(args);
  while (!page.fixtureDirectUploads.length) await new Promise(resolve => setTimeout(resolve, 1));
  page.fixtureDirectSetPeer('999999@g.us'); page.fixtureDirectSetPeer('123456@c.us');
  expect(await pending).toMatchObject({ outcome: 'not-sent', code: 'chat-changed', attempted: false });
});
test.each(['fixtureDirectUploadFails', 'fixtureDirectUploadShape'])('upload errors never claim unavailable or send (%s)', async flag => {
  const { args } = await prepare(); page[flag] = true;
  expect(await send(args)).toMatchObject({ status: 'finished', outcome: 'not-sent', phase: 'uploaded', uploaded: true, attempted: false });
  expect(page.fixtureDirectSent).toHaveLength(0);
});
test.each(['fixtureDirectSendFails', 'fixtureDirectSendShape'])('send errors consume the sole attempt and report unknown (%s)', async flag => {
  const { args } = await prepare(); page[flag] = true;
  expect(await send(args)).toMatchObject({ status: 'finished', outcome: 'unknown', phase: 'send-invoked', uploaded: true, attempted: true });
  expect(page.fixtureDirectUploads).toHaveLength(1);
});
test('ack zero cannot confirm queued send', async () => {
  const { args } = await prepare(); page.fixtureDirectAck = 0;
  expect(await send(args)).toMatchObject({ outcome: 'unknown', code: 'unconfirmed', attempted: true });
});
test('page verifies hash and bytes before upload, and rejects version/shape changes', async () => {
  const { args } = await prepare();
  expect(await send({ ...args, phase: 'send', expectedHash: 'a'.repeat(64) } as DirectArguments)).toMatchObject({ outcome: 'not-sent', code: 'hash-mismatch', phase: 'pre-upload', uploaded: false });
  page.Debug.VERSION = '2.3000.2';
  expect(await send(args)).toMatchObject({ status: 'unavailable', code: 'module-shape', detail: 'fingerprint changed', phase: 'pre-upload', uploaded: false });
  page.Debug.VERSION = 'private-version';
  expect(directResolveSchema.parse(await page.eval(directStickerScript({ phase: 'resolve', nonce, deadline: Date.now() + 2500 })))).toMatchObject({ status: 'unavailable', code: 'version-missing', fingerprint: null });
});

test('a delayed upload cannot invoke send after the page deadline', async () => {
  const { args } = await prepare(); page.fixtureDirectUploadDelay = 30;
  const pending = send(args);
  while (!page.fixtureDirectUploads.length) await new Promise(resolve => setTimeout(resolve, 1));
  const now = page.Date.now(); page.Date.now = () => now + 26_000;
  expect(await pending).toMatchObject({ status: 'finished', outcome: 'unknown', code: 'timeout', phase: 'uploaded', uploaded: true, attempted: false });
  expect(page.fixtureDirectSent).toHaveLength(0);
});
test('benign header status changes during upload do not change the bound title', async () => {
  const { args } = await prepare(); page.fixtureDirectUploadDelay = 30;
  const pending = send(args);
  while (!page.fixtureDirectUploads.length) await new Promise(resolve => setTimeout(resolve, 1));
  page.document.querySelector('#main header small').textContent = 'online';
  expect(await pending).toMatchObject({ outcome: 'confirmed', attempted: true });
});

import { directArgumentsSchema, type DirectArguments, type DirectDetail, type DirectSendPhase } from '../shared/direct-sticker';
import { readChatTitle } from '../shared/chat-title';

// Self-contained function: main serializes this bundled source, never page data
// as code. Its only page-global state is a non-callable in-flight token; it
// installs no page-callable send endpoint or desktop API.
export async function directStickerMain(readTitle: typeof readChatTitle, args: DirectArguments) {
  const page = window as unknown as {
    require?: (name: string) => any; Debug?: { VERSION?: string };
    __whatsappCompanionDirectStickerInFlight?: { nonce: string; deadline: number };
  };
  let fingerprint: string | null = null, uploaded = false, attempted = false;
  let phase: DirectSendPhase = 'pre-upload';
  const deadline = Math.min(args.deadline, Date.now() + 25_000);
  let code = 'page-error', changed = false, observer: MutationObserver | undefined;
  let detail: DirectDetail | null = null;
  let token: { nonce: string; deadline: number } | undefined, expired = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined, uploadTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined, cancelWait: (() => void) | undefined;
  const result = (outcome: 'confirmed' | 'not-sent' | 'unknown', status = 'finished', model?: any) => ({
    nonce: args.nonce, fingerprint, status, code, detail, phase, outcome, uploaded, attempted,
    ack: typeof model?.ack === 'number' && Number.isInteger(model.ack) && model.ack >= -10 && model.ack <= 10 ? model.ack : null,
    type: model?.type === 'sticker' ? 'sticker' : null, to: model?.to?.toString?.() ?? null
  });
  const fail = (failure: string, check: DirectDetail | null = null): never => { code = failure; detail = check; throw new Error('Direct sticker aborted'); };
  const checkDeadline = () => { if (expired || Date.now() >= deadline) { expired = true; fail('timeout'); } };
  // A pending internal promise cannot retain our waiter/continuation after the
  // deadline. Late fulfillment/rejection is consumed without resuming the send.
  const waitFor = <T>(operation: () => T | PromiseLike<T>): Promise<T> => {
    checkDeadline();
    const pending = operation();
    return new Promise<T>((resolve, reject) => {
      const waiter: { resolve?: (value: T) => void; reject?: (reason: unknown) => void; deadline: number } = { resolve, reject, deadline };
      cancelWait = () => {
        const rejectWait = waiter.reject;
        waiter.resolve = undefined; waiter.reject = undefined;
        rejectWait?.(new Error('Direct sticker deadline'));
      };
      // These handlers retain only the emptied waiter after cancellation, not
      // the page execution, args, chat, observer or uploaded bytes.
      Promise.resolve(pending).then(value => {
        const resolveWait = waiter.resolve, rejectWait = waiter.reject;
        waiter.resolve = undefined; waiter.reject = undefined;
        if (Date.now() >= waiter.deadline) rejectWait?.(new Error('Direct sticker deadline'));
        else resolveWait?.(value);
      }, error => {
        const rejectWait = waiter.reject;
        waiter.resolve = undefined; waiter.reject = undefined;
        rejectWait?.(error);
      });
    });
  };
  try {
    checkDeadline();
    // Even an overdue token remains exclusive until its owner has disconnected
    // observers and unwound. A new execution never takes over an old nonce.
    if (page.__whatsappCompanionDirectStickerInFlight) fail('in-flight');
    token = { nonce: args.nonce, deadline };
    page.__whatsappCompanionDirectStickerInFlight = token;
    deadlineTimer = setTimeout(() => {
      expired = true; code = 'timeout'; detail = null;
      observer?.disconnect(); observer = undefined;
      clearTimeout(uploadTimer); uploadTimer = undefined;
      controller?.abort(); controller = undefined;
      cancelWait?.(); cancelWait = undefined;
    }, Math.max(0, deadline - Date.now()));
    const version = page.Debug?.VERSION;
    if (typeof version !== 'string' || version.length > 80 || !/^\d+(\.\d+){2,}$/.test(version)) fail('version-missing');
    if (typeof page.require !== 'function') fail('modules-missing');
    const mod = (name: string) => {
      let m; try { m = page.require!(name); } catch { fail('modules-missing'); }
      return m;
    };
    const check = (valid: boolean, property: DirectDetail) => { if (!valid) fail('module-shape', property); };
    const identityGetters = ['getMaybeMeLidUser', 'getMeLidUser', 'getMeUser', 'getMaybeMePnUser', 'getMaybeMeUser'];
    const User = mod('WAWebUserPrefsMeUser');
    check(identityGetters.some(k => typeof User?.[k] === 'function'), 'WAWebUserPrefsMeUser.identity getters missing');
    const Wid = mod('WAWebWidFactory');
    check(typeof Wid?.createWid === 'function', 'WAWebWidFactory.createWid missing');
    const Collections = mod('WAWebCollections');
    check(typeof Collections?.Chat?.get === 'function', 'Collections.Chat.get missing');
    check(typeof Collections?.Msg?.get === 'function', 'Collections.Msg.get missing');
    // The live spike established Chat.get, not Chat.active. Prefer getActive;
    // wa-js declares active(), while wwebjs uses getModelsArray for Chat models.
    // Never use ChatCollectionImpl as a singleton or infer an ID from a title.
    const chats = Collections.Chat;
    check(typeof chats.getActive === 'function' || typeof chats.active === 'function' ||
      typeof chats.getModelsArray === 'function' || Array.isArray(chats.models), 'Collections.Chat.getActive/active/models missing');
    const activeResultDetail: DirectDetail = typeof chats.getActive === 'function' ? 'Collections.Chat.getActive result invalid' :
      typeof chats.active === 'function' ? 'Collections.Chat.active result invalid' :
      typeof chats.getModelsArray === 'function' ? 'Collections.Chat.getModelsArray result invalid' : 'Collections.Chat.models result invalid';
    const getActive = () => {
      let candidate;
      try {
        if (typeof chats.getActive === 'function') candidate = chats.getActive();
        else if (typeof chats.active === 'function') candidate = chats.active();
        else {
          const models = typeof chats.getModelsArray === 'function' ? chats.getModelsArray() : chats.models;
          if (!Array.isArray(models)) fail('module-shape', activeResultDetail);
          candidate = models.filter((chat: any) => chat?.active === true);
        }
      } catch {
        fail('module-shape', activeResultDetail);
      }
      if (Array.isArray(candidate)) {
        if (candidate.length > 1) fail('chat-unavailable', 'Collections.Chat.active ambiguous');
        candidate = candidate[0];
      }
      if (candidate == null) fail('chat-unavailable');
      if (typeof candidate !== 'object') fail('module-shape', activeResultDetail);
      return candidate;
    };
    const Upload = mod('WAWebUploadManager');
    check(typeof Upload?.encryptAndUpload === 'function', 'WAWebUploadManager.encryptAndUpload missing');
    const Qpl = mod('WAWebStartMediaUploadQpl');
    check(typeof Qpl?.startMediaUploadQpl === 'function', 'WAWebStartMediaUploadQpl.startMediaUploadQpl missing');
    const Send = mod('WAWebSendMsgChatAction');
    check(typeof Send?.addAndSendMsgToChat === 'function', 'WAWebSendMsgChatAction.addAndSendMsgToChat missing');
    const MsgKey = mod('WAWebMsgKey');
    check(typeof MsgKey === 'function', 'WAWebMsgKey constructor missing');
    check(typeof MsgKey.newId === 'function', 'WAWebMsgKey.newId missing');
    const Ephemeral = mod('WAWebGetEphemeralFieldsMsgActionsUtils');
    check(typeof Ephemeral?.getEphemeralFields === 'function', 'WAWebGetEphemeralFieldsMsgActionsUtils.getEphemeralFields missing');
    fingerprint = `direct-v1:active-get:upload-qpl:key:ephemeral:send-tuple|${version}`;
    const serialized = (wid: any) => {
      if (!wid || typeof wid.toString !== 'function' || typeof wid.equals !== 'function') fail('chat-unavailable', 'Chat.id invalid');
      const s = wid.toString();
      if (typeof s !== 'string' || s.length > 100 || !/^\d+(?:-\d+)?@(c\.us|g\.us|lid)$/.test(s)) fail('chat-unavailable', 'Chat.id invalid');
      return s as string;
    };
    const describe = (chat: any) => {
      const wid = serialized(chat?.id);
      const titleFailure = args.phase === 'send' ? 'chat-changed' : 'chat-unavailable';
      const titles = [chat.formattedTitle, chat.name, chat.contact?.name, wid.endsWith('@g.us') ? chat.groupMetadata?.subject : undefined]
        .filter((t): t is string => typeof t === 'string').map(t => readTitle(t)).filter(t => t.length > 0 && t.length <= 1024);
      if (!titles.length) fail(titleFailure, 'Chat.title unavailable');
      const node = document.querySelector('#main header [data-testid="conversation-info-header-chat-title"]');
      const visibleTitle = readTitle(node);
      if (!visibleTitle) fail(titleFailure, 'Chat.header title missing');
      const title = titles.find(t => t === visibleTitle);
      if (!title) fail(titleFailure, 'Chat.title mismatch');
      if (Collections.Chat.get(chat.id) !== chat || !Wid.createWid(wid)?.equals(chat.id)) fail('chat-unavailable', 'Chat.id invalid');
      return { wid, title, type: wid.endsWith('@lid') ? 'lid' as const : wid.endsWith('@g.us') ? 'group' as const : 'user' as const };
    };
    const active = getActive();
    const destination = describe(active);
    if (args.phase === 'resolve') return { nonce: args.nonce, fingerprint, status: 'resolved', destination };
    if (args.fingerprint !== fingerprint) fail('module-shape', 'fingerprint changed');
    // Resolve exactly the bound model, never a name, alternate PN/LID or new chat.
    const chat = Collections.Chat.get(args.destination.wid);
    const header = document.querySelector('#main header');
    const titleNode = header?.querySelector('[data-testid="conversation-info-header-chat-title"]');
    const title = () => {
      const n = header?.querySelector('[data-testid="conversation-info-header-chat-title"]');
      return readTitle(n);
    };
    const headerChanged = (records: MutationRecord[]) => records.some(r => !titleNode?.isConnected ||
      header?.querySelector('[data-testid="conversation-info-header-chat-title"]') !== titleNode ||
      r.target === titleNode || titleNode.contains(r.target));
    const assertChat = () => {
      changed ||= headerChanged(observer?.takeRecords() ?? []);
      checkDeadline();
      if (changed || !header?.isConnected || getActive() !== chat || Collections.Chat.get(args.destination.wid) !== chat ||
        serialized(chat?.id) !== args.destination.wid || describe(chat).title !== args.destination.title || title() !== args.destination.title) fail('chat-changed');
    };
    if (destination.wid !== args.destination.wid || destination.title !== args.destination.title) fail('chat-changed');
    assertChat();
    // Abort even if the user switches away and back while upload is pending.
    observer = new MutationObserver(records => { changed ||= headerChanged(records); });
    observer.observe(header!, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'alt', 'data-plain-text', 'data-emoji', 'class', 'data-testid'] });
    const binary = atob(args.base64);
    if (binary.length < 20 || binary.length > 1024 * 1024) fail('invalid-webp');
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0)), view = new DataView(bytes.buffer);
    const ascii = (start: number) => String.fromCharCode(...bytes.slice(start, start + 4));
    if (ascii(0) !== 'RIFF' || ascii(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) fail('invalid-webp');
    let animated = false, width: number | undefined, height: number | undefined;
    for (let p = 12; p < bytes.length;) {
      if (p + 8 > bytes.length) fail('invalid-webp');
      const n = view.getUint32(p + 4, true), end = p + 8 + n + (n & 1);
      if (end > bytes.length) fail('invalid-webp');
      const tag = ascii(p); animated ||= tag === 'ANIM';
      if (tag === 'VP8X' && n >= 10) { width = 1 + (bytes[p + 12] | bytes[p + 13] << 8 | bytes[p + 14] << 16); height = 1 + (bytes[p + 15] | bytes[p + 16] << 8 | bytes[p + 17] << 16); }
      if (tag === 'VP8L' && n >= 5) { const bits = view.getUint32(p + 9, true); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff); }
      if (tag === 'VP8 ' && n >= 10) { width = view.getUint16(p + 14, true) & 0x3fff; height = view.getUint16(p + 16, true) & 0x3fff; }
      p = end;
    }
    if (!width || !height || width > 16384 || height > 16384) fail('invalid-webp');
    const file = new File([bytes], 'sticker.webp', { type: 'image/webp', lastModified: Date.now() });
    const buffer = await waitFor(() => file.arrayBuffer());
    const digest = new Uint8Array(await waitFor(() => crypto.subtle.digest('SHA-256', buffer)));
    if ([...digest].map(b => b.toString(16).padStart(2, '0')).join('') !== args.expectedHash) fail('hash-mismatch');
    const filehash = btoa(String.fromCharCode(...digest));
    let me;
    for (const getter of identityGetters) {
      if (typeof User[getter] === 'function') { try { const w = User[getter](); if (w && /@(c\.us|lid)$/.test(serialized(w))) { me = w; break; } } catch {
        // A rejected optional identity must not leak its failure into a later
        // successful getter's outcome or diagnostic.
        code = 'page-error'; detail = null;
      } }
    }
    if (!me) fail('module-shape', 'WAWebUserPrefsMeUser.identity unavailable');
    assertChat();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const mediaKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => alphabet[n % alphabet.length]).join('');
    controller = new AbortController();
    uploadTimer = setTimeout(() => controller?.abort(), 20_000);
    let upload;
    // From this point on there can never be an automatic fallback.
    phase = 'uploaded'; uploaded = true; code = 'upload-failed';
    try { upload = await waitFor(() => Upload.encryptAndUpload({ blob: file, type: 'sticker', signal: controller!.signal, mediaKey, uploadQpl: Qpl.startMediaUploadQpl({ entryPoint: 'MediaUpload' }) })); }
    finally { clearTimeout(uploadTimer); uploadTimer = undefined; controller = undefined; }
    if (!upload || ['url', 'encFilehash', 'directPath', 'mediaKey'].some(k => typeof upload[k] !== 'string' || !upload[k] || upload[k].length > 8192)) fail('upload-shape');
    assertChat();
    const key = new MsgKey({ from: me, to: chat.id, id: await waitFor(() => MsgKey.newId()), selfDir: 'out' });
    if (key.fromMe !== true || !key.remote?.equals(chat.id)) fail('key-shape');
    const ephemeral = await waitFor(() => Ephemeral.getEphemeralFields(chat));
    if (!ephemeral || typeof ephemeral !== 'object' || Array.isArray(ephemeral)) fail('module-shape', 'WAWebGetEphemeralFieldsMsgActionsUtils.getEphemeralFields result invalid');
    const message = { ...ephemeral, ...upload, clientUrl: upload.url, deprecatedMms3Url: upload.url, uploadhash: upload.encFilehash,
      filehash, size: file.size, mimetype: 'image/webp', type: 'sticker', isAnimated: animated, fullWidth: width, fullHeight: height,
      id: key, from: me, to: chat.id, ack: 0, local: true, self: 'out', t: Math.floor(Date.now() / 1000), isNewMsg: true, body: undefined, caption: undefined };
    delete (message as any).__x_id;
    assertChat();
    phase = 'send-invoked'; attempted = true; code = 'send-failed';
    const pending = Send.addAndSendMsgToChat(chat, message); // Exactly one invocation.
    // Consume member rejections even if a promised tuple arrives after expiry.
    // This continuation carries no send state and cannot invoke send again.
    const observeTuple = (tuple: any) => {
      if (Array.isArray(tuple)) for (const p of tuple.slice(0, 2)) if (typeof p?.then === 'function') void Promise.resolve(p).catch(() => {});
      return tuple;
    };
    const tuple = Array.isArray(pending) ? observeTuple(pending) : await waitFor(() => Promise.resolve(pending).then(observeTuple));
    if (!Array.isArray(tuple) || tuple.length !== 2 || tuple.some(p => typeof p?.then !== 'function')) fail('send-shape');
    // Observe separately: an allSettled aggregate could keep the registered
    // model alive forever when its other member never settles.
    const settle = (promise: PromiseLike<any>) => Promise.resolve(promise).then(value => ({ value }), () => ({ value: null }));
    const model = (await waitFor(() => settle(tuple[0]))).value;
    await waitFor(() => settle(tuple[1]));
    if (model && model.type === 'sticker' && model.ack >= 1 && serialized(model.to) === args.destination.wid && model.to.equals(chat.id) && model.id?.fromMe === true &&
      model.id.remote?.equals(chat.id) && model.id.toString?.() === key.toString()) {
      code = 'none'; return result('confirmed', 'finished', model);
    }
    code = 'unconfirmed'; return result('unknown');
  } catch {
    if (expired || Date.now() >= deadline) { expired = true; code = 'timeout'; detail = null; }
    if (args.phase === 'resolve') return { nonce: args.nonce, fingerprint, status: 'unavailable', code, detail };
    // A changed destination is terminal even before upload; it never falls back.
    return result(expired || code === 'in-flight' || attempted ? 'unknown' : 'not-sent', phase === 'pre-upload' && ['modules-missing', 'module-shape', 'version-missing', 'chat-unavailable'].includes(code) ? 'unavailable' : 'finished');
  } finally {
    observer?.disconnect(); observer = undefined;
    clearTimeout(deadlineTimer); deadlineTimer = undefined;
    clearTimeout(uploadTimer); uploadTimer = undefined;
    controller?.abort(); controller = undefined;
    cancelWait?.(); cancelWait = undefined;
    if (token && page.__whatsappCompanionDirectStickerInFlight === token) delete page.__whatsappCompanionDirectStickerInFlight;
    token = undefined;
  }
}
export function directStickerScript(raw: DirectArguments) {
  const args = directArgumentsSchema.parse(raw);
  return `(${directStickerMain.toString()}).bind(null, ${readChatTitle.toString()})(${JSON.stringify(args)})`;
}

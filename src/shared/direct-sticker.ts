import { z } from 'zod';
import { MAX_STICKER_BYTES } from './sticker-limits';
import type { Snapshot } from './model';
import { readChatTitle } from './chat-title';

export const DIRECT_SHAPE = 'direct-v1:active-get:upload-qpl:key:ephemeral:send-tuple';
export const directDestinationSchema = z.object({
  wid: z.string().max(100).regex(/^\d+(?:-\d+)?@(c\.us|g\.us|lid)$/),
  type: z.enum(['user', 'group', 'lid']), title: z.string().min(1).max(1024)
}).strict().refine(d => d.type === (d.wid.endsWith('@lid') ? 'lid' : d.wid.endsWith('@g.us') ? 'group' : 'user'));
export type DirectDestination = z.infer<typeof directDestinationSchema>;
const fingerprintSchema = z.string().max(180).regex(/^direct-v1:active-get:upload-qpl:key:ephemeral:send-tuple\|\d+(?:\.\d+){2,}$/);
export const directFailureSchema = z.enum(['rate-limit', 'none', 'modules-missing', 'module-shape', 'version-missing', 'chat-unavailable', 'chat-changed', 'hash-mismatch', 'invalid-webp', 'upload-failed', 'upload-shape', 'key-shape', 'send-failed', 'send-shape', 'unconfirmed', 'page-error', 'invalid-result', 'timeout', 'in-flight', 'disabled', 'destination-mismatch']);
export type DirectFailure = z.infer<typeof directFailureSchema>;
// Fixed structural labels only: never accept a raw exception or page/chat text.
export const directDetailSchema = z.enum([
  'WAWebUserPrefsMeUser.identity getters missing', 'WAWebUserPrefsMeUser.identity unavailable',
  'WAWebWidFactory.createWid missing', 'Collections.Chat.get missing', 'Collections.Msg.get missing',
  'Collections.Chat.getActive/active/models missing', 'Collections.Chat.getActive result invalid',
  'Collections.Chat.active result invalid', 'Collections.Chat.getModelsArray result invalid', 'Collections.Chat.models result invalid',
  'Collections.Chat.active ambiguous', 'Chat.id invalid', 'Chat.title unavailable', 'Chat.header title missing', 'Chat.title mismatch',
  'WAWebUploadManager.encryptAndUpload missing', 'WAWebStartMediaUploadQpl.startMediaUploadQpl missing',
  'WAWebSendMsgChatAction.addAndSendMsgToChat missing', 'WAWebMsgKey constructor missing', 'WAWebMsgKey.newId missing',
  'WAWebGetEphemeralFieldsMsgActionsUtils.getEphemeralFields missing',
  'WAWebGetEphemeralFieldsMsgActionsUtils.getEphemeralFields result invalid', 'fingerprint changed'
]);
export type DirectDetail = z.infer<typeof directDetailSchema>;
// 'uploaded' means upload/network work has started, even if it later fails.
export const directSendPhaseSchema = z.enum(['pre-upload', 'uploaded', 'send-invoked']);
export type DirectSendPhase = z.infer<typeof directSendPhaseSchema>;
const envelope = { nonce: z.string().uuid(), fingerprint: fingerprintSchema.nullable() };
export const directResolveSchema = z.discriminatedUnion('status', [
  z.object({ ...envelope, status: z.literal('resolved'), fingerprint: fingerprintSchema, destination: directDestinationSchema }).strict(),
  z.object({ ...envelope, status: z.literal('unavailable'), code: z.enum(['modules-missing', 'module-shape', 'version-missing', 'chat-unavailable', 'timeout', 'in-flight']), detail: directDetailSchema.nullable().optional() }).strict()
    .refine(r => r.code !== 'module-shape' || r.detail != null)
]);
export const directSendSchema = z.object({
  ...envelope, status: z.enum(['unavailable', 'finished']), code: directFailureSchema,
  phase: directSendPhaseSchema,
  detail: directDetailSchema.nullable().optional(),
  outcome: z.enum(['confirmed', 'not-sent', 'unknown']), uploaded: z.boolean(), attempted: z.boolean(),
  ack: z.number().int().min(-10).max(10).nullable(), type: z.literal('sticker').nullable(), to: z.string().max(100).nullable()
}).strict().refine(r =>
  (r.uploaded === (r.phase !== 'pre-upload') && r.attempted === (r.phase === 'send-invoked')) &&
  (r.code !== 'module-shape' || r.detail != null) &&
  (r.status !== 'unavailable' || (r.phase === 'pre-upload' && r.outcome === 'not-sent' && ['modules-missing', 'module-shape', 'version-missing', 'chat-unavailable'].includes(r.code))) &&
  (r.outcome !== 'confirmed' || (r.status === 'finished' && r.fingerprint !== null && r.uploaded && r.attempted && r.ack !== null && r.ack >= 1 && r.type === 'sticker' && r.to !== null && r.code === 'none')) &&
  (r.outcome !== 'not-sent' || !r.attempted));
export const directArgumentsSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('resolve'), nonce: z.string().uuid(), deadline: z.number().int().positive().safe() }).strict(),
  z.object({ phase: z.literal('send'), nonce: z.string().uuid(), deadline: z.number().int().positive().safe(), destination: directDestinationSchema, fingerprint: fingerprintSchema,
    base64: z.string().min(16).max(Math.ceil(MAX_STICKER_BYTES / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .refine(s => s.length / 4 * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0) <= MAX_STICKER_BYTES),
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict()
]);
export type DirectArguments = z.infer<typeof directArgumentsSchema>;
export function matchesDirectDestination(destination: DirectDestination, snapshot: Snapshot) {
  // PN and LID are distinct identities. Never translate one into the other by title.
  const peer = snapshot.chatId?.replace(/@s\.whatsapp\.net$/, '@c.us');
  const title = readChatTitle(destination.title);
  return snapshot.conversationOpen && Boolean(title) && title === readChatTitle(snapshot.name) && (!peer || peer === destination.wid) &&
    (snapshot.kind !== 'group' || destination.type === 'group') && (snapshot.kind !== 'direct' || destination.type !== 'group');
}

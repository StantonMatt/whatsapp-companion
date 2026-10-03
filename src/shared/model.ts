import { z } from 'zod';
import { MAX_STICKER_DATA_URL_LENGTH, MAX_STICKER_BYTES, MAX_LIBRARY_BYTES, MAX_LIBRARY_STICKERS } from './sticker-limits';
import type { StickerSend, StickerSendBlockedReason } from './sticker-transfer';

export const providerSchema = z.enum(['openai', 'anthropic']);
export type Provider = z.infer<typeof providerSchema>;
export const modelIdSchema = z.string().min(1).max(250).regex(/^[a-zA-Z0-9._:-]+$/);
export type ModelOption = { id: string; name: string };
export type ModelsResult = { models: ModelOption[]; error?: string; cancelled?: boolean };
export const reasoningEffortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export const preferencesSchema = z.object({
  directStickerSend: z.boolean().default(false),
  suggestions: z.boolean(),
  tone: z.enum(['natural', 'friendly', 'professional', 'direct']),
  length: z.enum(['brief', 'balanced', 'detailed']),
  language: z.string().max(80),
  emoji: z.enum(['match', 'none', 'light']),
  instructions: z.string().max(4000),
  style: z.enum(['off', 'general', 'conversation']),
  learnFromSent: z.boolean(),
  shareContext: z.boolean()
}).strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export const directStickerDisabledReasonSchema = z.enum(['logged-out', 'account-warning', 'send-error', 'whatsapp-changed']);
export type DirectStickerDisabledReason = z.infer<typeof directStickerDisabledReasonSchema>;
// Safety metadata is main-owned and global only, never a preference patch.
const globalPreferencesSchema = preferencesSchema.extend({
  directStickerDisabledReason: directStickerDisabledReasonSchema.optional(),
  directStickerDisabledAt: z.number().int().nonnegative().safe().optional()
});
// Defaults migrate complete global preferences; sparse patches/overrides must
// leave omitted fields alone (Zod's partial() preserves field defaults).
const preferencesPatchSchema = preferencesSchema.extend({ directStickerSend: z.boolean() }).partial();
export type ChatKind = 'direct' | 'group' | 'unknown';
export const chatIdSchema = z.string().regex(/^[\d-]+@(c\.us|s\.whatsapp\.net|g\.us|lid)$/);
export const settingsIdSchema = z.union([chatIdSchema, z.string().regex(/^local:[0-9a-f-]{36}$/)]);
export const scopeSchema = z.union([z.literal('global'), settingsIdSchema]);
export const panelSchema = z.enum(['settings', 'stickers', 'chat']).nullable();
export type Panel = z.infer<typeof panelSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export const autoSchema = z.object({
  enabled: z.boolean(), startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
  dailyLimit: z.number().int().min(1).max(20),
  cooldownMinutes: z.number().int().min(1).max(1440),
  delaySeconds: z.number().int().min(15).max(120),
  paused: z.boolean()
}).strict();
export type AutoRules = z.infer<typeof autoSchema>;
export const autoPatchSchema = autoSchema.omit({ enabled: true, paused: true }).partial();
export type AutoPatch = z.infer<typeof autoPatchSchema>;
export const autoPermissionSchema = z.enum(['enable', 'disable', 'pause', 'resume']);
export type AutoPermission = z.infer<typeof autoPermissionSchema>;
export const defaultAuto: AutoRules = { enabled: false, startHour: 9, endHour: 18, dailyLimit: 5, cooldownMinutes: 10, delaySeconds: 30, paused: false };
export const defaults: Preferences = {
  directStickerSend: false, suggestions: false, tone: 'natural', length: 'brief', language: 'Match the conversation',
  emoji: 'match', instructions: '', style: 'off', learnFromSent: false, shareContext: false
};
const attachmentSchema = z.enum(['image', 'sticker', 'audio', 'video', 'document']);
const attachmentNameSchema = z.string().min(1).max(255);
export const messageSchema = z.object({
  id: z.string().max(250), text: z.string().max(4000), outgoing: z.boolean().nullable(),
  sender: z.string().min(1).max(150).optional(), attachment: attachmentSchema.optional(), attachmentName: attachmentNameSchema.optional(),
  quoted: z.object({ sender: z.string().min(1).max(150).optional(), text: z.string().max(4000), attachment: attachmentSchema.optional(), attachmentName: attachmentNameSchema.optional() }).strict().optional()
}).strict();
export type Message = z.infer<typeof messageSchema>;
export const snapshotSchema = z.object({
  chatId: chatIdSchema.nullable(), name: z.string().max(150), kind: z.enum(['direct', 'group', 'unknown']),
  messages: z.array(messageSchema).max(30), draft: z.string().max(8000),
  // A visible, stable conversation can be open even when its composer is missing.
  conversationOpen: z.boolean(),
  composing: z.boolean(), focused: z.boolean(), caretAtEnd: z.boolean(), ready: z.boolean(), atBottom: z.boolean(),
  revision: z.string().max(100),
  stickerPreparation: z.string().max(100).optional(),
  activity: z.number().int().nonnegative(),
  editRevision: z.number().int().nonnegative(),
  draftIssue: z.enum(['too-long', 'unsupported']).nullable(),
}).strict();
// settingsId is assigned only in the main process; the remote schema rejects it.
export type Snapshot = z.infer<typeof snapshotSchema> & { settingsId?: string | null };
export const emptySnapshot: Snapshot = { chatId: null, name: '', kind: 'direct', messages: [], draft: '', conversationOpen: false, composing: false, focused: false, caretAtEnd: false, ready: false, atBottom: false, revision: '', activity: 0, editRevision: 0, draftIssue: null };
export const profileSchema = z.object({
  description: z.string().max(2000), samples: z.number().int().min(0), updatedAt: z.number(),
  source: z.enum(['observed', 'selected', 'edited'])
}).strict();
export type StyleProfile = z.infer<typeof profileSchema>;
export const stickerImageSchema = z.string().max(MAX_STICKER_DATA_URL_LENGTH).regex(/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/);
const stickerBaseSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  firstSeen: z.number(), lastSeen: z.number(),
  fingerprint: z.object({
    version: z.literal(1), animated: z.boolean(), hash: z.string().regex(/^[a-f0-9]{16}$/),
    // 9 × 8 RGB pixels, composited over white, encoded as exactly 216 bytes.
    pixels: z.string().length(288).regex(/^[A-Za-z0-9+/]+$/)
  }).strict().optional()
}).strict();
const searchTermsSchema = z.string().max(4000);
// Read existing collections without dropping any labels, synonyms or captions.
// Subsequent saves use the single searchTerms field.
export const legacyStickerSchema = z.union([
  stickerBaseSchema.extend({ image: stickerImageSchema }).extend({ searchTerms: searchTermsSchema }).strict(),
  stickerBaseSchema.extend({ image: stickerImageSchema }).extend({ tags: z.array(z.string().max(60)).max(30), keywords: z.string().max(1000) }).strict()
    .transform(({ tags, keywords, ...sticker }) => ({ ...sticker, searchTerms: [...tags, keywords].filter(Boolean).join(', ') }))
]);
export const stickerGroupIdSchema = z.string().uuid();
export const stickerGroupNameSchema = z.string().trim().min(1).max(40);
export const stickerGroupSchema = z.object({ id: stickerGroupIdSchema, name: stickerGroupNameSchema }).strict();
export type StickerGroup = z.infer<typeof stickerGroupSchema>;
export const stickerSchema = stickerBaseSchema.extend({
  groups: z.array(stickerGroupIdSchema).max(50).default([]),
  searchTerms: searchTermsSchema, kind: z.enum(['static', 'animated']), size: z.number().int().min(12).max(MAX_STICKER_BYTES)
}).strict();
export const discoveredStickerSchema = stickerBaseSchema.extend({ searchTerms: searchTermsSchema, image: stickerImageSchema }).strict();
export type DiscoveredSticker = z.infer<typeof discoveredStickerSchema>;
export type Sticker = z.infer<typeof stickerSchema>;
const stateBaseSchema = z.object({
  version: z.literal(1), global: globalPreferencesSchema,
  direct: preferencesPatchSchema, group: preferencesPatchSchema,
  chats: z.record(z.string(), preferencesPatchSchema),
  provider: providerSchema, models: z.object({ openai: modelIdSchema, anthropic: modelIdSchema }),
  reasoning: z.object({ openai: z.record(modelIdSchema, reasoningEffortSchema), anthropic: z.record(modelIdSchema, reasoningEffortSchema) }).strict().default(() => ({ openai: {}, anthropic: {} })),
  conversations: z.record(z.string(), z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(200)).default({}),
  profiles: z.record(z.string(), profileSchema),
  auto: z.record(z.string(), autoSchema),
  ledger: z.record(z.string(), z.array(z.object({ at: z.number(), messageId: z.string().max(250) })).max(100)),
  stickers: z.array(legacyStickerSchema).max(MAX_LIBRARY_STICKERS),
  forgottenStickers: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(5000).default([])
}).strict();
export const legacyStateSchema = stateBaseSchema;
export const stateSchema = stateBaseSchema.extend({ version: z.literal(2), stickers: z.array(stickerSchema).max(MAX_LIBRARY_STICKERS), stickerGroups: z.array(stickerGroupSchema).max(50).default([]) }).strict()
  .superRefine((state, context) => {
    const groupIds = new Set(state.stickerGroups.map(g => g.id));
    const names = new Set(state.stickerGroups.map(g => g.name.toLowerCase()));
    if (groupIds.size !== state.stickerGroups.length || names.size !== state.stickerGroups.length) context.addIssue({ code: 'custom', message: 'Duplicate sticker groups.' });
    if (state.stickers.some(s => new Set(s.groups).size !== s.groups.length || s.groups.some(id => !groupIds.has(id)))) context.addIssue({ code: 'custom', message: 'Invalid sticker group references.' });
    const ids = new Set(state.stickers.map(s => s.id));
    if (ids.size !== state.stickers.length || state.stickers.some(s => state.forgottenStickers.includes(s.id))) context.addIssue({ code: 'custom', message: 'Invalid sticker references.' });
    if (state.stickers.reduce((total, s) => total + s.size, 0) > MAX_LIBRARY_BYTES) context.addIssue({ code: 'custom', message: 'Sticker library is full.' });
  });
export type State = z.infer<typeof stateSchema>;
export function initialState(): State {
  return { version: 2, global: { ...defaults }, direct: {}, group: {}, chats: {},
    provider: 'openai', models: { openai: 'gpt-6-luna', anthropic: 'claude-sonnet-5-5' }, reasoning: { openai: {}, anthropic: {} },
    conversations: {}, profiles: {}, auto: {}, ledger: {}, stickers: [], stickerGroups: [], forgottenStickers: [] };
}
export type ViewBounds = { x: number; y: number; width: number; height: number };
export type StickerShield = { nonce: string; image: string; bounds: ViewBounds; panel: ViewBounds };

export type Status = {
  sequence: number;
  runtimePaused: boolean;
  state: State; chat: Pick<Snapshot, 'chatId' | 'settingsId' | 'name' | 'kind' | 'ready'> & { canSendSticker: boolean; stickerSendBlockedReason?: StickerSendBlockedReason; loadedSentSamples?: number; destinationToken?: string };
  panel?: Panel; theme?: 'dark' | 'light';
  stickerLibraryError?: string;
  stickerLocation?: { id: string; state: 'looking' | 'found' | 'missing' | 'unavailable' } | null;
  stickerSend?: StickerSend | null;
  stickerShield?: StickerShield | null;
  keys: Record<Provider, boolean>; secureStorage: boolean; fixture: boolean;
  message: string; pending: { text: string; due: number } | null;
};
export type StatusUpdate = Omit<Status, 'state'> & { state?: Omit<State, 'stickers'>; stickerChanges?: { upsert: Sticker[]; removed: string[] } };
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('preferences'), scope: scopeSchema, patch: preferencesPatchSchema }).strict()
    .refine(action => action.scope === 'global' || action.patch.directStickerSend === undefined),
  z.object({ type: z.literal('resetPreferences'), scope: scopeSchema }).strict(),
  z.object({ type: z.literal('resetStylePreferences'), scope: settingsIdSchema }).strict(),
  z.object({ type: z.literal('provider'), provider: providerSchema, model: modelIdSchema }).strict(),
  z.object({ type: z.literal('reasoning'), provider: providerSchema, model: modelIdSchema, effort: reasoningEffortSchema }).strict(),
  z.object({ type: z.literal('key'), provider: providerSchema, persist: z.boolean() }).strict(),
  z.object({ type: z.literal('deleteKey'), provider: providerSchema }).strict(),
  z.object({ type: z.literal('testProvider') }).strict(),
  z.object({ type: z.literal('autoRules'), chatId: chatIdSchema, patch: autoPatchSchema }).strict(),
  z.object({ type: z.literal('autoPermission'), chatId: chatIdSchema, permission: autoPermissionSchema }).strict(),
  z.object({ type: z.literal('profile'), scope: z.union([z.literal('general'), settingsIdSchema]), description: z.string().max(2000) }).strict(),
  z.object({ type: z.literal('learn'), scope: z.union([z.literal('general'), settingsIdSchema]), examples: z.string().max(20000), sourceChatId: settingsIdSchema.optional() }).strict(),
  z.object({ type: z.literal('resetProfile'), scope: z.union([z.literal('general'), settingsIdSchema]) }).strict(),
  z.object({ type: z.literal('sticker'), id: z.string().regex(/^[a-f0-9]{64}$/), searchTerms: searchTermsSchema }).strict(),
  z.object({ type: z.literal('createStickerGroup'), name: stickerGroupNameSchema, stickerIds: z.array(stickerBaseSchema.shape.id).max(MAX_LIBRARY_STICKERS).optional() }).strict(),
  z.object({ type: z.literal('renameStickerGroup'), id: stickerGroupIdSchema, name: stickerGroupNameSchema }).strict(),
  z.object({ type: z.literal('deleteStickerGroup'), id: stickerGroupIdSchema }).strict(),
  z.object({ type: z.literal('stickerGroupMembership'), id: stickerBaseSchema.shape.id, groupId: stickerGroupIdSchema, member: z.boolean() }).strict(),
  z.object({ type: z.literal('bulkStickerGroupMembership'), stickerIds: z.array(stickerBaseSchema.shape.id).min(1).max(MAX_LIBRARY_STICKERS), groupId: stickerGroupIdSchema, member: z.boolean() }).strict(),
  z.object({ type: z.literal('forgetSticker'), id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal('locateSticker'), id: z.string().max(64), destinationToken: z.string().regex(/^[1-9][0-9]{0,15}$/) }).strict(),
  z.object({ type: z.literal('sendSticker'), id: z.string().regex(/^[a-f0-9]{64}$/), nonce: z.string().uuid(), destinationToken: z.string().regex(/^[1-9][0-9]{0,15}$/), still: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('cancelSticker') }).strict(),
  z.object({ type: z.literal('panel'), panel: panelSchema }).strict(),
  z.object({ type: z.literal('reload') }).strict(),
  z.object({ type: z.literal('cancelAuto') }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export interface DesktopAPI { shieldReady(nonce: string, reducedMotion: boolean): Promise<void>; shieldFaded(nonce: string): Promise<void>; status(): Promise<Status>; models(provider: Provider): Promise<ModelsResult>; action(action: Action): Promise<{ ok: boolean; error?: string }>; subscribe(fn: (status: StatusUpdate) => void): () => void }

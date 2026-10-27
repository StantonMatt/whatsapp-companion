import { z } from 'zod';

export const bootPhaseSchema = z.enum(['splash', 'shell', 'login', 'blocked', 'unknown']);
export type BootPhase = z.infer<typeof bootPhaseSchema>;
export const bootAssetKindSchema = z.enum(['script', 'stylesheet']);
export type BootAssetKind = z.infer<typeof bootAssetKindSchema>;
// Fixed WhatsApp identifiers used by connector selectors, never arbitrary page values.
export const bootStructuralIdentifierSchema = z.enum([
  'app', 'main', 'pane-side', 'side', 'initial_startup', 'startup-screen',
  'chat-list', 'side-panel', 'main-navigation', 'qrcode', 'qr-code', 'login-qr-code',
  'link-device', 'logged-out', 'link-device-phone-number-code-screen',
  'alert-phone', 'alert-computer', 'account-banned', 'account-warning', 'account-restriction', 'startup-error',
  'author', 'banner', 'conversation-compose-box-input', 'conversation-info-header-chat-title',
  'crop-rotate-button', 'document-thumb', 'expressions-btn-sticker', 'expressions-panel',
  'expressions-panel-container', 'grouped-sticker-item', 'ic-attach-file', 'image-thumb',
  'loading-spinner', 'media-editor-canvas', 'msg-container', 'msg-meta', 'msg-text',
  'panel-recent', 'panel-starred', 'popup-contents', 'ptt-status', 'quoted-message',
  'quoted-message-container', 'quoted-msg', 'reply-context', 'selectable-text', 'send',
  'sticker-container', 'sticker-item', 'tail-in', 'tail-out', 'video-content', 'video-thumb',
  'wds-ic-send-filled', 'other'
]);
// Fixed standard structural tags only; custom element names may contain account data.
export const bootStructuralTagSchema = z.enum([
  'PROGRESS', 'DIV', 'SPAN', 'SECTION', 'MAIN', 'HEADER', 'FOOTER', 'NAV',
  'BODY', 'HTML', 'ASIDE', 'P', 'ARTICLE', 'UL', 'OL', 'LI', 'DIALOG',
  'svg', 'g', 'path', 'circle', 'rect', 'other'
]);
const ancestorSchema = z.object({
  tagName: bootStructuralTagSchema, id: bootStructuralIdentifierSchema.nullable(), idPresent: z.boolean(),
  testId: bootStructuralIdentifierSchema.nullable(), testIdPresent: z.boolean()
}).strict().refine(value => value.idPresent === (value.id !== null) && value.testIdPresent === (value.testId !== null));
export const bootStructureSchema = z.object({
  visibleProgress: z.boolean(), tagName: bootStructuralTagSchema.nullable(),
  ancestors: z.array(ancestorSchema).max(3)
}).strict().refine(value => value.visibleProgress ? value.tagName !== null : value.tagName === null && value.ancestors.length === 0);
export type BootStructure = z.infer<typeof bootStructureSchema>;
export const bootObservationSchema = z.object({
  phase: bootPhaseSchema, progress: z.number().int().min(0).max(10).nullable(),
  visible: z.boolean(), online: z.boolean(), chatListReady: z.boolean().optional(), structure: bootStructureSchema.optional(),
  assetFailed: z.boolean().optional(), assetFailureKind: bootAssetKindSchema.optional()
}).strict();
export type BootObservation = z.infer<typeof bootObservationSchema>;
export const bootSessionSchema = z.object({ nonce: z.string().uuid().length(36), generation: z.number().int().nonnegative() }).strict();
export type BootSession = z.infer<typeof bootSessionSchema>;
export const bootHeartbeatSchema = bootObservationSchema.extend({
  ...bootSessionSchema.shape
}).strict();

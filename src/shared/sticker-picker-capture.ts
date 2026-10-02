import { z } from 'zod';

export const PICKER_CAPTURE_VERSION = 1;
export const PICKER_MAX_DEPTH = 40;
export const PICKER_MAX_NODES = 6000;
export const PICKER_MAX_ATTRIBUTE_LENGTH = 256;
export const PICKER_UI_WORDS = [
  'favorites', 'favourites', 'recent', 'recents', 'stickers', 'sticker', 'emoji', 'gif', 'gifs', 'avatar',
  'search', 'add', 'create', 'store', 'get', 'more', 'download', 'new', 'pack', 'packs', 'close', 'back', 'settings',
  'favoritos', 'recientes', 'recentes', 'crear', 'criar', 'tienda', 'loja', 'descargar', 'baixar', 'nuevo', 'novo', 'buscar', 'pesquisar'
] as const;
export const PICKER_ATTRIBUTES = [
  'data-testid', 'data-tab', 'data-icon', 'aria-selected', 'aria-controls', 'aria-expanded', 'aria-busy',
  'aria-disabled', 'aria-orientation', 'aria-haspopup', 'tabindex', 'id', 'dir', 'draggable', 'type', 'disabled'
] as const;
const boundedString = z.string().max(PICKER_MAX_ATTRIBUTE_LENGTH);
const metric = z.number().int().min(-10_000_000).max(10_000_000);
const size = metric.nonnegative();
const redactedTextSchema = z.object({ length: size, words: z.array(z.enum(PICKER_UI_WORDS)).max(PICKER_UI_WORDS.length) }).strict();
export type RedactedPickerText = z.infer<typeof redactedTextSchema>;
const attributesSchema = z.object(Object.fromEntries(PICKER_ATTRIBUTES.map(key => [key, boundedString.optional()])) as Record<typeof PICKER_ATTRIBUTES[number], z.ZodOptional<typeof boundedString>>).strict();
const rectSchema = z.object({ x: metric, y: metric, top: metric, right: metric, bottom: metric, left: metric, width: size, height: size }).strict();
const overflowSchema = z.enum(['visible', 'hidden', 'clip', 'scroll', 'auto', 'overlay']);
const nodeFields = {
  tagName: z.string().min(1).max(80).regex(/^[a-zA-Z0-9:_-]+$/), role: boundedString.optional(), attributes: attributesSchema,
  classCount: size, labels: z.object({ 'aria-label': redactedTextSchema.optional(), title: redactedTextSchema.optional(), alt: redactedTextSchema.optional() }).strict(),
  text: redactedTextSchema.optional(), rect: rectSchema,
  direction: z.enum(['ltr', 'rtl']), overflowX: overflowSchema, overflowY: overflowSchema,
  scroll: z.object({ scrollWidth: size, scrollHeight: size, clientWidth: size, clientHeight: size, scrollLeft: metric, scrollTop: metric }).strict().optional(),
  image: z.object({ scheme: z.enum(['blob', 'data', 'https']).nullable(), naturalWidth: size, naturalHeight: size, renderedWidth: size, renderedHeight: size }).strict().optional(),
  truncated: z.boolean()
};
export type PickerCaptureNode = z.infer<z.ZodObject<typeof nodeFields>> & { children: PickerCaptureNode[] };
const nodeSchema: z.ZodType<PickerCaptureNode> = z.lazy(() => z.object({ ...nodeFields, children: z.array(nodeSchema).max(PICKER_MAX_NODES) }).strict());
const ancestorSchema = z.object({ tagName: nodeFields.tagName, role: boundedString.optional(), testid: boundedString.optional() }).strict();
export type PickerAncestor = z.infer<typeof ancestorSchema>;
const captureSchema = z.object({
  status: z.literal('captured'), capturedAt: z.iso.datetime(), connectorVersion: z.literal(PICKER_CAPTURE_VERSION),
  viewport: z.object({ width: size, height: size }).strict(), ancestors: z.array(ancestorSchema).max(PICKER_MAX_DEPTH),
  tree: nodeSchema, nodeCount: z.number().int().min(1).max(PICKER_MAX_NODES), truncated: z.boolean()
}).strict();

// Bound recursion BEFORE zod visits the recursive tree. A malformed IPC reply
// must not be able to overflow the validator's stack.
const boundedTree = z.unknown().superRefine((raw, ctx) => {
  if (!raw || typeof raw !== 'object' || !('tree' in raw)) return;
  const stack = [{ node: raw.tree, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > PICKER_MAX_NODES || depth > PICKER_MAX_DEPTH) {
      ctx.addIssue({ code: 'custom', message: 'Picker tree exceeds capture limits' }); return;
    }
    if (!node || typeof node !== 'object' || !('children' in node) || !Array.isArray(node.children)) continue;
    if (node.children.length + count + stack.length > PICKER_MAX_NODES) {
      ctx.addIssue({ code: 'custom', message: 'Picker tree exceeds capture limits' }); return;
    }
    for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
  }
  if ('nodeCount' in raw && raw.nodeCount !== count) ctx.addIssue({ code: 'custom', message: 'Picker node count mismatch' });
});
export const pickerLayoutCaptureSchema = boundedTree.pipe(captureSchema);
export type PickerLayoutCapture = z.infer<typeof captureSchema>;
export const pickerLayoutResultSchema = z.union([
  pickerLayoutCaptureSchema,
  z.object({ status: z.literal('no-picker-open') }).strict()
]);
export type PickerLayoutResult = z.infer<typeof pickerLayoutResultSchema>;
export const pickerLayoutEventSchema = z.object({ type: z.literal('stickerPickerLayout'), nonce: z.string().uuid(), result: pickerLayoutResultSchema }).strict();
export const pickerLayoutDiagnosticSchema = boundedTree.pipe(captureSchema.extend({ appVersion: z.string().min(1).max(80) }).strict());

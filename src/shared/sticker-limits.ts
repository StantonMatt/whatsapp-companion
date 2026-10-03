// Observed animated favorites can exceed 900 KB. Keep a bounded 1 MiB intake;
// the separate library count and total-byte budgets still apply.
export const MAX_STICKER_BYTES = 1024 * 1024;
export const MAX_STICKER_DATA_URL_LENGTH = 'data:image/webp;base64,'.length + Math.ceil(MAX_STICKER_BYTES / 3) * 4;

export const MAX_LIBRARY_STICKERS = 2000;
export const MAX_LIBRARY_BYTES = 1024 * 1024 * 1024;
// Independent of the persistent library; bounds memory during slow decoding.
export const MAX_PENDING_STICKER_CHARS = 50_000_000;

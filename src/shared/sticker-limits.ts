// Observed animated favorites can exceed 900 KB. Keep a bounded 1 MiB intake;
// the separate library count and total-byte budgets still apply.
export const MAX_STICKER_BYTES = 1024 * 1024;
export const MAX_STICKER_DATA_URL_LENGTH = 'data:image/webp;base64,'.length + Math.ceil(MAX_STICKER_BYTES / 3) * 4;

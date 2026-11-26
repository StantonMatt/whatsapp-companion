export type TrayBadgeValue = '' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '9+';

export function unreadCountFromTitle(title: string): number {
  // Bound work and reject unsafe integers rather than rounding an arbitrary title.
  if (title.length > 40) return 0;
  const match = /^\(([1-9]\d*)\) WhatsApp$/.exec(title);
  const count = match && match[0] === title ? Number(match[1]) : 0;
  return Number.isSafeInteger(count) ? count : 0;
}

export function trayBadgeValue(count: number): TrayBadgeValue {
  if (!Number.isSafeInteger(count) || count <= 0) return '';
  return count > 9 ? '9+' : String(count) as TrayBadgeValue;
}

// Six-by-eight pixel glyphs use two-pixel strokes at the native 1x resolution.
const glyphs: Record<string, string[]> = {
  '1': ['001100', '011100', '111100', '001100', '001100', '001100', '111111', '111111'],
  '2': ['111111', '111111', '000011', '111111', '111111', '110000', '111111', '111111'],
  '3': ['111111', '111111', '000011', '111111', '111111', '000011', '111111', '111111'],
  '4': ['110011', '110011', '110011', '111111', '111111', '000011', '000011', '000011'],
  '5': ['111111', '111111', '110000', '111111', '111111', '000011', '111111', '111111'],
  '6': ['111111', '111111', '110000', '111111', '111111', '110011', '111111', '111111'],
  '7': ['111111', '111111', '000011', '000011', '001100', '001100', '001100', '001100'],
  '8': ['111111', '111111', '110011', '111111', '111111', '110011', '111111', '111111'],
  '9': ['111111', '111111', '110011', '111111', '111111', '000011', '111111', '111111'],
  '+': ['000000', '001100', '001100', '111111', '111111', '001100', '001100', '000000']
};

/** Compose onto Electron's premultiplied BGRA bitmap (supported desktop targets). */
export function drawTrayBadge(bitmap: Buffer, size: 22 | 44, value: TrayBadgeValue): Buffer {
  const output = Buffer.from(bitmap);
  if (!value) return output;
  const scale = size / 22, height = 14, width = value === '9+' ? 22 : 14;
  const left = 22 - width, top = 22 - height, radius = height / 2;
  const textWidth = value.length * 8 - 2;
  const textLeft = left + (width - textWidth) / 2, textTop = top + 3;
  // Four samples per axis smooth only the capsule boundary; glyphs align to pixels.
  for (let y = top * scale; y < size; y++) {
    for (let x = left * scale; x < size; x++) {
      let red = 0, green = 0, blue = 0, samples = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const px = (x + (sx + 0.5) / 4) / scale, py = (y + (sy + 0.5) / 4) / scale;
        const cx = Math.max(left + radius, Math.min(22 - radius, px));
        const distance = Math.hypot(px - cx, py - (top + radius));
        if (distance > radius) continue;
        let color = distance > radius - 1 ? [6, 61, 43] : [37, 211, 102];
        const tx = Math.floor(px - textLeft), ty = Math.floor(py - textTop);
        const glyph = glyphs[value[Math.floor(tx / 8)]];
        if (tx >= 0 && ty >= 0 && ty < 8 && glyph?.[ty][tx % 8] === '1') color = [255, 255, 255];
        red += color[0]; green += color[1]; blue += color[2]; samples++;
      }
      const offset = (y * size + x) * 4, remaining = 1 - samples / 16;
      output[offset] = Math.round(blue / 16 + output[offset] * remaining);
      output[offset + 1] = Math.round(green / 16 + output[offset + 1] * remaining);
      output[offset + 2] = Math.round(red / 16 + output[offset + 2] * remaining);
      output[offset + 3] = Math.round(255 * samples / 16 + output[offset + 3] * remaining);
    }
  }
  return output;
}

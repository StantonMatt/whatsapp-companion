import { describe, expect, test } from 'vitest';
import { drawTrayBadge, trayBadgeValue, unreadCountFromTitle } from '../src/main/tray-badge';

describe('WhatsApp unread title', () => {
  test.each([1, 3, 9, 10, 1234, Number.MAX_SAFE_INTEGER])('reads the exact count %i', count => {
    expect(unreadCountFromTitle(`(${count}) WhatsApp`)).toBe(count);
  });

  test.each(['', 'WhatsApp', '(0) WhatsApp', '(01) WhatsApp', '(-1) WhatsApp', '(1.5) WhatsApp', '(1e3) WhatsApp', '(1,234) WhatsApp', '( 3 ) WhatsApp', '(3) WhatsApp Web', ' (3) WhatsApp', '(3) WhatsApp\n', 'Chat (3) WhatsApp', '(NaN) WhatsApp', '(9007199254740992) WhatsApp', `(${'9'.repeat(10000)}) WhatsApp`])('ignores absent or malformed counts %#', title => {
    expect(unreadCountFromTitle(title)).toBe(0);
  });
});

describe('displayed tray value', () => {
  test.each([0, -1, 0.5, NaN, Infinity, Number.MAX_VALUE])('has no badge for invalid or zero count %s', count => {
    expect(trayBadgeValue(count)).toBe('');
  });
  test.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('shows %i without abbreviation', count => {
    expect(trayBadgeValue(count)).toBe(String(count));
  });
  test.each([10, 12, 999, Number.MAX_SAFE_INTEGER])('caps %i at 9+', count => {
    expect(trayBadgeValue(count)).toBe('9+');
  });
});

describe('bitmap badge', () => {
  test.each([22, 44] as const)('keeps original pixels outside the badge at %i px', size => {
    const base = Buffer.alloc(size * size * 4, 128), original = Buffer.from(base);
    const scale = size / 22, rendered = drawTrayBadge(base, size, '3');
    expect(base).toEqual(original);
    expect(drawTrayBadge(base, size, '')).toEqual(original);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (x < 8 * scale || y < 8 * scale) {
        const offset = (y * size + x) * 4;
        expect(rendered.subarray(offset, offset + 4)).toEqual(base.subarray(offset, offset + 4));
      }
    }
    const pixels = Array.from({ length: size * size }, (_, i) => rendered.subarray(i * 4, i * 4 + 4).toString('hex'));
    expect(pixels).toContain('66d325ff'); // #25D366 in BGRA
    expect(pixels).toContain('2b3d06ff'); // dark outline
    expect(pixels).toContain('ffffffff'); // white digit
    expect(drawTrayBadge(base, size, '9+')).not.toEqual(drawTrayBadge(base, size, '9'));
  });

  test.each([22, 44] as const)('draws an eight-pixel-tall digit with two-pixel strokes at %i px', size => {
    const scale = size / 22, rendered = drawTrayBadge(Buffer.alloc(size * size * 4), size, '3');
    const rows = ['111111', '111111', '000011', '111111', '111111', '000011', '111111', '111111'];
    const whitePixels: [number, number][] = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      if (rendered.subarray(offset, offset + 4).equals(Buffer.from([255, 255, 255, 255]))) whitePixels.push([x, y]);
    }
    const expected: [number, number][] = [];
    for (let y = 0; y < 8 * scale; y++) for (let x = 0; x < 6 * scale; x++) {
      if (rows[Math.floor(y / scale)][Math.floor(x / scale)] === '1') expected.push([12 * scale + x, 11 * scale + y]);
    }
    expect(whitePixels).toEqual(expected);
  });

  test.each([22, 44] as const)('keeps the 9+ pill below the top eight pixels at %i px', size => {
    const base = Buffer.alloc(size * size * 4, 128), scale = size / 22;
    const rendered = drawTrayBadge(base, size, '9+');
    expect(rendered.subarray(0, 8 * scale * size * 4)).toEqual(base.subarray(0, 8 * scale * size * 4));
    // The pill reaches both sides, retains its outline and has a two-pixel glyph gap.
    const pixel = (x: number, y: number) => rendered.subarray((y * size + x) * 4, (y * size + x) * 4 + 4).toString('hex');
    expect(pixel(0, 15 * scale)).toBe('2b3d06ff');
    expect(pixel(size - 1, 15 * scale)).toBe('2b3d06ff');
    for (let x = 10 * scale; x < 12 * scale; x++) expect(pixel(x, 14 * scale)).toBe('66d325ff');
    expect(pixel(12 * scale, 14 * scale)).toBe('ffffffff');
    expect(pixel(17 * scale, 14 * scale)).toBe('ffffffff');
  });
});

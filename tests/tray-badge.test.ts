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
      if (x < 11 * scale || y < 11 * scale) {
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
});

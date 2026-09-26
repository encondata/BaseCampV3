import { describe, expect, it } from 'vitest';

import { PERSON_COLORS, personColor } from './personColor';

// Pinned against the API's pages.person_color (int(uuid.hex, 16) % 12).
describe('personColor', () => {
  it('matches the API for known ids', () => {
    // 0x…0d = 13 → 13 % 12 = 1
    expect(personColor('00000000-0000-0000-0000-00000000000d')).toBe('#c2410c');
    // python: int('3f2504e04f8941d39a0c0305e82c3301', 16) % 12 == 5
    expect(personColor('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(PERSON_COLORS[5]);
    // python: int('ffffffffffffffffffffffffffffffff', 16) % 12 == 3
    expect(personColor('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe('#9333ea');
  });

  it('ignores case and dashes and falls back to the first color for junk', () => {
    expect(personColor('3F2504E04F8941D39A0C0305E82C3301')).toBe(PERSON_COLORS[5]);
    expect(personColor('not-a-uuid')).toBe(PERSON_COLORS[0]);
  });
});

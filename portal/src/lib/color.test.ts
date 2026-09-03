import { describe, expect, it } from 'vitest';

import { readableTextColor } from './color';

describe('readableTextColor', () => {
  it('picks dark text on light fills', () => {
    expect(readableTextColor('#eef0f3')).toBe('#111827');
    expect(readableTextColor('#FFFFFF')).toBe('#111827');
    expect(readableTextColor('#ff0')).toBe('#111827'); // 3-digit yellow
  });
  it('picks white text on dark fills', () => {
    expect(readableTextColor('#1668a7')).toBe('#ffffff'); // Server blue
    expect(readableTextColor('#6d4fc4')).toBe('#ffffff'); // Storage purple
    expect(readableTextColor('#000')).toBe('#ffffff');
  });
  it('falls back to dark text on malformed input', () => {
    expect(readableTextColor('')).toBe('#111827');
    expect(readableTextColor('tomato')).toBe('#111827');
    expect(readableTextColor('#12')).toBe('#111827');
  });
});

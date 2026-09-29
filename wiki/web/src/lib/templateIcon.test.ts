import { describe, expect, it } from 'vitest';

import { templateGlyph, templateTitle } from './templateIcon';

describe('templateGlyph', () => {
  it('shows an emoji or other glyph as it is', () => {
    expect(templateGlyph('📋')).toBe('📋');
    expect(templateGlyph('★')).toBe('★');
  });

  it('maps the icon names older databases seeded to their glyphs', () => {
    expect(templateGlyph('clipboard-list')).toBe('📋');
    expect(templateGlyph('compass')).toBe('🧭');
    expect(templateGlyph('wrench')).toBe('🔧');
    expect(templateGlyph('users')).toBe('👥');
  });

  it('shows nothing for any other plain word, rather than printing it', () => {
    expect(templateGlyph('star')).toBe('');
    expect(templateGlyph('i2')).toBe('');
    expect(templateGlyph('')).toBe('');
    expect(templateGlyph('  ')).toBe('');
  });
});

describe('templateTitle', () => {
  it('puts the glyph before the name, or shows the name alone', () => {
    expect(templateTitle({ icon: 'compass', name: 'How-to guide' })).toBe('🧭 How-to guide');
    expect(templateTitle({ icon: 'star', name: 'Mine' })).toBe('Mine');
    expect(templateTitle({ icon: '', name: 'Plain' })).toBe('Plain');
  });
});

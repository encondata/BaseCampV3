// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PRESET_COLORS } from '@portal/lib/variables';

import { libraryColor, SpaceBadge } from './NodeIcon';

afterEach(cleanup);

function badge(space: { key?: string; icon: string | null; name: string; color: string | null }) {
  const { container } = render(<SpaceBadge space={space} size="lg" />);
  return container.querySelector<HTMLElement>('.wiki-space-badge')!;
}

describe('SpaceBadge', () => {
  it('shows the icon on the library color', () => {
    const el = badge({ key: 'ops', icon: '📘', name: 'Operations', color: '#6d4fc4' });
    expect(el.textContent).toBe('📘');
    expect(el.style.getPropertyValue('--space-color')).toBe('#6d4fc4');
  });

  it('shows a book, not an initial, when there is no icon', () => {
    const el = badge({ key: 'ops', icon: null, name: 'Operations', color: '#6d4fc4' });
    expect(el.textContent).toBe('');
    expect(el.querySelector('svg.wiki-space-glyph')).not.toBeNull();
  });

  it('derives a stable palette color from the key when none is set', () => {
    const a = badge({ key: 'ops', icon: null, name: 'Operations', color: null }).style.getPropertyValue('--space-color');
    cleanup();
    const again = badge({ key: 'ops', icon: null, name: 'Ops renamed', color: null }).style.getPropertyValue('--space-color');
    expect(PRESET_COLORS.map((p) => p.value)).toContain(a);
    expect(again).toBe(a);
  });
});

describe('libraryColor', () => {
  it('spreads keys over the palette', () => {
    const colors = new Set(['ops', 'sales', 'hr', 'facilities', 'guides', 'it', 'legal', 'field-ops'].map(
      (key) => libraryColor({ key, color: null })));
    expect(colors.size).toBeGreaterThan(2);
  });

  it('keeps a color that is set', () => {
    expect(libraryColor({ key: 'ops', color: '#c03540' })).toBe('#c03540');
  });
});

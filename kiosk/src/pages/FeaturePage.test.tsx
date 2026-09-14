// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { FEATURES } from '../lib/features';
import FeaturePage from './FeaturePage';

afterEach(() => cleanup());

describe.each(FEATURES.filter((f) => f.placeholder))('FeaturePage for $title', (feature) => {
  it('shows the title, coming-soon hint, placeholder notice, and a link home', () => {
    render(<MemoryRouter><FeaturePage feature={feature} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: feature.title })).toBeTruthy();
    expect(screen.getByText(new RegExp(`^Coming soon\\. ${feature.blurb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))).toBeTruthy();
    expect(screen.getByText('This feature is not available yet.')).toBeTruthy();
    const back = screen.getByRole('link', { name: 'Back to home' });
    expect(back.getAttribute('href')).toBe('/');
  });
});

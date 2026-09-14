// @vitest-environment jsdom
/** The generic placeholder screen. Every feature in FEATURES has a real
 *  page of its own today, so this is tested against a representative
 *  feature rather than by iterating the registry — the component stays
 *  for the next feature that lands as a tile before it lands as a
 *  screen. */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';

import type { KioskFeature } from '../lib/features';
import FeaturePage from './FeaturePage';

afterEach(() => cleanup());

const FEATURE: KioskFeature = {
  id: 'timeclock', path: '/timeclock', title: 'Timeclock',
  blurb: 'Clock in and out of a move.', placeholder: true,
};

it('shows the title, coming-soon hint, placeholder notice, and a link home', () => {
  render(<MemoryRouter><FeaturePage feature={FEATURE} /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Timeclock' })).toBeTruthy();
  expect(screen.getByText('Coming soon. Clock in and out of a move.')).toBeTruthy();
  expect(screen.getByText('This feature is not available yet.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Back to home' }).getAttribute('href')).toBe('/');
});

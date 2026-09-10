// @vitest-environment jsdom
/**
 * statusChip's whole reason for existing: a vocabulary value with no
 * stored color must still render its label (as a neutral `chip tag`)
 * rather than blanking the cell — the bug nine page-local `chip()` copies
 * shared before this consolidation (final-review wave E).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { statusChip } from './chips';

afterEach(cleanup);

it('renders a colored chip when a color is present', () => {
  render(<div>{statusChip('Active', '#178a4c')}</div>);
  const el = screen.getByText('Active');
  expect(el.className).toContain('chip');
  expect(el.className).toContain('custom');
  expect(el.style.getPropertyValue('--chip')).toBe('#178a4c');
});

it('falls back to a colorless chip tag (label still shown) when color is missing', () => {
  render(<div>{statusChip('Pending', null)}</div>);
  const el = screen.getByText('Pending');
  expect(el.className).toBe('chip tag');
});

it('falls back to a colorless chip tag when color is undefined', () => {
  render(<div>{statusChip('Draft', undefined)}</div>);
  const el = screen.getByText('Draft');
  expect(el.className).toBe('chip tag');
});

it('renders nothing when the label itself is missing', () => {
  expect(statusChip(null, '#178a4c')).toBeNull();
  expect(statusChip(undefined, undefined)).toBeNull();
  expect(statusChip('', '#178a4c')).toBeNull();
});

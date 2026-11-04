// @vitest-environment jsdom
/** TradeChips — a worker's comma-separated trade text as chips. */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import TradeChips from './TradeChips';

afterEach(cleanup);

it('renders one tag chip per trade inside a single chips wrapper', () => {
  const { container } = render(<TradeChips trade="Cable, Hardware" />);
  const wrappers = container.querySelectorAll('.chips');
  expect(wrappers).toHaveLength(1);
  const chips = wrappers[0].querySelectorAll('.chip.tag');
  expect(Array.from(chips).map((c) => c.textContent)).toEqual(['Cable', 'Hardware']);
});

it('renders the default dash as plain text when there is no trade', () => {
  const { container } = render(<TradeChips trade={null} />);
  expect(container.querySelector('.chip')).toBeNull();
  expect(container.querySelector('.chips')).toBeNull();
  expect(screen.getByText('—')).toBeTruthy();
});

it('renders a custom fallback when there is no trade', () => {
  const { container } = render(<TradeChips trade={null} fallback="No trade set" />);
  expect(container.querySelector('.chip')).toBeNull();
  expect(screen.getByText('No trade set')).toBeTruthy();
});

// @vitest-environment jsdom
/**
 * Labels → Printers page. Currently a structured placeholder: a tab strip
 * (Zebra / Brother) over inert "coming soon" option rows. No API calls yet,
 * so no api mocks — just render and interact.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';

afterEach(cleanup);

const { default: Printers } = await import('./Printers');

it('shows the three Zebra options by default, each with a Coming soon chip', () => {
  render(<Printers />);

  expect(screen.getByText('Test Label Alignment')).not.toBeNull();
  expect(screen.getByText('Install Fonts')).not.toBeNull();
  expect(screen.getByText('Full Printer Setup')).not.toBeNull();
  expect(screen.getAllByText('Coming soon')).toHaveLength(3);
});

it('switching to the Brother tab hides the Zebra options and shows the empty state', async () => {
  const user = userEvent.setup();
  render(<Printers />);

  await user.click(screen.getByRole('tab', { name: 'Brother Printers' }));

  expect(screen.queryByText('Test Label Alignment')).toBeNull();
  expect(screen.queryByText('Install Fonts')).toBeNull();
  expect(screen.queryByText('Full Printer Setup')).toBeNull();
  expect(screen.queryAllByText('Coming soon')).toHaveLength(0);
  expect(screen.getByText('Brother printer tools are coming soon.')).not.toBeNull();
});

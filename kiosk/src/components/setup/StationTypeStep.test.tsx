// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import StationTypeStep from './StationTypeStep';

it('offers the four station types in order, with the Label Station path', () => {
  render(<StationTypeStep selected="" onSelect={() => {}} />);
  const titles = screen.getAllByRole('option').map((o) => o.querySelector('.setup-card-title')?.textContent);
  expect(titles).toEqual(['Label Station', 'RFID Station', 'Dock Station', 'Timeclock Station']);
  expect(screen.getByText(/Next: Move → Site → Label type → Printer\./)).toBeTruthy();
});

// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';

import Dev from './Dev';

afterEach(cleanup);

function Probe() {
  return <div data-testid="loc">{useLocation().pathname}</div>;
}

it('the Matching rules card opens /dev/matching-rules', async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/dev']}>
      <Routes>
        <Route path="/dev" element={<Dev />} />
        <Route path="/dev/matching-rules" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByRole('heading', { name: 'Developer tools' })).toBeTruthy();
  const card = screen.getByText('Matching rules').closest('.bulk-card') as HTMLElement;
  expect(card).toBeTruthy();
  expect(within(card).getByText('Edit, test and deploy how a scanned or typed value finds its asset.'))
    .toBeTruthy();
  await user.click(within(card).getByRole('button', { name: 'Open' }));
  expect(screen.getByTestId('loc').textContent).toBe('/dev/matching-rules');
});

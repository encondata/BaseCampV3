// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';

import { LABEL_SECTIONS } from '../lib/labelSections';
import LabelSectionPage from './LabelSectionPage';
import Labels from './Labels';

afterEach(() => cleanup());

function renderRouted() {
  return render(
    <MemoryRouter initialEntries={['/labels']}>
      <Routes>
        <Route path="/labels" element={<Labels />} />
        {/* Printer Setup / Troubleshooting has a real page now (see
            PrinterTools.test.tsx); it stands in here so this test stays
            about the launcher, not about the printer tools. */}
        {LABEL_SECTIONS.map((s) => (
          <Route
            key={s.id}
            path={s.path}
            element={s.id === 'printers' ? <p>Printer tools</p> : <LabelSectionPage section={s} />}
          />
        ))}
      </Routes>
    </MemoryRouter>,
  );
}

it('renders a tile link for each of the three sections', () => {
  renderRouted();
  const links = screen.getAllByRole('link');
  expect(links).toHaveLength(3);
  expect(screen.getByRole('link', { name: /Printing Station/ }).getAttribute('href')).toBe('/labels/station');
  expect(screen.getByRole('link', { name: /Bulk Print/ }).getAttribute('href')).toBe('/labels/bulk');
  expect(screen.getByRole('link', { name: /Printer Setup/ }).getAttribute('href')).toBe('/labels/printers');
});

it('sends the Printer Setup tile to its own page, not the placeholder', async () => {
  renderRouted();
  await userEvent.click(screen.getByRole('link', { name: /Printer Setup/ }));
  expect(await screen.findByText('Printer tools')).toBeTruthy();
  expect(screen.queryByText('This section is not available yet.')).toBeNull();
});

it('navigates to the Bulk Print placeholder and back', async () => {
  renderRouted();
  await userEvent.click(screen.getByRole('link', { name: /Bulk Print/ }));
  expect(await screen.findByText('This section is not available yet.')).toBeTruthy();
  await userEvent.click(screen.getByRole('link', { name: 'Back to Label Printing' }));
  expect(await screen.findByText('Choose what you want to do.')).toBeTruthy();
});

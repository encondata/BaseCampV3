// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';

import Troubleshooting from './Troubleshooting';
import TroubleshootingTopic from './TroubleshootingTopic';

afterEach(cleanup);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/troubleshooting" element={<Troubleshooting />} />
        <Route path="/troubleshooting/:topicId" element={<TroubleshootingTopic />} />
      </Routes>
    </MemoryRouter>,
  );
}

it('lists the scanner topic and links to it', () => {
  renderAt('/troubleshooting');
  expect(screen.getByText('Zebra Scanner Troubleshooting')).toBeTruthy();
  expect(screen.getByText('Set up, pair, and reset Zebra DS22 scanners, with programming barcodes.')).toBeTruthy();
  expect(screen.getByRole('link', { name: /Zebra Scanner Troubleshooting/ }).getAttribute('href'))
    .toBe('/troubleshooting/zebra-ds22');
});

it('shows a topic with its title and guide', () => {
  renderAt('/troubleshooting/zebra-ds22');
  expect(screen.getByRole('heading', { level: 1, name: 'Zebra Scanner Troubleshooting' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Appendix: programming barcodes' })).toBeTruthy();
});

it('an unknown topic says so and links back', () => {
  renderAt('/troubleshooting/nope');
  expect(screen.getByText("This topic isn't available.")).toBeTruthy();
  expect(screen.getByRole('link', { name: /Troubleshooting/ }).getAttribute('href')).toBe('/troubleshooting');
});

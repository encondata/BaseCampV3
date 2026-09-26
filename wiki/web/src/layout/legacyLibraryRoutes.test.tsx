// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { legacyLibraryRoutes } from './legacyLibraryRoutes';

afterEach(cleanup);

function Probe() {
  const { pathname, search, hash } = useLocation();
  return <div data-testid="at">{`${pathname}${search}${hash}`}</div>;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {legacyLibraryRoutes()}
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByTestId('at').textContent;
}

describe('legacy library routes', () => {
  it.each([
    ['/s/ops', '/library/ops'],
    ['/s/ops/settings', '/library/ops/settings'],
    ['/s/ops/due', '/library/ops/due'],
    ['/trash/ops', '/library/ops/trash'],
    ['/spaces/new', '/libraries/new'],
  ])('sends an old %s link to %s', (from, to) => {
    expect(renderAt(from)).toBe(to);
  });

  it.each([
    ['/s/ops/settings?tab=x#members', '/library/ops/settings?tab=x#members'],
    ['/spaces/new?from=menu#top', '/libraries/new?from=menu#top'],
  ])('keeps the query and the hash: %s', (from, to) => {
    expect(renderAt(from)).toBe(to);
  });

  it('leaves the new paths alone', () => {
    expect(renderAt('/library/ops')).toBe('/library/ops');
  });
});

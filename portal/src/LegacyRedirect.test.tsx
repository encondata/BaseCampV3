// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

// App.tsx pulls in every page; mock the heavy bits the module imports at load.
vi.mock('./lib/api', () => ({ apiFetch: vi.fn(), onSessionEnded: vi.fn(() => () => {}), onSystemStatusRefresh: vi.fn(() => () => {}) }));

const { LegacyRedirect } = await import('./App');

function Probe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}{loc.search}{loc.hash}|{JSON.stringify(loc.state)}</div>;
}

afterEach(cleanup);

it('redirects an old URL to the new path keeping query, hash, and state', () => {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/admin/asset-models', search: '?open=am-1', hash: '#x', state: { openRow: 'am-1' } }]}>
      <Routes>
        <Route path="/admin/asset-models" element={<LegacyRedirect to="/assets/models" />} />
        <Route path="/assets/models" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByTestId('loc').textContent).toBe('/assets/models?open=am-1#x|{"openRow":"am-1"}');
});

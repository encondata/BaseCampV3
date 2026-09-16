// @vitest-environment jsdom
/**
 * An asset's move history: compact by design — one line per move, with the
 * rack and RU detail behind the link to the move row.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AssetMoveRow } from '../../lib/api';

const api = vi.hoisted(() => ({ listAssetMoves: vi.fn() }));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const ROWS: AssetMoveRow[] = [
  {
    row_id: 'r1', initiative_id: 'i1', initiative_name: 'NAP11 Hall Migration',
    initiative_status: 'in_progress', initiative_status_label: 'In progress',
    initiative_status_color: '#d38b1d',
    asset_status: 'staged', asset_status_label: 'Staged', asset_status_color: '#178a4c',
    scheduled_start: '2026-06-01T00:00:00Z', scheduled_end: '2026-06-05T00:00:00Z',
    added_at: '2026-05-01T00:00:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.listAssetMoves.mockResolvedValue(ROWS);
});
afterEach(cleanup);

const { default: AssetMoveHistory } = await import('./AssetMoveHistory');

const renderPanel = () => render(
  <MemoryRouter><AssetMoveHistory assetId="a1" /></MemoryRouter>,
);

it('lists one line per move, linking to the move and its row', async () => {
  renderPanel();
  expect(await screen.findByRole('table', { name: 'Move history' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'NAP11 Hall Migration' })
    .getAttribute('href')).toBe('/initiatives/i1');
  expect(screen.getByText('In progress')).toBeTruthy();
  expect(screen.getByText('Staged')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open move row' })
    .getAttribute('href')).toBe('/initiatives/i1/assets/r1');
  await waitFor(() => expect(api.listAssetMoves).toHaveBeenCalledWith('a1'));
});

it('renders the scheduled day without shifting it west of UTC', async () => {
  // vite.config.ts sets no test-environment TZ, so this assertion's teeth
  // depend on whatever timezone the process happens to inherit — worthless
  // on a CI box that defaults to UTC, where `new Date(iso)` and
  // parseApiDay+longDateOf agree even when buggy. Pin a negative offset
  // here so the naive `new Date(iso)` path (which would read "31 May")
  // is actually exercised, regardless of host TZ.
  const prevTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    renderPanel();
    await screen.findByRole('table', { name: 'Move history' });
    expect(screen.queryByText(/31 May|May 31/)).toBeNull();
    expect(screen.getByText(/Jun(e)? 1|1 Jun/)).toBeTruthy();
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});

it('shows the empty state when the asset has never moved', async () => {
  api.listAssetMoves.mockResolvedValue([]);
  renderPanel();
  expect(await screen.findByText('This asset has not been on a move.')).toBeTruthy();
});

it('offers a retry when the fetch fails', async () => {
  api.listAssetMoves.mockRejectedValueOnce(new Error('network'));
  renderPanel();
  expect(await screen.findByText('Could not load move history.')).toBeTruthy();
  api.listAssetMoves.mockResolvedValue(ROWS);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('table', { name: 'Move history' })).toBeTruthy();
});

// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';

import type { MoveSetupDraft } from '../../lib/api';
import MoveSetupFinish from './MoveSetupFinish';

afterEach(cleanup);

const draft = (results: MoveSetupDraft['results']): MoveSetupDraft => ({
  id: 'd1', status: 'completed', error: null, payload: null, initiative_id: null,
  total_rows: 0, processed_rows: 0, created_at: '', previews: null, results,
});

it('shows exactly one Open the move link and the CSV download when assets were imported', () => {
  render(
    <MemoryRouter>
      <MoveSetupFinish moveName="SJC to DAL" draft={draft({
        move_id: 'm1', crates: 2, trucks: 1,
        assets: { summary: {}, details: [
          { row: 1, serial_number: 'SN1', status: 'created', message: 'Added', asset_id: 'a1' },
        ] },
      })} />
    </MemoryRouter>,
  );
  expect(screen.getAllByText('Open the move')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Download summary (.csv)' })).toBeTruthy();
});

it('shows only the top Open the move link, with no CSV download, when nothing was imported', () => {
  render(
    <MemoryRouter>
      <MoveSetupFinish moveName="SJC to DAL"
                        draft={draft({ move_id: 'm1', crates: 2, trucks: 1, assets: null })} />
    </MemoryRouter>,
  );
  expect(screen.getAllByText('Open the move')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Download summary (.csv)' })).toBeNull();
  expect(screen.getByText('No From-To file was imported.')).toBeTruthy();
});

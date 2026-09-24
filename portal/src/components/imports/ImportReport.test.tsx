// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { ImportJobOut } from '../../lib/api';
import ImportReport from './ImportReport';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
afterEach(cleanup);

const job = {
  id: 'j1', initiative_id: null, kind: 'move_assets', filename: 'ft.csv', options: {},
  phase: 'validate', status: 'completed', total_rows: 2, processed_rows: 2, created_count: 1,
  updated_count: 0, error_count: 0, error: null, created_at: '', started_at: null, finished_at: null,
  results: { summary: {}, details: [
    { row: 2, serial_number: 'sn-1', status: 'created', message: 'Asset added to move' },
    { row: 3, serial_number: 'sn-2', status: 'review', message: "Make/Model 'Ghost GX' not found — needs review", make_model: 'Ghost GX' },
  ] },
} as ImportJobOut;

it('shows the chips, the missing make/models card and a Fix button', () => {
  render(<ImportReport job={job} fixedTexts={new Set()} onFix={vi.fn()} canAddModels canChangeModels />);
  expect(screen.getByText(/1 will create/)).toBeTruthy();
  expect(screen.getByText('1 missing make/model')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Fix…' })).toBeTruthy();
});

it('readOnly drops every fix action', () => {
  render(<ImportReport job={job} fixedTexts={new Set()} onFix={vi.fn()} canAddModels canChangeModels readOnly />);
  expect(screen.queryByText('1 missing make/model')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Fix…' })).toBeNull();
  expect(screen.getByText('sn-2')).toBeTruthy();
});

it('says what a fixed group needs next', () => {
  render(<ImportReport job={job} fixedTexts={new Set(['ghost gx'])} onFix={vi.fn()} canAddModels
                       canChangeModels readyLabel="Ready — check again to apply" />);
  expect(screen.getByText('Ready — check again to apply')).toBeTruthy();
});

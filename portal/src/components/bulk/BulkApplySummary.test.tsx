// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import type { BulkSummaryResult, BulkSummaryRow } from './BulkApplySummary';

const listTools = vi.hoisted(() => ({ exportCsv: vi.fn() }));
vi.mock('../../lib/listTools', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/listTools')>()), ...listTools,
}));
const { default: BulkApplySummary, changesText } = await import('./BulkApplySummary');

beforeEach(() => listTools.exportCsv.mockReset());
afterEach(cleanup);

interface WorkerRow extends BulkSummaryRow { person_id: string }

const result: BulkSummaryResult<WorkerRow> = {
  created: 1, updated: 1, skipped: 1, unchanged: 0,
  rows: [
    { row: 2, name: 'Bob Smith', person_id: 'p1', action: 'updated',
      diff: { trade: { old: null, new: 'Cable' } } },
    { row: 3, name: 'Sara Jones', person_id: 'p2', action: 'skipped',
      diff: { city: { old: null, new: 'Austin' } } },
    { row: 4, name: 'Maria Lopez', person_id: 'p3', action: 'created', diff: null },
  ],
};

it('renders counts with skipped, entity links, result labels, and downloads the csv', () => {
  render(<MemoryRouter>
    <BulkApplySummary result={result} entityLabel="Worker" filename="workers-bulk-summary"
      linkFor={(r) => `/people/workers/${r.person_id}`} openTo="/people/workers" openLabel="Open Workers" />
  </MemoryRouter>);
  expect(screen.getByText('Applied: 1 added · 1 updated · 1 skipped · 0 unchanged')).toBeTruthy();
  expect(screen.getByText('Worker')).toBeTruthy();                       // column header
  expect((screen.getByRole('link', { name: 'Bob Smith' }) as HTMLAnchorElement).getAttribute('href'))
    .toMatch(/\/people\/workers\/p1$/);
  expect(screen.getByText('Skipped')).toBeTruthy();
  expect(screen.getByText('city: — → Austin')).toBeTruthy();
  expect((screen.getByRole('link', { name: 'Open Workers' }) as HTMLAnchorElement).getAttribute('href'))
    .toMatch(/\/people\/workers$/);
  fireEvent.click(screen.getByRole('button', { name: 'Download summary (.csv)' }));
  expect(listTools.exportCsv).toHaveBeenCalledWith('workers-bulk-summary', expect.any(Array), result.rows);
  const [, columns] = listTools.exportCsv.mock.calls[0];
  expect(columns.map(([h]: [string]) => h)).toEqual(['Row', 'Worker', 'Result', 'Changes']);
});

it('omits the skipped count when the result has none (sites shape)', () => {
  render(<MemoryRouter>
    <BulkApplySummary result={{ created: 2, updated: 0, unchanged: 1, rows: [] }} entityLabel="Site"
      filename="sites-bulk-summary" linkFor={() => '/sites'} openTo="/sites" openLabel="Open Sites" />
  </MemoryRouter>);
  expect(screen.getByText('Applied: 2 added · 0 updated · 1 unchanged')).toBeTruthy();
});

it('omits the added count when the tool never adds (assets update shape)', () => {
  render(<MemoryRouter>
    <BulkApplySummary result={{ updated: 3, skipped: 1, unchanged: 5, rows: [] }} entityLabel="Asset"
      filename="assets-bulk-summary" linkFor={() => '/assets'} openTo="/assets" openLabel="Open Assets" />
  </MemoryRouter>);
  expect(screen.getByText('Applied: 3 updated · 1 skipped · 5 unchanged')).toBeTruthy();
});

it('changesText flattens diffs including client add/remove', () => {
  expect(changesText({ name: { old: 'A', new: 'B' }, clients: { add: ['X'], remove: ['Y'] } }))
    .toBe('name: A → B; clients: +X, −Y');
  expect(changesText(null)).toBe('');
});

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

it('renders plain text instead of a link when linkFor returns null', () => {
  const rows: WorkerRow[] = [
    { row: 2, name: 'Asset 999999', person_id: '', action: 'skipped', diff: null },
    { row: 3, name: 'Asset 5', person_id: 'a5', action: 'updated', diff: null },
  ];
  render(<MemoryRouter>
    <BulkApplySummary result={{ updated: 1, skipped: 1, unchanged: 0, rows }} entityLabel="Asset"
      filename="assets-bulk-summary"
      linkFor={(r) => (r.person_id ? `/assets/${r.person_id}` : null)}
      openTo="/assets" openLabel="Open Assets" />
  </MemoryRouter>);
  expect(screen.queryByRole('link', { name: 'Asset 999999' })).toBeNull();
  expect(screen.getByText('Asset 999999')).toBeTruthy();
  expect((screen.getByRole('link', { name: 'Asset 5' }) as HTMLAnchorElement).getAttribute('href'))
    .toMatch(/\/assets\/a5$/);
});

it('changesText flattens diffs including client add/remove', () => {
  expect(changesText({ name: { old: 'A', new: 'B' }, clients: { add: ['X'], remove: ['Y'] } }))
    .toBe('name: A → B; clients: +X, −Y');
  expect(changesText(null)).toBe('');
});

const many: BulkSummaryResult<WorkerRow> = {
  updated: 450, unchanged: 0,
  rows: Array.from({ length: 450 }, (_, i) => ({
    row: i + 2, name: i % 2 ? `Worker ${i + 2}` : null, person_id: `p${i + 2}`,
    action: 'updated' as const, diff: null })),
};
const bodyRows = () => screen.getAllByRole('row').length - 1;

it('lists every row with no pageSize (the other tools are unchanged)', () => {
  render(<MemoryRouter>
    <BulkApplySummary result={many} entityLabel="Worker" filename="workers-bulk-summary"
      linkFor={() => '/people/workers'} openTo="/people/workers" openLabel="Open Workers" />
  </MemoryRouter>);
  expect(bodyRows()).toBe(450);
  expect(screen.queryByRole('button', { name: /^Show \d+ more$/ })).toBeNull();
  expect(screen.getAllByRole('columnheader').map((h) => h.textContent))
    .toEqual(['Row', 'Worker', 'Result', 'Changes']);
});

it('pages the table by pageSize while the csv still carries every row', () => {
  render(<MemoryRouter>
    <BulkApplySummary result={many} entityLabel="Asset" filename="assets-bulk-summary" pageSize={200}
      linkFor={() => '/assets'} openTo="/assets" openLabel="Open Assets" />
  </MemoryRouter>);
  expect(bodyRows()).toBe(200);
  fireEvent.click(screen.getByRole('button', { name: 'Show 200 more' }));
  expect(bodyRows()).toBe(400);
  fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }));
  expect(bodyRows()).toBe(450);
  expect(screen.queryByRole('button', { name: /^Show \d+ more$/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Download summary (.csv)' }));
  expect(listTools.exportCsv).toHaveBeenCalledWith('assets-bulk-summary', expect.any(Array), many.rows);
  expect(listTools.exportCsv.mock.calls[0][2]).toHaveLength(450);
});

it('an add-only result lists only the counts it has', () => {
  render(<MemoryRouter>
    <BulkApplySummary result={{ created: 2, skipped: 1, rows: [] }} entityLabel="Worker"
      filename="time-bulk-summary" linkFor={() => null} openTo="/people/time"
      openLabel="Open Time Management" />
  </MemoryRouter>);
  expect(screen.getByText('Applied: 2 added · 1 skipped')).toBeTruthy();
});

it('adds an extra column after the name in the table and the csv, and a note line', () => {
  render(<MemoryRouter>
    <BulkApplySummary result={many} entityLabel="Asset" filename="assets-bulk-summary" pageSize={200}
      linkFor={() => '/assets'} openTo="/assets" openLabel="Open Assets"
      extraColumn={{ label: 'Asset ID', mono: true, value: (r) => (r.row === 3 ? '' : `A-${r.row}`) }}
      note="Rack placement was rechecked." />
  </MemoryRouter>);
  expect(screen.getAllByRole('columnheader').map((h) => h.textContent))
    .toEqual(['Row', 'Asset', 'Asset ID', 'Result', 'Changes']);
  expect(screen.getByText('A-2')).toBeTruthy();
  expect(screen.getByText('Rack placement was rechecked.').className).toBe('set-note');
  const row3 = screen.getAllByRole('row')[2];
  expect(row3.querySelectorAll('td')[2].textContent).toBe('—');   // blank value → em dash
  fireEvent.click(screen.getByRole('button', { name: 'Download summary (.csv)' }));
  const [, columns] = listTools.exportCsv.mock.calls[0];
  expect(columns.map(([h]: [string]) => h)).toEqual(['Row', 'Asset', 'Asset ID', 'Result', 'Changes']);
  expect(columns[2][1](many.rows[0])).toBe('A-2');
});

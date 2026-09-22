// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ previewTruckBulk: vi.fn(), commitTruckBulk: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
vi.mock('../../lib/listTools', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/listTools')>()), exportCsv: vi.fn(),
}));
const { default: TruckBulkUpload } = await import('./TruckBulkUpload');

beforeEach(() => { api.previewTruckBulk.mockReset(); api.commitTruckBulk.mockReset(); });
afterEach(cleanup);

const row = (over: Record<string, unknown>) => ({
  row: 2, name: 'Truck 1', action: 'create', matched_by: null, matched_name: null,
  errors: [], diff: null, truck_id: null,
  cells: { name: 'Truck 1', status: '' }, data: { name: 'Truck 1', status: 'created' },
  ...over,
});

function pickFile() {
  const input = screen.getByLabelText('Upload a file (.csv or .xlsx)') as HTMLInputElement;
  expect(input.id).toBe('truck-bulk-file');
  fireEvent.change(input, { target: { files: [new File(['name\nX'], 'fleet.csv', { type: 'text/csv' })] } });
}

it('renders truck copy, list diffs, and commits approved truck ids', async () => {
  api.previewTruckBulk.mockResolvedValue({ can_commit: true, rows: [
    row({ row: 2, name: 'Truck 1', action: 'update', matched_by: 'name', matched_name: 'Truck 1',
          truck_id: 't1', diff: { status: { old: 'created', new: 'active' },
                                  containers: { add: ['Crate B'], remove: ['Crate A'] } } }),
    row({ row: 3, name: 'Truck 9', cells: { name: 'Truck 9', status: '' } }),
  ] });
  api.commitTruckBulk.mockResolvedValue({
    created: 1, updated: 1, skipped: 0, unchanged: 0,
    rows: [
      { row: 1, name: 'Truck 1', truck_id: 't1', action: 'updated',
        diff: { containers: { add: ['Crate B'], remove: ['Crate A'] } } },
      { row: 2, name: 'Truck 9', truck_id: 't9', action: 'created', diff: null },
    ],
  });
  render(<MemoryRouter><TruckBulkUpload /></MemoryRouter>);
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText('new truck')).toBeTruthy();
  expect(screen.getByText('status: created → active')).toBeTruthy();
  expect(screen.getByText('containers: +Crate B, −Crate A')).toBeTruthy();
  expect(screen.getByText('1 to add · 0 to update · 1 to skip · 0 unchanged · 0 errors')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Update Truck 1'));
  fireEvent.click(screen.getByRole('button', { name: 'Add 1 truck and update 1 truck' }));
  await waitFor(() => expect(api.commitTruckBulk).toHaveBeenCalledWith(
    [{ name: 'Truck 1', status: '' }, { name: 'Truck 9', status: '' }], ['t1'], 'fleet.csv'));
  expect(await screen.findByText('Applied: 1 added · 1 updated · 0 skipped · 0 unchanged')).toBeTruthy();
  expect((screen.getByRole('link', { name: 'Truck 1' }) as HTMLAnchorElement).getAttribute('href'))
    .toMatch(/\/logistics\/trucks\/t1$/);
  expect(screen.getByRole('link', { name: 'Open Trucks' })).toBeTruthy();
  expect(screen.getByText('containers: +Crate B, −Crate A')).toBeTruthy();   // summary changes text
});

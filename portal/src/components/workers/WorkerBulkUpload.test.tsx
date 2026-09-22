// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ previewWorkerBulk: vi.fn(), commitWorkerBulk: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const listTools = vi.hoisted(() => ({ exportCsv: vi.fn() }));
vi.mock('../../lib/listTools', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/listTools')>()), ...listTools,
}));
const { ApiError } = await import('../../lib/api');
const { default: WorkerBulkUpload } = await import('./WorkerBulkUpload');

function renderUpload(onDone: (result: unknown) => void = () => {}) {
  return render(<MemoryRouter><WorkerBulkUpload onDone={onDone} /></MemoryRouter>);
}

const row = (over: Record<string, unknown>) => ({
  row: 2, name: 'Bob Smith', action: 'create', matched_by: null, matched_name: null,
  errors: [], diff: null, person_id: null,
  cells: { first_name: 'Bob', last_name: 'Smith', status: '', country: '' },
  data: { first_name: 'Bob', last_name: 'Smith', status: 'active', country: 'US' },
  ...over,
});

beforeEach(() => {
  api.previewWorkerBulk.mockReset();
  api.commitWorkerBulk.mockReset();
  listTools.exportCsv.mockReset();
});
afterEach(cleanup);

function pickFile() {
  const input = screen.getByLabelText('Upload a file (.csv or .xlsx)') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['first_name\nX'], 'crew.csv', { type: 'text/csv' })] } });
}

it('previews and keeps Apply disabled while errors exist', async () => {
  api.previewWorkerBulk.mockResolvedValue({ can_commit: false, rows: [
    row({ row: 2, name: 'Bad Row', action: 'error', errors: ["unknown level 'L9'"], data: null }),
    row({ row: 3, name: 'Good Row' }),
  ] });
  renderUpload();
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText("unknown level 'L9'")).toBeTruthy();
  expect(screen.getAllByText('new worker')).toHaveLength(2);
  expect(screen.getByText('1 to add · 0 to update · 0 to skip · 0 unchanged · 1 error')).toBeTruthy();
  expect((screen.getByRole('button', { name: /Add 1 worker/ }) as HTMLButtonElement).disabled).toBe(true);
});

const commitResult = {
  created: 1, updated: 1, skipped: 1, unchanged: 0,
  rows: [
    { row: 1, name: 'Bob Smith', person_id: 'p1', action: 'updated' as const,
      diff: { trade: { old: null, new: 'Cable' } } },
    { row: 2, name: 'Sara Jones', person_id: 'p2', action: 'skipped' as const,
      diff: { city: { old: null, new: 'Austin' } } },
    { row: 3, name: 'Maria Lopez', person_id: 'p3', action: 'created' as const, diff: null },
  ],
};

it('skips updates by default, Update all / Skip all toggle them, commits approved ids, renders the summary', async () => {
  api.previewWorkerBulk.mockResolvedValue({ can_commit: true, rows: [
    row({ row: 2, name: 'Bob Smith', action: 'update', matched_by: 'email, name', matched_name: 'Bob Smith',
          person_id: 'p1', diff: { trade: { old: null, new: 'Cable' } } }),
    row({ row: 3, name: 'Sara Jones', action: 'update', matched_by: 'phone', matched_name: 'Sara Jones',
          person_id: 'p2', diff: { city: { old: null, new: 'Austin' } },
          cells: { first_name: 'Sara', last_name: 'Jones', city: 'Austin' } }),
    row({ row: 4, name: 'Maria Lopez', cells: { first_name: 'Maria', last_name: 'Lopez' } }),
  ] });
  api.commitWorkerBulk.mockResolvedValue(commitResult);
  const onDone = vi.fn();
  renderUpload(onDone);
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText('email, name')).toBeTruthy();
  expect(screen.getByText('phone')).toBeTruthy();
  // default: both updates skipped, adds alone make Apply available
  expect(screen.getByText('1 to add · 0 to update · 2 to skip · 0 unchanged · 0 errors')).toBeTruthy();
  const apply = () => screen.getByRole('button', { name: /^Add 1 worker and update \d workers?$/ }) as HTMLButtonElement;
  expect(apply().textContent).toBe('Add 1 worker and update 0 workers');
  expect(apply().disabled).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: 'Update all' }));
  expect(screen.getByText('1 to add · 2 to update · 0 to skip · 0 unchanged · 0 errors')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Skip all' }));
  expect(screen.getByText('1 to add · 0 to update · 2 to skip · 0 unchanged · 0 errors')).toBeTruthy();

  fireEvent.click(screen.getByLabelText('Update Bob Smith'));
  expect(apply().textContent).toBe('Add 1 worker and update 1 worker');
  fireEvent.click(apply());
  await waitFor(() => expect(api.commitWorkerBulk).toHaveBeenCalledWith(
    [{ first_name: 'Bob', last_name: 'Smith', status: '', country: '' },
     { first_name: 'Sara', last_name: 'Jones', city: 'Austin' },
     { first_name: 'Maria', last_name: 'Lopez' }],
    ['p1'], 'crew.csv'));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith({
    ...commitResult,
    rows: [{ ...commitResult.rows[0], row: 2 }, { ...commitResult.rows[1], row: 3 },
           { ...commitResult.rows[2], row: 4 }],
  }));
  expect(await screen.findByText('Applied: 1 added · 1 updated · 1 skipped · 0 unchanged')).toBeTruthy();
  const link = screen.getByRole('link', { name: 'Bob Smith' }) as HTMLAnchorElement;
  expect(link.getAttribute('href')).toMatch(/\/people\/workers\/p1$/);
  expect(screen.getByText('Skipped')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Download summary (.csv)' }));
  expect(listTools.exportCsv.mock.calls[0][0]).toBe('workers-bulk-summary');
});

it('disables Apply when nothing would be written (only skipped and unchanged rows)', async () => {
  api.previewWorkerBulk.mockResolvedValue({ can_commit: true, rows: [
    row({ row: 2, name: 'Bob Smith', action: 'update', matched_by: 'name', matched_name: 'Bob Smith',
          person_id: 'p1', diff: { trade: { old: null, new: 'Cable' } } }),
    row({ row: 3, name: 'Same Person', action: 'unchanged', matched_by: 'email', matched_name: 'Same Person',
          person_id: 'p9' }),
  ] });
  renderUpload();
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByText('name');
  const apply = screen.getByRole('button', { name: 'Add 0 workers and update 0 workers' }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Update Bob Smith'));
  expect((screen.getByRole('button', { name: 'Add 0 workers and update 1 worker' }) as HTMLButtonElement).disabled).toBe(false);
});

it('shows the mapped error and clears the preview when the commit fails; a new file clears everything', async () => {
  api.previewWorkerBulk.mockResolvedValue({ can_commit: true, rows: [row({ row: 2 })] });
  api.commitWorkerBulk.mockRejectedValue(new ApiError(422, 'rows_invalid'));
  renderUpload();
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByText('new worker');
  fireEvent.click(screen.getByRole('button', { name: /Add 1 worker/ }));
  expect(await screen.findByText('Some rows have problems — fix them and preview again.')).toBeTruthy();
  expect(screen.queryByText('new worker')).toBeNull();
  pickFile();
  expect(screen.queryByText('Some rows have problems — fix them and preview again.')).toBeNull();
});

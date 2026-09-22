// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ previewSiteBulk: vi.fn(), commitSiteBulk: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const listTools = vi.hoisted(() => ({ exportCsv: vi.fn() }));
vi.mock('../../lib/listTools', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/listTools')>()), ...listTools,
}));
const { default: SiteBulkUpload } = await import('./SiteBulkUpload');

function renderUpload(onDone: (result: unknown) => void = () => {}) {
  return render(<MemoryRouter><SiteBulkUpload onDone={onDone} /></MemoryRouter>);
}

const row = (over: Record<string, unknown>) => ({
  row: 2, name: 'Site', action: 'create', matched_by: null, matched_name: null,
  errors: [], diff: null, site_id: null, data: { name: (over.name as string) ?? 'Site' }, ...over,
});

beforeEach(() => {
  api.previewSiteBulk.mockReset();
  api.commitSiteBulk.mockReset();
  listTools.exportCsv.mockReset();
});
afterEach(cleanup);

function pickFile() {
  const input = screen.getByLabelText('Upload a file (.csv or .xlsx)') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['name\nX'], 'sites.csv', { type: 'text/csv' })] } });
}

it('previews and keeps Apply disabled while errors exist', async () => {
  api.previewSiteBulk.mockResolvedValue({ can_commit: false, rows: [
    row({ row: 2, name: 'Bad', action: 'error', errors: ["unknown type 'nope'"], data: null }),
    row({ row: 3, name: 'Good' }),
  ] });
  renderUpload();
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText("unknown type 'nope'")).toBeTruthy();
  // both rows are unmatched here, so the label appears twice
  expect(screen.getAllByText('new site')).toHaveLength(2);
  expect(screen.getByText('1 to add · 0 to update · 0 unchanged · 1 error')).toBeTruthy();
  expect((screen.getByRole('button', { name: /Add 1 site/ }) as HTMLButtonElement).disabled).toBe(true);
});

const commitResult = {
  created: 1, updated: 1, unchanged: 0,
  rows: [
    { row: 2, name: 'New Name', site_id: 's1', action: 'updated' as const,
      diff: { name: { old: 'Old Name', new: 'New Name' } } },
    { row: 3, name: 'Fresh', site_id: 's2', action: 'created' as const, diff: null },
  ],
};

it('gates Apply on approving every update, shows matched-by, commits approved ids, renders the summary', async () => {
  api.previewSiteBulk.mockResolvedValue({ can_commit: true, rows: [
    row({ row: 2, name: 'New Name', action: 'update', matched_by: 'address', matched_name: 'Old Name',
          site_id: 's1', diff: { name: { old: 'Old Name', new: 'New Name' } }, data: { name: 'New Name' } }),
    row({ row: 3, name: 'Fresh' }),
  ] });
  api.commitSiteBulk.mockResolvedValue(commitResult);
  const onDone = vi.fn();
  renderUpload(onDone);
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText('address')).toBeTruthy();
  const apply = screen.getByRole('button', { name: 'Add 1 site and update 1 site' }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Approve update to New Name'));
  expect(apply.disabled).toBe(false);
  fireEvent.click(apply);
  await waitFor(() => expect(api.commitSiteBulk).toHaveBeenCalledWith(
    [{ name: 'New Name' }, { name: 'Fresh' }], ['s1'], 'sites.csv'));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(commitResult));

  expect(await screen.findByText('Applied: 1 added · 1 updated · 0 unchanged')).toBeTruthy();
  const link = screen.getByRole('link', { name: 'New Name' }) as HTMLAnchorElement;
  expect(link.getAttribute('href')).toMatch(/\/sites\?open=s1$/);
  expect(screen.getByText('name: Old Name → New Name')).toBeTruthy();
  expect(screen.getByText('Added')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Download summary (.csv)' }));
  expect(listTools.exportCsv).toHaveBeenCalledWith(
    'sites-bulk-summary',
    expect.arrayContaining([
      expect.any(Array), expect.any(Array), expect.any(Array), expect.any(Array),
    ]),
    commitResult.rows,
  );
  expect(listTools.exportCsv.mock.calls[0][1]).toHaveLength(4);
});

it('clears the summary when a new file is chosen', async () => {
  api.previewSiteBulk.mockResolvedValue({ can_commit: true, rows: [
    row({ row: 2, name: 'Fresh' }),
  ] });
  api.commitSiteBulk.mockResolvedValue(commitResult);
  renderUpload();
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByText('new site');
  fireEvent.click(screen.getByRole('button', { name: /Add 1 site/ }));
  await screen.findByText('Applied: 1 added · 1 updated · 0 unchanged');

  pickFile();
  expect(screen.queryByText('Applied: 1 added · 1 updated · 0 unchanged')).toBeNull();
});

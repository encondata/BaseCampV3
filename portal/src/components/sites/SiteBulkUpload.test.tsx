// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ previewSiteBulk: vi.fn(), commitSiteBulk: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: SiteBulkUpload } = await import('./SiteBulkUpload');

const row = (over: Record<string, unknown>) => ({
  row: 2, name: 'Site', action: 'create', matched_by: null, matched_name: null,
  errors: [], diff: null, site_id: null, data: { name: (over.name as string) ?? 'Site' }, ...over,
});

beforeEach(() => { api.previewSiteBulk.mockReset(); api.commitSiteBulk.mockReset(); });
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
  render(<SiteBulkUpload onDone={() => {}} />);
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText("unknown type 'nope'")).toBeTruthy();
  // both rows are unmatched here, so the label appears twice
  expect(screen.getAllByText('new site')).toHaveLength(2);
  expect(screen.getByText('1 to add · 0 to update · 0 unchanged · 1 error')).toBeTruthy();
  expect((screen.getByRole('button', { name: /Add 1 site/ }) as HTMLButtonElement).disabled).toBe(true);
});

it('gates Apply on approving every update, shows matched-by, commits approved ids', async () => {
  api.previewSiteBulk.mockResolvedValue({ can_commit: true, rows: [
    row({ row: 2, name: 'New Name', action: 'update', matched_by: 'address', matched_name: 'Old Name',
          site_id: 's1', diff: { name: { old: 'Old Name', new: 'New Name' } }, data: { name: 'New Name' } }),
    row({ row: 3, name: 'Fresh' }),
  ] });
  api.commitSiteBulk.mockResolvedValue({ created: 1, updated: 1, unchanged: 0 });
  const onDone = vi.fn();
  render(<SiteBulkUpload onDone={onDone} />);
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
  await waitFor(() => expect(onDone).toHaveBeenCalledWith({ created: 1, updated: 1, unchanged: 0 }));
});

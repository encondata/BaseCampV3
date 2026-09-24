// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AssetBulkAction, AssetBulkJob, AssetBulkListing, AssetBulkRow } from '../../lib/api';

function row(n: number, over: Partial<AssetBulkRow> = {}): AssetBulkRow {
  return {
    row: n, name: `Server ${n}`, asset_id: `a${n}`, asset_number: 1000 + n, matched_by: 'serial',
    action: 'update', errors: [], issues: [], diff: { name: { old: `Old ${n}`, new: `Server ${n}` } },
    ...over,
  };
}
function listing(rows: AssetBulkRow[], unchanged = 0): AssetBulkListing {
  const counts: Record<AssetBulkAction, number> = { update: 0, unchanged, attention: 0, error: 0, skipped: 0 };
  rows.forEach((r) => { counts[r.action] += 1; });
  return {
    rows, counts, can_commit: counts.attention === 0 && counts.error === 0 && rows.length + unchanged > 0,
    total: rows.length + unchanged,
  };
}
function job(over: Partial<AssetBulkJob> = {}): AssetBulkJob {
  return {
    id: 'job1', initiative_id: null, kind: 'asset_bulk_update', filename: 'assets.csv', options: {},
    phase: 'commit', status: 'queued', total_rows: 3, processed_rows: 0, created_count: 0,
    updated_count: 0, error_count: 0, error: null, results: null, created_at: '2026-09-24T12:00:00Z',
    started_at: null, finished_at: null, ...over,
  } as AssetBulkJob;
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const AMBIGUOUS = row(3, {
  action: 'attention', asset_id: null, asset_number: null, matched_by: null, diff: null, name: 'SN-1',
  issues: [{ field: 'asset', kind: 'ambiguous', value: 'SN-1', candidates: [
    { id: 'a1', label: 'Asset 1001', detail: 'SN-1 · Rack A' },
    { id: 'a2', label: 'Asset 1002', detail: 'SN-1 · Rack B' }] }],
});
const MISSING = row(5, {
  action: 'error', asset_id: null, asset_number: null, matched_by: null, diff: null, name: 'SN-9',
  errors: ['No live asset has serial number SN-9.'],
});

const api = vi.hoisted(() => ({
  uploadAssetBulk: vi.fn(),
  previewAssetBulk: vi.fn(),
  commitAssetBulk: vi.fn(),
  getAssetBulkJob: vi.fn(),
  cancelAssetBulk: vi.fn(async () => {}),
  listAssetModels: vi.fn(async () => [{ id: 'm9', make: 'Dell', model: 'R740', category: 'server' }]),
  listClients: vi.fn(async () => []),
  listSites: vi.fn(async () => []),
  listAssetStatuses: vi.fn(async () => []),
}));
vi.mock('../../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../../lib/api')>()), ...api }));

const { default: AssetBulkUpload } = await import('./AssetBulkUpload');

beforeEach(() => {
  api.uploadAssetBulk.mockResolvedValue({
    job_id: 'job1', preview: listing([AMBIGUOUS, MISSING, row(2), row(4)], 7),
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

async function upload(name = 'assets.csv') {
  const input = screen.getByLabelText('Upload a file (.csv or .xlsx)') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], name)] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByRole('table', { name: 'Import preview' });
}
async function start() {
  render(<MemoryRouter><AssetBulkUpload /></MemoryRouter>);
  await upload();
}
const table = () => screen.getByRole('table', { name: 'Import preview' });
const tr = (n: number) => within(table()).getByText(String(n), { selector: 'td' }).closest('tr') as HTMLElement;
const cells = (n: number) => [...tr(n).querySelectorAll('td')].map((td) => td.textContent);
const applyButton = (name: RegExp | string) => screen.getByRole('button', { name }) as HTMLButtonElement;

it('upload renders the shared preview: columns, row tints, counts, and Apply blocked', async () => {
  await start();
  expect(api.uploadAssetBulk).toHaveBeenCalledWith(expect.any(File), 'assets.csv');
  expect(within(table()).getAllByRole('columnheader').map((h) => h.textContent))
    .toEqual(['Row', 'Name', 'Matched by', 'Action', 'Details']);
  expect(cells(2).slice(1, 4)).toEqual(['Server 2Asset 1002', 'serial', 'Skip']);
  expect(within(tr(2)).getByText('Asset 1002').className).toBe('mono');
  expect(cells(2)[4]).toBe('name: Old 2 → Server 2 Update');
  expect(tr(2).className).toBe('bulk-row-skipped');
  expect(cells(3).slice(2, 4)).toEqual(['—', 'Needs a match']);
  expect(tr(3).className).toBe('bulk-row-error');
  expect(within(tr(3)).getByText('“SN-1” matches 2 assets — pick one.')).toBeTruthy();
  expect(cells(5)[3]).toBe('Error');
  expect(within(tr(5)).getByText('No live asset has serial number SN-9.').className).toBe('pf-error');
  expect(screen.getByText('0 to update · 2 to skip · 7 unchanged · 1 needs a match · 1 error')).toBeTruthy();
  expect(applyButton('Update 0 assets').disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Update row 2'));
  expect(cells(2)[3]).toBe('Update');
  expect(tr(2).className).toBe('bulk-row-update');
  expect(applyButton('Update 1 asset').disabled).toBe(true);   // attention/error rows still block it
});

it('picking a candidate re-previews the job with the override only — no rows are posted', async () => {
  await start();
  api.previewAssetBulk.mockResolvedValue(listing([row(3, { matched_by: 'your pick' }), row(2), row(4)], 7));
  fireEvent.focus(screen.getByLabelText('Match asset for row 3'));
  fireEvent.mouseDown(await screen.findByText('SN-1 · Rack B'));
  await waitFor(() => expect(api.previewAssetBulk).toHaveBeenCalledWith('job1',
    { overrides: { 3: { asset: 'a2' } }, skip: [] }));
  expect(await within(table()).findByText('your pick')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Clear picks for row 3' })).toBeTruthy();
});

it('Skip all unmatched skips every attention and error row in one re-preview', async () => {
  await start();
  api.previewAssetBulk.mockResolvedValue(listing([
    row(3, { action: 'skipped', diff: null }), row(5, { action: 'skipped', diff: null }), row(2), row(4)], 7));
  fireEvent.click(screen.getByRole('button', { name: 'Skip all unmatched' }));
  await waitFor(() => expect(api.previewAssetBulk).toHaveBeenCalledWith('job1', { overrides: {}, skip: [3, 5] }));
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Skip row 5' }) as HTMLInputElement).checked).toBe(true));
  expect(screen.queryByRole('button', { name: 'Skip all unmatched' })).toBeNull();
});

it('Update all approves every update, and the commit sends approve_all', async () => {
  api.uploadAssetBulk.mockResolvedValue({ job_id: 'job1', preview: listing([row(2), row(4), row(6)], 1) });
  await start();
  fireEvent.click(screen.getByRole('button', { name: 'Update all' }));
  expect((screen.getByLabelText('Update row 4') as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText('3 to update · 0 to skip · 1 unchanged · 0 need a match · 0 errors')).toBeTruthy();
  api.commitAssetBulk.mockResolvedValue(job());
  api.getAssetBulkJob.mockResolvedValue(job({ status: 'running' }));
  fireEvent.click(applyButton('Update 3 assets'));
  await waitFor(() => expect(api.commitAssetBulk).toHaveBeenCalledWith('job1', {
    overrides: {}, skip: [], approved_updates: [], approve_all: true }));
});

it('unchecking a row under Update all turns it off and approves the others explicitly', async () => {
  api.uploadAssetBulk.mockResolvedValue({ job_id: 'job1', preview: listing([row(2), row(4), row(6)]) });
  await start();
  fireEvent.click(screen.getByRole('button', { name: 'Update all' }));
  fireEvent.click(screen.getByLabelText('Update row 4'));
  expect((screen.getByLabelText('Update row 4') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText('Update row 6') as HTMLInputElement).checked).toBe(true);
  api.commitAssetBulk.mockResolvedValue(job());
  api.getAssetBulkJob.mockResolvedValue(job({ status: 'running' }));
  fireEvent.click(applyButton('Update 2 assets'));
  await waitFor(() => expect(api.commitAssetBulk).toHaveBeenCalledWith('job1', {
    overrides: {}, skip: [], approved_updates: [2, 6], approve_all: false }));
  expect(await screen.findByText(/^Applying…/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Skip all' }) as HTMLButtonElement).disabled).toBe(true);
});

it('Apply polls the job every 1.5 s, shows progress, then the per-row summary', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.uploadAssetBulk.mockResolvedValue({ job_id: 'job1', preview: listing([row(2), row(4)], 7) });
  await start();
  fireEvent.click(screen.getByLabelText('Update row 2'));
  api.commitAssetBulk.mockResolvedValue(job({ total_rows: 9800 }));
  api.getAssetBulkJob
    .mockResolvedValueOnce(job({ status: 'running', processed_rows: 1250, total_rows: 9800 }))
    .mockResolvedValueOnce(job({
      status: 'completed', processed_rows: 9800, total_rows: 9800, error: null, results: {
        summary: { updated: 1, skipped: 1, unchanged: 7 },
        rows: [{ row: 2, name: 'Server 2', asset_id: 'a2', asset_number: 1002, action: 'updated',
                 diff: { name: { old: 'Old 2', new: 'Server 2' } } },
               { row: 4, name: null, asset_id: 'a4', asset_number: 1004, action: 'skipped', diff: null }] },
    }));
  fireEvent.click(applyButton('Update 1 asset'));
  expect(await screen.findByText('Applying… 0 of 9,800')).toBeTruthy();
  expect(api.getAssetBulkJob).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(api.getAssetBulkJob).toHaveBeenCalledWith('job1');
  expect(screen.getByText('Applying… 1,250 of 9,800')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(screen.getByText('Applied: 1 updated · 1 skipped · 7 unchanged')).toBeTruthy();
  expect((screen.getByRole('link', { name: 'Server 2' }) as HTMLAnchorElement).getAttribute('href')).toBe('/assets/a2');
  expect((screen.getByRole('link', { name: 'Open Assets' }) as HTMLAnchorElement).getAttribute('href')).toBe('/assets');
  // the Asset ID column: a nameless row is still identifiable
  const summary = screen.getByRole('table', { name: 'Apply summary' });
  expect(within(summary).getByRole('columnheader', { name: 'Asset ID' })).toBeTruthy();
  expect(within(summary).getByText('1002')).toBeTruthy();
  expect(within(summary).getByText('1004')).toBeTruthy();
  expect(screen.queryByText(/^Rack placement/)).toBeNull();     // no model change, no recheck
  expect(screen.queryByRole('table', { name: 'Import preview' })).toBeNull();
  expect(screen.queryByText(/^Applying…/)).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(api.getAssetBulkJob).toHaveBeenCalledTimes(2);          // polling stopped
});

it('a completed job with a placement recheck shows the counts; its summary lists 200 rows at a time', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.uploadAssetBulk.mockResolvedValue({ job_id: 'job1', preview: listing([row(2)]) });
  await start();
  fireEvent.click(screen.getByLabelText('Update row 2'));
  api.commitAssetBulk.mockResolvedValue(job());
  const applied = Array.from({ length: 250 }, (_, i) => ({
    row: i + 2, name: `Server ${i + 2}`, asset_id: `a${i + 2}`, asset_number: 1000 + i + 2,
    action: 'updated' as const, diff: null }));
  api.getAssetBulkJob.mockResolvedValue(job({
    status: 'completed', error: null, results: {
      summary: { updated: 250, skipped: 0, unchanged: 0,
                 placement: { collisions: 2, orphans: 1, cleared: 0 } },
      rows: applied },
  }));
  fireEvent.click(applyButton('Update 1 asset'));
  await screen.findByText('Applying… 0 of 3');
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(screen.getByText('Rack placement was rechecked on the moves holding these assets: '
    + '2 collisions, 1 orphan node, and 0 flags cleared.').className).toBe('set-note');
  const summary = screen.getByRole('table', { name: 'Apply summary' });
  expect(within(summary).getAllByRole('row').length - 1).toBe(200);
  fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }));
  expect(within(summary).getAllByRole('row').length - 1).toBe(250);
});

it('a failing status rule names the row and the rule, and drops the preview', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.uploadAssetBulk.mockResolvedValue({ job_id: 'job1', preview: listing([row(2)]) });
  await start();
  fireEvent.click(screen.getByLabelText('Update row 2'));
  api.commitAssetBulk.mockResolvedValue(job());
  api.getAssetBulkJob.mockResolvedValue(job({
    status: 'failed', error: 'rule_failed',
    results: { row: 2, rule_name: 'Close the move', message: "rule 'Close the move' failed: boom" },
  }));
  fireEvent.click(applyButton('Update 1 asset'));
  await screen.findByText('Applying… 0 of 3');
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(screen.getByText('Row 2: the status rule “Close the move” stopped the update — nothing was applied.'))
    .toBeTruthy();
  expect(screen.queryByRole('table', { name: 'Import preview' })).toBeNull();
});

it('a job that fails with rows_invalid shows the mapped message and drops the preview', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.uploadAssetBulk.mockResolvedValue({ job_id: 'job1', preview: listing([row(2)]) });
  await start();
  fireEvent.click(screen.getByLabelText('Update row 2'));
  api.commitAssetBulk.mockResolvedValue(job());
  api.getAssetBulkJob.mockResolvedValue(job({ status: 'failed', error: 'rows_invalid', results: { rows: [] } }));
  fireEvent.click(applyButton('Update 1 asset'));
  await screen.findByText('Applying… 0 of 3');
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(screen.getByText('Some rows changed and now need attention — nothing was applied. '
    + 'Upload the file again to review them.')).toBeTruthy();
  expect(screen.queryByRole('table', { name: 'Import preview' })).toBeNull();
});

it('polling stops when the pane unmounts', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.uploadAssetBulk.mockResolvedValue({ job_id: 'job1', preview: listing([row(2)]) });
  await start();
  fireEvent.click(screen.getByLabelText('Update row 2'));
  api.commitAssetBulk.mockResolvedValue(job());
  api.getAssetBulkJob.mockResolvedValue(job({ status: 'running' }));
  fireEvent.click(applyButton('Update 1 asset'));
  await screen.findByText('Applying… 0 of 3');
  cleanup();
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(api.getAssetBulkJob).not.toHaveBeenCalled();
});

it('lists 200 rows at a time; "Show 200 more" reveals rows 201–400', async () => {
  const many = Array.from({ length: 450 }, (_, i) => row(i + 2));
  api.uploadAssetBulk.mockResolvedValue({ job_id: 'job1', preview: listing(many) });
  await start();
  const body = () => within(table()).getAllByRole('row').length - 1;
  expect(body()).toBe(200);
  expect(within(table()).queryByText('202', { selector: 'td' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show 200 more' }));
  expect(body()).toBe(400);
  expect(within(table()).getByText('202', { selector: 'td' })).toBeTruthy();
  expect(within(table()).getByText('401', { selector: 'td' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }));
  expect(body()).toBe(450);
  expect(screen.queryByRole('button', { name: /^Show \d+ more$/ })).toBeNull();
});

it('the newest re-preview wins when responses arrive out of order', async () => {
  await start();
  const first = deferred<AssetBulkListing>();
  const second = deferred<AssetBulkListing>();
  api.previewAssetBulk.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  expect(api.previewAssetBulk).toHaveBeenCalledTimes(2);
  expect(applyButton(/^Update \d+ assets?$/).disabled).toBe(true);
  await act(async () => { second.resolve(listing([row(2, { name: 'Second Response' })])); });
  await act(async () => { first.resolve(listing([row(2, { name: 'First Response' })])); });
  expect(screen.getByText('Second Response')).toBeTruthy();
  expect(screen.queryByText('First Response')).toBeNull();
});

it('a new file drops an in-flight re-preview, cancels the old job, and resets picks, skips and approvals', async () => {
  await start();
  fireEvent.click(screen.getByLabelText('Update row 2'));
  const stale = deferred<AssetBulkListing>();
  api.previewAssetBulk.mockReturnValueOnce(stale.promise);
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  const input = screen.getByLabelText('Upload a file (.csv or .xlsx)') as HTMLInputElement;
  expect(input.disabled).toBe(true);           // no new file while a re-preview is pending …
  fireEvent.change(input, { target: { files: [new File(['y'], 'other.csv')] } });   // … should one land anyway
  expect(screen.queryByRole('table', { name: 'Import preview' })).toBeNull();
  expect(api.cancelAssetBulk).toHaveBeenCalledWith('job1');
  await act(async () => { stale.resolve(listing([row(2, { name: 'Old File Row' })])); });
  expect(screen.queryByText('Old File Row')).toBeNull();

  api.uploadAssetBulk.mockResolvedValueOnce({ job_id: 'job2', preview: listing([row(2), row(4)]) });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByRole('table', { name: 'Import preview' });
  expect(api.uploadAssetBulk).toHaveBeenLastCalledWith(expect.any(File), 'other.csv');
  expect((screen.getByLabelText('Update row 2') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByLabelText('Update row 4'));
  api.commitAssetBulk.mockResolvedValue(job({ id: 'job2' }));
  api.getAssetBulkJob.mockResolvedValue(job({ id: 'job2', status: 'running' }));
  fireEvent.click(applyButton('Update 1 asset'));
  await waitFor(() => expect(api.commitAssetBulk).toHaveBeenCalledWith('job2', {
    overrides: {}, skip: [], approved_updates: [4], approve_all: false }));
});

it('an unknown model lists its candidates, then every model (loaded once, lazily); a failed load retries', async () => {
  api.listAssetModels.mockRejectedValueOnce(new Error('down'));
  const unknown = (n: number) => row(n, {
    action: 'attention', diff: null,
    issues: [{ field: 'model', kind: 'unknown', value: 'Dell R999', candidates: [] }],
  });
  api.uploadAssetBulk.mockResolvedValue({ job_id: 'job1', preview: listing([unknown(2), unknown(4)]) });
  render(<MemoryRouter><AssetBulkUpload /></MemoryRouter>);
  expect(api.listAssetModels).not.toHaveBeenCalled();
  await upload();
  expect(await screen.findAllByText(/could not load the list/i)).toHaveLength(2);
  expect(api.listAssetModels).toHaveBeenCalledTimes(1);
  expect(screen.getAllByText('No model named “Dell R999” — pick one.')).toHaveLength(2);
  api.previewAssetBulk.mockResolvedValue(listing([row(2), unknown(4)]));
  fireEvent.focus(screen.getByLabelText('Match model for row 2'));
  fireEvent.mouseDown(await screen.findByText('Dell R740'));
  await waitFor(() => expect(api.previewAssetBulk).toHaveBeenCalledWith('job1',
    { overrides: { 2: { model: 'm9' } }, skip: [] }));
  expect(api.listAssetModels).toHaveBeenCalledTimes(2);
});

it('a checked Skip keeps "Skip" in its accessible name and says how to undo', async () => {
  await start();
  api.previewAssetBulk.mockResolvedValueOnce(listing([row(3, { action: 'skipped', diff: null })]));
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  const box = await screen.findByRole('checkbox', { name: 'Skip row 3' });
  await waitFor(() => expect((box as HTMLInputElement).checked).toBe(true));
  expect(screen.getByText('Skipped — uncheck to undo.')).toBeTruthy();
});

it('an upload error is shown as a sentence', async () => {
  const { ApiError } = await import('../../lib/api');
  api.uploadAssetBulk.mockRejectedValue(new ApiError(422, 'too_many_rows'));
  render(<MemoryRouter><AssetBulkUpload /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Upload a file (.csv or .xlsx)'),
    { target: { files: [new File(['x'], 'big.csv')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText('Too many rows — the limit is 15,000 per upload.')).toBeTruthy();
});

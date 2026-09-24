// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { TeamBulkPreview, TeamBulkRow } from '../../lib/api';

function row(n: number, over: Partial<TeamBulkRow>): TeamBulkRow {
  return {
    row: n, worker: `W${n}`, person_id: null, person_name: null, site_id: null, site_name: null,
    role_key: null, role_label: null, action: 'add', errors: [], issues: [], diff: null,
    cells: { worker: `W${n}`, site: '', role: '' }, ...over,
  };
}
function preview(rows: TeamBulkRow[]): TeamBulkPreview {
  const counts = { add: 0, update: 0, unchanged: 0, attention: 0, error: 0, skipped: 0 };
  rows.forEach((r) => { counts[r.action] += 1; });
  return { rows, counts, can_commit: counts.attention === 0 && counts.error === 0 };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const api = vi.hoisted(() => ({
  previewTeamBulkFile: vi.fn(),
  previewTeamBulk: vi.fn(),
  commitTeamBulk: vi.fn(),
  listWorkerOptions: vi.fn(async () => [{ person_id: 'p9', display_name: 'Zed Zulu' }]),
}));
vi.mock('../../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../../lib/api')>()), ...api }));

const { default: TeamBulkUpload } = await import('./TeamBulkUpload');

beforeEach(() => {
  api.previewTeamBulkFile.mockResolvedValue(preview([
    row(2, { action: 'add', person_id: 'p1', person_name: 'Ana Lopez', worker: 'ana lopez' }),
    row(3, { action: 'attention', worker: 'Jimmy Henderson', issues: [{
      field: 'worker', kind: 'ambiguous', value: 'Jimmy Henderson',
      candidates: [{ id: 'j1', label: 'Jimmy Henderson', detail: 'j1@x.test' },
                   { id: 'j2', label: 'Jimmy Henderson', detail: 'j2@x.test' }] }] }),
    row(4, { action: 'update', person_id: 'p4', person_name: 'Ben Ng',
             diff: { site: { old: 'DC East', new: 'DC West' } } }),
  ]));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function upload() {
  render(<MemoryRouter><TeamBulkUpload jobId="job1" /></MemoryRouter>);
  const input = screen.getByLabelText(/upload a file/i) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], 'team.csv')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByText('Needs a match');
}

it('picking a candidate re-previews with the override and enables Apply', async () => {
  await upload();
  const apply = screen.getByRole('button', { name: /^Add 1 person and update 0 people$/ }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  api.previewTeamBulk.mockResolvedValue(preview([
    row(2, { action: 'add', person_id: 'p1', person_name: 'Ana Lopez' }),
    row(3, { action: 'add', person_id: 'j2', person_name: 'Jimmy Henderson' }),
    row(4, { action: 'update', person_id: 'p4', person_name: 'Ben Ng',
             diff: { site: { old: 'DC East', new: 'DC West' } } }),
  ]));
  const picker = screen.getByLabelText('Match worker for row 3');
  fireEvent.focus(picker);
  fireEvent.mouseDown(await screen.findByText('j2@x.test'));
  await waitFor(() => expect(api.previewTeamBulk).toHaveBeenCalledWith('job1', {
    rows: [{ worker: 'W2', site: '', role: '' }, { worker: 'W3', site: '', role: '' },
           { worker: 'W4', site: '', role: '' }],
    row_numbers: [2, 3, 4], overrides: { 3: { worker: 'j2' } }, skip: [] }));
  await waitFor(() => expect((screen.getByRole('button', { name: /^Add 2 people and update 0 people$/ }) as HTMLButtonElement).disabled).toBe(false));
  const row3 = within(screen.getByRole('table', { name: 'Team preview' }))
    .getByText('3', { selector: 'td' }).closest('tr') as HTMLElement;
  expect(within(row3).getByText('your pick')).toBeTruthy();
});

it('skip re-previews; approve is local; apply posts everything and shows the summary', async () => {
  await upload();
  api.previewTeamBulk.mockResolvedValue(preview([
    row(2, { action: 'add', person_id: 'p1', person_name: 'Ana Lopez' }),
    row(3, { action: 'skipped' }),
    row(4, { action: 'update', person_id: 'p4', person_name: 'Ben Ng',
             diff: { site: { old: 'DC East', new: 'DC West' } } }),
  ]));
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  await waitFor(() => expect(api.previewTeamBulk).toHaveBeenLastCalledWith('job1',
    expect.objectContaining({ skip: [3], overrides: {} })));
  const callsBefore = api.previewTeamBulk.mock.calls.length;
  fireEvent.click(await screen.findByLabelText('Update row 4'));
  expect(api.previewTeamBulk.mock.calls.length).toBe(callsBefore);
  api.commitTeamBulk.mockResolvedValue({
    created: 1, updated: 1, unchanged: 0, skipped: 1,
    rows: [{ row: 2, name: 'Ana Lopez', person_id: 'p1', action: 'created', diff: null },
           { row: 3, name: 'W3', person_id: null, action: 'skipped', diff: null },
           { row: 4, name: 'Ben Ng', person_id: 'p4', action: 'updated',
             diff: { site: { old: 'DC East', new: 'DC West' } } }],
  });
  fireEvent.click(screen.getByRole('button', { name: /^Add 1 person and update 1 person$/ }));
  await waitFor(() => expect(api.commitTeamBulk).toHaveBeenCalledWith('job1', expect.objectContaining({
    row_numbers: [2, 3, 4], skip: [3], approved_updates: [4], source: 'team.csv' })));
  const summary = await screen.findByRole('table', { name: /applied|summary/i });
  expect(within(summary).getByText('Ana Lopez')).toBeTruthy();
});

it('an API error is shown and forces a fresh preview', async () => {
  await upload();
  api.previewTeamBulk.mockResolvedValue(preview([
    row(2, { action: 'add', person_id: 'p1', person_name: 'Ana Lopez' }),
    row(3, { action: 'skipped' }),
    row(4, { action: 'unchanged', person_id: 'p4', person_name: 'Ben Ng' }),
  ]));
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  const { ApiError } = await import('../../lib/api');
  api.commitTeamBulk.mockRejectedValue(new ApiError(422, 'rows_invalid'));
  fireEvent.click(await screen.findByRole('button', { name: /^Add 1 person and update 0 people$/ }));
  expect(await screen.findByText(/still need attention/i)).toBeTruthy();
  expect(screen.queryByText('Needs a match')).toBeNull();
});

it('an unknown value lists candidates, then every worker (loaded once, lazily)', async () => {
  api.previewTeamBulkFile.mockResolvedValue(preview([
    row(2, { action: 'attention', worker: 'Nobody', issues: [{
      field: 'worker', kind: 'unknown', value: 'Nobody', candidates: [] }] }),
    row(3, { action: 'attention', worker: 'Nobody Else', issues: [{
      field: 'worker', kind: 'unknown', value: 'Nobody Else', candidates: [] }] }),
  ]));
  render(<MemoryRouter><TeamBulkUpload jobId="job1" /></MemoryRouter>);
  expect(api.listWorkerOptions).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(/upload a file/i), { target: { files: [new File(['x'], 'team.csv')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findAllByText('Needs a match');
  fireEvent.focus(screen.getByLabelText('Match worker for row 2'));
  fireEvent.mouseDown(await screen.findByText('Zed Zulu'));
  await waitFor(() => expect(api.previewTeamBulk).toHaveBeenCalledWith('job1',
    expect.objectContaining({ overrides: { 2: { worker: 'p9' } } })));
  expect(api.listWorkerOptions).toHaveBeenCalledTimes(1);
});

it('approvals are pruned to rows that are still updates after a re-preview', async () => {
  await upload();
  fireEvent.click(screen.getByLabelText('Update row 4'));
  expect(screen.getByRole('button', { name: /^Add 1 person and update 1 person$/ })).toBeTruthy();
  api.previewTeamBulk.mockResolvedValue(preview([
    row(2, { action: 'add', person_id: 'p1', person_name: 'Ana Lopez' }),
    row(3, { action: 'skipped' }),
    row(4, { action: 'unchanged', person_id: 'p4', person_name: 'Ben Ng' }),
  ]));
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  const apply = await screen.findByRole('button', { name: /^Add 1 person and update 0 people$/ });
  await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
  api.commitTeamBulk.mockResolvedValue({ created: 1, updated: 0, unchanged: 1, skipped: 1, rows: [] });
  fireEvent.click(apply);
  await waitFor(() => expect(api.commitTeamBulk).toHaveBeenCalledWith('job1',
    expect.objectContaining({ approved_updates: [], skip: [3] })));
});

it('Clear picks drops the row’s overrides and re-previews', async () => {
  await upload();
  api.previewTeamBulk.mockResolvedValueOnce(preview([
    row(2, { action: 'add', person_id: 'p1', person_name: 'Ana Lopez' }),
    row(3, { action: 'add', person_id: 'j1', person_name: 'Jimmy Henderson' }),
  ]));
  fireEvent.focus(screen.getByLabelText('Match worker for row 3'));
  fireEvent.mouseDown(await screen.findByText('j1@x.test'));
  const clear = await screen.findByRole('button', { name: 'Clear picks for row 3' });
  api.previewTeamBulk.mockResolvedValueOnce(preview([row(3, { action: 'attention' })]));
  fireEvent.click(clear);
  await waitFor(() => expect(api.previewTeamBulk).toHaveBeenLastCalledWith('job1',
    expect.objectContaining({ overrides: {} })));
});

it('the newest re-preview wins when responses arrive out of order', async () => {
  await upload();
  const first = deferred<TeamBulkPreview>();
  const second = deferred<TeamBulkPreview>();
  api.previewTeamBulk.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  fireEvent.click(screen.getByLabelText('Skip row 3'));     // skip
  fireEvent.click(screen.getByLabelText('Skip row 3'));     // and un-skip
  expect(api.previewTeamBulk).toHaveBeenCalledTimes(2);
  await act(async () => {
    second.resolve(preview([row(2, { action: 'add', person_id: 'p1', person_name: 'Second Response' })]));
  });
  await act(async () => {
    first.resolve(preview([row(2, { action: 'add', person_id: 'p1', person_name: 'First Response' })]));
  });
  expect(screen.getByText('Second Response')).toBeTruthy();
  expect(screen.queryByText('First Response')).toBeNull();
});

it('Apply is disabled while a re-preview is pending', async () => {
  await upload();
  api.previewTeamBulk.mockResolvedValueOnce(preview([
    row(2, { action: 'add', person_id: 'p1', person_name: 'Ana Lopez' }),
    row(3, { action: 'skipped' }),
  ]));
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  const apply = await screen.findByRole('button', { name: /^Add 1 person and update 0 people$/ }) as HTMLButtonElement;
  await waitFor(() => expect(apply.disabled).toBe(false));

  const later = deferred<TeamBulkPreview>();
  api.previewTeamBulk.mockReturnValueOnce(later.promise);
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  expect(apply.disabled).toBe(true);
  await act(async () => {
    later.resolve(preview([
      row(2, { action: 'add', person_id: 'p1', person_name: 'Ana Lopez' }),
      row(3, { action: 'skipped' }),
    ]));
  });
  expect(apply.disabled).toBe(false);
});

it('choosing a new file drops an in-flight re-preview and resets picks, skips and approvals', async () => {
  await upload();
  fireEvent.click(screen.getByLabelText('Update row 4'));
  const stale = deferred<TeamBulkPreview>();
  api.previewTeamBulk.mockReturnValueOnce(stale.promise);
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  const input = screen.getByLabelText(/upload a file/i) as HTMLInputElement;
  expect(input.disabled).toBe(true);           // no new file while a re-preview is pending …
  // … and should a change land anyway, the old file's response is ignored.
  fireEvent.change(input, { target: { files: [new File(['y'], 'other.csv')] } });
  expect(screen.queryByRole('table', { name: 'Team preview' })).toBeNull();
  await act(async () => {
    stale.resolve(preview([row(2, { action: 'add', person_id: 'p1', person_name: 'Old File Row' })]));
  });
  expect(screen.queryByText('Old File Row')).toBeNull();
  expect(screen.queryByRole('table', { name: 'Team preview' })).toBeNull();

  api.previewTeamBulkFile.mockResolvedValueOnce(preview([
    row(3, { action: 'add', person_id: 'p3', person_name: 'Cy Park' }),
    row(4, { action: 'update', person_id: 'p4', person_name: 'Ben Ng',
             diff: { site: { old: 'DC East', new: 'DC West' } } }),
  ]));
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByText('Cy Park');
  expect((screen.getByLabelText('Update row 4') as HTMLInputElement).checked).toBe(false);
  api.commitTeamBulk.mockResolvedValue({ created: 1, updated: 0, unchanged: 0, skipped: 1, rows: [] });
  fireEvent.click(screen.getByRole('button', { name: /^Add 1 person and update 0 people$/ }));
  await waitFor(() => expect(api.commitTeamBulk).toHaveBeenCalledWith('job1', expect.objectContaining({
    overrides: {}, skip: [], approved_updates: [], source: 'other.csv' })));
});

it('an error row that also carries issues shows a match dropdown', async () => {
  api.previewTeamBulkFile.mockResolvedValue(preview([
    row(2, { action: 'error', errors: ['That worker is archived.'], issues: [{
      field: 'site', kind: 'ambiguous', value: 'DC',
      candidates: [{ id: 's1', label: 'DC East', detail: '' }, { id: 's2', label: 'DC West', detail: '' }] }] }),
  ]));
  render(<MemoryRouter><TeamBulkUpload jobId="job1" /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText(/upload a file/i), { target: { files: [new File(['x'], 'team.csv')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText('That worker is archived.')).toBeTruthy();
  fireEvent.focus(screen.getByLabelText('Match site for row 2'));
  expect(await screen.findByText('DC West')).toBeTruthy();
});

it('a failed full-list load says so, and reopening the dropdown retries', async () => {
  api.listWorkerOptions.mockRejectedValueOnce(new Error('down'));
  api.previewTeamBulkFile.mockResolvedValue(preview([
    row(2, { action: 'attention', worker: 'Nobody', issues: [{
      field: 'worker', kind: 'unknown', value: 'Nobody', candidates: [] }] }),
  ]));
  render(<MemoryRouter><TeamBulkUpload jobId="job1" /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText(/upload a file/i), { target: { files: [new File(['x'], 'team.csv')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText(/could not load the list/i)).toBeTruthy();
  expect(api.listWorkerOptions).toHaveBeenCalledTimes(1);
  fireEvent.focus(screen.getByLabelText('Match worker for row 2'));
  expect(await screen.findByText('Zed Zulu')).toBeTruthy();
  expect(api.listWorkerOptions).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/could not load the list/i)).toBeNull();
});

it('a checked Skip keeps "Skip" in its accessible name and says how to undo', async () => {
  await upload();
  api.previewTeamBulk.mockResolvedValueOnce(preview([row(3, { action: 'skipped' })]));
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  const box = await screen.findByRole('checkbox', { name: 'Skip row 3' });
  await waitFor(() => expect((box as HTMLInputElement).checked).toBe(true));
  expect(screen.getByText('Skipped — uncheck to undo.')).toBeTruthy();
});

it('before a job is picked the pane still renders, with the file input and Preview disabled', () => {
  render(<MemoryRouter><TeamBulkUpload jobId={null} /></MemoryRouter>);
  expect((screen.getByLabelText('Upload a file (.csv or .xlsx)') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Add 0 people and update 0 people' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/pick a job/i)).toBeNull();
});

it('the apply button reads "Add 1 person and update 0 people"', async () => {
  await upload();
  expect(screen.getByRole('button', { name: 'Add 1 person and update 0 people' })).toBeTruthy();
});

it('the preview uses the shared Row / Name / Matched by / Action / Details columns and row tints', async () => {
  api.previewTeamBulkFile.mockResolvedValue(preview([
    row(2, { action: 'add', person_id: 'p1', person_name: 'Ana Lopez', worker: 'ana lopez',
             site_name: 'DC West', cells: { worker: 'ana lopez', site: 'dc west', role: '' } }),
    row(3, { action: 'attention', worker: 'Jimmy Henderson', issues: [{
      field: 'worker', kind: 'ambiguous', value: 'Jimmy Henderson',
      candidates: [{ id: 'j1', label: 'Jimmy Henderson', detail: 'j1@x.test' }] }] }),
    row(4, { action: 'update', person_id: 'p4', person_name: 'Ben Ng',
             diff: { site: { old: 'DC East', new: 'DC West' } } }),
    row(5, { action: 'unchanged', person_id: 'p5', person_name: 'W5' }),
    row(6, { action: 'error', errors: ['That worker is archived.'] }),
  ]));
  render(<MemoryRouter><TeamBulkUpload jobId="job1" /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText(/upload a file/i), { target: { files: [new File(['x'], 'team.csv')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  const table = await screen.findByRole('table', { name: 'Team preview' });
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent))
    .toEqual(['Row', 'Name', 'Matched by', 'Action', 'Details']);
  expect(screen.queryByText('Site', { selector: 'th' })).toBeNull();
  expect(table.querySelector('.chip')).toBeNull();
  const cells = (n: number) => [...(within(table).getByText(String(n), { selector: 'td' })
    .closest('tr') as HTMLElement).querySelectorAll('td')].map((td) => td.textContent);
  const tr = (n: number) => within(table).getByText(String(n), { selector: 'td' }).closest('tr') as HTMLElement;
  expect(cells(2).slice(1, 4)).toEqual(['ana lopez → Ana Lopez', 'name', 'Add']);
  expect(cells(2)[4]).toBe('Site: DC WestRole: —');
  expect(tr(2).className).toBe('bulk-row-create');
  expect(cells(3).slice(2, 4)).toEqual(['—', 'Needs a match']);
  expect(tr(3).className).toBe('bulk-row-error');
  expect(cells(4)[3]).toBe('Skip');
  expect(tr(4).className).toBe('bulk-row-skipped');
  fireEvent.click(screen.getByLabelText('Update row 4'));
  expect(cells(4)[3]).toBe('Update');
  expect(tr(4).className).toBe('bulk-row-update');
  expect(cells(5)[3]).toBe('No change');
  expect(tr(5).className).toBe('bulk-row-unchanged');
  expect(cells(6)[3]).toBe('Error');
  expect(tr(6).className).toBe('bulk-row-error');
  expect(within(tr(6)).getByText('That worker is archived.').className).toBe('pf-error');
  expect(screen.getByText('1 to add · 1 to update · 0 to skip · 1 unchanged · 1 needs a match · 1 error')).toBeTruthy();
});

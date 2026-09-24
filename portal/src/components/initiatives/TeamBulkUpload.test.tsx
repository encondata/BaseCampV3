// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  const apply = screen.getByRole('button', { name: /^Add 1 and update 0/ }) as HTMLButtonElement;
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
  await waitFor(() => expect((screen.getByRole('button', { name: /^Add 2 and update 0/ }) as HTMLButtonElement).disabled).toBe(false));
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
  fireEvent.click(screen.getByRole('button', { name: /^Add 1 and update 1/ }));
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
  fireEvent.click(await screen.findByRole('button', { name: /^Add 1 and update 0/ }));
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
  expect(screen.getByRole('button', { name: /^Add 1 and update 1/ })).toBeTruthy();
  api.previewTeamBulk.mockResolvedValue(preview([
    row(2, { action: 'add', person_id: 'p1', person_name: 'Ana Lopez' }),
    row(3, { action: 'skipped' }),
    row(4, { action: 'unchanged', person_id: 'p4', person_name: 'Ben Ng' }),
  ]));
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  const apply = await screen.findByRole('button', { name: /^Add 1 and update 0/ });
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

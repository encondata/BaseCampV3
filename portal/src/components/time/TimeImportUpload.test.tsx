// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { TimeImportPreview, TimeImportRow } from '../../lib/api';

function row(n: number, over: Partial<TimeImportRow>): TimeImportRow {
  return {
    row: n, name: `W${n}`, person_id: null, person_name: null, matched_by: null,
    job_id: null, job_name: null, site_id: null, site_name: null, zone: 'America/New_York',
    clock_in_at: '2026-09-24T11:00:00+00:00', clock_out_at: '2026-09-24T19:30:00+00:00',
    break_minutes: 30, minutes: 480, shift: 'Sep 24, 7:00 AM – 3:30 PM EDT', notes: '',
    action: 'add', errors: [], issues: [], detail: null,
    cells: { worker: `W${n}`, clock_in: '9/24/2026 7:00 AM', clock_out: '9/24/2026 3:30 PM',
             break_minutes: '30', job: '', site: '', notes: '' },
    ...over,
  };
}
const cells = (n: number) => row(n, {}).cells;
function preview(rows: TimeImportRow[]): TimeImportPreview {
  const counts = { add: 0, duplicate: 0, attention: 0, error: 0, skipped: 0 };
  rows.forEach((r) => { counts[r.action] += 1; });
  return { rows, counts, can_commit: counts.add > 0 && counts.attention === 0 && counts.error === 0 };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const api = vi.hoisted(() => ({
  previewTimeImportFile: vi.fn(),
  previewTimeImport: vi.fn(),
  commitTimeImport: vi.fn(),
  listWorkerOptions: vi.fn(async () => [{ person_id: 'p9', display_name: 'Zed Zulu' }]),
  listSites: vi.fn(async () => []),
  listInitiatives: vi.fn(async () => [
    { id: 'm1', name: 'Dallas Move', type_label: 'Move', client_name: 'Acme',
      scheduled_start: null, archived_at: null },
    { id: 'm9', name: 'Old Job', type_label: 'Project', client_name: null,
      scheduled_start: null, archived_at: '2026-01-01T00:00:00Z' },
  ] as never),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: TimeImportUpload } = await import('./TimeImportUpload');

const ANA = { person_id: 'p1', person_name: 'Ana Lopez', matched_by: 'email' as const };

beforeEach(() => {
  api.previewTimeImportFile.mockResolvedValue(preview([
    row(2, ANA),
    row(3, { action: 'attention', issues: [{
      field: 'worker', kind: 'ambiguous', value: 'Jo Park',
      candidates: [{ id: 'j1', label: 'Jo Park', detail: 'j1@x.test' },
                   { id: 'j2', label: 'Jo Park', detail: 'j2@x.test' }] }] }),
    row(4, { action: 'duplicate', detail: 'Already there.' }),
  ]));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function upload(waitFor = 'Needs a match') {
  render(<MemoryRouter><TimeImportUpload /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Upload a file (.csv or .xlsx)'),
    { target: { files: [new File(['x'], 'time.csv')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByText(waitFor);
}
const addButton = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const trOf = (n: string) => within(screen.getByRole('table', { name: 'Time preview' }))
  .getByText(n, { selector: 'td' }).closest('tr') as HTMLElement;

it('the preview uses the shared Row / Name / Matched by / Action / Details columns and row tints', async () => {
  await upload();
  const table = screen.getByRole('table', { name: 'Time preview' });
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent))
    .toEqual(['Row', 'Name', 'Matched by', 'Action', 'Details']);
  expect(trOf('2').className).toContain('bulk-row-create');
  expect(within(trOf('2')).getByText('email')).toBeTruthy();
  expect(within(trOf('2')).getByText('Sep 24, 7:00 AM – 3:30 PM EDT · 8h (30m break)')).toBeTruthy();
  expect(trOf('3').className).toContain('bulk-row-error');
  expect(within(trOf('3')).getByText('“Jo Park” matches 2 workers — pick one.')).toBeTruthy();
  expect(within(trOf('4')).getByText('Already there')).toBeTruthy();
  expect(trOf('4').className).toContain('bulk-row-unchanged');
  expect(screen.getByText('1 to add · 1 already there · 0 to skip · 1 needs a match · 0 errors')).toBeTruthy();
  expect(addButton('Add 1 shift').disabled).toBe(true);
});

it('picking a candidate re-previews with the override and enables Add N shifts', async () => {
  await upload();
  api.previewTimeImport.mockResolvedValue(preview([
    row(2, ANA),
    row(3, { person_id: 'j2', person_name: 'Jo Park', matched_by: 'your pick' }),
    row(4, { action: 'duplicate', detail: 'Already there.' }),
  ]));
  fireEvent.focus(screen.getByLabelText('Match worker for row 3'));
  fireEvent.mouseDown(await screen.findByText('j2@x.test'));
  await waitFor(() => expect(api.previewTimeImport).toHaveBeenCalledWith({
    rows: [cells(2), cells(3), cells(4)], row_numbers: [2, 3, 4],
    overrides: { 3: { worker: 'j2' } }, skip: [] }));
  await waitFor(() => expect(addButton('Add 2 shifts').disabled).toBe(false));
  expect(within(trOf('3')).getByText('your pick')).toBeTruthy();
});

it('Skip all unmatched skips every attention and error row in one re-preview', async () => {
  api.previewTimeImportFile.mockResolvedValue(preview([
    row(2, ANA),
    row(3, { action: 'attention', issues: [{ field: 'job', kind: 'unknown', value: 'Mystery', candidates: [] }] }),
    row(4, { action: 'error', errors: ['Clock-in is in the future.'] }),
  ]));
  api.previewTimeImport.mockResolvedValue(preview([
    row(2, ANA), row(3, { action: 'skipped' }), row(4, { action: 'skipped' }),
  ]));
  await upload();
  fireEvent.click(screen.getByRole('button', { name: 'Skip all unmatched' }));
  await waitFor(() => expect(api.previewTimeImport).toHaveBeenCalledWith(
    expect.objectContaining({ skip: [3, 4], overrides: {} })));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Skip all unmatched' })).toBeNull());
  expect(addButton('Add 1 shift').disabled).toBe(false);
});

it('an unknown job lists every non-archived job, loaded once and lazily', async () => {
  api.previewTimeImportFile.mockResolvedValue(preview([
    row(2, { action: 'attention', issues: [{ field: 'job', kind: 'unknown', value: 'Mystery', candidates: [] }] }),
    row(3, { action: 'attention', issues: [{ field: 'job', kind: 'unknown', value: 'Other', candidates: [] }] }),
  ]));
  await upload('No job matches “Other” — pick one.');   // two rows read "Needs a match"; wait on a unique line
  await waitFor(() => expect(api.listInitiatives).toHaveBeenCalledTimes(1));
  expect(screen.getByText('No job matches “Mystery” — pick one.')).toBeTruthy();
  fireEvent.focus(screen.getByLabelText('Match job for row 2'));
  expect(await screen.findByText('Dallas Move')).toBeTruthy();
  expect(screen.queryByText('Old Job')).toBeNull();
});

it('apply posts the base rows with the file name and shows the per-row summary', async () => {
  await upload();
  api.previewTimeImport.mockResolvedValue(preview([
    row(2, ANA), row(3, { action: 'skipped' }), row(4, { action: 'duplicate', detail: 'Already there.' }),
  ]));
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  await waitFor(() => expect(addButton('Add 1 shift').disabled).toBe(false));
  api.commitTimeImport.mockResolvedValue({
    summary: { added: 1, skipped: 2 },
    rows: [
      { row: 2, name: 'Ana Lopez', entry_id: 't1', action: 'created', detail: 'Sep 24, 7:00 AM – 3:30 PM EDT' },
      { row: 3, name: 'W3', entry_id: null, action: 'skipped', detail: 'Skipped.' },
      { row: 4, name: 'W4', entry_id: null, action: 'skipped', detail: 'Already there.' },
    ],
  });
  fireEvent.click(addButton('Add 1 shift'));
  await waitFor(() => expect(api.commitTimeImport).toHaveBeenCalledWith({
    rows: [cells(2), cells(3), cells(4)], row_numbers: [2, 3, 4], overrides: {}, skip: [3],
    source: 'time.csv' }));
  expect(await screen.findByText('Applied: 1 added · 2 skipped')).toBeTruthy();
  const summary = screen.getByRole('table', { name: 'Apply summary' });
  expect(within(summary).getByText('Sep 24, 7:00 AM – 3:30 PM EDT')).toBeTruthy();
  expect(within(summary).getByText('Already there.')).toBeTruthy();
  expect(screen.queryByRole('table', { name: 'Time preview' })).toBeNull();
});

it('a refused commit explains why and drops the stale preview', async () => {
  api.previewTimeImportFile.mockResolvedValue(preview([row(2, ANA)]));
  const { ApiError } = await import('../../lib/api');
  api.commitTimeImport.mockRejectedValue(new ApiError(422, 'rows_invalid'));
  await upload('Ana Lopez');
  fireEvent.click(addButton('Add 1 shift'));
  expect(await screen.findByText(/a shift now overlaps time added since the preview/)).toBeTruthy();
  expect(screen.queryByRole('table', { name: 'Time preview' })).toBeNull();
});

it('lists 200 rows at a time', async () => {
  api.previewTimeImportFile.mockResolvedValue(preview(Array.from({ length: 450 }, (_, i) =>
    row(i + 2, { person_id: `p${i}`, person_name: `Worker ${i}`, matched_by: 'name' }))));
  await upload('Worker 0');
  const table = screen.getByRole('table', { name: 'Time preview' });
  expect(within(table).queryByText('202', { selector: 'td' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show 200 more' }));
  expect(within(table).getByText('202', { selector: 'td' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }));
  expect(within(table).getByText('451', { selector: 'td' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add 450 shifts' })).toBeTruthy();
});

it('the newest re-preview wins when responses arrive out of order', async () => {
  await upload();
  const first = deferred<TimeImportPreview>();
  const second = deferred<TimeImportPreview>();
  api.previewTimeImport.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  const still = preview([row(2, ANA), row(3, { action: 'attention', issues: [{
    field: 'worker', kind: 'unknown', value: 'Jo Park', candidates: [] }] })]);
  await act(async () => { second.resolve(still); });
  await act(async () => { first.resolve(preview([row(2, ANA), row(3, { action: 'skipped' })])); });
  expect(screen.getByText('Needs a match')).toBeTruthy();
});

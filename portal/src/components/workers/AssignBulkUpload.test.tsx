// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AssignFlag, AssignPreview, AssignRow } from '../../lib/api';

function row(n: number, over: Partial<AssignRow>): AssignRow {
  return {
    row: n, cells: { first_name: `First${n}`, last_name: `Last${n}` }, name: `Person ${n}`,
    table: 'matched', matched_by: 'name', matched_value: `Person ${n}`,
    person_id: `p${n}`, person_name: `Person ${n}`, create: false, becomes_worker: false,
    role_key: 'tech', role_label: 'Tech', flags: [], action: 'assign', errors: [], ...over,
  };
}
const flag = (kind: AssignFlag['kind'], over: Partial<AssignFlag> = {}): AssignFlag =>
  ({ kind, decided: false, lines: [], other_person: null, ...over });

function preview(rows: AssignRow[], over: Partial<AssignPreview> = {}): AssignPreview {
  const counts = { assign: 0, create: 0, already_assigned: 0, attention: 0, error: 0 };
  rows.forEach((r) => { counts[r.action] += 1; });
  return {
    rows, counts,
    people: [{ id: 'p2', label: 'Person 2', detail: 'Partner A' },
             { id: 'p9', label: 'Zed Zulu', detail: 'Partner B' }],
    roles: [{ key: 'tech', label: 'Tech' }, { key: 'lead', label: 'Lead' }],
    can_commit: counts.attention === 0 && counts.error === 0,
    ...over,
  };
}

const FIRST = () => preview([
  row(2, {}),
  row(3, {
    action: 'attention', matched_by: 'email', matched_value: 'person.b@example.com',
    flags: [flag('contact', { lines: [{ label: 'Phone on file', value: '+1 555 555 0102' },
                                       { label: 'Phone in sheet', value: '+1 555 555 0199' }] })],
  }),
  row(4, {
    action: 'attention', matched_by: 'phone', matched_value: '555-0104',
    flags: [flag('name_differs', { lines: [{ label: 'Name on file', value: 'Someone Else' }] })],
  }),
  row(5, { table: 'unmatched', matched_by: null, matched_value: null, person_id: null,
           person_name: null, action: 'attention', flags: [flag('needs_match')] }),
  row(6, { action: 'already_assigned' }),
]);

const api = vi.hoisted(() => ({
  previewAssignBulkFile: vi.fn(),
  previewAssignBulk: vi.fn(),
  commitAssignBulk: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../../lib/api')>()), ...api }));

const { default: AssignBulkUpload } = await import('./AssignBulkUpload');

beforeEach(() => {
  api.previewAssignBulkFile.mockResolvedValue(FIRST());
  api.previewAssignBulk.mockResolvedValue(FIRST());
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const fileInput = () => screen.getByLabelText(/drop your file here/i) as HTMLInputElement;

function mount(ids: { jobId?: string | null; siteId?: string | null; partnerId?: string | null } = {}) {
  const props = { jobId: 'job1', siteId: 's1', partnerId: 'pa1', ...ids };
  const view = render(<MemoryRouter><AssignBulkUpload {...props} /></MemoryRouter>);
  return {
    ...view,
    rerenderWith: (next: typeof ids) =>
      view.rerender(<MemoryRouter><AssignBulkUpload {...props} {...next} /></MemoryRouter>),
  };
}

async function upload(ids = {}) {
  const view = mount(ids);
  fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'workers.xlsx')] } });
  await screen.findByRole('table', { name: 'Matched' });
  return view;
}

const rowEl = (table: string, n: number) =>
  within(screen.getByRole('table', { name: table }))
    .getByText(String(n), { selector: 'td' }).closest('tr') as HTMLElement;

it('disables the dropzone until initiative, site and partner are picked', () => {
  const view = mount({ siteId: null });
  expect(fileInput().disabled).toBe(true);
  expect(screen.getByText('Excel spreadsheet — .xlsx')).toBeTruthy();
  expect(fileInput().accept).toBe('.xlsx');
  view.rerenderWith({ siteId: 's1' });
  expect(fileInput().disabled).toBe(false);
});

it('previews automatically and splits rows into Matched and No match found', async () => {
  const view = await upload();
  expect(api.previewAssignBulkFile).toHaveBeenCalledWith('job1', expect.any(File), 'pa1', 's1');
  expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();

  const matched = screen.getByRole('table', { name: 'Matched' });
  const unmatched = screen.getByRole('table', { name: 'No match found' });
  expect(within(matched).queryByText('5', { selector: 'td' })).toBeNull();
  expect(within(unmatched).getByText('5', { selector: 'td' })).toBeTruthy();
  const heads = screen.getAllByRole('button', { expanded: true });
  expect(heads.map((h) => h.textContent)).toEqual(['Matched4', 'No match found1']);

  expect(rowEl('Matched', 2).className).toBe('bulk-row-create');
  expect(rowEl('Matched', 3).className).toBe('bulk-row-update');
  expect(within(rowEl('Matched', 3)).getByText('Discrepancy')).toBeTruthy();
  expect(within(rowEl('Matched', 3)).getByText('person.b@example.com')).toBeTruthy();
  expect(rowEl('Matched', 6).className).toBe('bulk-row-unchanged');
  expect(within(rowEl('Matched', 6)).getByText('Already assigned')).toBeTruthy();
  expect(rowEl('Matched', 4).className).toBe('bulk-row-update');
  expect(within(rowEl('Matched', 4)).getByText('Needs a decision')).toBeTruthy();
  expect(rowEl('No match found', 5).className).toBe('bulk-row-error');
  expect(within(rowEl('No match found', 5)).getByText('Needs a match')).toBeTruthy();
  expect(screen.getByText(
    '4 matched · 1 discrepancy · 0 to create · 1 needs a match · 1 already assigned · 0 errors',
  )).toBeTruthy();

  // changing a picker re-previews by JSON with the same cells
  view.rerenderWith({ siteId: 's2' });
  await waitFor(() => expect(api.previewAssignBulk).toHaveBeenCalledWith('job1', expect.objectContaining({
    row_numbers: [2, 3, 4, 5, 6], site_id: 's2', partner_id: 'pa1', decisions: {},
  })));
  expect(api.previewAssignBulkFile).toHaveBeenCalledTimes(1);
});

it('collapsing a panel hides its table', async () => {
  await upload();
  fireEvent.click(screen.getByRole('button', { name: /^Matched/ }));
  expect(screen.queryByRole('table', { name: 'Matched' })).toBeNull();
  expect(screen.getByRole('table', { name: 'No match found' })).toBeTruthy();
});

it('shows discrepancy lines and Update/Ignore; Update re-previews with change=update', async () => {
  await upload();
  const r3 = rowEl('Matched', 3);
  expect(within(r3).getByText('Phone on file: +1 555 555 0102')).toBeTruthy();
  expect(within(r3).getByText('Phone in sheet: +1 555 555 0199')).toBeTruthy();
  expect(within(r3).getByText(/^Discrepancy: the sheet's contact details/).className).toContain('bulk-warn');
  const update = within(r3).getByRole('button', { name: 'Update row 3' });
  expect(within(r3).getByRole('button', { name: 'Ignore the discrepancy on row 3' })).toBeTruthy();
  expect(update.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(update);
  await waitFor(() => expect(api.previewAssignBulk).toHaveBeenCalledWith('job1', expect.objectContaining({
    decisions: { 3: { change: 'update' } },
  })));
  expect(screen.getByRole('button', { name: 'Update row 3' }).getAttribute('aria-pressed')).toBe('true');
});

it('Accept on name differs adds acknowledged', async () => {
  await upload();
  fireEvent.click(within(rowEl('Matched', 4)).getByRole('button', { name: 'Accept the name on row 4' }));
  await waitFor(() => expect(api.previewAssignBulk).toHaveBeenCalledWith('job1', expect.objectContaining({
    decisions: { 4: { acknowledged: ['name_differs'] } },
  })));
});

it('picking Create new sends person=new', async () => {
  await upload();
  const r5 = rowEl('No match found', 5);
  expect(within(r5).getByText('No worker matched. Pick one or create a new worker.').className)
    .not.toContain('bulk-warn');
  fireEvent.focus(within(r5).getByLabelText('Worker for row 5'));
  expect(await screen.findByText('Partner B')).toBeTruthy();
  fireEvent.mouseDown(await screen.findByText('+ Create new worker "Person 5"'));
  await waitFor(() => expect(api.previewAssignBulk).toHaveBeenCalledWith('job1', expect.objectContaining({
    decisions: { 5: { person: 'new' } },
  })));
});

it('role dropdown sends the picked role', async () => {
  await upload();
  fireEvent.focus(within(rowEl('Matched', 2)).getByLabelText('Role for row 2'));
  fireEvent.mouseDown(await screen.findByText('Lead'));
  await waitFor(() => expect(api.previewAssignBulk).toHaveBeenCalledWith('job1', expect.objectContaining({
    decisions: { 2: { role: 'lead' } },
  })));
});

it('Assign button disabled until can_commit, label counts new workers', async () => {
  await upload();
  const first = screen.getByRole('button', { name: 'Assign 1 worker (0 new)' }) as HTMLButtonElement;
  expect(first.disabled).toBe(true);
  api.previewAssignBulk.mockResolvedValue(preview([
    row(2, {}),
    row(5, { table: 'unmatched', matched_by: null, person_id: null, create: true, action: 'create',
             becomes_worker: false, flags: [flag('needs_match', { decided: true })] }),
    row(7, { table: 'unmatched', matched_by: 'pick', person_id: 'p9', action: 'create', create: true }),
  ]));
  fireEvent.click(screen.getByRole('button', { name: 'Update row 3' }));
  const next = await screen.findByRole('button', { name: 'Assign 3 workers (2 new)' }) as HTMLButtonElement;
  await waitFor(() => expect(next.disabled).toBe(false));
});

it('commit shows the apply summary', async () => {
  api.previewAssignBulkFile.mockResolvedValue(preview([
    row(2, {}),
    row(3, { table: 'unmatched', matched_by: null, person_id: null, create: true, action: 'create' }),
    row(4, { action: 'already_assigned' }),
  ]));
  await upload();
  api.commitAssignBulk.mockResolvedValue({
    assigned: 1, created: 1, updated: 0, already_assigned: 1,
    rows: [{ row: 2, name: 'Person 2', person_id: 'p2', action: 'created', diff: null },
           { row: 3, name: 'Person 3', person_id: 'p3n', action: 'created', diff: null },
           { row: 4, name: 'Person 4', person_id: 'p4', action: 'unchanged', diff: null }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Assign 2 workers (1 new)' }));
  await waitFor(() => expect(api.commitAssignBulk).toHaveBeenCalledWith('job1', {
    rows: [{ first_name: 'First2', last_name: 'Last2' }, { first_name: 'First3', last_name: 'Last3' },
           { first_name: 'First4', last_name: 'Last4' }],
    row_numbers: [2, 3, 4], partner_id: 'pa1', site_id: 's1', decisions: {}, source: 'workers.xlsx',
  }));
  const summary = await screen.findByRole('table', { name: 'Apply summary' });
  expect(within(summary).getByText('Person 3')).toBeTruthy();
  expect(screen.queryByText(/already assigned$/)).toBeNull();
  expect(screen.getByRole('link', { name: 'Open the initiative' }).getAttribute('href')).toBe('/initiatives/job1');
  expect(screen.queryByRole('table', { name: 'Matched' })).toBeNull();
});

it('a commit error keeps the file and decisions, shows the error and re-previews by JSON', async () => {
  api.previewAssignBulkFile.mockResolvedValue(preview([row(2, {}), row(3, {})]));
  api.previewAssignBulk.mockResolvedValue(preview([row(2, {}), row(3, {})]));
  await upload();
  fireEvent.focus(within(rowEl('Matched', 2)).getByLabelText('Role for row 2'));
  fireEvent.mouseDown(await screen.findByText('Lead'));
  await waitFor(() => expect(api.previewAssignBulk).toHaveBeenCalledTimes(1));
  const { ApiError } = await import('../../lib/api');
  api.commitAssignBulk.mockRejectedValue(new ApiError(422, 'rows_invalid'));
  api.previewAssignBulk.mockResolvedValue(preview([
    row(2, {}), row(3, { action: 'error', errors: ['Rank guard'] }),
  ]));
  fireEvent.click(await screen.findByRole('button', { name: 'Assign 2 workers (0 new)' }));
  expect(await screen.findByText('Some rows still need attention — resolve them and try again.')).toBeTruthy();
  await waitFor(() => expect(api.previewAssignBulk).toHaveBeenCalledTimes(2));
  expect(api.previewAssignBulk).toHaveBeenLastCalledWith('job1', expect.objectContaining({
    row_numbers: [2, 3], decisions: { 2: { role: 'lead' } },
  }));
  expect(await screen.findByText('Rank guard')).toBeTruthy();
  expect(screen.getByText('Some rows still need attention — resolve them and try again.')).toBeTruthy();
  expect(screen.getByText('workers.xlsx')).toBeTruthy();
  expect(api.previewAssignBulkFile).toHaveBeenCalledTimes(1);
});

it('"matched" in the count line is the Matched panel row count', async () => {
  await upload();
  expect(screen.getByText(/^4 matched · /)).toBeTruthy();
});

it('a newer re-preview wins over an older one', async () => {
  await upload();
  let resolveOld!: (v: AssignPreview) => void;
  api.previewAssignBulk.mockImplementationOnce(() => new Promise((res) => { resolveOld = res; }));
  api.previewAssignBulk.mockResolvedValueOnce(preview([row(2, { name: 'Newest', person_name: 'Newest' })]));
  fireEvent.click(screen.getByRole('button', { name: 'Update row 3' }));
  fireEvent.click(screen.getByRole('button', { name: 'Accept the name on row 4' }));
  await screen.findByText('Newest');
  resolveOld(preview([row(2, { name: 'Stale', person_name: 'Stale' })]));
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByText('Stale')).toBeNull();
});

it('appends "(becomes a worker)" to the action', async () => {
  api.previewAssignBulkFile.mockResolvedValue(preview([row(2, { becomes_worker: true })]));
  await upload();
  expect(within(rowEl('Matched', 2)).getByText('Assign (becomes a worker)')).toBeTruthy();
});

it('Ignore on a status flag adds acknowledged', async () => {
  api.previewAssignBulkFile.mockResolvedValue(preview([
    row(2, { action: 'attention', flags: [flag('status', { lines: [{ label: 'Status on file', value: 'Inactive' }] })] }),
  ]));
  await upload();
  const r2 = rowEl('Matched', 2);
  expect(within(r2).getByText('Needs a decision')).toBeTruthy();
  fireEvent.click(within(r2).getByRole('button', { name: 'Ignore the status on row 2' }));
  await waitFor(() => expect(api.previewAssignBulk).toHaveBeenCalledWith('job1', expect.objectContaining({
    decisions: { 2: { acknowledged: ['status'] } },
  })));
});

it('a picker change drops Update/Ignore but keeps acknowledgements, picks and roles', async () => {
  const view = await upload();
  fireEvent.click(screen.getByRole('button', { name: 'Update row 3' }));
  await waitFor(() => expect(api.previewAssignBulk).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Accept the name on row 4' }));
  await waitFor(() => expect(api.previewAssignBulk).toHaveBeenLastCalledWith('job1', expect.objectContaining({
    decisions: { 3: { change: 'update' }, 4: { acknowledged: ['name_differs'] } },
  })));
  fireEvent.focus(within(rowEl('Matched', 2)).getByLabelText('Role for row 2'));
  fireEvent.mouseDown(await screen.findByText('Lead'));
  await waitFor(() => expect(api.previewAssignBulk).toHaveBeenCalledTimes(3));
  view.rerenderWith({ partnerId: 'pa2' });
  await waitFor(() => expect(api.previewAssignBulk).toHaveBeenLastCalledWith('job1', expect.objectContaining({
    partner_id: 'pa2', decisions: { 2: { role: 'lead' }, 4: { acknowledged: ['name_differs'] } },
  })));
  await waitFor(() => expect(
    screen.getByRole('button', { name: 'Update row 3' }).getAttribute('aria-pressed')).toBe('false'));
});

it('a failed re-preview keeps the rows up with the error, and the next decision retries', async () => {
  await upload();
  const { ApiError } = await import('../../lib/api');
  api.previewAssignBulk.mockRejectedValueOnce(new ApiError(422, 'invalid_decisions'));
  fireEvent.click(screen.getByRole('button', { name: 'Update row 3' }));
  expect(await screen.findByText('The preview is out of date — upload the file again.')).toBeTruthy();
  expect(screen.getByRole('table', { name: 'Matched' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Accept the name on row 4' }));
  await waitFor(() => expect(api.previewAssignBulk).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(
    screen.queryByText('The preview is out of date — upload the file again.')).toBeNull());
  expect(screen.getByRole('table', { name: 'Matched' })).toBeTruthy();
});

it('shows Matched by as Name / Email / Phone / Picked', async () => {
  api.previewAssignBulkFile.mockResolvedValue(preview([
    row(2, { matched_by: 'name' }), row(3, { matched_by: 'email' }),
    row(4, { matched_by: 'phone' }), row(5, { matched_by: 'pick', matched_value: null }),
  ]));
  await upload();
  expect(within(rowEl('Matched', 2)).getByText('Name')).toBeTruthy();
  expect(within(rowEl('Matched', 3)).getByText('Email')).toBeTruthy();
  expect(within(rowEl('Matched', 4)).getByText('Phone')).toBeTruthy();
  expect(within(rowEl('Matched', 5)).getByText('Picked')).toBeTruthy();
  expect(within(rowEl('Matched', 5)).queryByText('pick')).toBeNull();
});

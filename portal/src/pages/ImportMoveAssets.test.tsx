// @vitest-environment jsdom
/**
 * Move-assets bulk import page — covers the fix-surface + reprocess flow
 * added on top of the existing upload -> validate -> commit sequence: the
 * missing-make/models card grouping review rows by their unmatched text,
 * the footer's "Reprocess N flagged" action (which swaps the polled job
 * for the reprocess child job the API hands back), and the child-job
 * banner shown once a job carries options.reprocess_of. Mocking style
 * mirrors NotificationGroupDetail.test.tsx (hoisted react-router-dom /
 * AuthContext / lib/api mocks).
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

import type { ImportJobOut, InitiativeDetail } from '../lib/api';
import type { ImportReportFile } from '../lib/importReport';
import { LIST_FIT } from '../lib/listTools';
import ImportMoveAssets from './ImportMoveAssets';

const state = vi.hoisted(() => ({ id: 'i1' }));

vi.mock('react-router-dom', async (importActual) => ({
  ...(await importActual<typeof import('react-router-dom')>()),
  useParams: () => ({ id: state.id }),
}));

const auth = vi.hoisted(() => {
  const s: { can: (resource: string, action: string) => boolean } = { can: () => true };
  return s;
});

const session = vi.hoisted(() => ({ person: { display_name: 'Jimmy Henderson' } }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can, person: session.person }),
}));

const report = vi.hoisted(() => ({ downloadImportReport: vi.fn() }));

vi.mock('../lib/importReport', async (importActual) => ({
  ...(await importActual<typeof import('../lib/importReport')>()),
  ...report,
}));

const api = vi.hoisted(() => ({
  getInitiative: vi.fn(),
  getImportJob: vi.fn(),
  commitImportJob: vi.fn(),
  cancelImportJob: vi.fn(),
  createMoveAssetImportJob: vi.fn(),
  downloadMoveAssetTemplate: vi.fn(),
  reprocessImportJob: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.can = () => true;
});

const INITIATIVE: InitiativeDetail = {
  id: 'i1', name: 'NAP11 Move', initiative_type: 'move',
} as unknown as InitiativeDetail;

/** A completed commit job: 1 created row + 2 review rows sharing one
 *  unmatched make/model string ("Dell Dell PowerEdge R720"). */
function commitJob(overrides: Partial<ImportJobOut> = {}): ImportJobOut {
  return {
    id: 'job-1', initiative_id: 'i1', kind: 'move_assets', filename: 'assets.csv',
    options: { make_model_mode: 'fuzzy', generate_serials: false },
    phase: 'commit', status: 'completed',
    total_rows: 3, processed_rows: 3, created_count: 1, updated_count: 0, error_count: 0,
    results: {
      summary: { created: 1, updated: 0, review: 2, error: 0 },
      details: [
        { row: 1, serial_number: 'SN1', status: 'created', message: 'Created' },
        {
          row: 2, serial_number: 'SN2', status: 'review',
          message: "Make/Model 'Dell Dell PowerEdge R720' not found",
        },
        {
          row: 3, serial_number: 'SN3', status: 'review',
          message: "Make/Model 'Dell Dell PowerEdge R720' not found",
        },
      ],
    },
    error: null, created_at: '2026-09-01T00:00:00Z',
    started_at: '2026-09-01T00:00:01Z', finished_at: '2026-09-01T00:00:02Z',
    ...overrides,
  } as ImportJobOut;
}

it('groups review rows into a missing-make/models card', async () => {
  api.getInitiative.mockResolvedValue(INITIATIVE);
  // Drive the page into the completed-job view the same way a real user
  // would — drop a file and validate — with createMoveAssetImportJob mocked
  // straight to a completed commit-phase job.
  const job = commitJob();
  api.createMoveAssetImportJob.mockResolvedValue(job);
  render(<MemoryRouter><ImportMoveAssets /></MemoryRouter>);
  await screen.findByText('NAP11 Move');

  // Drive the page into the completed-job view via drop-in file + validate,
  // matching how a real user reaches this screen.
  const file = new File(['a,b'], 'assets.csv', { type: 'text/csv' });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await userEvent.upload(input, file);
  await userEvent.click(await screen.findByRole('button', { name: /Validate file/ }));

  await screen.findByText('1 missing make/model');
  expect(screen.getByText('Dell Dell PowerEdge R720')).toBeTruthy();
  expect(screen.getByText('2 rows')).toBeTruthy();
  expect(screen.getAllByText('Fix…')).toHaveLength(2);
});

it('reprocess swaps the polled job for the child job and shows its banner', { timeout: 10000 }, async () => {
  const parent = commitJob();
  const child = commitJob({
    id: 'job-2', phase: 'validate', status: 'queued',
    options: { ...parent.options, reprocess_of: 'job-1', only_rows: [2, 3] },
    results: null, processed_rows: 0,
  });
  api.getInitiative.mockResolvedValue(INITIATIVE);
  api.createMoveAssetImportJob.mockResolvedValue(parent);
  api.reprocessImportJob.mockResolvedValue(child);
  api.getImportJob.mockResolvedValue(child);

  render(<MemoryRouter><ImportMoveAssets /></MemoryRouter>);
  await screen.findByText('NAP11 Move');

  const file = new File(['a,b'], 'assets.csv', { type: 'text/csv' });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await userEvent.upload(input, file);
  await userEvent.click(await screen.findByRole('button', { name: /Validate file/ }));

  const reprocessBtn = await screen.findByRole('button', { name: 'Reprocess 2 flagged' });
  await userEvent.click(reprocessBtn);

  await waitFor(() => expect(api.reprocessImportJob).toHaveBeenCalledWith('job-1'));
  // the page now polls the CHILD id, not the parent's — the poll interval
  // is 2s, so give this a longer-than-default waitFor window.
  await waitFor(() => expect(api.getImportJob).toHaveBeenCalledWith('job-2'), { timeout: 4000 });
  expect(api.getImportJob).not.toHaveBeenCalledWith('job-1');

  await screen.findByText('Reprocessing 2 flagged rows from the earlier run.');
});

it('read-only users see a hint instead of fix actions', async () => {
  auth.can = () => false;
  const job = commitJob();
  api.getInitiative.mockResolvedValue(INITIATIVE);
  api.createMoveAssetImportJob.mockResolvedValue(job);

  render(<MemoryRouter><ImportMoveAssets /></MemoryRouter>);
  await screen.findByText('NAP11 Move');

  const file = new File(['a,b'], 'assets.csv', { type: 'text/csv' });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await userEvent.upload(input, file);
  await userEvent.click(await screen.findByRole('button', { name: /Validate file/ }));

  await screen.findByText('1 missing make/model');
  expect(screen.getByText('Ask an admin to add these models.')).toBeTruthy();
  expect(screen.queryByText('Create model…')).toBeNull();
  expect(screen.queryByText('Map to existing…')).toBeNull();
  expect(screen.queryByText('Fix…')).toBeNull();
});

it('report list: column floors, shared template + minimum, sideways-scroll card', async () => {
  api.getInitiative.mockResolvedValue(INITIATIVE);
  api.createMoveAssetImportJob.mockResolvedValue(commitJob());

  render(<MemoryRouter><ImportMoveAssets /></MemoryRouter>);
  await screen.findByText('NAP11 Move');

  const file = new File(['a,b'], 'assets.csv', { type: 'text/csv' });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await userEvent.upload(input, file);
  await userEvent.click(await screen.findByRole('button', { name: /Validate file/ }));

  const row = (await screen.findByText('SN1')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toBe('70px 160px 130px minmax(220px, 1fr)');
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  // Fit: default columns ≤ LIST_FIT.initPanel (1134px — the report card is an
  // .init-panel, 18px padding plus a 1px border each side off the measured
  // 1174px page width).
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.initPanel);
});

// ── From-To import report (.xlsx) ────────────────────────────────────

afterEach(() => { vi.useRealTimers(); });

const REPORT_BUTTON = { name: 'Download report (.xlsx)' };

/** Upload + validate, with createMoveAssetImportJob answering `next`. */
async function showJob(next: ImportJobOut) {
  api.getInitiative.mockResolvedValue(INITIATIVE);
  api.createMoveAssetImportJob.mockResolvedValue(next);
  api.getImportJob.mockResolvedValue(next);
  render(<MemoryRouter><ImportMoveAssets /></MemoryRouter>);
  await screen.findByText('NAP11 Move');
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await userEvent.upload(input, new File(['a,b'], 'assets.csv', { type: 'text/csv' }));
  await userEvent.click(await screen.findByRole('button', { name: /Validate file/ }));
}

it('offers the report after a completed check', async () => {
  await showJob(commitJob({ phase: 'validate' }));
  expect(await screen.findByRole('button', REPORT_BUTTON)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Start over' })).toBeTruthy();
});

it('offers the report after a completed import', async () => {
  await showJob(commitJob());
  await screen.findByText('Import complete');
  expect(screen.getByRole('button', REPORT_BUTTON)).toBeTruthy();
});

it('hides the report while a job is running', async () => {
  await showJob(commitJob({
    phase: 'validate', status: 'running', processed_rows: 1, results: null,
  }));
  await screen.findByText('Checking the file…');
  expect(screen.queryByRole('button', REPORT_BUTTON)).toBeNull();
});

it.each([
  ['failed', 'Import failed'],
  ['cancelled', 'Validation cancelled.'],
] as const)('hides the report on a %s job', async (status, shown) => {
  await showJob(commitJob({
    phase: 'validate', status, error: status === 'failed' ? 'invalid_csv' : null,
  }));
  await screen.findByText(shown);
  expect(screen.queryByRole('button', REPORT_BUTTON)).toBeNull();
});

it('downloads the report under the move name and today\'s local date', async () => {
  await showJob(commitJob());
  const button = await screen.findByRole('button', REPORT_BUTTON);

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 25, 9, 30));
  await userEvent.click(button);

  expect(report.downloadImportReport).toHaveBeenCalledTimes(1);
  const file = report.downloadImportReport.mock.calls[0][0] as ImportReportFile;
  expect(file.filename).toBe('nap11-move-from-to-import-2026-09-25.xlsx');
  const summary = XLSX.utils.sheet_to_json<[string, string | number]>(
    file.workbook.Sheets.Summary, { header: 1 });
  expect(summary).toContainEqual(['Move', 'NAP11 Move']);
  expect(summary).toContainEqual(['File', 'assets.csv']);
  expect(summary).toContainEqual(['Report', 'Import']);
  expect(summary).toContainEqual(['Generated by', 'Jimmy Henderson']);
});

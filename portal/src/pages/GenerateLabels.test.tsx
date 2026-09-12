// @vitest-environment jsdom
/**
 * /labels/generate — picker, type cards, gating, start→progress polling→
 * runs-list refresh, cancel, the errors modal, and the ?run= deep link.
 * Mocks the API entirely (see the worktree brief: the API implementer's
 * routes land in parallel on this same branch).
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError,
  type InitiativeItem, type LabelGeneratePreview, type LabelRun, type LabelVocab,
} from '../lib/api';

/** Real-timer wait — the page polls with a real `setInterval` (see
 *  GenerateReportModal's own test convention), so proving a poll has
 *  actually STOPPED needs to wait past its period, not just await a
 *  promise. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

vi.mock('../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({
    status: { read_only: false, read_only_message: '', workers_paused: false, banner: null },
    refresh: vi.fn(),
  }),
}));

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(), listLabelVocab: vi.fn(), listLabelRuns: vi.fn(),
  getLabelRun: vi.fn(), getLabelGeneratePreview: vi.fn(), startLabelRun: vi.fn(), cancelLabelRun: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const { default: GenerateLabels } = await import('./GenerateLabels');

const ini = (id: string, name: string, status: string, clientName = 'Acme'): InitiativeItem => ({
  id, name, status, status_label: status, status_color: '#000', initiative_type: 'move',
  type_label: 'Move', type_color: '#000', client_name: clientName, archived_at: null,
  scheduled_start: '2026-10-01T00:00:00Z', scheduled_end: null,
  created_at: '2026-09-01T00:00:00Z',
} as unknown as InitiativeItem);

const INIS = [ini('i1', 'Zeta', 'completed'), ini('i2', 'NAP11', 'in_progress'), ini('i3', 'Beta', 'planned')];

const vocabRow = (key: string, label: string): LabelVocab => ({
  kind: 'type', key, label, description: `${label} tag`, meta: {}, sort_order: 0, is_active: true, usage_count: null,
});
const VOCAB = [vocabRow('top', 'Top'), vocabRow('front', 'Front')];

const preview = (over: Partial<LabelGeneratePreview> = {}): LabelGeneratePreview => ({
  initiative: {
    id: 'i2', name: 'NAP11', client_name: 'Acme', status: 'in_progress',
    scheduled_start: '2026-10-01T00:00:00Z', source_name: 'NAP7', destination_name: 'NAP11',
    asset_count: 42,
  },
  types: [
    { key: 'top', label: 'Top', template: { id: 't1', name: 'Top asset tag', version: 5, scope: 'site' }, current: 3, stale: 1 },
    { key: 'front', label: 'Front', template: null, current: 0, stale: 0 },
  ],
  active_run_id: null,
  ...over,
});

const run = (over: Partial<LabelRun> = {}): LabelRun => ({
  id: 'r1', initiative_id: 'i2', initiative_name: 'NAP11', label_types: ['top'],
  regenerate_existing: false, status: 'queued', cancel_requested: false,
  current_label_type: null, current_item: null, total: 0, processed: 0,
  generated: 0, skipped: 0, errors: 0, error_summary: {}, error_details: [], error: null,
  requested_by: 'p1', requested_by_name: 'Alice', notify: false,
  created_at: '2026-09-11T00:00:00Z', started_at: null, finished_at: null, progress_pct: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.listInitiatives.mockResolvedValue(INIS);
  api.listLabelVocab.mockResolvedValue(VOCAB);
  api.listLabelRuns.mockResolvedValue([]);
  api.getLabelGeneratePreview.mockResolvedValue(preview());
  // Safe fallback so an unexpected extra poll (or a test that doesn't care
  // about getLabelRun) never calls `.then` on an unmocked `undefined`.
  api.getLabelRun.mockResolvedValue(run({}));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function renderAt(path = '/labels/generate') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/labels/generate" element={<GenerateLabels />} /></Routes>
    </MemoryRouter>,
  );
}

async function pickNap11(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByText('NAP11'));
  await screen.findByText('Top asset tag v5 · site');
}

it('renders the eyebrow, title, and description', async () => {
  renderAt();
  expect(screen.getByText('Labels')).not.toBeNull();
  expect(screen.getByText('Generate Labels')).not.toBeNull();
  expect(screen.getByText(/Generate printable labels for every asset/)).not.toBeNull();
});

it('the picker hides finished initiatives', async () => {
  const user = userEvent.setup();
  renderAt();
  await user.click(screen.getByRole('combobox'));
  expect(await screen.findByText('NAP11')).not.toBeNull();
  expect(screen.getByText('Beta')).not.toBeNull();
  expect(screen.queryByText('Zeta')).toBeNull();
});

it('type cards come from vocab and show a template chip / disabled state from the preview', async () => {
  const user = userEvent.setup();
  renderAt();
  await pickNap11(user);
  expect((screen.getByRole('checkbox', { name: /Top/ }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('checkbox', { name: /Front/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('No active template', { selector: '.chip' })).not.toBeNull();
});

it('Generate is disabled until an initiative and a type are picked', async () => {
  const user = userEvent.setup();
  renderAt();
  expect((screen.getByRole('button', { name: 'Generate labels' }) as HTMLButtonElement).disabled).toBe(true);
  await pickNap11(user);
  expect((screen.getByRole('button', { name: 'Generate labels' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('checkbox', { name: /Top/ }));
  expect((screen.getByRole('button', { name: 'Generate labels' }) as HTMLButtonElement).disabled).toBe(false);
});

it('an active run for the initiative disables Generate with a hint', async () => {
  const user = userEvent.setup();
  api.getLabelGeneratePreview.mockResolvedValue(preview({ active_run_id: 'r-active' }));
  api.getLabelRun.mockResolvedValue(run({ id: 'r-active', status: 'running' }));
  renderAt();
  await pickNap11(user);
  await user.click(screen.getByRole('checkbox', { name: /Top/ }));
  await screen.findByText('A run is already active for this initiative.');
  expect((screen.getByRole('button', { name: 'Generate labels' }) as HTMLButtonElement).disabled).toBe(true);
});

it('Generate posts the expected body and the progress panel polls until completed, then refreshes the runs list', async () => {
  const user = userEvent.setup();
  api.startLabelRun.mockResolvedValue(run({ status: 'queued' }));
  api.getLabelRun
    .mockResolvedValueOnce(run({ status: 'running', processed: 5, total: 10, current_label_type: 'top' }))
    .mockResolvedValueOnce(run({ status: 'completed', processed: 10, total: 10, generated: 10 }));
  renderAt();
  await pickNap11(user);
  await user.click(screen.getByRole('checkbox', { name: /Top/ }));
  await user.click(screen.getByRole('button', { name: 'Generate labels' }));

  await waitFor(() => expect(api.startLabelRun).toHaveBeenCalledWith({
    initiative_id: 'i2', label_types: ['top'], regenerate_existing: false, notify: false,
  }));

  await screen.findByText(/Processing Top · 5 \/ 10/, {}, { timeout: 6000 });
  await screen.findByText('Completed', {}, { timeout: 6000 });
  // mount + the pick-triggered reload + the start's own immediate refresh
  // (so the new run shows right away) + the post-completion refresh
  await waitFor(() => expect(api.listLabelRuns).toHaveBeenCalledTimes(4));

  // Load-bearing: exactly the two polls that actually happened (running,
  // then completed) — and no more once it settles. Waiting past another
  // full POLL_MS proves the interval was actually torn down, not just
  // that the assertion happened to run before a third tick could fire.
  expect(api.getLabelRun).toHaveBeenCalledTimes(2);
  await wait(2200);
  expect(api.getLabelRun).toHaveBeenCalledTimes(2);
}, 12000);

it('polling stops once the run fails — no further getLabelRun calls', async () => {
  const user = userEvent.setup();
  api.startLabelRun.mockResolvedValue(run({ status: 'queued' }));
  api.getLabelRun
    .mockResolvedValueOnce(run({ status: 'running', processed: 5, total: 10, current_label_type: 'top' }))
    .mockResolvedValueOnce(run({ status: 'failed', error: 'Boom' }));
  renderAt();
  await pickNap11(user);
  await user.click(screen.getByRole('checkbox', { name: /Top/ }));
  await user.click(screen.getByRole('button', { name: 'Generate labels' }));
  await screen.findByText(/Processing Top/, {}, { timeout: 6000 });
  await screen.findByText('Failed', {}, { timeout: 6000 });
  expect(api.getLabelRun).toHaveBeenCalledTimes(2);
  await wait(2200);
  expect(api.getLabelRun).toHaveBeenCalledTimes(2);
}, 12000);

it('polling stops once the run is canceled — no further getLabelRun calls', async () => {
  const user = userEvent.setup();
  api.startLabelRun.mockResolvedValue(run({ status: 'queued' }));
  api.getLabelRun
    .mockResolvedValueOnce(run({ status: 'running', processed: 5, total: 10, current_label_type: 'top' }))
    .mockResolvedValueOnce(run({ status: 'canceled', cancel_requested: true }));
  renderAt();
  await pickNap11(user);
  await user.click(screen.getByRole('checkbox', { name: /Top/ }));
  await user.click(screen.getByRole('button', { name: 'Generate labels' }));
  await screen.findByText(/Processing Top/, {}, { timeout: 6000 });
  await screen.findByText('Canceled', {}, { timeout: 6000 });
  expect(api.getLabelRun).toHaveBeenCalledTimes(2);
  await wait(2200);
  expect(api.getLabelRun).toHaveBeenCalledTimes(2);
}, 12000);

it('a 409 run_active on Generate fetches and shows the already-active run', async () => {
  const user = userEvent.setup();
  api.startLabelRun.mockRejectedValue(new ApiError(409, 'run_active', { code: 'run_active', run_id: 'r-x' }));
  api.getLabelRun.mockResolvedValue(run({ id: 'r-x', status: 'running', processed: 3, total: 9 }));
  renderAt();
  await pickNap11(user);
  await user.click(screen.getByRole('checkbox', { name: /Top/ }));
  await user.click(screen.getByRole('button', { name: 'Generate labels' }));
  await waitFor(() => expect(api.getLabelRun).toHaveBeenCalledWith('r-x'));
  await screen.findByText('A run is already active for this initiative.');
  expect((screen.getByRole('button', { name: 'Generate labels' }) as HTMLButtonElement).disabled).toBe(true);
  await screen.findByText('Generating');
});

it('Cancel posts a cancel for the active run', async () => {
  const user = userEvent.setup();
  api.startLabelRun.mockResolvedValue(run({ status: 'running', processed: 1, total: 10 }));
  api.cancelLabelRun.mockResolvedValue(run({ status: 'canceled', cancel_requested: true }));
  renderAt();
  await pickNap11(user);
  await user.click(screen.getByRole('checkbox', { name: /Top/ }));
  await user.click(screen.getByRole('button', { name: 'Generate labels' }));
  await user.click(await screen.findByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(api.cancelLabelRun).toHaveBeenCalledWith('r1'));
  await screen.findByText('Canceled');
});

it('the errors modal shows summary chips, sample rows, and the hidden-count note; "View errors" opens it', async () => {
  const user = userEvent.setup();
  const errRun = run({
    id: 'r-err', status: 'completed', errors: 60,
    error_summary: { no_template: 60 },
    error_details: Array.from({ length: 3 }, (_, i) => (
      { item: `A-${i}`, label_type: 'top', type: 'no_template', message: 'No active template for top' }
    )),
  });
  api.listLabelRuns.mockResolvedValue([errRun]);
  renderAt();
  await screen.findByText('NAP11');   // the run row, in the Recent runs list (no initiative picked yet)
  await user.click(await screen.findByRole('button', { name: /Actions/ }));
  await user.click(await screen.findByText('View errors'));
  expect(screen.getByText('60 errors in NAP11')).not.toBeNull();
  expect(screen.getByText(/no_template/)).not.toBeNull();
  expect(screen.getByText('A-0')).not.toBeNull();
  expect(screen.getByText(/Only the first 3 of 60 errors are shown/)).not.toBeNull();
});

it('?run= deep link opens that run\'s progress when still active', async () => {
  api.getLabelRun.mockResolvedValue(run({ id: 'r-deep', status: 'running', processed: 2, total: 4 }));
  renderAt('/labels/generate?run=r-deep');
  await waitFor(() => expect(api.getLabelRun).toHaveBeenCalledWith('r-deep'));
  await screen.findByText('Generating');
});

it('?run= deep link opens the errors modal when the run already finished with errors', async () => {
  api.getLabelRun.mockResolvedValue(run({
    id: 'r-deep2', status: 'completed', errors: 2,
    error_summary: { no_template: 2 },
    error_details: [
      { item: 'A-1', label_type: 'top', type: 'no_template', message: 'msg' },
      { item: 'A-2', label_type: 'top', type: 'no_template', message: 'msg' },
    ],
  }));
  renderAt('/labels/generate?run=r-deep2');
  expect(await screen.findByText('2 errors in NAP11')).not.toBeNull();
});

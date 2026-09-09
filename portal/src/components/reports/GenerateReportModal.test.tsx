// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { InitiativeItem, ReportDefinition, ReportRun } from '../../lib/api';

const status = vi.hoisted(() => ({ workers_paused: false }));
vi.mock('../../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({ status: { read_only: false, read_only_message: '', workers_paused: status.workers_paused, banner: null }, refresh: vi.fn() }),
}));
const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(), createReportRun: vi.fn(), getReportRun: vi.fn(),
  getReportRunDownloadUrl: vi.fn(), setReportRunNotify: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: GenerateReportModal } = await import('./GenerateReportModal');

const DEF: ReportDefinition = {
  id: 'd1', name: 'Move Report', description: '', report_type: 'move_report', is_system: true,
  updated_at: '2026-09-09T10:00:00Z',
  options: { summary: true, assets_by_source: true, assets_by_destination: true, size_weight: true,
    rail_usage: true, collisions: false, source_racks: true, destination_racks: true },
};
const ini = (id: string, name: string, status: string, type = 'move', client = 'Acme') => ({
  id, name, status, status_label: status, status_color: '#000', initiative_type: type,
  type_label: type, type_color: '#000', client_name: client, archived_at: null,
  scheduled_start: '2026-10-01T00:00:00Z', scheduled_end: null,
} as unknown as InitiativeItem);
const INIS = [ini('i1', 'Zeta', 'completed'), ini('i2', 'NAP11', 'in_progress'),
              ini('i3', 'Beta', 'planned', 'decommission')];
const run = (over: Partial<ReportRun>): ReportRun => ({
  id: 'r1', definition_id: 'd1', definition_name: 'Move Report', report_type: 'move_report',
  initiative_id: 'i2', initiative_name: 'NAP11', options: DEF.options, status: 'queued', error: null,
  requested_by: 'p1', requested_by_name: 'Alice', requested_rank: 40, notify: false, filename: null,
  size_bytes: null, started_at: null, finished_at: null, created_at: '2026-09-09T12:00:00Z', ...over,
});

beforeEach(() => {
  status.workers_paused = false;
  api.listInitiatives.mockResolvedValue(INIS);
  api.createReportRun.mockResolvedValue(run({}));
  api.getReportRun.mockResolvedValue(run({}));
  api.getReportRunDownloadUrl.mockResolvedValue('https://spaces/x.pdf');
  api.setReportRunNotify.mockResolvedValue(run({ notify: true }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

async function toStep2(user: ReturnType<typeof userEvent.setup>) {
  render(<GenerateReportModal definition={DEF} onClose={() => {}} />);
  await screen.findByText('NAP11');
  await user.click(screen.getByLabelText('NAP11'));
  await user.click(screen.getByRole('button', { name: 'Next' }));
}

it('step 1 sorts active first, filters by type and search, Next needs a pick', async () => {
  const user = userEvent.setup();
  render(<GenerateReportModal definition={DEF} onClose={() => {}} />);
  await screen.findByText('NAP11');
  expect(screen.getByRole('heading', { name: 'Generate Move Report' })).toBeTruthy();
  const names = screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label'));
  expect(names).toEqual(['NAP11', 'Beta', 'Zeta']);
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  await user.selectOptions(screen.getByLabelText('Type'), 'decommission');
  expect(screen.getAllByRole('radio')).toHaveLength(1);
  await user.selectOptions(screen.getByLabelText('Type'), '');
  await user.type(screen.getByPlaceholderText('Search initiatives…'), 'nap');
  expect(screen.getAllByRole('radio')).toHaveLength(1);
});

it('step 2 shows the eight sections with definition defaults; select/deselect all; generate posts', async () => {
  const user = userEvent.setup();
  await toStep2(user);
  const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
  expect(boxes).toHaveLength(8);
  expect(boxes.map((b) => b.checked)).toEqual([true, true, true, true, true, false, true, true]);
  await user.click(screen.getByRole('button', { name: 'Deselect All' }));
  expect((screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Turn on at least one section')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Select All' }));
  await user.click(screen.getByLabelText(/^Collision Report/));
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  await waitFor(() => expect(api.createReportRun).toHaveBeenCalledWith({
    definition_id: 'd1', initiative_id: 'i2', notify: false,
    options: { ...DEF.options, collisions: false },
  }));
});

it('step 3 polls, then offers Download and the Files note', async () => {
  const user = userEvent.setup();
  api.getReportRun
    .mockResolvedValueOnce(run({ status: 'running' }))
    .mockResolvedValue(run({ status: 'completed', filename: 'Move Report - NAP11.pdf' }));
  await toStep2(user);
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  // The dialog opens on "Queued" (the create response) and only flips to
  // "Generating…" on the first 2 s poll, so this wait must outlast
  // MODAL_POLL_MS rather than the 1 s testing-library default.
  await screen.findByText(/Generating/, {}, { timeout: 6000 });
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  await screen.findByRole('button', { name: 'Download' }, { timeout: 6000 });
  expect(screen.getByText("Also saved to the initiative's Files")).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://spaces/x.pdf', '_blank'));
});

it('notify-me sets the flag, toasts and closes', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onToast = vi.fn();
  render(<GenerateReportModal definition={DEF} onClose={onClose} onToast={onToast} />);
  await screen.findByText('NAP11');
  await user.click(screen.getByLabelText('NAP11'));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  await user.click(await screen.findByRole('button', { name: "Notify me when it's ready" }));
  await waitFor(() => expect(api.setReportRunNotify).toHaveBeenCalledWith('r1', true));
  expect(onToast).toHaveBeenCalledWith("We'll let you know when it's ready");
  expect(onClose).toHaveBeenCalled();
});

it('failure shows the error and Try again re-queues with the same options', async () => {
  const user = userEvent.setup();
  api.getReportRun.mockResolvedValue(run({ status: 'failed', error: 'rack renderer unavailable: x' }));
  await toStep2(user);
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  // Same as above: the failure only lands on the first poll.
  await screen.findByText('rack renderer unavailable: x', {}, { timeout: 6000 });
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(api.createReportRun).toHaveBeenCalledTimes(2));
});

it('says paused while workers are paused', async () => {
  status.workers_paused = true;
  const user = userEvent.setup();
  await toStep2(user);
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  await screen.findByText('Paused for maintenance — will resume automatically');
});

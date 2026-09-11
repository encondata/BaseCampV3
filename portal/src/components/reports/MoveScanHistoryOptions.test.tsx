// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { InitiativeItem, ReportDefinition, ScanHistoryPreview } from '../../lib/api';

const api = vi.hoisted(() => ({ getScanHistoryPreview: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: MoveScanHistoryOptions } = await import('./MoveScanHistoryOptions');

const DEF: ReportDefinition = {
  id: 'd3', name: 'Move Scan History', description: '', report_type: 'move_scan_history',
  is_system: true, updated_at: '2026-09-09T10:00:00Z',
  options: { default_format: 'xlsx', status_columns: 'pipeline' },
};
// Deliberately the non-fallback values (formatDefaults' own fallback is
// xlsx/pipeline) — this is what makes the "defaults from PDF_DEF" test
// below load-bearing rather than incidentally passing.
const PDF_DEF: ReportDefinition = {
  ...DEF, options: { default_format: 'pdf', status_columns: 'all' },
};

const INITIATIVE = {
  id: 'i2', name: 'NAP11 Hall Migration', client_name: 'Acme',
} as unknown as InitiativeItem;

const PREVIEW = (over: Partial<ScanHistoryPreview> = {}): ScanHistoryPreview => ({
  initiative: {
    id: 'i2', name: 'NAP11 Hall Migration', client_name: 'Acme',
    scheduled_start: '2026-10-01T00:00:00Z', source_name: 'NAP11', destination_name: 'NAP22',
  },
  total_assets: 102, scanned_assets: 80, completed: 60, completion_pct: 59,
  last_scan_at: '2026-09-10T12:00:00Z',
  statuses: [
    { key: 'pre_stage', label: 'Pre-Stage', color: '#3366ff', in_pipeline: true, scan_count: 100 },
    { key: 'complete', label: 'Complete', color: '#22aa55', in_pipeline: true, scan_count: 58 },
    { key: 'on_hold', label: 'On Hold', color: null, in_pipeline: false, scan_count: 3 },
    { key: 'cancelled', label: 'Canceled', color: '#aa2222', in_pipeline: false, scan_count: 0 },
  ],
  ...over,
});

beforeEach(() => {
  api.getScanHistoryPreview.mockResolvedValue(PREVIEW());
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('defaults the format cards and status columns from the definition, and loads the preview KPIs', async () => {
  render(<MoveScanHistoryOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={() => {}} />);
  expect(await screen.findByText('NAP11 Hall Migration')).toBeTruthy();
  expect(api.getScanHistoryPreview).toHaveBeenCalledWith('i2');

  const xlsxCard = screen.getByRole('radio', { name: /Excel workbook/ });
  const pdfCard = screen.getByRole('radio', { name: /PDF document/ });
  expect(xlsxCard.getAttribute('aria-checked')).toBe('true');
  expect(pdfCard.getAttribute('aria-checked')).toBe('false');
  expect(screen.getByRole('tab', { name: 'Pipeline' }).className).toContain('on');

  expect(screen.getByText('102')).toBeTruthy();   // Assets
  expect(screen.getByText('80')).toBeTruthy();    // Scanned
  expect(screen.getByText('60')).toBeTruthy();    // Complete
  expect(screen.getByText('59%')).toBeTruthy();   // Completion
  expect(screen.getByText('NAP11 → NAP22')).toBeTruthy();
});

it('defaults to PDF and All statuses when the definition says so', async () => {
  render(<MoveScanHistoryOptions definition={PDF_DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByText('NAP11 Hall Migration');
  expect(screen.getByRole('radio', { name: /PDF document/ }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('radio', { name: /Excel workbook/ }).getAttribute('aria-checked')).toBe('false');
  expect(screen.getByRole('tab', { name: 'All statuses' }).className).toContain('on');
  expect(screen.getByRole('tab', { name: 'Pipeline' }).className).not.toContain('on');
});

it('switching format cards updates the checked state', async () => {
  const user = userEvent.setup();
  render(<MoveScanHistoryOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByText('NAP11 Hall Migration');
  await user.click(screen.getByRole('radio', { name: /PDF document/ }));
  expect(screen.getByRole('radio', { name: /PDF document/ }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('radio', { name: /Excel workbook/ }).getAttribute('aria-checked')).toBe('false');
});

it('the status chip strip changes with the segmented control: pipeline keeps scanned extras, all shows every status', async () => {
  const user = userEvent.setup();
  render(<MoveScanHistoryOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByText('NAP11 Hall Migration');

  // pipeline (default): Pre-Stage + Complete, then On Hold (scanned, not in
  // pipeline) flagged "also scanned"; Canceled (never scanned) is hidden.
  // ("Complete" also names a KPI tile, so scope the chip queries to the strip.)
  const chipText = () => screen.getByText('Pre-Stage').closest('.rgm-status-chips') as HTMLElement;
  expect(within(chipText()).getByText('Pre-Stage')).toBeTruthy();
  expect(within(chipText()).getByText('Complete')).toBeTruthy();
  expect(within(chipText()).getByText('On Hold')).toBeTruthy();
  expect(within(chipText()).getByText('also scanned')).toBeTruthy();
  expect(within(chipText()).queryByText('Canceled')).toBeNull();

  await user.click(screen.getByRole('tab', { name: 'All statuses' }));
  expect(within(chipText()).getByText('Canceled')).toBeTruthy();
  expect(within(chipText()).queryByText('also scanned')).toBeNull();
});

it('shows a loading state, then an error with Retry on failure', async () => {
  let resolvePreview: (v: ScanHistoryPreview) => void = () => {};
  api.getScanHistoryPreview.mockReturnValueOnce(new Promise((res) => { resolvePreview = res; }));
  render(<MoveScanHistoryOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={() => {}} />);
  expect(screen.getByText('Loading preview…')).toBeTruthy();
  resolvePreview(PREVIEW());
  await screen.findByText('NAP11 Hall Migration');
});

it('Retry re-fetches the preview after a failure', async () => {
  const user = userEvent.setup();
  api.getScanHistoryPreview.mockRejectedValueOnce(new Error('network down'));
  render(<MoveScanHistoryOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByText("Couldn't load the preview.");
  api.getScanHistoryPreview.mockResolvedValueOnce(PREVIEW());
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('NAP11 Hall Migration');
  expect(api.getScanHistoryPreview).toHaveBeenCalledTimes(2);
});

it('shows the zero-asset hint but still allows generating', async () => {
  const user = userEvent.setup();
  api.getScanHistoryPreview.mockResolvedValue(PREVIEW({ total_assets: 0 }));
  const onGenerate = vi.fn();
  render(<MoveScanHistoryOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={onGenerate} />);
  await screen.findByText('NAP11 Hall Migration');
  expect(screen.getByText('This move has no assets yet — the report will say so.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement).disabled)
    .toBe(false);
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  expect(onGenerate).toHaveBeenCalled();
});

it('Generate posts {format, status_columns} after switching both controls', async () => {
  const user = userEvent.setup();
  const onGenerate = vi.fn();
  render(<MoveScanHistoryOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={onGenerate} />);
  await screen.findByText('NAP11 Hall Migration');
  await user.click(screen.getByRole('radio', { name: /PDF document/ }));
  await user.click(screen.getByRole('tab', { name: 'All statuses' }));
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  expect(onGenerate).toHaveBeenCalledWith({
    initiative_id: 'i2', options: { format: 'pdf', status_columns: 'all' }, notify: false,
  });
});

it('Notify me flips the payload\'s notify flag', async () => {
  const user = userEvent.setup();
  const onGenerate = vi.fn();
  render(<MoveScanHistoryOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={onGenerate} />);
  await screen.findByText('NAP11 Hall Migration');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  await waitFor(() => expect(onGenerate).toHaveBeenCalledWith(
    expect.objectContaining({ notify: true })));
});

it('Back returns to the pick step', async () => {
  const user = userEvent.setup();
  const onBack = vi.fn();
  render(<MoveScanHistoryOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={onBack} onGenerate={() => {}} />);
  await screen.findByText('NAP11 Hall Migration');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(onBack).toHaveBeenCalled();
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpecLookupStatus, SpecSuggestion } from '../../lib/api';

const api = vi.hoisted(() => ({
  listSpecSuggestions: vi.fn(),
  actOnSpecSuggestion: vi.fn(),
  bulkSpecSuggestions: vi.fn(),
  queueSpecLookup: vi.fn(),
  updateAiLookupConfig: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { ApiError } = await import('../../lib/api');
const { default: SpecLookupPanel } = await import('./SpecLookupPanel');

const STATUS: SpecLookupStatus = {
  configured: true, background_enabled: false, queued: 3, running_model: null,
  last_finished_at: null, pending_count: 1,
  failed_this_month: 0, last_error: null, key_rejected: false,
  month: { lookups: 4, input_tokens: 40000, output_tokens: 4000, searches: 9, est_cost_usd: 0.21 },
};
const SUGG: SpecSuggestion = {
  id: 's1', model_id: 'm1', make: 'HPE', model: 'DL320 Gen11', field: 'weight', value: '13.6',
  unit: 'kg', current_value: null, source_url: 'https://www.hpe.com/psnow/doc/a1',
  quote: 'Maximum weight 13.6 kg', status: 'pending', created_at: '2026-09-28T12:00:00Z',
  decided_at: null,
};

const renderPanel = (status: SpecLookupStatus | null = STATUS, onChanged = vi.fn(), canChange = true) => render(
  <MemoryRouter><SpecLookupPanel canChange={canChange} status={status} onChanged={onChanged} /></MemoryRouter>,
);

describe('SpecLookupPanel', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.listSpecSuggestions.mockResolvedValue([SUGG]);
  });
  afterEach(cleanup);

  it('shows the status strip and a suggestion row', async () => {
    renderPanel();
    expect(await screen.findByText('DL320 Gen11')).toBeTruthy();
    expect(api.listSpecSuggestions).toHaveBeenCalledWith('pending');
    expect(screen.getByText(/3 queued/)).toBeTruthy();
    expect(screen.getByText(/\$0\.21/)).toBeTruthy();
    expect(screen.getByText('13.6 kg')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'hpe.com' }).getAttribute('href')).toBe(SUGG.source_url);
  });

  it('shows the model being looked up right now', async () => {
    renderPanel({ ...STATUS, running_model: { id: 'm9', make: 'Dell', model: 'R650' } });
    expect(await screen.findByText(/looking up Dell R650/)).toBeTruthy();
  });

  it('approves a row and reloads', async () => {
    const onChanged = vi.fn();
    api.actOnSpecSuggestion.mockResolvedValue({ ...SUGG, status: 'approved' });
    renderPanel(STATUS, onChanged);
    const row = (await screen.findByText('DL320 Gen11')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.actOnSpecSuggestion).toHaveBeenCalledWith('s1', 'approve'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(api.listSpecSuggestions).toHaveBeenCalledTimes(2));
  });

  it('maps a field_changed refusal to its message', async () => {
    api.actOnSpecSuggestion.mockRejectedValue(new ApiError(409, 'field_changed'));
    renderPanel();
    const row = (await screen.findByText('DL320 Gen11')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/The field was changed since this was found/)).toBeTruthy();
  });

  it('offers Undo on applied rows and switches filters', async () => {
    api.listSpecSuggestions.mockImplementation(async (status: string) =>
      (status === 'applied' ? [{ ...SUGG, status: 'applied' }] : []));
    renderPanel();
    expect(await screen.findByText('No suggestions in this view.')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Applied' }));
    const row = (await screen.findByText('DL320 Gen11')).closest('tr')!;
    expect(within(row).getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(row).queryByRole('checkbox')).toBeNull();
  });

  it('queues every eligible model', async () => {
    const onChanged = vi.fn();
    api.queueSpecLookup.mockResolvedValue({ queued: 5, skipped: [] });
    renderPanel(STATUS, onChanged);
    await userEvent.click(await screen.findByRole('button', { name: 'Find missing specs' }));
    await waitFor(() => expect(api.queueSpecLookup).toHaveBeenCalledWith(undefined));
    expect(await screen.findByText(/Queued 5 models/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it('explains when no API key is configured', async () => {
    renderPanel({ ...STATUS, configured: false });
    expect(await screen.findByText(/No Anthropic API key/)).toBeTruthy();
    expect(screen.getByText(/SS_ANTHROPIC_API_KEY/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Find missing specs' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides row actions without change permission', async () => {
    renderPanel(STATUS, vi.fn(), false);
    const row = (await screen.findByText('DL320 Gen11')).closest('tr')!;
    expect(within(row).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Find missing specs' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('bulk approve ends in the per-row summary', async () => {
    const onChanged = vi.fn();
    api.bulkSpecSuggestions.mockResolvedValue({ results: [
      { id: 's1', ok: true, error: null, make: 'HPE', model: 'DL320 Gen11', field: 'weight', value: '13.6' }] });
    renderPanel(STATUS, onChanged);
    const row = (await screen.findByText('DL320 Gen11')).closest('tr')!;
    await userEvent.click(within(row).getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Approve selected/ }));
    await waitFor(() => expect(api.bulkSpecSuggestions).toHaveBeenCalledWith(['s1'], 'approve'));
    // BulkApplySummary's download button — its real label
    expect(await screen.findByRole('button', { name: /Download summary/ })).toBeTruthy();
    expect(screen.getByText('HPE DL320 Gen11 — Weight')).toBeTruthy();
    expect(screen.getByText('Weight: — → 13.6')).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('button', { name: /Download summary/ })).toBeNull();
  });

  const S2: SpecSuggestion = {
    ...SUGG, id: 's2', model: 'DL360 Gen10', field: 'ru_size', value: '1', unit: null, current_value: '2',
  };
  const selectAndClick = async (label: RegExp, name: string) => {
    await userEvent.click(within((await screen.findByText(name)).closest('tr')!).getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: label }));
  };

  it('bulk approve shows old → new and names each failed row with its reason', async () => {
    api.listSpecSuggestions.mockResolvedValue([SUGG, S2]);
    api.bulkSpecSuggestions.mockResolvedValue({ results: [
      { id: 's2', ok: true, error: null, make: 'HPE', model: 'DL360 Gen10', field: 'ru_size', value: '1' },
      { id: 's1', ok: false, error: 'bad_state', make: 'HPE', model: 'DL320 Gen11', field: 'weight', value: '13.6' },
    ] });
    renderPanel();
    await userEvent.click(within((await screen.findByText('DL320 Gen11')).closest('tr')!).getByRole('checkbox'));
    await selectAndClick(/Approve selected/, 'DL360 Gen10');
    const table = await screen.findByRole('table', { name: 'Apply summary' });
    expect(within(table).getByText('Outcome')).toBeTruthy();
    const okRow = within(table).getByText('HPE DL360 Gen10 — RU size').closest('tr')!;
    expect(within(okRow).getByText('Approved')).toBeTruthy();
    expect(within(okRow).getByText('Updated')).toBeTruthy();
    expect(within(okRow).getByText('RU size: 2 → 1')).toBeTruthy();
    const badRow = within(table).getByText('HPE DL320 Gen11 — Weight').closest('tr')!;
    expect(within(badRow).getByText('Already decided.')).toBeTruthy();
    expect(within(badRow).getByText('Skipped')).toBeTruthy();
    expect(screen.getByText('Applied: 1 updated · 1 skipped')).toBeTruthy();
  });

  it('bulk reject never reports the catalog as updated', async () => {
    api.bulkSpecSuggestions.mockResolvedValue({ results: [
      { id: 's1', ok: true, error: null, make: 'HPE', model: 'DL320 Gen11', field: 'weight', value: '13.6' }] });
    renderPanel();
    await selectAndClick(/Reject selected/, 'DL320 Gen11');
    await waitFor(() => expect(api.bulkSpecSuggestions).toHaveBeenCalledWith(['s1'], 'reject'));
    const table = await screen.findByRole('table', { name: 'Apply summary' });
    expect(within(table).queryByText('Updated')).toBeNull();
    expect(within(table).queryByText(/→/)).toBeNull();
    expect(within(table).getByText('Rejected')).toBeTruthy();
    expect(within(table).getByText('No change')).toBeTruthy();
    expect(screen.getByText('Applied: 0 skipped · 1 unchanged')).toBeTruthy();
  });

  it('"Select all pending" selects only the pending rows', async () => {
    api.listSpecSuggestions.mockResolvedValue([SUGG, S2, { ...SUGG, id: 's3', model: 'Applied One', status: 'applied' }]);
    api.bulkSpecSuggestions.mockResolvedValue({ results: [] });
    renderPanel();
    await screen.findByText('Applied One');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all pending' }));
    expect(screen.getByRole('button', { name: 'Approve selected (2)' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Approve selected (2)' }));
    await waitFor(() => expect(api.bulkSpecSuggestions).toHaveBeenCalledWith(['s1', 's2'], 'approve'));
  });

  it('counts failed lookups this month in the strip', async () => {
    renderPanel({ ...STATUS, failed_this_month: 2 });
    expect(await screen.findByText(/2 failed this month/)).toBeTruthy();
    cleanup();
    renderPanel();
    await screen.findByText('DL320 Gen11');
    expect(screen.queryByText(/failed this month/)).toBeNull();
  });

  it('explains a rejected API key', async () => {
    renderPanel({ ...STATUS, key_rejected: true, last_error: 'not_configured' });
    expect(await screen.findByText('The Anthropic API rejected the configured key.')).toBeTruthy();
    expect(screen.getByText(/SS_ANTHROPIC_API_KEY/)).toBeTruthy();
    expect(screen.getByText(/Test connection/)).toBeTruthy();
  });

  it('says so when no field groups are turned on', async () => {
    api.queueSpecLookup.mockResolvedValue({ queued: 0, skipped: [], reason: 'no_fields_enabled' });
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Find missing specs' }));
    expect(await screen.findByText('No field groups are turned on in System settings › AI lookup.')).toBeTruthy();
    expect(screen.queryByText(/Queued 0 models/)).toBeNull();
  });

  it('shows when the last lookup finished', async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    renderPanel({ ...STATUS, last_finished_at: fiveMinAgo });
    expect(await screen.findByText(/last run 5m ago/)).toBeTruthy();
  });

  it('toggles Background search from the strip', async () => {
    const onChanged = vi.fn();
    api.updateAiLookupConfig.mockResolvedValue({});
    renderPanel(STATUS, onChanged);
    const sw = await screen.findByRole('checkbox', { name: 'Background search' }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    await userEvent.click(sw);
    await waitFor(() => expect(api.updateAiLookupConfig).toHaveBeenCalledWith({ background_enabled: true }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('disables the Background search switch without change permission', async () => {
    renderPanel({ ...STATUS, background_enabled: true }, vi.fn(), false);
    const sw = await screen.findByRole('checkbox', { name: 'Background search' }) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    expect(sw.disabled).toBe(true);
  });
});

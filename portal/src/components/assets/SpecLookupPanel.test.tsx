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
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { ApiError } = await import('../../lib/api');
const { default: SpecLookupPanel } = await import('./SpecLookupPanel');

const STATUS: SpecLookupStatus = {
  configured: true, background_enabled: false, queued: 3, running_model: null,
  last_finished_at: null, pending_count: 1,
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
    expect(onChanged).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('button', { name: /Download summary/ })).toBeNull();
  });
});

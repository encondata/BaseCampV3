// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { MacroPointApplyResult, MacroPointPreview } from '../../lib/api';

const api = vi.hoisted(() => ({ previewMacroPoint: vi.fn(), applyMacroPoint: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

import ManualUpdateModal from './ManualUpdateModal';

const preview: MacroPointPreview = {
  groups: [
    {
      group_key: 'order:tok', id_number: 'JAMIE & PATRICK', order_token: 'tok', carrier: 'Landstar - ATL',
      match: { truck_id: 't1', by: 'tracker_id', ambiguous_ids: [] },
      rows: [
        { source: 'a.eml', kind: 'trip_event', recorded_at: '2024-10-15T15:11:00Z', location: null,
          address: '', event: 'Departed at Pickup', status_to: 'in_transit', status_to_label: 'In Transit', duplicate: false },
        { source: 'b.eml', kind: 'location', recorded_at: '2024-10-15T20:32:00Z', location: '35.481693, -119.140353',
          address: 'CA-99 Bakersfield', event: null, status_to: null, status_to_label: null, duplicate: true },
      ],
      new: 1, duplicates: 1,
    },
    {
      group_key: 'id:other', id_number: 'Other Load', order_token: null, carrier: 'Longboard Transportation',
      match: { truck_id: null, by: null, ambiguous_ids: [] },
      rows: [{ source: 'c.eml', kind: 'location', recorded_at: '2026-03-13T18:22:00Z', location: '1.000000, 2.000000',
               address: '', event: null, status_to: null, status_to_label: null, duplicate: false }],
      new: 1, duplicates: 0,
    },
  ],
  errors: [{ source: 'x.eml', reason: 'not_macropoint' }],
  trucks: [
    { id: 't1', name: 'JP Truck', status: 'active', status_label: 'Active', tracker_id: null, initiative_name: null },
    { id: 't2', name: 'Spare Truck', status: 'created', status_label: 'Created', tracker_id: null, initiative_name: 'NAP11' },
  ],
};
const result: MacroPointApplyResult = {
  added: 2, duplicates: 1, skipped: 0, errors: 1, status_changes: 1,
  rows: [
    { row: 1, source: 'a.eml', group_key: 'order:tok', id_number: 'JAMIE & PATRICK', truck_id: 't1', truck_name: 'JP Truck',
      kind: 'trip_event', recorded_at: '2024-10-15T15:11:00Z', detail: 'Departed at Pickup', result: 'added',
      status_change: 'Active → In Transit', reason: null, note: null },
    { row: 2, source: 'x.eml', group_key: null, id_number: null, truck_id: null, truck_name: null, kind: null,
      recorded_at: null, detail: '', result: 'error', status_change: null, reason: 'not_macropoint', note: null },
  ],
};

beforeEach(() => { api.previewMacroPoint.mockReset(); api.applyMacroPoint.mockReset(); });
afterEach(cleanup);

it('has the three source tabs; Copeland is coming soon', () => {
  render(<ManualUpdateModal onClose={() => {}} onApplied={() => {}} />);
  const tabs = within(screen.getByRole('tablist', { name: 'Update source' })).getAllByRole('tab');
  expect(tabs.map((t) => t.textContent)).toEqual(['MacroPoint', 'Copeland', '3rd-Party']);
  fireEvent.click(screen.getByRole('tab', { name: 'Copeland' }));
  expect(screen.getByText(/Copeland updates are not built yet/)).not.toBeNull();
});

it('parses pasted text, picks a truck for the unmatched load, applies and shows the summary', async () => {
  api.previewMacroPoint.mockResolvedValue(preview);
  api.applyMacroPoint.mockResolvedValue(result);
  const onApplied = vi.fn();
  const onClose = vi.fn();
  render(<ManualUpdateModal onClose={onClose} onApplied={onApplied} />);

  const parse = screen.getByRole('button', { name: 'Parse' }) as HTMLButtonElement;
  expect(parse.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Pasted email text'), { target: { value: 'Location Update from …' } });
  fireEvent.click(parse);

  await screen.findByText('2 loads · 2 new · 1 already recorded · 1 problem');
  expect(api.previewMacroPoint).toHaveBeenCalledWith([], 'Location Update from …');
  expect(screen.getByText('Matched by tracking name')).not.toBeNull();
  expect(screen.getByText('No match — pick a truck or leave blank to skip')).not.toBeNull();
  expect(screen.getByText('→ In Transit')).not.toBeNull();
  expect(screen.getByText(/Already recorded/)).not.toBeNull();
  expect(screen.getByText('Not a MacroPoint email')).not.toBeNull();

  fireEvent.focus(screen.getByLabelText('Truck for Other Load'));
  fireEvent.mouseDown(screen.getByText('Spare Truck'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

  await screen.findByText(/Applied: 2 added/);
  expect(api.applyMacroPoint).toHaveBeenCalledWith([], 'Location Update from …',
    { 'order:tok': 't1', 'id:other': 't2' });
  expect(screen.getByText('Active → In Transit')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(onApplied).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

it('shows a coded API error and keeps the input', async () => {
  const { ApiError } = await import('../../lib/api');
  api.previewMacroPoint.mockRejectedValue(new ApiError(413, 'too_many_files'));
  render(<ManualUpdateModal onClose={() => {}} onApplied={() => {}} />);
  fireEvent.change(screen.getByLabelText('Pasted email text'), { target: { value: 'x' } });
  fireEvent.click(screen.getByRole('button', { name: 'Parse' }));
  await waitFor(() => expect(screen.getByText('Too many files — 500 at most per upload.')).not.toBeNull());
  expect((screen.getByLabelText('Pasted email text') as HTMLTextAreaElement).value).toBe('x');
});

it('a mixed drop keeps the .eml files and reports the skipped ones', () => {
  render(<ManualUpdateModal onClose={() => {}} onApplied={() => {}} />);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], 'a.eml'), new File(['y'], 'a.pdf')] } });
  expect(screen.getByText('a.eml')).not.toBeNull();
  expect(screen.getByText('Skipped (not .eml): a.pdf')).not.toBeNull();
  expect((screen.getByRole('button', { name: 'Parse' }) as HTMLButtonElement).disabled).toBe(false);
});

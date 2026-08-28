// @vitest-environment jsdom
/**
 * The reason-required rule described in this modal's header comment: the
 * API's PATCH only demands `adjust_reason` when the submitted body actually
 * carries a clock_in_at/clock_out_at/break_minutes key (routes/time.py's
 * `is_adjustment` looks at which keys were SENT, not whether they differ),
 * so the modal must only include a time field in its patch — and only
 * require/highlight the Reason field — once that field truly changed from
 * the entry's original value. Nothing but the header comment guarded that
 * before; these tests drive the real component to prove the wiring.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TimeEntryItem } from '../../lib/api';

const api = vi.hoisted(() => ({
  createTimeEntry: vi.fn(),
  updateTimeEntry: vi.fn(),
  approveTimeEntry: vi.fn(),
  rejectTimeEntry: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.updateTimeEntry.mockResolvedValue({});
});

afterEach(cleanup);

const { default: TimeEntryEditModal } = await import('./TimeEntryEditModal');

const ENTRY: TimeEntryItem = {
  id: 'te-1', person_id: 'p-1', person_name: 'Jordan Ellis',
  initiative_id: null, initiative_name: null,
  site_id: null, site_name: null,
  clock_in_at: '2026-08-27T14:00:00Z', clock_out_at: '2026-08-27T22:00:00Z',
  break_minutes: 30, minutes: 450,
  status: 'pending', status_label: 'Pending', status_color: '#a36207',
  source: 'clock', notes: '', adjusted: false, adjust_reason: null,
  approved_by: null, approved_by_name: null, approved_at: null, reject_reason: null,
  created_at: '2026-08-27T22:00:00Z', updated_at: '2026-08-27T22:00:00Z',
};

function renderModal() {
  const onSaved = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <TimeEntryEditModal
      entry={ENTRY}
      initiatives={[]}
      sites={[]}
      workers={[]}
      canApprove={false}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onSaved, onClose };
}

/** Change the Clock out input to a value guaranteed different from
 *  whatever local-time string it started with — flips the minutes between
 *  :00 and :30 rather than asserting an absolute clock time, so the test
 *  doesn't depend on the machine's timezone. */
function changeClockOut(): string {
  const input = screen.getByLabelText('Clock out') as HTMLInputElement;
  const original = input.value;
  const changed = original.endsWith('00')
    ? `${original.slice(0, -2)}30`
    : `${original.slice(0, -2)}00`;
  fireEvent.change(input, { target: { value: changed } });
  return changed;
}

describe('reason required only when the times actually change', () => {
  it('reason field is present but optional when nothing changed', async () => {
    const user = userEvent.setup();
    renderModal();

    expect(screen.getByLabelText('Reason for change')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    // no-op save: nothing changed, so no patch is even sent
    await waitFor(() => expect(api.updateTimeEntry).not.toHaveBeenCalled());
  });

  it('becomes required once clock out changes, and blocks submit without one', async () => {
    renderModal();

    changeClockOut();

    // the label itself flips to carry the asterisk once an adjustment is pending
    expect(await screen.findByLabelText('Reason for change *')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(
      'A reason is required when changing clock in/out or break time.',
    )).toBeDefined();
    expect(api.updateTimeEntry).not.toHaveBeenCalled();
  });

  it('submits clock_out_at + adjust_reason (and nothing else) once a reason is given', async () => {
    const user = userEvent.setup();
    renderModal();

    const changed = changeClockOut();
    const reason = await screen.findByLabelText('Reason for change *');
    await user.type(reason, 'Forgot to clock out on time');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateTimeEntry).toHaveBeenCalledTimes(1));
    const [id, patch] = api.updateTimeEntry.mock.calls[0];
    expect(id).toBe('te-1');
    expect(patch.adjust_reason).toBe('Forgot to clock out on time');
    expect(patch.clock_out_at).toBe(new Date(changed).toISOString());
    expect(patch).not.toHaveProperty('clock_in_at');
    expect(patch).not.toHaveProperty('break_minutes');
  });
});

// @vitest-environment jsdom
/**
 * StateChangeModal — a version another tab moved on (409 bad_state) says
 * what it is now and stays open with only Close; onStale lets the page
 * reload the list behind it.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type MatchingVersion } from '../../lib/api';
import StateChangeModal from './StateChangeModal';

const api = vi.hoisted(() => ({
  deployMatchingVersion: vi.fn(),
  rollbackMatchingVersion: vi.fn(),
  standbyMatchingVersion: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const V2: MatchingVersion = {
  id: 'v2id', place: 'printing', version: 2, state: 'draft', based_on_version: 1,
  saved_by_name: null, saved_at: '2026-11-10T09:00:00Z', state_changed_at: null,
  checked: null, current: { passed: 9, total: 9, ok: true, checked_at: null },
};

beforeEach(() => { Object.values(api).forEach((f) => f.mockReset()); });
afterEach(cleanup);

it('a version that changed state meanwhile says what it is now, stays open and reloads', async () => {
  const user = userEvent.setup();
  const onDone = vi.fn();
  const onStale = vi.fn();
  const onClose = vi.fn();
  api.standbyMatchingVersion.mockRejectedValue(new ApiError(409, 'bad_state', { code: 'bad_state', state: 'live' }));
  render(<StateChangeModal kind="standby" version={V2} liveVersion={1} placeLabel="Printing"
                           onClose={onClose} onDone={onDone} onStale={onStale} />);
  await user.click(screen.getByRole('button', { name: 'Save as standby' }));

  expect((await screen.findByRole('alert')).textContent).toBe('v2 is now Live.');
  await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
  expect(onDone).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Save as standby' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  // the footer's Close (the header's X is labeled Close too)
  await user.click(screen.getAllByRole('button', { name: 'Close' }).find((b) => b.textContent === 'Close')!);
  expect(onClose).toHaveBeenCalledTimes(1);
});

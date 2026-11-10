// @vitest-environment jsdom
/**
 * An expanded scan's Details | Raw switch: Details shows the tab's own
 * grid; Raw loads the scan as JSON only when chosen, can copy it, and says
 * where a raw scan went when it has matched since the list loaded.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getScanRecord: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { default: ScanDetailViews } = await import('./ScanDetailViews');
const { ApiError } = await import('../../lib/api');

const RECORD = {
  id: 232747, kind: 'raw', scanned_value: '000000000000000100222',
  match_trace: { outcome: 'no_match', reason: 'No asset, container or person has this RFID tag' },
};

beforeEach(() => {
  api.getScanRecord.mockResolvedValue(RECORD);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('shows Details first and loads the JSON only when Raw is chosen', async () => {
  render(<ScanDetailViews kind="raw" id={232747}><p>the detail grid</p></ScanDetailViews>);
  expect(screen.getByText('the detail grid')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true');
  expect(api.getScanRecord).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('tab', { name: 'Raw' }));
  const pre = await screen.findByLabelText('Scan as JSON');
  expect(api.getScanRecord).toHaveBeenCalledWith('raw', 232747, expect.any(AbortSignal));
  expect(pre.textContent).toBe(JSON.stringify(RECORD, null, 2));
  expect(screen.queryByText('the detail grid')).toBeNull();

  await userEvent.click(screen.getByRole('tab', { name: 'Details' }));
  expect(screen.getByText('the detail grid')).toBeTruthy();
});

it('copies the JSON', async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  render(<ScanDetailViews kind="processed" id="b323c36d"><p>grid</p></ScanDetailViews>);
  await user.click(screen.getByRole('tab', { name: 'Raw' }));
  await screen.findByLabelText('Scan as JSON');
  await user.click(screen.getByRole('button', { name: 'Copy' }));
  expect(writeText).toHaveBeenCalledWith(JSON.stringify(RECORD, null, 2));
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
});

it('says where a raw scan went once it has matched', async () => {
  api.getScanRecord.mockRejectedValue(new ApiError(404, 'scan_not_found'));
  render(<ScanDetailViews kind="raw" id={5}><p>grid</p></ScanDetailViews>);
  await userEvent.click(screen.getByRole('tab', { name: 'Raw' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'This scan has matched since the list loaded. Find it on the Processed tab.');
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const helper = vi.hoisted(() => ({
  getWifiNetworks: vi.fn(),
  joinWifi: vi.fn(),
}));
vi.mock('../../lib/hostHelper', async (orig) => ({
  ...(await orig<typeof import('../../lib/hostHelper')>()),
  getWifiNetworks: helper.getWifiNetworks,
  joinWifi: helper.joinWifi,
}));

import NetworkModal, { WIFI_LIST_MS } from './NetworkModal';

const NETWORKS = {
  networks: [
    { ssid: 'CSG-Ops', signal: 72, secure: true, active: true },
    { ssid: 'Lobby', signal: 40, secure: false, active: false },
  ],
  wired: { connected: false, device: 'enp0s31f6' },
};

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (v: DocumentVisibilityState) => {
  visibility = v;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
};

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  helper.getWifiNetworks.mockReset().mockResolvedValue(NETWORKS);
  helper.joinWifi.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const renderModal = () => render(<NetworkModal onClose={() => {}} onChanged={() => {}} />);

it('lists again every 15 s', async () => {
  renderModal();
  await flush();
  expect(helper.getWifiNetworks).toHaveBeenCalledTimes(1);
  expect(WIFI_LIST_MS).toBe(15_000);
  await wait(WIFI_LIST_MS - 1);
  expect(helper.getWifiNetworks).toHaveBeenCalledTimes(1);
  await wait(1);
  expect(helper.getWifiNetworks).toHaveBeenCalledTimes(2);
  await wait(WIFI_LIST_MS);
  expect(helper.getWifiNetworks).toHaveBeenCalledTimes(3);
});

it('a slow list never overlaps the next one: the 15 s start after it settles', async () => {
  let answer!: (v: typeof NETWORKS) => void;
  helper.getWifiNetworks.mockReturnValueOnce(new Promise((r) => { answer = r; }));
  renderModal();
  await flush();
  await wait(WIFI_LIST_MS * 3);                     // a rescan that takes 45 s
  expect(helper.getWifiNetworks).toHaveBeenCalledTimes(1);
  await act(async () => { answer(NETWORKS); });
  await wait(WIFI_LIST_MS - 1);
  expect(helper.getWifiNetworks).toHaveBeenCalledTimes(1);
  await wait(1);
  expect(helper.getWifiNetworks).toHaveBeenCalledTimes(2);
});

it('does not list while a join is under way', async () => {
  let joined!: (v: { ok: true }) => void;
  helper.joinWifi.mockReturnValueOnce(new Promise((r) => { joined = r; }));
  renderModal();
  await flush();
  const dialog = screen.getByRole('dialog', { name: 'Network' });
  fireEvent.click(within(dialog).getByRole('radio', { name: /Lobby/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Join' }));
  expect(helper.joinWifi).toHaveBeenCalledWith('Lobby', '');
  await wait(WIFI_LIST_MS * 3);
  expect(helper.getWifiNetworks).toHaveBeenCalledTimes(1);
  await act(async () => { joined({ ok: true }); });
  await flush();
  expect(helper.getWifiNetworks).toHaveBeenCalledTimes(2);   // once, right after the join
});

it('stops listing once closed', async () => {
  const { unmount } = renderModal();
  await flush();
  unmount();
  await wait(WIFI_LIST_MS * 3);
  expect(helper.getWifiNetworks).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('pauses while the page is hidden and lists again when it is back', async () => {
  renderModal();
  await flush();
  setVisibility('hidden');
  await wait(WIFI_LIST_MS * 3);
  expect(helper.getWifiNetworks).toHaveBeenCalledTimes(1);
  setVisibility('visible');
  await flush();
  expect(helper.getWifiNetworks).toHaveBeenCalledTimes(2);
  await wait(WIFI_LIST_MS);
  expect(helper.getWifiNetworks).toHaveBeenCalledTimes(3);
});

it('when the first list fails, the wired line does not claim there is no adapter', async () => {
  helper.getWifiNetworks.mockRejectedValueOnce(new Error('down'));
  renderModal();
  await flush();
  const dialog = screen.getByRole('dialog', { name: 'Network' });
  expect(within(dialog).queryByText('No wired adapter')).toBeNull();
  expect(within(dialog).getByText("Couldn't read the wired status.")).toBeTruthy();
  await wait(WIFI_LIST_MS);
  expect(within(dialog).getByText('Not connected (enp0s31f6)')).toBeTruthy();
});

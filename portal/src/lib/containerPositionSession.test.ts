/**
 * The position cache is dropped when the local session is cleared
 * (sign-out does not reload the page), using the real api module.
 */

import { beforeEach, expect, it, vi } from 'vitest';

const getContainerPosition = vi.fn();
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  getContainerPosition: (id: string) => getContainerPosition(id),
}));

const { clearLocalSession } = await import('./api');
const { clearPositionCache, loadContainerPosition } = await import('./containerPosition');

beforeEach(() => {
  clearPositionCache();
  getContainerPosition.mockReset();
  getContainerPosition.mockResolvedValue({ kind: 'none' });
});

it('makes a new request after the local session is cleared', async () => {
  await loadContainerPosition('c1');
  await loadContainerPosition('c1');
  expect(getContainerPosition).toHaveBeenCalledTimes(1);
  clearLocalSession();
  await loadContainerPosition('c1');
  expect(getContainerPosition).toHaveBeenCalledTimes(2);
});

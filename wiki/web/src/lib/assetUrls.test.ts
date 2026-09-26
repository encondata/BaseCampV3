import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./wikiApi', () => ({ getAssetUrls: vi.fn() }));

import { clearAssetUrls, resolveAssetUrl } from './assetUrls';
import { getAssetUrls } from './wikiApi';

const urlsFor = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, `https://s3/${id}`]));
/** A uuid-shaped asset id (the API only takes uuids). */
const u = (n: number | string) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = u(1);
const B = u(2);
const GONE = u(999);

beforeEach(() => {
  vi.useFakeTimers();
  clearAssetUrls();
  vi.mocked(getAssetUrls).mockReset();
  vi.mocked(getAssetUrls).mockImplementation(async (ids) => urlsFor(ids.filter((id) => id !== GONE)));
});
afterEach(() => { vi.useRealTimers(); });

describe('resolveAssetUrl', () => {
  it('batches the ids asked for in the same tick into one request', async () => {
    const all = Promise.all([resolveAssetUrl(A), resolveAssetUrl(B), resolveAssetUrl(A)]);
    await vi.runAllTimersAsync();
    expect(await all).toEqual([`https://s3/${A}`, `https://s3/${B}`, `https://s3/${A}`]);
    expect(getAssetUrls).toHaveBeenCalledTimes(1);
    expect(getAssetUrls).toHaveBeenCalledWith([A, B]);
  });

  it('answers null for an id the API left out (not viewable)', async () => {
    const p = resolveAssetUrl(GONE);
    await vi.runAllTimersAsync();
    expect(await p).toBeNull();
  });

  it('answers null for an id that is not a uuid without asking (it would fail the batch)', async () => {
    const all = Promise.all([resolveAssetUrl('javascript:alert(1)'), resolveAssetUrl(A)]);
    await vi.runAllTimersAsync();
    expect(await all).toEqual([null, `https://s3/${A}`]);
    expect(getAssetUrls).toHaveBeenCalledWith([A]);
  });

  it('caches answers for 8 minutes, then asks again', async () => {
    const first = resolveAssetUrl(A);
    await vi.runAllTimersAsync();
    await first;

    vi.advanceTimersByTime(7 * 60_000);
    const cached = resolveAssetUrl(A);
    await vi.runAllTimersAsync();
    expect(await cached).toBe(`https://s3/${A}`);
    expect(getAssetUrls).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * 60_000);
    const fresh = resolveAssetUrl(A);
    await vi.runAllTimersAsync();
    expect(await fresh).toBe(`https://s3/${A}`);
    expect(getAssetUrls).toHaveBeenCalledTimes(2);
  });

  it('splits more than 200 ids into several requests', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => u(i + 10));
    const all = Promise.all(ids.map((id) => resolveAssetUrl(id)));
    await vi.runAllTimersAsync();
    expect((await all).every((url, i) => url === `https://s3/${ids[i]}`)).toBe(true);
    expect(vi.mocked(getAssetUrls).mock.calls.map(([batch]) => batch.length)).toEqual([200, 200, 50]);
  });

  it('does not cache a failed request', async () => {
    vi.mocked(getAssetUrls).mockRejectedValueOnce(new Error('offline'));
    const failed = resolveAssetUrl(A);
    const caught = failed.catch((e: Error) => e.message);
    await vi.runAllTimersAsync();
    expect(await caught).toBe('offline');

    const retry = resolveAssetUrl(A);
    await vi.runAllTimersAsync();
    expect(await retry).toBe(`https://s3/${A}`);
  });
});

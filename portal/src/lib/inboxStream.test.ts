// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  getFreshAccessTokenForStream: vi.fn(async () => 'tok'),
  refreshSession: vi.fn(async () => ({ ok: true })),
}));

import * as api from './api';
import { INBOX_STREAM_STALE_MS, useInboxStream } from './inboxStream';

class FakeWS {
  static all: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string, public protocols: string[]) {
    FakeWS.all.push(this);
  }
  open() { this.onopen?.(); }
  msg(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
  end(code = 1006) { this.onclose?.({ code }); }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWS.all = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
  vi.mocked(api.getFreshAccessTokenForStream).mockResolvedValue('tok');
  vi.mocked(api.refreshSession).mockClear();
});
afterEach(() => vi.useRealTimers());

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const mount = async (id = 'p1', cb: () => void = vi.fn()) => {
  const r = renderHook(({ i, c }) => useInboxStream(i, c), {
    initialProps: { i: id, c: cb },
  });
  await flush();
  return r;
};

describe('useInboxStream', () => {
  it('opens with ss-bearer protocols and no token in the URL', async () => {
    await mount();
    expect(FakeWS.all).toHaveLength(1);
    expect(FakeWS.all[0].protocols).toEqual(['ss-bearer', 'tok']);
    expect(FakeWS.all[0].url).toMatch(/^ws.*\/notifications\/inbox\/stream$/);
    expect(FakeWS.all[0].url).not.toContain('tok');
  });

  it('calls onChange on open and on each inbox message, not on ping', async () => {
    const onChange = vi.fn();
    await mount('p1', onChange);
    act(() => FakeWS.all[0].open());
    expect(onChange).toHaveBeenCalledTimes(1);
    act(() => FakeWS.all[0].msg({ inbox: true }));
    expect(onChange).toHaveBeenCalledTimes(2);
    act(() => FakeWS.all[0].msg({ ping: true }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('returns true while open and false after close', async () => {
    const { result } = await mount();
    expect(result.current).toBe(false);
    act(() => FakeWS.all[0].open());
    expect(result.current).toBe(true);
    await act(async () => { FakeWS.all[0].end(); });
    expect(result.current).toBe(false);
  });

  it('reconnects with backoff 1 s then 2 s', async () => {
    await mount();
    await act(async () => { FakeWS.all[0].end(); });
    await tick(999);
    expect(FakeWS.all).toHaveLength(1);
    await tick(1);
    expect(FakeWS.all).toHaveLength(2);
    await act(async () => { FakeWS.all[1].end(); });
    await tick(1999);
    expect(FakeWS.all).toHaveLength(2);
    await tick(1);
    expect(FakeWS.all).toHaveLength(3);
  });

  it('retries after backoff when there is no token', async () => {
    vi.mocked(api.getFreshAccessTokenForStream).mockResolvedValue(null);
    await mount();
    expect(FakeWS.all).toHaveLength(0);
    vi.mocked(api.getFreshAccessTokenForStream).mockResolvedValue('tok');
    await tick(1000);
    expect(FakeWS.all).toHaveLength(1);
  });

  it('waits for the fresh token before constructing the socket', async () => {
    let release: (t: string) => void = () => {};
    vi.mocked(api.getFreshAccessTokenForStream).mockReturnValueOnce(
      new Promise<string>((r) => { release = r; }),
    );
    await mount();
    expect(FakeWS.all).toHaveLength(0);
    await act(async () => { release('fresh'); });
    expect(FakeWS.all).toHaveLength(1);
    expect(FakeWS.all[0].protocols).toEqual(['ss-bearer', 'fresh']);
  });

  it('on 4401 after a stable connection refreshes then reconnects at once', async () => {
    await mount();
    act(() => FakeWS.all[0].open());
    await tick(6000);
    await act(async () => { FakeWS.all[0].end(4401); });
    expect(api.refreshSession).toHaveBeenCalledTimes(1);
    expect(FakeWS.all).toHaveLength(2);
  });

  it('two quick 4401 closes: the second waits for backoff', async () => {
    await mount();
    await act(async () => { FakeWS.all[0].end(4401); });
    expect(api.refreshSession).toHaveBeenCalledTimes(1);
    expect(FakeWS.all).toHaveLength(1);
    await tick(1000);
    expect(FakeWS.all).toHaveLength(2);
    act(() => FakeWS.all[1].open());
    await act(async () => { FakeWS.all[1].end(4401); });
    expect(FakeWS.all).toHaveLength(2);
    // the open was not stable, so the backoff keeps growing: 2 s, not 1 s
    await tick(1999);
    expect(FakeWS.all).toHaveLength(2);
    await tick(1);
    expect(FakeWS.all).toHaveLength(3);
  });

  it('an open-then-drop loop keeps growing the backoff', async () => {
    await mount();
    await act(async () => { FakeWS.all[0].end(); });
    for (const [i, wait] of [[1, 1000], [2, 2000], [3, 4000]] as const) {
      await tick(wait - 1);
      expect(FakeWS.all).toHaveLength(i);
      await tick(1);
      expect(FakeWS.all).toHaveLength(i + 1);
      act(() => FakeWS.all[i].open());
      await tick(100);
      await act(async () => { FakeWS.all[i].end(); });
    }
    await tick(7999);
    expect(FakeWS.all).toHaveLength(4);
    await tick(1);
    expect(FakeWS.all).toHaveLength(5);
  });

  it('a stable socket that drops resets the backoff to 1 s', async () => {
    await mount();
    await act(async () => { FakeWS.all[0].end(); });
    await tick(1000);
    await act(async () => { FakeWS.all[1].end(); });
    await tick(2000);
    expect(FakeWS.all).toHaveLength(3);
    act(() => FakeWS.all[2].open());
    await tick(5000);
    await act(async () => { FakeWS.all[2].end(); });
    await tick(999);
    expect(FakeWS.all).toHaveLength(3);
    await tick(1);
    expect(FakeWS.all).toHaveLength(4);
  });

  it('closes a socket that has gone silent and reconnects', async () => {
    const { result } = await mount();
    const ws = FakeWS.all[0];
    act(() => ws.open());
    // pings keep it alive past the stale window
    await tick(INBOX_STREAM_STALE_MS - 1000);
    act(() => ws.msg({ ping: true }));
    await tick(INBOX_STREAM_STALE_MS - 1000);
    expect(ws.close).not.toHaveBeenCalled();
    expect(result.current).toBe(true);
    // then nothing at all for the whole window
    await tick(1000);
    expect(ws.close).toHaveBeenCalled();
    expect(result.current).toBe(false);
    // it had been up long enough to count as stable: retry after 1 s
    await tick(1000);
    expect(FakeWS.all).toHaveLength(2);
    // the late close event of the dead socket changes nothing
    await act(async () => { ws.end(); });
    await tick(30_000);
    expect(FakeWS.all).toHaveLength(2);
  });

  it('backs off when 4401 refresh finds no session', async () => {
    vi.mocked(api.refreshSession).mockResolvedValueOnce(null);
    await mount();
    act(() => FakeWS.all[0].open());
    await tick(6000);
    await act(async () => { FakeWS.all[0].end(4401); });
    expect(FakeWS.all).toHaveLength(1);
    await tick(1000);
    expect(FakeWS.all).toHaveLength(2);
  });

  it('closes and stops reconnecting on unmount', async () => {
    const { unmount } = await mount();
    const ws = FakeWS.all[0];
    unmount();
    expect(ws.close).toHaveBeenCalled();
    await tick(60_000);
    expect(FakeWS.all).toHaveLength(1);
  });

  it('closes and reconnects fresh when personId changes', async () => {
    const { rerender } = await mount();
    const first = FakeWS.all[0];
    rerender({ i: 'p2', c: vi.fn() });
    await flush();
    expect(first.close).toHaveBeenCalled();
    expect(FakeWS.all).toHaveLength(2);
  });

  it('does not reconnect when only the callback changes', async () => {
    const { rerender } = await mount();
    rerender({ i: 'p1', c: vi.fn() });
    await flush();
    expect(FakeWS.all).toHaveLength(1);
  });
});

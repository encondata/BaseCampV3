// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  getFreshAccessTokenForStream: vi.fn(async () => 'tok'),
  refreshSession: vi.fn(async () => ({ ok: true })),
}));

import * as api from './api';
import { useInboxStream } from './inboxStream';

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
    await tick(1000);
    expect(FakeWS.all).toHaveLength(3);
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

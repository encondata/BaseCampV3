// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  getAccessTokenForStream: vi.fn(() => 'tok'),
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
  vi.mocked(api.getAccessTokenForStream).mockReturnValue('tok');
  vi.mocked(api.refreshSession).mockClear();
});
afterEach(() => vi.useRealTimers());

describe('useInboxStream', () => {
  it('opens with ss-bearer protocols and no token in the URL', () => {
    renderHook(() => useInboxStream('p1', vi.fn()));
    expect(FakeWS.all).toHaveLength(1);
    expect(FakeWS.all[0].protocols).toEqual(['ss-bearer', 'tok']);
    expect(FakeWS.all[0].url).toMatch(/^ws.*\/notifications\/inbox\/stream$/);
    expect(FakeWS.all[0].url).not.toContain('tok');
  });

  it('calls onChange on open and on each inbox message, not on ping', () => {
    const onChange = vi.fn();
    renderHook(() => useInboxStream('p1', onChange));
    act(() => FakeWS.all[0].open());
    expect(onChange).toHaveBeenCalledTimes(1);
    act(() => FakeWS.all[0].msg({ inbox: true }));
    expect(onChange).toHaveBeenCalledTimes(2);
    act(() => FakeWS.all[0].msg({ ping: true }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('returns true while open and false after close', () => {
    const { result } = renderHook(() => useInboxStream('p1', vi.fn()));
    expect(result.current).toBe(false);
    act(() => FakeWS.all[0].open());
    expect(result.current).toBe(true);
    act(() => FakeWS.all[0].end());
    expect(result.current).toBe(false);
  });

  it('reconnects with backoff 1 s then 2 s', () => {
    renderHook(() => useInboxStream('p1', vi.fn()));
    act(() => FakeWS.all[0].end());
    act(() => { vi.advanceTimersByTime(999); });
    expect(FakeWS.all).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(FakeWS.all).toHaveLength(2);
    act(() => FakeWS.all[1].end());
    act(() => { vi.advanceTimersByTime(1999); });
    expect(FakeWS.all).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(1); });
    expect(FakeWS.all).toHaveLength(3);
  });

  it('retries after backoff when there is no token', () => {
    vi.mocked(api.getAccessTokenForStream).mockReturnValue(null);
    renderHook(() => useInboxStream('p1', vi.fn()));
    expect(FakeWS.all).toHaveLength(0);
    vi.mocked(api.getAccessTokenForStream).mockReturnValue('tok');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(FakeWS.all).toHaveLength(1);
  });

  it('on 4401 calls refreshSession before reconnecting', async () => {
    renderHook(() => useInboxStream('p1', vi.fn()));
    await act(async () => { FakeWS.all[0].end(4401); });
    expect(api.refreshSession).toHaveBeenCalledTimes(1);
    expect(FakeWS.all).toHaveLength(2);
  });

  it('backs off when 4401 refresh finds no session', async () => {
    vi.mocked(api.refreshSession).mockResolvedValueOnce(null);
    renderHook(() => useInboxStream('p1', vi.fn()));
    await act(async () => { FakeWS.all[0].end(4401); });
    expect(FakeWS.all).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(FakeWS.all).toHaveLength(2);
  });

  it('closes and stops reconnecting on unmount', () => {
    const { unmount } = renderHook(() => useInboxStream('p1', vi.fn()));
    const ws = FakeWS.all[0];
    unmount();
    expect(ws.close).toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(FakeWS.all).toHaveLength(1);
  });

  it('closes and reconnects fresh when personId changes', () => {
    const { rerender } = renderHook(
      ({ id }) => useInboxStream(id, vi.fn()),
      { initialProps: { id: 'p1' } },
    );
    const first = FakeWS.all[0];
    rerender({ id: 'p2' });
    expect(first.close).toHaveBeenCalled();
    expect(FakeWS.all).toHaveLength(2);
  });

  it('does not reconnect when only the callback changes', () => {
    const { rerender } = renderHook(
      ({ cb }) => useInboxStream('p1', cb),
      { initialProps: { cb: vi.fn() } },
    );
    rerender({ cb: vi.fn() });
    expect(FakeWS.all).toHaveLength(1);
  });
});

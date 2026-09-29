// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  recordView: vi.fn(),
}));

import { recordView } from '../lib/wikiApi';
import { useRecordView, VIEW_DWELL_MS } from './useRecordView';

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(recordView).mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function wait(ms: number) {
  act(() => { vi.advanceTimersByTime(ms); });
}

describe('useRecordView', () => {
  it('records one view once the reader has stayed a moment', () => {
    const { rerender } = renderHook(({ id }) => useRecordView(id, true), { initialProps: { id: 'p1' } });
    wait(VIEW_DWELL_MS - 1);
    expect(recordView).not.toHaveBeenCalled();
    wait(1);
    expect(recordView).toHaveBeenCalledTimes(1);
    expect(recordView).toHaveBeenCalledWith('p1');
    // re-renders of the same page don't count again
    rerender({ id: 'p1' });
    wait(VIEW_DWELL_MS * 3);
    expect(recordView).toHaveBeenCalledTimes(1);
  });

  it('counts once under StrictMode', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    renderHook(() => useRecordView('p1', true), { wrapper });
    wait(VIEW_DWELL_MS);
    expect(recordView).toHaveBeenCalledTimes(1);
  });

  it('records nothing for a page left before the dwell', () => {
    const { unmount } = renderHook(() => useRecordView('p1', true));
    wait(VIEW_DWELL_MS / 2);
    unmount();
    wait(VIEW_DWELL_MS);
    expect(recordView).not.toHaveBeenCalled();
  });

  it('records nothing for a page that opened in edit mode, even after switching to View', () => {
    const { rerender } = renderHook(({ on }) => useRecordView('p1', on), { initialProps: { on: false } });
    wait(VIEW_DWELL_MS);
    rerender({ on: true });
    wait(VIEW_DWELL_MS * 2);
    expect(recordView).not.toHaveBeenCalled();
  });

  it('records the next page shown in the same view', () => {
    const { rerender } = renderHook(({ id }) => useRecordView(id, true), { initialProps: { id: 'p1' } });
    wait(VIEW_DWELL_MS);
    rerender({ id: 'p2' });
    wait(VIEW_DWELL_MS);
    expect(vi.mocked(recordView).mock.calls).toEqual([['p1'], ['p2']]);
  });

  it('swallows a failure — a view is telemetry', async () => {
    vi.mocked(recordView).mockRejectedValue(new Error('offline'));
    renderHook(() => useRecordView('p1', true));
    wait(VIEW_DWELL_MS);
    await act(async () => { await Promise.resolve(); });
    expect(recordView).toHaveBeenCalledTimes(1);
  });
});

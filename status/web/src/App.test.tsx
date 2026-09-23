import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import type { Summary } from './lib/summary';

const summary: Summary = {
  generated_at: '2026-09-23T12:00:00Z',
  overall: 'operational',
  services: ['API', 'Portal', 'Kiosk'].map((name) => ({
    key: name.toLowerCase(), name, state: 'up', last_checked_at: '2026-09-23T12:00:00Z',
    latency_ms: 10, uptime_90d: 100,
    days: Array.from({ length: 90 }, (_, i) => ({ day: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`, ok: 1, total: 1 })),
  })),
};

describe('App', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders the three services from /api/summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(summary)));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByText('All systems operational')).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['API', 'Portal', 'Kiosk']);
    expect(fetchMock).toHaveBeenCalledWith('/api/summary', expect.objectContaining({ cache: 'no-store' }));
  });

  it('keeps last data and warns when a refresh fails — never fakes green', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(summary)))
      .mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByText('All systems operational');
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(await screen.findByText(/Status data may be stale/)).toBeTruthy();
    expect(screen.getByText('All systems operational')).toBeTruthy();
  });

  it('shows an error state when the first load fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })));
    render(<App />);
    expect(await screen.findByText(/Status is unavailable right now/)).toBeTruthy();
    expect(screen.queryByText('All systems operational')).toBeNull();
  });
});

// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useEdgeStatus } from './edgeStatus';

const STATUS = {
  cloud: { online: false, last_contact: null },
  sync: { initiative_id: null, synced_at: null, last_error: null },
  outbox: { queued: 2, sending: 0, sent: 0, rejected: 0, failed: 0, needs_sign_in: 0 },
  waiting: [], session: null, identity: { serial: 's', name: 'n' },
};

afterEach(() => { delete window.__KIOSK_CONFIG__; vi.unstubAllGlobals(); });

describe('useEdgeStatus', () => {
  it('stays null and never fetches outside laptop mode', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useEdgeStatus());
    expect(result.current.status).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads /edge/status in laptop mode', async () => {
    window.__KIOSK_CONFIG__ = { mode: 'laptop', apiUrl: 'http://edge.test' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(STATUS))));
    const { result } = renderHook(() => useEdgeStatus());
    await waitFor(() => expect(result.current.status?.outbox.queued).toBe(2));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.status?.cloud.online).toBe(false);
  });
});

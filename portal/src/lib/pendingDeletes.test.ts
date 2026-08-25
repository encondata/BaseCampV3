// @vitest-environment jsdom
/**
 * usePendingDeletes: the entityId<->markerId bookkeeping that lets callers
 * mark/unmark by entity id even though the API's DELETE takes the marker's
 * own id. Pins two things a page-level integration test can't isolate:
 * markerIdsByEntity's pure reduction, and that the hook never calls the
 * API at all while `enabled` is false (the whole point of gating this on
 * godMode).
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { markerIdsByEntity, usePendingDeletes } from './pendingDeletes';
import type { PendingDeleteItem } from './api';

const api = vi.hoisted(() => ({
  listPendingDeletes: vi.fn(),
  markPendingDelete: vi.fn(),
  unmarkPendingDelete: vi.fn(),
}));

vi.mock('./api', () => ({
  listPendingDeletes: api.listPendingDeletes,
  markPendingDelete: api.markPendingDelete,
  unmarkPendingDelete: api.unmarkPendingDelete,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function item(over: Partial<PendingDeleteItem> = {}): PendingDeleteItem {
  return {
    id: 'marker-1', entity_type: 'site', entity_id: 'ent-1',
    entity_label: 'DA1', marked_by: null, marked_by_name: null,
    marked_at: '2026-01-01T00:00:00Z', ...over,
  };
}

describe('markerIdsByEntity', () => {
  it('reduces the marker list to entityId -> markerId', () => {
    const map = markerIdsByEntity([
      item({ id: 'm1', entity_id: 'e1' }),
      item({ id: 'm2', entity_id: 'e2' }),
    ]);
    expect(map.get('e1')).toBe('m1');
    expect(map.get('e2')).toBe('m2');
    expect(map.size).toBe(2);
  });

  it('returns an empty map for an empty list', () => {
    expect(markerIdsByEntity([]).size).toBe(0);
  });
});

describe('usePendingDeletes', () => {
  it('never calls the API when disabled', async () => {
    const { result } = renderHook(() => usePendingDeletes(false));
    expect(result.current.pendingIds.size).toBe(0);
    await act(async () => { await result.current.refresh(); });
    expect(api.listPendingDeletes).not.toHaveBeenCalled();
  });

  it('fetches once when enabled and exposes the marked entity ids', async () => {
    api.listPendingDeletes.mockResolvedValue([
      item({ id: 'm1', entity_id: 'e1' }),
      item({ id: 'm2', entity_id: 'e2' }),
    ]);
    const { result } = renderHook(() => usePendingDeletes(true));
    await waitFor(() => expect(result.current.pendingIds.size).toBe(2));
    expect(api.listPendingDeletes).toHaveBeenCalledTimes(1);
    expect(result.current.pendingIds.has('e1')).toBe(true);
    expect(result.current.pendingIds.has('e2')).toBe(true);
  });

  it('mark() adds the entity optimistically and records its marker id', async () => {
    api.listPendingDeletes.mockResolvedValue([]);
    api.markPendingDelete.mockResolvedValue(item({ id: 'new-marker', entity_id: 'e3' }));
    const { result } = renderHook(() => usePendingDeletes(true));
    await waitFor(() => expect(api.listPendingDeletes).toHaveBeenCalled());

    await act(async () => { await result.current.mark('site', 'e3', 'DA3'); });

    expect(api.markPendingDelete).toHaveBeenCalledWith('site', 'e3', 'DA3');
    expect(result.current.pendingIds.has('e3')).toBe(true);
  });

  it('unmark() looks up the marker id for the entity and deletes by that id', async () => {
    api.listPendingDeletes.mockResolvedValue([item({ id: 'marker-9', entity_id: 'e9' })]);
    api.unmarkPendingDelete.mockResolvedValue(undefined);
    const { result } = renderHook(() => usePendingDeletes(true));
    await waitFor(() => expect(result.current.pendingIds.has('e9')).toBe(true));

    await act(async () => { await result.current.unmark('e9'); });

    expect(api.unmarkPendingDelete).toHaveBeenCalledWith('marker-9');
    expect(result.current.pendingIds.has('e9')).toBe(false);
  });

  it('unmark() on an id with no tracked marker is a no-op', async () => {
    api.listPendingDeletes.mockResolvedValue([]);
    const { result } = renderHook(() => usePendingDeletes(true));
    await waitFor(() => expect(api.listPendingDeletes).toHaveBeenCalled());

    await act(async () => { await result.current.unmark('ghost'); });

    expect(api.unmarkPendingDelete).not.toHaveBeenCalled();
  });
});

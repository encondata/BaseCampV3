import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./wikiApi', () => ({ getTree: vi.fn() }));

import { makeNode } from '../testing/fixtures';
import {
  getSnapshot, loadChildren, noteChanged, noteCreated, noteMoved, resetTreeStore, subscribe,
} from './treeStore';
import { getTree } from './wikiApi';

const getTreeMock = vi.mocked(getTree);

function children(spaceKey: string, parentId: string | null) {
  return getSnapshot().entries.get(`${spaceKey}:${parentId ?? ''}`);
}

beforeEach(() => {
  resetTreeStore();
  getTreeMock.mockReset();
});

describe('treeStore', () => {
  it('caches children per parent and fetches each parent once', async () => {
    getTreeMock.mockResolvedValue([makeNode('a')]);
    await loadChildren('ops', null);
    await loadChildren('ops', null);
    expect(getTreeMock).toHaveBeenCalledTimes(1);
    expect(getTreeMock).toHaveBeenCalledWith('ops', null);
    expect(children('ops', null)?.nodes?.map((n) => n.id)).toEqual(['a']);
  });

  it('notifies subscribers and bumps the revision on changes', async () => {
    const listener = vi.fn();
    const off = subscribe(listener);
    getTreeMock.mockResolvedValue([]);
    const before = getSnapshot().revision;
    noteCreated(makeNode('new', { parent_id: 'f1' }));
    expect(getSnapshot().revision).toBe(before + 1);
    expect(listener).toHaveBeenCalled();
    off();
  });

  it('refetches the new parent after a create, only when it is cached', async () => {
    getTreeMock.mockResolvedValue([]);
    await loadChildren('ops', 'f1');
    getTreeMock.mockClear();
    getTreeMock.mockResolvedValue([makeNode('new', { parent_id: 'f1' })]);
    noteCreated(makeNode('new', { parent_id: 'f1' }));
    noteCreated(makeNode('other', { parent_id: 'uncached' }));
    await vi.waitFor(() => expect(children('ops', 'f1')?.nodes?.map((n) => n.id)).toEqual(['new']));
    expect(getTreeMock).toHaveBeenCalledTimes(1);
    expect(getTreeMock).toHaveBeenCalledWith('ops', 'f1');
  });

  it('refetches both the old and the new parent after a move', async () => {
    getTreeMock.mockImplementation(async (_key, parentId) =>
      (parentId === 'f1' ? [makeNode('x', { parent_id: 'f1' })] : []));
    await loadChildren('ops', 'f1');
    await loadChildren('ops', 'f2');
    getTreeMock.mockClear();
    getTreeMock.mockImplementation(async (_key, parentId) =>
      (parentId === 'f2' ? [makeNode('x', { parent_id: 'f2' })] : []));

    noteMoved(makeNode('x', { parent_id: 'f2' }), { spaceKey: 'ops', parentId: 'f1' });

    await vi.waitFor(() => {
      expect(children('ops', 'f1')?.nodes).toEqual([]);
      expect(children('ops', 'f2')?.nodes?.map((n) => n.id)).toEqual(['x']);
    });
    expect(getTreeMock.mock.calls.map((c) => c[1]).sort()).toEqual(['f1', 'f2']);
  });

  it('patches a renamed node in place before the refetch lands', async () => {
    getTreeMock.mockResolvedValue([makeNode('x', { title: 'Old' })]);
    await loadChildren('ops', null);
    getTreeMock.mockReturnValue(new Promise(() => {}));   // refetch never lands
    noteChanged(makeNode('x', { title: 'New' }));
    expect(children('ops', null)?.nodes?.[0].title).toBe('New');
  });

  it('keeps only the latest response when fetches overlap', async () => {
    let first!: (v: ReturnType<typeof makeNode>[]) => void;
    getTreeMock.mockReturnValueOnce(new Promise((r) => { first = r; }));
    const p1 = loadChildren('ops', null);
    getTreeMock.mockResolvedValueOnce([makeNode('fresh')]);
    await loadChildren('ops', null, true);
    first([makeNode('stale')]);
    await p1;
    expect(children('ops', null)?.nodes?.map((n) => n.id)).toEqual(['fresh']);
  });
});

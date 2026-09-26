// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getTree: vi.fn(),
  moveNode: vi.fn(),
  updateNode: vi.fn(),
}));
vi.mock('../uploads/uploadQueue', () => ({ enqueueWalked: vi.fn() }));

import { ApiError } from '@portal/lib/api';

import { resetTreeStore } from '../lib/treeStore';
import type { NodeOut } from '../lib/types';
import { getTree, moveNode } from '../lib/wikiApi';
import { makeNode, makeSpace } from '../testing/fixtures';
import { enqueueWalked } from '../uploads/uploadQueue';
import SpaceTree from './SpaceTree';

const getTreeMock = vi.mocked(getTree);
const moveMock = vi.mocked(moveNode);

const ROOT: NodeOut[] = [
  makeNode('f1', { kind: 'folder', title: 'Guides', has_children: true, position: 1 }),
  makeNode('p1', { title: 'Intro', position: 2 }),
  makeNode('p2', { title: 'Checklist', position: 3 }),
];
const IN_F1: NodeOut[] = [
  makeNode('c1', { kind: 'folder', title: 'Racks', parent_id: 'f1' }),
];

beforeEach(() => {
  resetTreeStore();
  localStorage.clear();
  getTreeMock.mockReset();
  getTreeMock.mockImplementation(async (_key, parentId) => (parentId === 'f1' ? IN_F1 : parentId ? [] : ROOT));
  moveMock.mockReset();
  toast.mockReset();
});
afterEach(cleanup);

function renderTree() {
  const handlers = {
    onNewChild: vi.fn(),
  };
  const utils = render(
    <MemoryRouter>
      <SpaceTree space={makeSpace()} activeId={null} {...handlers} />
    </MemoryRouter>,
  );
  return { ...utils, handlers };
}

function row(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
  if (!el) throw new Error(`no row ${id}`);
  // jsdom has no layout: every row is 40px tall at the top of the viewport
  el.getBoundingClientRect = () => ({
    top: 0, bottom: 40, height: 40, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON: () => ({}),
  });
  return el;
}

/** jsdom has no DragEvent; React only needs the event type, clientY and a dataTransfer. */
function drag(type: 'dragstart' | 'dragover' | 'drop' | 'dragend', el: HTMLElement, clientY = 0) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(ev, 'dataTransfer', {
    value: { setData: () => {}, getData: () => '', types: [], effectAllowed: 'all', dropEffect: 'none' },
  });
  act(() => { el.dispatchEvent(ev); });
  return ev;
}

/** A drag of files from the operating system (no row is being dragged). */
function fileDrag(type: 'dragover' | 'drop', el: HTMLElement, files: File[]) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: 5 });
  Object.defineProperty(ev, 'dataTransfer', {
    value: { types: ['Files'], items: [], files, dropEffect: 'none' },
  });
  act(() => { el.dispatchEvent(ev); });
  return ev;
}

async function dragOnto(source: string, target: string, clientY: number) {
  drag('dragstart', row(source));
  const over = drag('dragover', row(target), clientY);
  drag('drop', row(target), clientY);
  drag('dragend', row(source));
  return over;
}

describe('SpaceTree', () => {
  it('loads a folder\'s children only when it is expanded, and remembers the expansion', async () => {
    renderTree();
    expect(await screen.findByText('Guides')).toBeTruthy();
    expect(getTreeMock).toHaveBeenCalledWith('ops', null);
    expect(getTreeMock).not.toHaveBeenCalledWith('ops', 'f1');

    fireEvent.click(screen.getByRole('button', { name: 'Expand Guides' }));
    expect(await screen.findByText('Racks')).toBeTruthy();
    expect(getTreeMock).toHaveBeenCalledWith('ops', 'f1');
    expect(JSON.parse(localStorage.getItem('ss.wiki.expanded.ops')!)).toEqual(['f1']);

    // a fresh visit (empty cache) reopens it without a click
    cleanup();
    resetTreeStore();
    getTreeMock.mockClear();
    renderTree();
    expect(await screen.findByText('Racks')).toBeTruthy();
    expect(getTreeMock).toHaveBeenCalledWith('ops', 'f1');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Guides' }));
    expect(screen.queryByText('Racks')).toBeNull();
    expect(JSON.parse(localStorage.getItem('ss.wiki.expanded.ops')!)).toEqual([]);
  });

  it('survives unreadable storage', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    renderTree();
    expect(await screen.findByText('Guides')).toBeTruthy();
    spy.mockRestore();
  });

  it('drops into a folder through the middle of its row', async () => {
    moveMock.mockResolvedValue(makeNode('p2', { title: 'Checklist', parent_id: 'f1' }));
    renderTree();
    await screen.findByText('Guides');
    getTreeMock.mockClear();

    const over = await dragOnto('p2', 'f1', 20);
    expect(over.defaultPrevented).toBe(true);   // the drop is allowed
    await vi.waitFor(() => expect(moveMock).toHaveBeenCalledWith('p2', { parent_id: 'f1' }));
    // the old parent (the space root) and the new one (now expanded) are refreshed
    await vi.waitFor(() => {
      expect(getTreeMock).toHaveBeenCalledWith('ops', null);
      expect(getTreeMock).toHaveBeenCalledWith('ops', 'f1');
    });
  });

  it('drops before a sibling through the top quarter of its row', async () => {
    moveMock.mockResolvedValue(makeNode('p2', { title: 'Checklist' }));
    renderTree();
    await screen.findByText('Intro');
    await dragOnto('p2', 'p1', 5);
    await vi.waitFor(() =>
      expect(moveMock).toHaveBeenCalledWith('p2', { parent_id: null, before_id: 'p1' }));
  });

  it('drops after a sibling through the bottom quarter of its row', async () => {
    moveMock.mockResolvedValue(makeNode('p1', { title: 'Intro' }));
    renderTree();
    await screen.findByText('Intro');
    await dragOnto('p1', 'p2', 36);
    await vi.waitFor(() =>
      expect(moveMock).toHaveBeenCalledWith('p1', { parent_id: null, after_id: 'p2' }));
  });

  it('shows a drop indicator while dragging over a row', async () => {
    renderTree();
    await screen.findByText('Intro');
    drag('dragstart', row('p2'));
    drag('dragover', row('p1'), 5);
    expect(row('p1').getAttribute('data-drop')).toBe('before');
    drag('dragover', row('f1'), 20);
    expect(row('f1').getAttribute('data-drop')).toBe('into');
    expect(row('p1').getAttribute('data-drop')).toBeNull();
    drag('dragend', row('p2'));
    expect(row('f1').getAttribute('data-drop')).toBeNull();
  });

  it('refuses to drop a folder onto itself or its own descendant', async () => {
    localStorage.setItem('ss.wiki.expanded.ops', JSON.stringify(['f1']));
    renderTree();
    await screen.findByText('Racks');

    const intoChild = await dragOnto('f1', 'c1', 20);
    expect(intoChild.defaultPrevented).toBe(false);
    const ontoSelf = await dragOnto('f1', 'f1', 20);
    expect(ontoSelf.defaultPrevented).toBe(false);
    const beforeChild = await dragOnto('f1', 'c1', 2);
    expect(beforeChild.defaultPrevented).toBe(false);
    expect(moveMock).not.toHaveBeenCalled();
  });

  it('toasts the server\'s refusal and refetches', async () => {
    moveMock.mockRejectedValue(new ApiError(422, 'bad_parent', undefined, 'A file can\'t hold other items.'));
    renderTree();
    await screen.findByText('Intro');
    getTreeMock.mockClear();
    await dragOnto('p2', 'p1', 20);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('A file can\'t hold other items.'));
    await vi.waitFor(() => expect(getTreeMock).toHaveBeenCalledWith('ops', null));
  });

  it('uploads files dropped from the computer onto a folder row', async () => {
    vi.mocked(enqueueWalked).mockReset().mockResolvedValue(undefined);
    renderTree();
    await screen.findByText('Guides');
    const file = new File(['x'], 'rack.pdf');
    const over = fileDrag('dragover', row('f1'), [file]);
    expect(over.defaultPrevented).toBe(true);
    expect(row('f1').getAttribute('data-drop')).toBe('into');
    const drop = fileDrag('drop', row('f1'), [file]);
    expect(drop.defaultPrevented).toBe(true);
    expect(row('f1').getAttribute('data-drop')).toBeNull();
    await vi.waitFor(() => expect(enqueueWalked).toHaveBeenCalledWith(
      [{ path: [], file }], { spaceId: 'space-1', spaceKey: 'ops', parentId: 'f1', label: 'Guides' }, expect.any(Function)));
    expect(moveMock).not.toHaveBeenCalled();
  });

  it('takes no file drop on a page row or a folder the user can\'t edit', async () => {
    vi.mocked(enqueueWalked).mockReset();
    getTreeMock.mockImplementation(async () => [
      makeNode('ro', { kind: 'folder', title: 'Read only', my_level: 'view' }),
      makeNode('p1', { title: 'Intro' }),
    ]);
    renderTree();
    await screen.findByText('Intro');
    for (const id of ['ro', 'p1']) {
      expect(fileDrag('dragover', row(id), [new File(['x'], 'x')]).defaultPrevented).toBe(false);
      expect(row(id).getAttribute('data-drop')).toBeNull();
      fileDrag('drop', row(id), [new File(['x'], 'x')]);
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(enqueueWalked).not.toHaveBeenCalled();
  });

  it('never lets a view-only row be dragged', async () => {
    getTreeMock.mockImplementation(async () => [makeNode('ro', { title: 'Read only', my_level: 'view' })]);
    renderTree();
    await screen.findByText('Read only');
    expect(row('ro').getAttribute('draggable')).toBe('false');
  });
});

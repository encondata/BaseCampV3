import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@portal/lib/api';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  startUpload: vi.fn(),
  completeUpload: vi.fn(),
  createNode: vi.fn(),
}));
vi.mock('../lib/treeStore', () => ({ noteCreated: vi.fn(), noteChanged: vi.fn() }));

import { noteChanged, noteCreated } from '../lib/treeStore';
import type { NodeCreateIn, UploadStartIn } from '../lib/types';
import { completeUpload, createNode, startUpload } from '../lib/wikiApi';
import { FakeXhr } from '../testing/fakeXhr';
import { makeNode } from '../testing/fixtures';
import {
  cancel, clearDone, dismiss, enqueue, enqueueWalked, getSnapshot, MAX_PARALLEL, resetUploadQueue, retry,
  subscribe, type UploadItem,
} from './uploadQueue';

const TARGET = { kind: 'node' as const, spaceId: 'space-1', parentId: 'f1', label: 'Guides' };
const files = (...names: string[]) => names.map((n) => new File([n], n, { type: 'text/plain' }));
const statuses = () => getSnapshot().map((i) => i.status);
const item = (id: string) => getSnapshot().find((i) => i.id === id) as UploadItem;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetUploadQueue();
  FakeXhr.reset();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  let n = 0;
  vi.mocked(startUpload).mockReset().mockImplementation(async (body: UploadStartIn) => {
    n += 1;
    return { upload_id: `up-${n}`, url: `https://s3/put/${body.filename}`, headers: { 'Content-Type': body.content_type } };
  });
  vi.mocked(completeUpload).mockReset().mockImplementation(async (uploadId: string) =>
    makeNode(`node-${uploadId}`, { kind: 'file', parent_id: 'f1', page: null }));
  vi.mocked(createNode).mockReset();
  vi.mocked(noteCreated).mockReset();
  vi.mocked(noteChanged).mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('uploadQueue', () => {
  it('uploads three at a time, reporting progress, then completes and refreshes the tree', async () => {
    const seen: number[] = [];
    const unsubscribe = subscribe(() => seen.push(getSnapshot().length));
    const ids = enqueue(files('a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'), TARGET);
    expect(ids).toHaveLength(5);
    expect(MAX_PARALLEL).toBe(3);
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(3));
    expect(statuses()).toEqual(['uploading', 'uploading', 'uploading', 'queued', 'queued']);
    expect(seen.length).toBeGreaterThan(0);

    expect(startUpload).toHaveBeenCalledWith({
      target: 'node', space_id: 'space-1', parent_id: 'f1', filename: 'a.txt', content_type: 'text/plain', size: 5,
    });
    const [xa] = FakeXhr.instances;
    expect(xa.method).toBe('PUT');
    expect(xa.url).toBe('https://s3/put/a.txt');
    expect(xa.headers).toEqual({ 'Content-Type': 'text/plain' });
    expect(xa.body).toBe(item(ids[0]).file);

    xa.progress(2, 5);
    expect(item(ids[0]).progress).toBeCloseTo(0.4);

    xa.respond(200);
    await vi.waitFor(() => expect(item(ids[0]).status).toBe('done'));
    expect(completeUpload).toHaveBeenCalledWith('up-1');
    expect(item(ids[0]).result?.id).toBe('node-up-1');
    expect(item(ids[0]).progress).toBe(1);
    expect(noteCreated).toHaveBeenCalledWith(item(ids[0]).result);
    // a slot freed up: the fourth starts, the fifth still waits
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(4));
    expect(statuses()).toEqual(['done', 'uploading', 'uploading', 'uploading', 'queued']);
    unsubscribe();
  });

  it('shows "completing" between the storage PUT and the server confirming', async () => {
    let finish!: (n: ReturnType<typeof makeNode>) => void;
    vi.mocked(completeUpload).mockImplementation(() => new Promise((r) => { finish = r; }));
    const [id] = enqueue(files('a.txt'), TARGET);
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    FakeXhr.instances[0].respond(200);
    await vi.waitFor(() => expect(item(id).status).toBe('completing'));
    cancel(id); // too late to cancel: the file is already stored
    expect(item(id).status).toBe('completing');
    finish(makeNode('n1', { kind: 'file', page: null }));
    await vi.waitFor(() => expect(item(id).status).toBe('done'));
  });

  it('marks a failed upload with the reason, and retries it on request', async () => {
    const [id] = enqueue(files('a.txt'), TARGET);
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    FakeXhr.instances[0].fail();
    await vi.waitFor(() => expect(item(id).status).toBe('error'));
    expect(item(id).error).toBe('The upload failed: a network error.');

    retry(id);
    // a slot is free, so it starts again straight away
    expect(item(id)).toMatchObject({ status: 'uploading', progress: 0, error: undefined });
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(2));
    FakeXhr.instances[1].respond(200);
    await vi.waitFor(() => expect(item(id).status).toBe('done'));
    expect(startUpload).toHaveBeenCalledTimes(2);
  });

  it('carries the server\'s refusal as the error', async () => {
    vi.mocked(startUpload).mockRejectedValueOnce(
      new ApiError(413, 'too_large', undefined, 'Files are limited to 1073741824 bytes.'));
    const [id] = enqueue(files('huge.iso'), TARGET);
    await vi.waitFor(() => expect(item(id).status).toBe('error'));
    expect(item(id).error).toBe('Files are limited to 1073741824 bytes.');
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('cancels an upload in flight (aborting the PUT) and one still waiting', async () => {
    const ids = enqueue(files('a', 'b', 'c', 'd', 'e'), TARGET);
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(3));
    cancel(ids[4]);
    expect(item(ids[4])).toMatchObject({ status: 'error', error: 'Canceled.' });

    cancel(ids[0]);
    expect(FakeXhr.instances[0].aborted).toBe(true);
    await vi.waitFor(() => expect(item(ids[0])).toMatchObject({ status: 'error', error: 'Canceled.' }));
    // its slot goes to the next waiting file, never the canceled one
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(4));
    await flush();
    expect(FakeXhr.instances).toHaveLength(4);
    expect(statuses()).toEqual(['error', 'uploading', 'uploading', 'uploading', 'error']);
    expect(completeUpload).not.toHaveBeenCalled();
  });

  it('cancels while the upload is still being started', async () => {
    let started!: (v: Awaited<ReturnType<typeof startUpload>>) => void;
    vi.mocked(startUpload).mockImplementationOnce(() => new Promise((r) => { started = r; }));
    const [id] = enqueue(files('a.txt'), TARGET);
    await vi.waitFor(() => expect(startUpload).toHaveBeenCalled());
    cancel(id);
    started({ upload_id: 'up-x', url: 'https://s3/x', headers: {} });
    await flush();
    expect(item(id)).toMatchObject({ status: 'error', error: 'Canceled.' });
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('clears finished uploads and dismisses failed ones', async () => {
    const ids = enqueue(files('a', 'b'), TARGET);
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(2));
    FakeXhr.instances[0].respond(200);
    FakeXhr.instances[1].respond(500);
    await vi.waitFor(() => expect(statuses()).toEqual(['done', 'error']));
    clearDone();
    expect(getSnapshot().map((i) => i.id)).toEqual([ids[1]]);
    dismiss(ids[1]);
    expect(getSnapshot()).toEqual([]);
  });

  it('uploads a new version of a file', async () => {
    const [id] = enqueue(files('v2.pdf'), { kind: 'version', nodeId: 'file-1', label: 'plan.pdf' });
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    expect(startUpload).toHaveBeenCalledWith({
      target: 'version', node_id: 'file-1', filename: 'v2.pdf', content_type: 'text/plain', size: 6,
    });
    FakeXhr.instances[0].respond(200);
    await vi.waitFor(() => expect(item(id).status).toBe('done'));
    expect(noteChanged).toHaveBeenCalledWith(item(id).result);
    expect(noteCreated).not.toHaveBeenCalled();
  });

  it('sends a typeless file as application/octet-stream', async () => {
    enqueue([new File(['x'], 'blob.bin')], TARGET);
    await vi.waitFor(() => expect(startUpload).toHaveBeenCalled());
    expect(vi.mocked(startUpload).mock.calls[0][0].content_type).toBe('application/octet-stream');
  });
});

describe('enqueueWalked', () => {
  it('recreates dropped folders level by level, once each, and uploads into them', async () => {
    let n = 0;
    vi.mocked(createNode).mockImplementation(async (body: NodeCreateIn) => {
      n += 1;
      return makeNode(`dir-${n}`, { kind: 'folder', title: body.title, parent_id: body.parent_id, page: null });
    });
    const onError = vi.fn();
    const f = (name: string) => new File([name], name);
    await enqueueWalked([
      { path: [], file: f('loose.txt') },
      { path: ['Site A'], file: f('a1.pdf') },
      { path: ['Site A', 'Photos'], file: f('p1.jpg') },
      { path: ['Site A'], file: f('a2.pdf') },
      { path: ['Site B'], file: f('b1.pdf') },
    ], { spaceId: 'space-1', parentId: 'f1', label: 'Guides' }, onError);

    expect(vi.mocked(createNode).mock.calls.map(([b]) => [b.title, b.parent_id, b.kind, b.space_id])).toEqual([
      ['Site A', 'f1', 'folder', 'space-1'],
      ['Photos', 'dir-1', 'folder', 'space-1'],
      ['Site B', 'f1', 'folder', 'space-1'],
    ]);
    expect(noteCreated).toHaveBeenCalledTimes(3);
    expect(getSnapshot().map((i) => [i.file.name, i.target.kind === 'node' && i.target.parentId, i.target.label]))
      .toEqual([
        ['loose.txt', 'f1', 'Guides'],
        ['a1.pdf', 'dir-1', 'Site A'],
        ['p1.jpg', 'dir-2', 'Photos'],
        ['a2.pdf', 'dir-1', 'Site A'],
        ['b1.pdf', 'dir-3', 'Site B'],
      ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a folder it couldn\'t create and skips the files inside it', async () => {
    vi.mocked(createNode).mockRejectedValue(new ApiError(403, 'forbidden', undefined, 'You need edit access.'));
    const onError = vi.fn();
    await enqueueWalked([
      { path: ['Locked'], file: new File(['x'], 'x.txt') },
      { path: ['Locked', 'Deeper'], file: new File(['y'], 'y.txt') },
      { path: [], file: new File(['z'], 'z.txt') },
    ], { spaceId: 'space-1', parentId: null, label: 'Operations' }, onError);
    expect(createNode).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      'Couldn\'t create the folder “Locked”, so 2 files inside it weren\'t uploaded. You need edit access.');
    expect(getSnapshot().map((i) => i.file.name)).toEqual(['z.txt']);
  });
});

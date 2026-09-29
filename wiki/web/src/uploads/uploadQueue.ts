/** The upload queue behind the tray: a module-level list of uploads
 *  (read it with `useUploads` / `subscribe` + `getSnapshot`), run
 *  MAX_PARALLEL at a time. Each upload is `startUpload` → a PUT straight
 *  to storage with progress (`putUpload`) → `completeUpload`, after which
 *  the tree is told (a new file node, or a file's new version). Uploads
 *  can be canceled while waiting or transferring, retried after a failure,
 *  and cleared once done. `enqueueWalked` recreates dropped folders as
 *  wiki folders first, then uploads each file into its folder. */
import { useSyncExternalStore } from 'react';

import { ApiError } from '@portal/lib/api';

import { PutUploadError, putUpload, UploadAbortedError } from '../lib/putUpload';
import { noteChanged, noteCreated } from '../lib/treeStore';
import type { NodeOut, UploadStartIn } from '../lib/types';
import { completeUpload, createNode, errorMessage, getTree, startUpload } from '../lib/wikiApi';
import type { WalkedFile } from './folderWalk';

export const MAX_PARALLEL = 3;

export type UploadStatus = 'queued' | 'uploading' | 'completing' | 'done' | 'error';

/** Where an upload lands; `label` names it in the tray ("Guides"). */
export type QueueTarget =
  | { kind: 'node'; spaceId: string; parentId: string | null; label: string }
  | { kind: 'version'; nodeId: string; label: string };

export interface UploadItem {
  id: string;
  file: File;
  target: QueueTarget;
  status: UploadStatus;
  /** 0…1 of the bytes sent. */
  progress: number;
  error?: string;
  /** The file node, once done. */
  result?: NodeOut;
}

/** A folder (or the space's top level: `parentId` null) to drop into.
 *  `spaceKey` is only needed for folder drops (`enqueueWalked` looks up
 *  each level's existing children by it); a plain file drop never reads it. */
export interface DropDestination {
  spaceId: string;
  spaceKey?: string;
  parentId: string | null;
  label: string;
}

const CANCELED = 'Canceled.';

let items: readonly UploadItem[] = [];
const listeners = new Set<() => void>();
/** The in-flight run of each uploading item; a run whose controller is no
 *  longer here (canceled, or the queue reset) changes nothing any more. */
const running = new Map<string, AbortController>();
let seq = 0;

function emit(next: readonly UploadItem[]) {
  items = next;
  listeners.forEach((fn) => fn());
}

function update(id: string, patch: Partial<UploadItem>) {
  if (!items.some((i) => i.id === id)) return;
  emit(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getSnapshot(): readonly UploadItem[] {
  return items;
}

export function useUploads(): readonly UploadItem[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}

function startBody(item: UploadItem): UploadStartIn {
  const { file, target } = item;
  const common = { filename: file.name, content_type: file.type || 'application/octet-stream', size: file.size };
  return target.kind === 'node'
    ? { target: 'node', space_id: target.spaceId, parent_id: target.parentId, ...common }
    : { target: 'version', node_id: target.nodeId, ...common };
}

/** A server refusal keeps its own message; a PutUploadError is already
 *  worded for people (a specific storage failure); anything else — a raw
 *  browser error from somewhere else in the chain — is never shown
 *  verbatim, so the tray never leaks something like "Failed to fetch". */
function failure(err: unknown): string {
  if (err instanceof UploadAbortedError) return CANCELED;
  const fallback = 'Upload failed — try again.';
  if (err instanceof ApiError) return errorMessage(err, fallback);
  if (err instanceof PutUploadError) return err.message;
  return fallback;
}

async function run(item: UploadItem, ctl: AbortController) {
  const current = () => running.get(item.id) === ctl;
  try {
    const start = await startUpload(startBody(item));
    if (!current()) return;
    await putUpload(start.url, start.headers, item.file, {
      signal: ctl.signal,
      onProgress: (progress) => { if (current()) update(item.id, { progress }); },
    });
    if (!current()) return;
    update(item.id, { status: 'completing', progress: 1 });
    const result = (await completeUpload(start.upload_id)) as NodeOut;
    if (!current()) return;
    update(item.id, { status: 'done', result });
    if (item.target.kind === 'node') noteCreated(result);
    else noteChanged(result);
  } catch (err) {
    if (current()) update(item.id, { status: 'error', error: failure(err) });
  } finally {
    if (current()) {
      running.delete(item.id);
      pump();
    }
  }
}

function pump() {
  while (running.size < MAX_PARALLEL) {
    const next = items.find((i) => i.status === 'queued');
    if (!next) return;
    const ctl = new AbortController();
    running.set(next.id, ctl);
    update(next.id, { status: 'uploading', progress: 0, error: undefined });
    void run(next, ctl);
  }
}

/** Adds `files` for `target`; returns their ids. */
export function enqueue(files: File[], target: QueueTarget): string[] {
  const added = files.map((file): UploadItem => {
    seq += 1;
    return { id: `upload-${seq}`, file, target, status: 'queued', progress: 0 };
  });
  emit([...items, ...added]);
  pump();
  return added.map((i) => i.id);
}

/** Tries a failed (or canceled) upload again. */
export function retry(id: string): void {
  if (items.find((i) => i.id === id)?.status !== 'error') return;
  update(id, { status: 'queued', progress: 0, error: undefined });
  pump();
}

/** Stops an upload that's waiting or transferring (a finished or
 *  completing one can't be taken back). */
export function cancel(id: string): void {
  const status = items.find((i) => i.id === id)?.status;
  if (status !== 'queued' && status !== 'uploading') return;
  const ctl = running.get(id);
  running.delete(id);
  ctl?.abort();
  update(id, { status: 'error', error: CANCELED });
  pump();
}

/** Removes a failed upload from the list. */
export function dismiss(id: string): void {
  if (items.find((i) => i.id === id)?.status !== 'error') return;
  emit(items.filter((i) => i.id !== id));
}

/** Removes every finished upload from the list. */
export function clearDone(): void {
  if (items.some((i) => i.status === 'done')) emit(items.filter((i) => i.status !== 'done'));
}

/** Uploads dropped files and folders into `dest`: each dropped folder is
 *  created as a wiki folder (once, level by level) before the files in it
 *  are queued. A folder that can't be created is reported through
 *  `onError`, and the files inside it are skipped. */
export async function enqueueWalked(
  walked: WalkedFile[], dest: DropDestination, onError: (message: string) => void,
): Promise<void> {
  /** A folder to upload into (`id` null: the space's top level). */
  type Folder = { id: string | null; label: string };
  const folders = new Map<string, Folder | null>();
  const failed = new Map<string, { name: string; reason: string; count: number }>();
  const keyOf = (path: string[]) => path.join('\u0000');

  for (const { path, file } of walked) {
    let parent: Folder = { id: dest.parentId, label: dest.label };
    let blockedAt: string | null = null;
    for (let depth = 1; depth <= path.length; depth += 1) {
      const key = keyOf(path.slice(0, depth));
      if (!folders.has(key)) {
        const title = path[depth - 1];
        try {
          // a folder with the same name already sitting here (case-
          // insensitively) is reused rather than duplicated — dropping the
          // same tree twice, or into a folder someone already made by hand,
          // shouldn't pile up "Site A", "Site A" siblings
          const siblings = dest.spaceKey ? await getTree(dest.spaceKey, parent.id) : [];
          const existing = siblings.find(
            (n) => n.kind === 'folder' && n.title.toLowerCase() === title.toLowerCase());
          if (existing) {
            folders.set(key, { id: existing.id, label: existing.title });
          } else {
            const node = await createNode({
              space_id: dest.spaceId, parent_id: parent.id, kind: 'folder', title,
            });
            noteCreated(node);
            folders.set(key, { id: node.id, label: node.title });
          }
        } catch (err) {
          folders.set(key, null);
          failed.set(key, { name: title, reason: errorMessage(err, ''), count: 0 });
        }
      }
      const folder: Folder | null | undefined = folders.get(key);
      if (!folder) { blockedAt = key; break; }
      parent = folder;
    }
    if (blockedAt !== null) {
      failed.get(blockedAt)!.count += 1;
      continue;
    }
    enqueue([file], { kind: 'node', spaceId: dest.spaceId, parentId: parent.id, label: parent.label });
  }

  for (const { name, reason, count } of failed.values()) {
    const skipped = count === 1 ? '1 file inside it wasn\'t uploaded' : `${count} files inside it weren't uploaded`;
    onError(`Couldn't create the folder “${name}”, so ${skipped}.${reason ? ` ${reason}` : ''}`);
  }
}

/** Tests only: forget everything (aborting whatever is in flight). */
export function resetUploadQueue(): void {
  running.forEach((ctl) => ctl.abort());
  running.clear();
  items = [];
  seq = 0;
}

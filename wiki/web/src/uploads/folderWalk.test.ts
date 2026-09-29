import { describe, expect, it } from 'vitest';

import { walkDrop } from './folderWalk';

/** Stand-ins for the File and Directory Entries API a drop hands over. */
function fileEntry(name: string, fail = false) {
  return {
    isFile: true, isDirectory: false, name,
    file: (ok: (f: File) => void, bad: (e: Error) => void) =>
      queueMicrotask(() => (fail ? bad(new Error('gone')) : ok(new File([name], name)))),
  };
}

/** A directory whose reader hands its children over in batches of `batch`,
 *  then an empty batch — the way browsers page readEntries. */
function dirEntry(name: string, children: unknown[], batch = 2) {
  return {
    isFile: false, isDirectory: true, name,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (ok: (e: unknown[]) => void) => queueMicrotask(() => {
          const next = children.slice(at, at + batch);
          at += batch;
          ok(next);
        }),
      };
    },
  };
}

function transfer(entries: unknown[], files: File[] = []): DataTransfer {
  return {
    items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry })),
    files,
  } as unknown as DataTransfer;
}

const shape = (walked: { path: string[]; file: File }[]) => walked.map((w) => [...w.path, w.file.name].join('/'));

describe('walkDrop', () => {
  it('walks dropped folders to every file, with its folder path', async () => {
    const dt = transfer([
      fileEntry('top.txt'),
      dirEntry('Site A', [
        fileEntry('a1.pdf'),
        dirEntry('Photos', [fileEntry('p1.jpg'), fileEntry('p2.jpg'), fileEntry('p3.jpg')]),
        fileEntry('a2.pdf'),
        dirEntry('Empty', []),
      ]),
    ]);
    const walked = await walkDrop(dt);
    expect(shape(walked)).toEqual([
      'top.txt', 'Site A/a1.pdf', 'Site A/Photos/p1.jpg', 'Site A/Photos/p2.jpg', 'Site A/Photos/p3.jpg',
      'Site A/a2.pdf',
    ]);
    expect(walked[2].path).toEqual(['Site A', 'Photos']);
    expect(walked[0].file).toBeInstanceOf(File);
  });

  it('skips operating-system clutter and files that can no longer be read', async () => {
    const dt = transfer([dirEntry('D', [
      fileEntry('.DS_Store'), fileEntry('Thumbs.db'), fileEntry('desktop.ini'),
      fileEntry('keep.txt'), fileEntry('vanished.txt', true),
    ])]);
    expect(shape(await walkDrop(dt))).toEqual(['D/keep.txt']);
  });

  it('falls back to the plain file list where entries are not available', async () => {
    const a = new File(['a'], 'a.txt');
    const dt = { items: [{ kind: 'file' }], files: [a] } as unknown as DataTransfer;
    expect(await walkDrop(dt)).toEqual([{ path: [], file: a }]);
    expect(await walkDrop({ files: [a] } as unknown as DataTransfer)).toEqual([{ path: [], file: a }]);
  });

  it('ignores dragged text and links', async () => {
    const dt = {
      items: [{ kind: 'string', webkitGetAsEntry: () => null }, { kind: 'file', webkitGetAsEntry: () => fileEntry('x.txt') }],
      files: [],
    } as unknown as DataTransfer;
    expect(shape(await walkDrop(dt))).toEqual(['x.txt']);
  });
});

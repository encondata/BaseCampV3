// @vitest-environment jsdom
/** The Sound tab body's read of this kiosk's uploaded sounds, once the
 *  panel has closed. A read that settles after a test file has finished
 *  lands with jsdom's window gone, and a state update then throws: under
 *  load Settings.test.tsx logged that as an unhandled error. */
import 'fake-indexeddb/auto';
import { cleanup, render } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// The real read runs; each one is kept so a test can wait for the panel's
// own read to settle.
const reads = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock('../lib/sound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sound')>();
  return {
    ...actual,
    listUploadedSounds: () => {
      const read = actual.listUploadedSounds();
      reads.push(read);
      return read;
    },
  };
});

vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => ({ status: 'authed' }) }));

import { closeDb } from '../lib/localDb';
import SoundPanel from './SoundPanel';

beforeEach(() => {
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  reads.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  localStorage.clear();
});

/** Closes the panel, takes jsdom's window away as the end of a test file
 *  does, and waits for the panel's read. Returns whatever escaped. */
async function closeAndSettle(unmount: () => void): Promise<unknown[]> {
  const escaped: unknown[] = [];
  const onUnhandled = (reason: unknown) => { escaped.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    unmount();
    vi.stubGlobal('window', undefined);
    await Promise.allSettled(reads);
    // Node reports an unhandled rejection once the microtasks run dry.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    vi.unstubAllGlobals();
  }
  return escaped;
}

it('a sound list that arrives after the panel has closed changes nothing', async () => {
  const { unmount } = render(<SoundPanel />);
  expect(reads).toHaveLength(1);
  expect(await closeAndSettle(unmount)).toEqual([]);
});

it('a sound list read that fails after the panel has closed changes nothing', async () => {
  vi.stubGlobal('indexedDB', undefined);
  const { unmount } = render(<SoundPanel />);
  expect(reads).toHaveLength(1);
  expect(await closeAndSettle(unmount)).toEqual([]);
});

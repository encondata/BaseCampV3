// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  startUpload: vi.fn(),
  completeUpload: vi.fn(),
}));
vi.mock('../lib/treeStore', () => ({ noteCreated: vi.fn(), noteChanged: vi.fn() }));

import { completeUpload, startUpload } from '../lib/wikiApi';
import { FakeXhr } from '../testing/fakeXhr';
import { makeNode } from '../testing/fixtures';
import { enqueue, getSnapshot, resetUploadQueue } from './uploadQueue';
import UploadTray from './UploadTray';

const TARGET = { kind: 'node' as const, spaceId: 'space-1', parentId: 'f1', label: 'Guides' };

beforeEach(() => {
  resetUploadQueue();
  FakeXhr.reset();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.mocked(startUpload).mockReset().mockImplementation(async (body) => ({
    upload_id: `up-${body.filename}`, url: 'https://s3/put', headers: {},
  }));
  vi.mocked(completeUpload).mockReset().mockImplementation(async (id) =>
    makeNode(`node-${id}`, { kind: 'file', title: id.slice(3), page: null }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderTray() {
  return render(<MemoryRouter><UploadTray /></MemoryRouter>);
}

describe('UploadTray', () => {
  it('stays out of the way until something uploads', () => {
    renderTray();
    expect(screen.queryByRole('region', { name: 'Uploads' })).toBeNull();
  });

  it('lists uploads with progress, cancel, retry and clear finished', async () => {
    renderTray();
    enqueue([new File(['aaaa'], 'a.pdf'), new File(['b'], 'b.pdf')], TARGET);
    const tray = await screen.findByRole('region', { name: 'Uploads' });
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(2));
    FakeXhr.instances[0].progress(1, 4);
    const rowA = await within(tray).findByRole('listitem', { name: 'a.pdf' });
    await vi.waitFor(() => expect(within(rowA).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25'));
    expect(within(rowA).getByText('to Guides')).toBeTruthy();

    FakeXhr.instances[0].respond(200);
    await vi.waitFor(() => expect(within(rowA).getByRole('link', { name: 'a.pdf' }).getAttribute('href'))
      .toBe('/n/node-up-a.pdf'));
    expect(within(tray).getByText('1 of 2 done')).toBeTruthy();

    const rowB = within(tray).getByRole('listitem', { name: 'b.pdf' });
    fireEvent.click(within(rowB).getByRole('button', { name: 'Cancel b.pdf' }));
    expect(within(rowB).getByText('Canceled.')).toBeTruthy();
    fireEvent.click(within(rowB).getByRole('button', { name: 'Retry b.pdf' }));
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(3));

    fireEvent.click(within(tray).getByRole('button', { name: 'Clear finished' }));
    expect(getSnapshot().map((i) => i.file.name)).toEqual(['b.pdf']);
    expect(within(tray).queryByRole('listitem', { name: 'a.pdf' })).toBeNull();
  });

  it('collapses to its header', async () => {
    renderTray();
    enqueue([new File(['a'], 'a.pdf')], TARGET);
    const tray = await screen.findByRole('region', { name: 'Uploads' });
    fireEvent.click(within(tray).getByRole('button', { name: 'Collapse uploads' }));
    expect(within(tray).queryByRole('list')).toBeNull();
    fireEvent.click(within(tray).getByRole('button', { name: 'Expand uploads' }));
    expect(within(tray).getByRole('list')).toBeTruthy();
  });
});

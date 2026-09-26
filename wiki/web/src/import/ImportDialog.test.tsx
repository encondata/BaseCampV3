// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@portal/lib/api';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  createNode: vi.fn(),
  updateNode: vi.fn(),
  putDraft: vi.fn(),
  deleteNode: vi.fn(),
  startUpload: vi.fn(),
  completeUpload: vi.fn(),
}));
vi.mock('../lib/treeStore', () => ({ noteCreated: vi.fn(), noteChanged: vi.fn(), noteDeleted: vi.fn() }));

import { noteCreated, noteDeleted } from '../lib/treeStore';
import type { NodeCreateIn } from '../lib/types';
import { completeUpload, createNode, deleteNode, putDraft, startUpload, updateNode } from '../lib/wikiApi';
import { FakeXhr } from '../testing/fakeXhr';
import { makeNode } from '../testing/fixtures';
import ImportDialog from './ImportDialog';

const SAMPLE = readFileSync(resolve(__dirname, 'fixtures/sample.docx'));
const onClose = vi.fn();

function Probe() {
  const loc = useLocation();
  return <div>at {loc.pathname}{loc.search}</div>;
}

function renderDialog() {
  return render(
    <MemoryRouter initialEntries={['/n/f1']}>
      <Routes>
        <Route path="/n/f1" element={(
          <ImportDialog spaceId="space-1" parentId="f1" parentTitle="Guides" onClose={onClose} />
        )} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function choose(...files: File[]) {
  fireEvent.change(screen.getByLabelText('Choose files to import'), { target: { files } });
}

beforeEach(() => {
  onClose.mockReset();
  FakeXhr.reset();
  FakeXhr.autoRespond = 200;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  let n = 0;
  vi.mocked(createNode).mockReset().mockImplementation(async (body: NodeCreateIn) => {
    n += 1;
    return makeNode(`page-${n}`, { title: body.title, parent_id: body.parent_id });
  });
  vi.mocked(updateNode).mockReset().mockImplementation(async (id, body) => makeNode(id, { title: body.title }));
  vi.mocked(putDraft).mockReset().mockResolvedValue(undefined);
  vi.mocked(deleteNode).mockReset().mockResolvedValue({ batch_id: 'b', count: 1 });
  vi.mocked(startUpload).mockReset().mockResolvedValue({ upload_id: 'up-1', url: 'https://s3/put', headers: {} });
  vi.mocked(completeUpload).mockReset().mockResolvedValue({
    id: 'asset-1', filename: 'image-1.png', content_type: 'image/png', size_bytes: 70,
  });
  vi.mocked(noteCreated).mockReset();
  vi.mocked(noteDeleted).mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ImportDialog', () => {
  it('uses the modal header pattern and names the destination', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Import pages' });
    expect(within(dialog).getByText('Wiki')).toBeTruthy();
    expect(within(dialog).getByText(/into Guides/)).toBeTruthy();
    expect((screen.getByLabelText('Choose files to import') as HTMLInputElement).accept)
      .toBe('.docx,.md,.markdown,.txt');
    expect((within(dialog).getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('imports one Markdown file as a draft page and opens it in edit mode', async () => {
    renderDialog();
    choose(new File(['# Cutover\n\nStep one.'], 'runbook.md', { type: 'text/markdown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await screen.findByText('at /n/page-1?edit=1');
    expect(createNode).toHaveBeenCalledWith({ space_id: 'space-1', parent_id: 'f1', kind: 'page', title: 'runbook' });
    expect(noteCreated).toHaveBeenCalled();
    // the first heading 1 becomes the title
    expect(updateNode).toHaveBeenCalledWith('page-1', { title: 'Cutover' });
    expect(putDraft).toHaveBeenCalledWith('page-1', {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { textAlign: null }, content: [{ type: 'text', text: 'Step one.' }] }],
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('uploads a Word document\'s images as assets of the new page', async () => {
    renderDialog();
    choose(new File([SAMPLE], 'Sample.docx'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText('at /n/page-1?edit=1');
    expect(startUpload).toHaveBeenCalledWith({
      target: 'asset', page_id: 'page-1', filename: 'image-1.png', content_type: 'image/png', size: expect.any(Number),
    });
    expect(FakeXhr.instances).toHaveLength(1);
    expect(completeUpload).toHaveBeenCalledWith('up-1');
    const doc = vi.mocked(putDraft).mock.calls[0][1];
    expect(JSON.stringify(doc)).toContain('"assetId":"asset-1"');
    expect(updateNode).toHaveBeenCalledWith('page-1', { title: 'Rack plan' });
  });

  it('imports several files, reporting each, and stays on the folder', async () => {
    renderDialog();
    choose(
      new File(['plain words'], 'notes.txt', { type: 'text/plain' }),
      new File(['x'], 'sheet.xlsx'),
      new File(['## Only h2'], 'guide.md'),
    );
    const list = screen.getByRole('list', { name: 'Files to import' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await vi.waitFor(() => expect(within(list).getAllByText('Imported')).toHaveLength(2));
    const bad = within(list).getByRole('listitem', { name: 'sheet.xlsx' });
    expect(within(bad).getByText('“sheet.xlsx” can\'t be imported. Choose a .docx, .md or .txt file.')).toBeTruthy();
    // no page is made for a file that can't be imported, and no rename when the name already fits
    expect(createNode).toHaveBeenCalledTimes(2);
    expect(updateNode).not.toHaveBeenCalled();
    const ok = within(list).getByRole('listitem', { name: 'notes.txt' });
    expect(within(ok).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/n/page-1?edit=1');
    expect(screen.queryByText(/^at /)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps a successfully converted page under its filename title if the rename fails, and still saves it', async () => {
    vi.mocked(updateNode).mockRejectedValue(new ApiError(422, 'bad_title'));
    renderDialog();
    choose(new File(['# Cutover\n\nStep one.'], 'runbook.md', { type: 'text/markdown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const item = await screen.findByRole('listitem', { name: 'runbook.md' });
    await vi.waitFor(() => expect(within(item).getByText('Imported')).toBeTruthy());
    expect(deleteNode).not.toHaveBeenCalled();
    expect(putDraft).toHaveBeenCalledWith('page-1', expect.any(Object));
    expect(within(item).getByText('Couldn\'t rename it to “Cutover” — kept “runbook”.')).toBeTruthy();
    expect(within(item).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/n/page-1?edit=1');
    // a warning keeps it on the list rather than auto-opening it
    expect(screen.queryByText(/^at /)).toBeNull();
  });

  it('never leaves the dialog stuck on "Importing…" if the importers module fails to load', async () => {
    vi.doMock('./importers', () => { throw new Error('Failed to fetch dynamically imported module'); });
    renderDialog();
    choose(new File(['# Cutover\n\nStep one.'], 'runbook.md', { type: 'text/markdown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const item = await screen.findByRole('listitem', { name: 'runbook.md' });
    await vi.waitFor(() => expect(
      within(item).getByText('Couldn\'t read “runbook.md”. Check that it opens, then try again.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(createNode).not.toHaveBeenCalled();
    vi.doUnmock('./importers');
  });

  it('takes the new page back to the trash when saving its content fails', async () => {
    vi.mocked(putDraft).mockRejectedValue(new ApiError(413, 'too_large', undefined, 'The page content is larger than 5 MB.'));
    renderDialog();
    choose(new File(['text'], 'huge.txt'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const item = await screen.findByRole('listitem', { name: 'huge.txt' });
    await vi.waitFor(() => expect(within(item).getByText('The page content is larger than 5 MB.')).toBeTruthy());
    expect(deleteNode).toHaveBeenCalledWith('page-1');
    expect(noteDeleted).toHaveBeenCalled();
    expect(screen.queryByText(/^at /)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

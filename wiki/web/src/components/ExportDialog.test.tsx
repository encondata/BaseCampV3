// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  createExport: vi.fn(),
  getExport: vi.fn(),
}));
vi.mock('../lib/download', () => ({ openDownload: vi.fn() }));

import { ApiError } from '@portal/lib/api';

import { openDownload } from '../lib/download';
import type { ExportOut } from '../lib/types';
import { createExport, getExport } from '../lib/wikiApi';
import { makeNode, makeSpace } from '../testing/fixtures';
import ExportDialog from './ExportDialog';
import { EXPORT_POLL_MAX_MS, EXPORT_POLL_MS } from './ExportProgress';

const PUBLISHED = { is_home: false, published_version_id: 'v1', published_at: '2026-09-20T12:00:00Z', has_unpublished_changes: false };
const PAGE = makeNode('n1', { title: 'Rack Guide', my_level: 'view', page: PUBLISHED });

function job(over: Partial<ExportOut> = {}): ExportOut {
  return { id: 'j1', status: 'queued', filename: 'Rack Guide.pdf', url: null, error: null, ...over };
}

function renderDialog(target: Parameters<typeof ExportDialog>[0]['target'], onClose = vi.fn()) {
  render(<MemoryRouter><ExportDialog target={target} onClose={onClose} /></MemoryRouter>);
  return onClose;
}

const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(createExport).mockReset().mockResolvedValue({ job_id: 'j1' });
  vi.mocked(getExport).mockReset().mockResolvedValue(job());
  vi.mocked(openDownload).mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ExportDialog', () => {
  it('exports a page, shows progress while it runs, then downloads it', async () => {
    renderDialog({ kind: 'node', node: PAGE });
    expect(screen.getByRole('heading', { name: 'Export “Rack Guide”' })).toBeTruthy();
    expect(pressed('PDF')).toBe('true');
    // a page without subpages has no .zip choice
    expect(screen.queryByRole('button', { name: 'With subpages (.zip)' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }));
    expect(pressed('Markdown')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(createExport).toHaveBeenCalledWith({ node_id: 'n1', format: 'md' }));
    expect(await screen.findByText(/Preparing/)).toBeTruthy();
    expect(screen.getByText(/notification when it’s ready/)).toBeTruthy();
    expect(getExport).toHaveBeenCalledTimes(1);

    // polls every two seconds until it's done
    vi.mocked(getExport).mockResolvedValue(job({ status: 'running' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS); });
    expect(getExport).toHaveBeenCalledTimes(2);
    vi.mocked(getExport).mockResolvedValue(job({ status: 'done', filename: 'Rack Guide.md', url: 'https://s3/one' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS); });
    expect(await screen.findByText(/is ready/)).toBeTruthy();
    const calls = vi.mocked(getExport).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS * 3); });
    expect(getExport).toHaveBeenCalledTimes(calls);               // stopped polling

    // the download asks for a fresh link first
    vi.mocked(getExport).mockResolvedValue(job({ status: 'done', filename: 'Rack Guide.md', url: 'https://s3/fresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(openDownload).toHaveBeenCalledWith('https://s3/fresh'));
  });

  it('offers a page with subpages as a .zip, with the pages’ format', async () => {
    renderDialog({ kind: 'node', node: { ...PAGE, has_children: true } });
    expect(pressed('This page')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'With subpages (.zip)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(createExport).toHaveBeenCalledWith(
      { node_id: 'n1', format: 'zip', zip_format: 'md' }));
  });

  it('says a PDF has a cover, contents and comments, and Markdown has no comments', () => {
    renderDialog({ kind: 'node', node: PAGE });
    expect(screen.getByText('The published version of the page, with a cover page, contents and its comments.')).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Format' });
    fireEvent.click(within(group).getByRole('button', { name: 'Markdown' }));
    expect(screen.getByText('The published version of the page, without comments.')).toBeTruthy();
  });

  it('offers exactly PDF and Markdown as formats (no Word)', () => {
    renderDialog({ kind: 'node', node: PAGE });
    const group = screen.getByRole('group', { name: 'Format' });
    expect(Array.from(group.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['PDF', 'Markdown']);
    expect(screen.queryByRole('button', { name: 'Word' })).toBeNull();
  });

  it('forces a .zip for a never-published page with subpages', async () => {
    renderDialog({ kind: 'node', node: makeNode('n2', { title: 'Draft', my_level: 'edit', has_children: true }) });
    expect(pressed('With subpages (.zip)')).toBe('true');
    expect(screen.getByRole('button', { name: 'This page' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(createExport).toHaveBeenCalledWith(
      { node_id: 'n2', format: 'zip', zip_format: 'pdf' }));
  });

  it('exports a folder as a .zip', async () => {
    renderDialog({ kind: 'node', node: makeNode('f1', { kind: 'folder', title: 'Runbooks', my_level: 'view' }) });
    expect(screen.getByText(/every page and file in it you can see/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(createExport).toHaveBeenCalledWith(
      { node_id: 'f1', format: 'zip', zip_format: 'pdf' }));
  });

  it('exports a whole space as a .zip', async () => {
    renderDialog({ kind: 'space', space: makeSpace({ key: 'ops', name: 'Operations' }) });
    expect(screen.getByRole('heading', { name: 'Export “Operations”' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(createExport).toHaveBeenCalledWith(
      { space_key: 'ops', format: 'zip', zip_format: 'md' }));
  });

  it('says why it couldn’t start and stays on the choice', async () => {
    vi.mocked(createExport).mockRejectedValue(new ApiError(429, 'too_many_exports', undefined,
      'You already have 3 exports in progress. Wait for one to finish, then try again.'));
    renderDialog({ kind: 'node', node: PAGE });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/already have 3 exports in progress/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
    expect(getExport).not.toHaveBeenCalled();
  });

  it('shows why an export failed', async () => {
    vi.mocked(getExport).mockResolvedValue(job({ status: 'failed', error: '“Rack Guide” was deleted.' }));
    renderDialog({ kind: 'node', node: PAGE });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText('“Rack Guide” was deleted.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });

  it('stops checking once the export is off-limits', async () => {
    renderDialog({ kind: 'node', node: PAGE });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/Preparing/)).toBeTruthy();
    vi.mocked(getExport).mockRejectedValue(new ApiError(403, 'forbidden', undefined, 'Nope'));
    await act(async () => { await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS); });
    expect(await screen.findByText(/can’t check on this export/)).toBeTruthy();
    const calls = vi.mocked(getExport).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS * 10); });
    expect(getExport).toHaveBeenCalledTimes(calls);
  });

  it('backs off while the server is unreachable, then resumes', async () => {
    renderDialog({ kind: 'node', node: PAGE });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/Preparing/)).toBeTruthy();
    vi.mocked(getExport).mockRejectedValue(new ApiError(503, 'unavailable'));
    const at = () => vi.mocked(getExport).mock.calls.length;
    const start = at();
    // 2 s, then 4 s, 8 s, 16 s, 30 s, 30 s… — not every 2 s
    await act(async () => { await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS * 30); });
    expect(at() - start).toBeLessThanOrEqual(6);
    expect(at() - start).toBeGreaterThanOrEqual(4);
    expect(screen.getByText(/Still trying/)).toBeTruthy();

    vi.mocked(getExport).mockResolvedValue(job({ status: 'running' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(EXPORT_POLL_MAX_MS); });
    const back = at();
    await act(async () => { await vi.advanceTimersByTimeAsync(EXPORT_POLL_MS); });
    expect(at()).toBe(back + 1);                                   // normal pace again
    expect(screen.queryByText(/Still trying/)).toBeNull();
  });

  it('closes on Done, Cancel and Escape', async () => {
    const onClose = renderDialog({ kind: 'node', node: PAGE });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

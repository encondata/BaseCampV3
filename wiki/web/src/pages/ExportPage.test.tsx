// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getExport: vi.fn(),
}));
vi.mock('../lib/download', () => ({ openDownload: vi.fn() }));

import { ApiError } from '@portal/lib/api';

import { openDownload } from '../lib/download';
import { getExport } from '../lib/wikiApi';
import ExportPage from './ExportPage';

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/exports/:jobId" element={<ExportPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(getExport).mockReset();
  vi.mocked(openDownload).mockReset();
});
afterEach(cleanup);

describe('ExportPage (the inbox link)', () => {
  it('offers a finished export for download with a fresh link', async () => {
    vi.mocked(getExport).mockResolvedValue(
      { id: 'j1', status: 'done', filename: 'Runbooks.zip', url: 'https://s3/zip', error: null });
    renderAt('/exports/j1');
    expect(await screen.findByText(/Runbooks\.zip/)).toBeTruthy();
    expect(getExport).toHaveBeenCalledWith('j1');
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(openDownload).toHaveBeenCalledWith('https://s3/zip'));
  });

  it('explains an export that is gone (or someone else’s)', async () => {
    vi.mocked(getExport).mockRejectedValue(new ApiError(404, 'not_found', undefined, 'Not found.'));
    renderAt('/exports/j1');
    expect(await screen.findByText(/kept for 7 days/)).toBeTruthy();
  });
});

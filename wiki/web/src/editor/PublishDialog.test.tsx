// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  publishPage: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import type { VersionOut } from '../lib/types';
import { publishPage } from '../lib/wikiApi';
import { FlushError } from './liveFlush';
import PublishDialog from './PublishDialog';

const VERSION: VersionOut = {
  id: 'v4', version_no: 4, kind: 'published', title: 'Rack power', note: 'Fixed the breaker list',
  created_by: { id: 'p-1', name: 'Jimmy Henderson' }, created_at: '2026-09-25T12:00:00Z',
};

const onClose = vi.fn();
const onPublished = vi.fn();
const flush = vi.fn<() => Promise<void>>();

beforeEach(() => {
  toast.mockReset();
  onClose.mockReset();
  onPublished.mockReset();
  flush.mockReset().mockResolvedValue(undefined);
  vi.mocked(publishPage).mockReset();
});
afterEach(cleanup);

function renderDialog() {
  render(<PublishDialog pageId="p1" pageTitle="Rack power" flush={flush} onClose={onClose}
                        onPublished={onPublished} />);
}

describe('PublishDialog', () => {
  it('publishes with the change note, toasts and reports back', async () => {
    vi.mocked(publishPage).mockResolvedValue(VERSION);
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Publish “Rack power”' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Change note/), { target: { value: '  Fixed the breaker list ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith(VERSION));
    expect(publishPage).toHaveBeenCalledWith('p1', 'Fixed the breaker list');
    expect(toast).toHaveBeenCalledWith('Published');
    expect(onClose).toHaveBeenCalled();
  });

  it('publishes without a note', async () => {
    vi.mocked(publishPage).mockResolvedValue(VERSION);
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(publishPage).toHaveBeenCalledWith('p1', undefined));
  });

  it('says there is nothing new to publish on a 409', async () => {
    vi.mocked(publishPage).mockRejectedValue(new ApiError(409, 'nothing_to_publish'));
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('Nothing new to publish')).toBeTruthy();
    expect(onPublished).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stores the live document before publishing it', async () => {
    let stored!: () => void;
    flush.mockReturnValue(new Promise<void>((resolve) => { stored = resolve; }));
    vi.mocked(publishPage).mockResolvedValue(VERSION);
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Publishing…' })).toBeTruthy();
    expect(publishPage).not.toHaveBeenCalled();
    stored();
    await waitFor(() => expect(publishPage).toHaveBeenCalledWith('p1', undefined));
  });

  it('does not publish a draft it could not bring up to date', async () => {
    flush.mockRejectedValue(new FlushError('offline'));
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/latest changes/i);
    expect(publishPage).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();

    flush.mockRejectedValue(new FlushError('read_only'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/read-only mode/i));
    expect(publishPage).not.toHaveBeenCalled();

    flush.mockRejectedValue(new FlushError('too_large'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/too large/i));
    expect(publishPage).not.toHaveBeenCalled();
  });
});

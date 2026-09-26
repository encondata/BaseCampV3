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
import PublishDialog from './PublishDialog';

const VERSION: VersionOut = {
  id: 'v4', version_no: 4, kind: 'published', title: 'Rack power', note: 'Fixed the breaker list',
  created_by: { id: 'p-1', name: 'Jimmy Henderson' }, created_at: '2026-09-25T12:00:00Z',
};

const onClose = vi.fn();
const onPublished = vi.fn();

beforeEach(() => {
  toast.mockReset();
  onClose.mockReset();
  onPublished.mockReset();
  vi.mocked(publishPage).mockReset();
});
afterEach(cleanup);

function renderDialog() {
  render(<PublishDialog pageId="p1" pageTitle="Rack power" onClose={onClose} onPublished={onPublished} />);
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
});

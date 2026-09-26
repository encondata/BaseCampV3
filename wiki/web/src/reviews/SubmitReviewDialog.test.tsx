// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  submitReview: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import { FlushError } from '../editor/liveFlush';
import { submitReview } from '../lib/wikiApi';
import { makeReview } from '../testing/fixtures';
import SubmitReviewDialog from './SubmitReviewDialog';

const REVIEW = makeReview();

const onClose = vi.fn();
const onSubmitted = vi.fn();
const flush = vi.fn<() => Promise<void>>();

beforeEach(() => {
  toast.mockReset();
  onClose.mockReset();
  onSubmitted.mockReset();
  flush.mockReset().mockResolvedValue(undefined);
  vi.mocked(submitReview).mockReset();
});
afterEach(cleanup);

function renderDialog(replacesPending = false) {
  render(<SubmitReviewDialog pageId="p1" pageTitle="Rack power" flush={flush} replacesPending={replacesPending}
                             onClose={onClose} onSubmitted={onSubmitted} />);
}

describe('SubmitReviewDialog', () => {
  it('stores the live document, then submits it with the note', async () => {
    let stored!: () => void;
    flush.mockReturnValue(new Promise<void>((resolve) => { stored = resolve; }));
    vi.mocked(submitReview).mockResolvedValue(REVIEW);
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Submit “Rack power” for review' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Note for the reviewer/), { target: { value: ' Updated the breaker list ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Submitting…' })).toBeTruthy();
    expect(submitReview).not.toHaveBeenCalled();
    stored();
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(REVIEW));
    expect(submitReview).toHaveBeenCalledWith('p1', 'Updated the breaker list');
    expect(toast).toHaveBeenCalledWith('Submitted for review. A manager of the page will approve it.');
    expect(onClose).toHaveBeenCalled();
  });

  it('submits without a note', async () => {
    vi.mocked(submitReview).mockResolvedValue(REVIEW);
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(submitReview).toHaveBeenCalledWith('p1', undefined));
  });

  it('says so when the draft has nothing new', async () => {
    vi.mocked(submitReview).mockRejectedValue(new ApiError(409, 'nothing_to_review'));
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(await screen.findByText('Nothing new to review — the draft matches the published page.')).toBeTruthy();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('submits nothing it couldn\'t bring up to date', async () => {
    flush.mockRejectedValue(new FlushError('read_only'));
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/read-only mode/i);
    expect(submitReview).not.toHaveBeenCalled();
  });

  it('warns that a new request replaces the pending one', () => {
    renderDialog(true);
    expect(screen.getByText(/replaces the request already waiting/)).toBeTruthy();
  });
});

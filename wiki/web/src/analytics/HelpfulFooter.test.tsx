// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getMyFeedback: vi.fn(),
  putFeedback: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import { getMyFeedback, putFeedback } from '../lib/wikiApi';
import HelpfulFooter from './HelpfulFooter';

const saved = (helpful: boolean, comment: string | null = null) => ({
  helpful, comment, updated_at: '2026-09-26T12:00:00Z',
});

beforeEach(() => {
  toast.mockReset();
  vi.mocked(getMyFeedback).mockReset().mockRejectedValue(new ApiError(404, 'not_found'));
  vi.mocked(putFeedback).mockReset().mockImplementation(async (_id, body) => saved(body.helpful, body.comment ?? null));
});
afterEach(cleanup);

describe('HelpfulFooter', () => {
  it('asks, saves a Yes and thanks the reader', async () => {
    render(<HelpfulFooter pageId="p1" />);
    expect(await screen.findByText('Was this page helpful?')).toBeTruthy();
    expect(getMyFeedback).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(putFeedback).toHaveBeenCalledWith('p1', { helpful: true }));
    expect(await screen.findByText('Thanks for your feedback.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('saves a No at once, then takes an optional comment', async () => {
    render(<HelpfulFooter pageId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'No' }));
    await waitFor(() => expect(putFeedback).toHaveBeenCalledWith('p1', { helpful: false }));
    const box = await screen.findByRole('textbox', { name: 'What was missing or wrong?' });
    fireEvent.change(box, { target: { value: 'The steps skip the login.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(putFeedback).toHaveBeenLastCalledWith(
      'p1', { helpful: false, comment: 'The steps skip the login.' }));
    expect(await screen.findByText('Thanks for your feedback.')).toBeTruthy();
  });

  it('lets the reader skip the comment', async () => {
    render(<HelpfulFooter pageId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'No' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    expect(await screen.findByText('Thanks for your feedback.')).toBeTruthy();
    expect(putFeedback).toHaveBeenCalledTimes(1);
  });

  it('shows an earlier answer and lets the reader change it', async () => {
    vi.mocked(getMyFeedback).mockResolvedValue(saved(false, 'Out of date.'));
    render(<HelpfulFooter pageId="p1" />);
    expect(await screen.findByText('You said this page wasn\'t helpful.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change your answer' }));
    const no = screen.getByRole('button', { name: 'No' });
    expect(no.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(putFeedback).toHaveBeenCalledWith('p1', { helpful: true }));
    expect(await screen.findByText('Thanks for your feedback.')).toBeTruthy();
  });

  it('keeps the earlier comment in the box when the answer stays No', async () => {
    vi.mocked(getMyFeedback).mockResolvedValue(saved(false, 'Out of date.'));
    render(<HelpfulFooter pageId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change your answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    const box = await screen.findByRole('textbox', { name: 'What was missing or wrong?' }) as HTMLTextAreaElement;
    expect(box.value).toBe('Out of date.');
    // saving the No again keeps the comment the reader already left
    expect(putFeedback).toHaveBeenCalledWith('p1', { helpful: false, comment: 'Out of date.' });
  });

  it('tells the reader when an answer could not be saved', async () => {
    vi.mocked(putFeedback).mockRejectedValue(new ApiError(423, 'read_only_mode', undefined, 'The wiki is read-only.'));
    render(<HelpfulFooter pageId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('The wiki is read-only.'));
    expect(screen.getByText('Was this page helpful?')).toBeTruthy();
  });

  it('shows the question even when the earlier answer can\'t be read', async () => {
    vi.mocked(getMyFeedback).mockRejectedValue(new Error('offline'));
    render(<HelpfulFooter pageId="p1" />);
    expect(await screen.findByText('Was this page helpful?')).toBeTruthy();
  });
});

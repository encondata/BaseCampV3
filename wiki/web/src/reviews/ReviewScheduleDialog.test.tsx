// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  updateNode: vi.fn(),
}));

import type { NodeDetailOut, NodeReviewOut } from '../lib/types';
import { updateNode } from '../lib/wikiApi';
import { makeDetail, makeNode, makeSpace } from '../testing/fixtures';
import ReviewScheduleDialog from './ReviewScheduleDialog';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const review: NodeReviewOut = {
  interval_months: 6, own_interval_months: null, next_review_at: null,
  last_reviewed_at: null, state: null, pending_review_id: null,
};

const onClose = vi.fn();
const onSaved = vi.fn();

beforeEach(() => {
  toast.mockReset();
  onClose.mockReset();
  onSaved.mockReset();
  vi.mocked(updateNode).mockReset();
});
afterEach(cleanup);

function renderDialog(node: NodeDetailOut) {
  render(<ReviewScheduleDialog node={node} onClose={onClose} onSaved={onSaved} />);
}

const picker = () => screen.getByRole('combobox', { name: 'Review every' }) as HTMLInputElement;

describe('ReviewScheduleDialog', () => {
  it('shows a page following the space\'s schedule', () => {
    renderDialog(makeDetail('p1', {
      title: 'Rack power', my_level: 'manage', review,
      space: makeSpace({ settings: { review_interval_months: 6 } }),
    }));
    expect(screen.getByRole('dialog', { name: 'Review schedule for “Rack power”' })).toBeTruthy();
    expect(picker().value).toBe('Library default: 6 months');
    expect(screen.getByText('This page follows the library\'s schedule.')).toBeTruthy();
  });

  it('shows a page\'s own schedule, and a space with none', () => {
    renderDialog(makeDetail('p1', {
      my_level: 'manage', review: { ...review, interval_months: 12, own_interval_months: 12 }, space: makeSpace(),
    }));
    expect(picker().value).toBe('Every 12 months');
    expect(screen.getByText('This page has its own schedule (the library default is none).')).toBeTruthy();
  });

  it('saves a page\'s own interval', async () => {
    const saved = makeNode('p1', { review: { ...review, interval_months: 3, own_interval_months: 3 } });
    vi.mocked(updateNode).mockResolvedValue(saved);
    renderDialog(makeDetail('p1', { my_level: 'manage', review, space: makeSpace({ settings: { review_interval_months: 6 } }) }));
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.focus(picker());
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Every 3 months' }));
    fireEvent.click(save);
    await waitFor(() => expect(updateNode).toHaveBeenCalledWith('p1', { review_interval_months: 3 }));
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(toast).toHaveBeenCalledWith('Review schedule saved.');
    expect(onClose).toHaveBeenCalled();
  });

  it('goes back to the space default with null', async () => {
    vi.mocked(updateNode).mockResolvedValue(makeNode('p1'));
    renderDialog(makeDetail('p1', {
      my_level: 'manage', review: { ...review, interval_months: 12, own_interval_months: 12 },
      space: makeSpace({ settings: { review_interval_months: 6 } }),
    }));
    fireEvent.focus(picker());
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Library default: 6 months' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateNode).toHaveBeenCalledWith('p1', { review_interval_months: null }));
  });

  it('keeps an unusual interval set elsewhere as an option', () => {
    renderDialog(makeDetail('p1', {
      my_level: 'manage', review: { ...review, interval_months: 9, own_interval_months: 9 },
    }));
    expect(picker().value).toBe('Every 9 months');
  });

  it('reports a failed save and stays open', async () => {
    vi.mocked(updateNode).mockRejectedValue(new Error('nope'));
    renderDialog(makeDetail('p1', { my_level: 'manage', review }));
    fireEvent.focus(picker());
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Every 24 months' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

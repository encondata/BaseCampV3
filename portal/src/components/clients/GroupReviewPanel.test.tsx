// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ dismissGroupReview: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: GroupReviewPanel } = await import('./GroupReviewPanel');

const rv = (value: string, dismissed = false) => ({
  value, value_key: value.toLowerCase(), asset_count: 1, move_ids: ['m1'], move_names: ['Move A'], dismissed,
});
beforeEach(() => api.dismissGroupReview.mockReset());
afterEach(cleanup);

const panel = (over = {}) => (
  <GroupReviewPanel clientId="c1" data={[rv('Accounting')]} loadError="" showDismissed={false}
                    onToggleDismissed={() => {}} onMatch={() => {}} onCreate={() => {}}
                    onChanged={() => {}} {...over} />
);

it('row buttons hand the value to match and create', () => {
  const onMatch = vi.fn(); const onCreate = vi.fn();
  render(panel({ onMatch, onCreate }));
  fireEvent.click(screen.getByRole('button', { name: 'Match to group…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
  expect(onMatch).toHaveBeenCalledWith('Accounting');
  expect(onCreate).toHaveBeenCalledWith('Accounting');
});

it('dismiss writes then asks the parent to reload', async () => {
  api.dismissGroupReview.mockResolvedValue(undefined);
  const onChanged = vi.fn();
  render(panel({ onChanged }));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(api.dismissGroupReview).toHaveBeenCalledWith('c1', { value: 'Accounting', dismissed: true });
});

it('empty state and load error', () => {
  const { unmount } = render(panel({ data: [] }));
  expect(screen.getByText('Nothing to review')).toBeTruthy();
  unmount();
  render(panel({ data: null, loadError: 'boom' }));
  expect(screen.getByText('Cannot load review')).toBeTruthy();
});

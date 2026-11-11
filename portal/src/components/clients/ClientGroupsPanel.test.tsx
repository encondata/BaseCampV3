// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listClientGroups: vi.fn(), listGroupReview: vi.fn(), matchGroupReview: vi.fn(),
  dismissGroupReview: vi.fn(), mergeClientGroups: vi.fn(), deleteClientGroup: vi.fn(),
  createClientGroup: vi.fn(), updateClientGroup: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: ClientGroupsPanel } = await import('./ClientGroupsPanel');

const groups = [
  { id: 'g1', name: 'Finance', aliases: ['FIN', 'Fin Dept'], asset_count: 12, people_count: 3 },
  { id: 'g2', name: 'Legal', aliases: [], asset_count: 4, people_count: 1 },
];
const rv = (value: string, over: Record<string, unknown> = {}) => ({
  value, value_key: value.toLowerCase(), asset_count: 2, move_ids: ['m1', 'm2'],
  move_names: ['Move A', 'Move B'], dismissed: false, ...over,
});

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Object.values(api).forEach((f) => f.mockReset());
  api.listClientGroups.mockResolvedValue(groups);
  api.listGroupReview.mockResolvedValue([rv('Accounting'), rv('Ops', { dismissed: true })]);
});
afterEach(cleanup);

it('renders groups with alias chips and counts', async () => {
  render(<ClientGroupsPanel clientId="c1" />);
  expect(await screen.findByText('Finance')).toBeTruthy();
  expect(screen.getByText('FIN')).toBeTruthy();
  expect(screen.getByText('Fin Dept')).toBeTruthy();
  const row = screen.getByText('Finance').closest('.dir-row') as HTMLElement;
  expect(within(row).getByText('12')).toBeTruthy();
  expect(within(row).getByText('3')).toBeTruthy();
  expect(screen.getByText('Groups')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add group' })).toBeTruthy();
});

it('the Review badge shows the undismissed count', async () => {
  render(<ClientGroupsPanel clientId="c1" />);
  const tab = await screen.findByRole('tab', { name: /Review/ });
  await waitFor(() => expect(tab.textContent).toBe('Review 1'));
});

it('match calls matchGroupReview and the row leaves the list', async () => {
  api.matchGroupReview.mockResolvedValue(undefined);
  render(<ClientGroupsPanel clientId="c1" />);
  fireEvent.click(await screen.findByRole('tab', { name: /Review/ }));
  expect(await screen.findByText('Accounting')).toBeTruthy();
  expect(screen.getByText(/2 assets · 2 moves/)).toBeTruthy();
  expect(screen.getByText('Move A, Move B')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Match to group…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Match to group' });
  fireEvent.focus(within(dialog).getByRole('combobox'));
  fireEvent.mouseDown(await screen.findByText('Legal', { selector: '.combo-menu *' }));
  api.listGroupReview.mockResolvedValue([rv('Ops', { dismissed: true })]);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Match' }));
  await waitFor(() => expect(api.matchGroupReview).toHaveBeenCalledWith('c1', { value: 'Accounting', group_id: 'g2' }));
  await waitFor(() => expect(screen.queryByText('Accounting')).toBeNull());
  expect(screen.getByText('Nothing to review')).toBeTruthy();
});

it('dismiss and restore toggle', async () => {
  api.dismissGroupReview.mockResolvedValue(undefined);
  render(<ClientGroupsPanel clientId="c1" />);
  fireEvent.click(await screen.findByRole('tab', { name: /Review/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(api.dismissGroupReview).toHaveBeenCalledWith('c1', { value: 'Accounting', dismissed: true }));
  expect(screen.queryByText('Ops')).toBeNull();
  fireEvent.click(screen.getByLabelText('Show dismissed (1)'));
  fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
  await waitFor(() => expect(api.dismissGroupReview).toHaveBeenCalledWith('c1', { value: 'Ops', dismissed: false }));
});

it('merge shows the dry-run numbers before confirming', async () => {
  api.mergeClientGroups.mockImplementation(async (_c, _t, _s, dry) => ({
    aliases_added: ['Legal'], rows_moved: 4, people_moved: 1, conflicts: [], dry,
  }));
  render(<ClientGroupsPanel clientId="c1" />);
  const row = (await screen.findByText('Legal')).closest('.dir-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: /Actions/ }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Merge into…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Merge into another group' });
  fireEvent.focus(within(dialog).getByRole('combobox'));
  fireEvent.mouseDown(await screen.findByText('Finance', { selector: '.combo-menu *' }));
  await waitFor(() => expect(api.mergeClientGroups).toHaveBeenCalledWith('c1', 'g1', 'g2', true));
  expect(await within(dialog).findByText(/4 asset rows move/)).toBeTruthy();
  expect(api.mergeClientGroups).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
  await waitFor(() => expect(api.mergeClientGroups).toHaveBeenCalledWith('c1', 'g1', 'g2', false));
});

it('delete in use shows the clear message', async () => {
  const { ApiError } = await import('../../lib/api');
  api.deleteClientGroup.mockRejectedValue(new ApiError(409, 'group_in_use', 'x'));
  render(<ClientGroupsPanel clientId="c1" />);
  const row = (await screen.findByText('Legal')).closest('.dir-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: /Actions/ }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete group' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText(/before deleting it/)).toBeTruthy();
});

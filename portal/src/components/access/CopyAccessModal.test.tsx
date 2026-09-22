// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ copyAccess: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: CopyAccessModal } = await import('./CopyAccessModal');

const members = [
  { person_id: 'p1', display_name: 'Ann One', job_title: null, login_email: 'a@x', status: 'active',
    roles: ['staff'], max_rank: 40, avatar_url: null },
  { person_id: 'p2', display_name: 'Bob Two', job_title: null, login_email: 'b@x', status: 'active',
    roles: ['worker'], max_rank: 10, avatar_url: null },
] as never[];

const plan = {
  mode: 'replace', parts: ['roles', 'groups', 'overrides'], applied: false,
  targets: [{ person_id: 'p2', display_name: 'Bob Two', avatar_url: null, status: 'ok', reason: null,
              roles: { from: ['worker'], to: ['staff'] }, groups: null,
              overrides: { added: 2, removed: 0, changed: 0 } }],
};

beforeEach(() => { api.copyAccess.mockReset(); });
afterEach(cleanup);

it('previews with dry_run, renders the plan, then applies the same request', async () => {
  api.copyAccess.mockResolvedValueOnce(plan).mockResolvedValueOnce({ ...plan, applied: true });
  const onApplied = vi.fn();
  render(<CopyAccessModal members={members} sourceId="p1" onClose={() => {}} onApplied={onApplied} />);
  fireEvent.focus(screen.getByPlaceholderText('Add person…'));
  fireEvent.mouseDown(screen.getByText('Bob Two'));
  fireEvent.click(screen.getByRole('button', { name: 'Add only' }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(api.copyAccess).toHaveBeenCalledWith({
    source_id: 'p1', target_ids: ['p2'], parts: ['roles', 'groups', 'overrides'],
    mode: 'add', dry_run: true }));
  expect(await screen.findByText('Role: worker → staff')).toBeTruthy();
  expect(screen.getByText('Overrides: 2 added')).toBeTruthy();
  expect(screen.getByText('Groups: no change')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(api.copyAccess).toHaveBeenLastCalledWith(expect.objectContaining({ dry_run: false })));
  await waitFor(() => expect(onApplied).toHaveBeenCalled());
});

it('shows skipped targets with a reason and keeps Apply disabled until a preview exists', async () => {
  api.copyAccess.mockResolvedValueOnce({ ...plan, targets: [{ ...plan.targets[0], status: 'skipped',
    reason: 'rank_too_low', roles: null, overrides: null }] });
  render(<CopyAccessModal members={members} sourceId="p1" onClose={() => {}} onApplied={() => {}} />);
  expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.focus(screen.getByPlaceholderText('Add person…'));
  fireEvent.mouseDown(screen.getByText('Bob Two'));
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText('Skipped — their rank is at or above yours')).toBeTruthy();
  expect(screen.getByText('0 will change, 1 skipped')).toBeTruthy();
});

it('drops a target that is then picked as the source', async () => {
  api.copyAccess.mockResolvedValue(plan);
  render(<CopyAccessModal members={members} sourceId={null} onClose={() => {}} onApplied={() => {}} />);
  fireEvent.focus(screen.getByPlaceholderText('Add person…'));
  fireEvent.mouseDown(screen.getByText('Bob Two'));
  expect(screen.getByText('Bob Two').closest('.chip')).toBeTruthy();

  fireEvent.focus(screen.getByPlaceholderText('Copy from…'));
  const option = screen.getAllByText('Bob Two').find((el) => el.classList.contains('kbar-item'));
  fireEvent.mouseDown(option!);
  expect(screen.queryAllByText('Bob Two').filter((el) => el.closest('.chip'))).toHaveLength(0);

  fireEvent.focus(screen.getByPlaceholderText('Add person…'));
  fireEvent.mouseDown(screen.getByText('Ann One'));
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(api.copyAccess).toHaveBeenCalledWith(
    expect.objectContaining({ source_id: 'p2', target_ids: ['p1'] })));
});

it('clears the plan when any input changes', async () => {
  api.copyAccess.mockResolvedValue(plan);
  render(<CopyAccessModal members={members} sourceId="p1" onClose={() => {}} onApplied={() => {}} />);
  fireEvent.focus(screen.getByPlaceholderText('Add person…'));
  fireEvent.mouseDown(screen.getByText('Bob Two'));
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText('Role: worker → staff')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false);

  fireEvent.click(screen.getByLabelText('Access groups'));
  expect(screen.queryByText('Role: worker → staff')).toBeNull();
  expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
});

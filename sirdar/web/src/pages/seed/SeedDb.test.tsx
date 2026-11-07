// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const snaps = vi.hoisted(() => ({ listSnapshots: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...snaps }));
const api = vi.hoisted(() => ({
  listRecipes: vi.fn(), getRecipe: vi.fn(), createRecipe: vi.fn(), putRecipe: vi.fn(),
  openSnapshot: vi.fn(), snapshotStatus: vi.fn(), listTables: vi.fn(), getRows: vi.fn(),
  getKeys: vi.fn(), resolveSelection: vi.fn(),
}));
vi.mock('./seedApi', async (orig) => ({ ...(await orig<typeof import('./seedApi')>()), ...api }));

import { SNAP, SNAP_TAKING } from '../environments/testData';

import SeedDb from './SeedDb';

Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)

const PEOPLE = {
  columns: [{ name: 'id', type: 'uuid' }, { name: 'first_name', type: 'text' }],
  rows: ['1', '2', '3'].map((id) => ({ pk: { id }, values: { id, first_name: `Person ${id}` } })),
  total: 3,
};
const LOGS = {
  columns: [{ name: 'line', type: 'text' }],
  rows: [{ pk: null, values: { line: 'Line A' } }],
  total: 1,
};
const NONE = { added: {}, reasons: [], missing: {}, added_tables: [], missing_tables: [] };

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  snaps.listSnapshots.mockResolvedValue({ snapshots: [SNAP, SNAP_TAKING] });
  api.listRecipes.mockResolvedValue([{ id: 'r1', name: 'Recipe A', notes: '', tables: 1, rows: 1, files: 1, updated_at: '' }]);
  api.getRecipe.mockResolvedValue({
    id: 'r1', name: 'Recipe A', notes: '', tables: { people: { mode: 'rows', pks: [{ id: '1' }] } },
    files: { 'avatars/a.jpg': false },
  });
  api.openSnapshot.mockResolvedValue({ status: 'ready' });
  api.snapshotStatus.mockResolvedValue({ status: 'ready' });
  api.listTables.mockResolvedValue([
    { table: 'people', rows: 3, pk: ['id'], file_columns: [] },
    { table: 'logs', rows: 1, pk: null, file_columns: [] },
  ]);
  api.getRows.mockImplementation((_s: string, t: string) => Promise.resolve(t === 'logs' ? LOGS : PEOPLE));
  api.getKeys.mockResolvedValue({ pks: [{ id: '2' }, { id: '3' }], total: 2 });
  api.resolveSelection.mockResolvedValue(NONE);
  api.putRecipe.mockImplementation((id: string, body: object) => Promise.resolve({ id, notes: '', ...body }));
});
afterEach(cleanup);

async function pick(label: string, option: RegExp) {
  await userEvent.click(screen.getByLabelText(label));
  await waitFor(() => expect(document.querySelector('.combo-menu')).toBeTruthy());
  await userEvent.click(within(document.querySelector('.combo-menu') as HTMLElement).getByText(option));
}

async function openPeople() {
  render(<MemoryRouter><SeedDb /></MemoryRouter>);
  await waitFor(() => expect(snaps.listSnapshots).toHaveBeenCalled());
  await pick('Snapshot', new RegExp(SNAP.name));
  await screen.findByRole('checkbox', { name: 'Row Person 1' });
}

it('offers only ready snapshots', async () => {
  render(<MemoryRouter><SeedDb /></MemoryRouter>);
  await userEvent.click(screen.getByLabelText('Snapshot'));
  expect(await screen.findByText(new RegExp(SNAP.name))).toBeTruthy();
  expect(screen.queryByText(new RegExp(SNAP_TAKING.name))).toBeNull();
});

it('Check all with a filter calls keys with that filter and ticks them', async () => {
  await openPeople();
  await pick('Filter column', /^first_name$/);
  await userEvent.type(screen.getByLabelText('Filter'), 'Person');
  await waitFor(() => expect(api.getRows).toHaveBeenLastCalledWith(
    SNAP.id, 'people', expect.objectContaining({ filter_col: 'first_name', filter: 'Person' })));
  await userEvent.click(screen.getByRole('button', { name: 'Check all' }));
  expect(api.getKeys).toHaveBeenCalledWith(SNAP.id, 'people', { filter_col: 'first_name', filter: 'Person' });
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Row Person 2' }) as HTMLInputElement).checked).toBe(true));
  expect((screen.getByRole('checkbox', { name: 'Row Person 3' }) as HTMLInputElement).checked).toBe(true);
  expect(within(screen.getByRole('table', { name: 'Tables' })).getByText('2 / 3')).toBeTruthy();
});

it('Deselect all with no filter calls keys with no filter', async () => {
  await openPeople();
  await userEvent.click(screen.getByRole('button', { name: 'Deselect all' }));
  expect(api.getKeys).toHaveBeenCalledWith(SNAP.id, 'people', { filter_col: '', filter: '' });
});

it('shows resolve\'s reasons under Added because they\'re needed', async () => {
  api.resolveSelection.mockResolvedValue({
    ...NONE,
    added: { partners: [{ id: 'p1' }] },
    reasons: [{ table: 'partners', pk: { id: 'p1' }, label: 'Partner A', needed_by_table: 'worker_profiles',
                needed_by_pk: { id: 'w1' }, needed_by_label: 'Person D' }],
    added_tables: [{ table: 'countries', needed_by_table: 'sites', via_columns: ['country'] }],
    missing: { people: [{ id: '9' }] },
  });
  await openPeople();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Row Person 1' }));
  expect(await screen.findByText("Added because they're needed")).toBeTruthy();
  expect(screen.getByText('partners: Partner A, needed by worker_profiles row for Person D')).toBeTruthy();
  expect(screen.getByText('Added whole table countries, needed by sites')).toBeTruthy();
  expect(screen.getByText('people: 9')).toBeTruthy();
  const [snapId, tables] = api.resolveSelection.mock.calls.at(-1)!;
  expect(snapId).toBe(SNAP.id);
  expect(tables).toEqual({ people: { mode: 'rows', pks: [{ id: '1' }] } });
});

it('Save recipe PUTs the selection with the recipe\'s files', async () => {
  await openPeople();
  await pick('Recipe', /^Recipe A$/);
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Row Person 1' }) as HTMLInputElement).checked).toBe(true));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Row Person 2' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }));
  await waitFor(() => expect(api.putRecipe).toHaveBeenCalled());
  expect(api.putRecipe).toHaveBeenCalledWith('r1', {
    name: 'Recipe A',
    tables: { people: { mode: 'rows', pks: [{ id: '1' }, { id: '2' }] } },
    files: { 'avatars/a.jpg': false },
  });
});

it('a new recipe is created by name and then saved', async () => {
  api.createRecipe.mockResolvedValue({ id: 'r2', name: 'Recipe B', notes: '', tables: {}, files: {} });
  await openPeople();
  await userEvent.click(screen.getByRole('button', { name: 'New recipe' }));
  await userEvent.type(screen.getByLabelText('Recipe name'), 'Recipe B');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Row Person 3' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }));
  await waitFor(() => expect(api.putRecipe).toHaveBeenCalled());
  expect(api.createRecipe).toHaveBeenCalledWith('Recipe B');
  expect(api.putRecipe).toHaveBeenCalledWith('r2', {
    name: 'Recipe B', tables: { people: { mode: 'rows', pks: [{ id: '3' }] } }, files: {},
  });
});

it('a table without a primary key disables its checkboxes', async () => {
  await openPeople();
  await userEvent.click(screen.getByRole('button', { name: 'logs' }));
  const box = await screen.findByRole('checkbox', { name: 'Row Line A' }) as HTMLInputElement;
  expect(box.disabled).toBe(true);
  expect(screen.getByText(/has no primary key/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Check all' }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(screen.getByLabelText('All rows'));
  await waitFor(() => expect(api.resolveSelection).toHaveBeenLastCalledWith(
    SNAP.id, { logs: { mode: 'all', pks: [] } }));
});

it('polls while the snapshot is restoring', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    api.openSnapshot.mockResolvedValue({ status: 'restoring' });
    api.snapshotStatus.mockResolvedValueOnce({ status: 'restoring' }).mockResolvedValue({ status: 'ready' });
    render(<MemoryRouter><SeedDb /></MemoryRouter>);
    await waitFor(() => expect(snaps.listSnapshots).toHaveBeenCalled());
    await pick('Snapshot', new RegExp(SNAP.name));
    expect(await screen.findByText(/Opening the snapshot/)).toBeTruthy();
    expect(api.listTables).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.snapshotStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.snapshotStatus).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(api.listTables).toHaveBeenCalledWith(SNAP.id));
  } finally {
    vi.useRealTimers();
  }
});

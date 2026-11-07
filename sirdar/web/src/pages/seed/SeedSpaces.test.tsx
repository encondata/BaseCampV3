// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (_r: string, a: string) => a !== 'change' || perms.change }),
}));
const snaps = vi.hoisted(() => ({ listSnapshots: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...snaps }));
const api = vi.hoisted(() => ({
  listRecipes: vi.fn(), getRecipe: vi.fn(), putRecipe: vi.fn(),
  openSnapshot: vi.fn(), snapshotStatus: vi.fn(), listFiles: vi.fn(),
}));
vi.mock('./seedApi', async (orig) => ({ ...(await orig<typeof import('./seedApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { SNAP } from '../environments/testData';

import SeedSpaces from './SeedSpaces';

Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)

const TABLES = { people: { mode: 'rows', pks: [{ id: '1' }] } };
const FILES = [
  { key: 'avatars/a.jpg', size: 1536, kept: true, because: 'Avatar of Person A (people)',
    reference: 'Avatar of Person A (people)' },
  { key: 'avatars/x.jpg', size: 10, kept: false, because: 'Unticked by hand (Avatar of Person X (people))',
    reference: 'Avatar of Person X (people)' },
  { key: 'misc/c.pdf', size: 10, kept: true, because: 'Ticked by hand', reference: null },
  { key: 'assets/b.jpg', size: 10, kept: false, because: '—', reference: null },
];
const RECIPE_A = {
  id: 'r1', name: 'Recipe A', notes: '', tables: { people: { mode: 'rows', pks: [{ id: '1' }] } },
  files: { 'misc/c.pdf': true, 'avatars/x.jpg': false, 'gone/old.png': true },
};
const RECIPE_B = { id: 'r2', name: 'Recipe B', notes: '', tables: {}, files: { 'avatars/a.jpg': false } };

/** The files endpoint: filters by key and pages like the API. */
function serveFiles(all = FILES) {
  api.listFiles.mockImplementation((_s: string, _r: string, q: { page: number; size: number; filter?: string }) => {
    const m = q.filter ? all.filter((f) => f.key.toLowerCase().includes(q.filter!.toLowerCase())) : all;
    return Promise.resolve({ files: m.slice((q.page - 1) * q.size, q.page * q.size), total: m.length });
  });
}

beforeEach(() => {
  perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  snaps.listSnapshots.mockResolvedValue({ snapshots: [SNAP] });
  api.listRecipes.mockResolvedValue([
    { id: 'r1', name: 'Recipe A', notes: '', tables: 1, rows: 1, files: 2, updated_at: '' },
    { id: 'r2', name: 'Recipe B', notes: '', tables: 0, rows: 0, files: 1, updated_at: '' },
  ]);
  api.getRecipe.mockImplementation((id: string) => Promise.resolve(id === 'r2' ? RECIPE_B : RECIPE_A));
  api.openSnapshot.mockResolvedValue({ status: 'ready' });
  api.snapshotStatus.mockResolvedValue({ status: 'ready' });
  serveFiles();
  api.putRecipe.mockImplementation((id: string, body: object) => Promise.resolve({ id, notes: '', ...body }));
});
afterEach(cleanup);

async function pick(label: string, option: RegExp) {
  await userEvent.click(screen.getByLabelText(label));
  await waitFor(() => expect(document.querySelector('.combo-menu')).toBeTruthy());
  await userEvent.click(within(document.querySelector('.combo-menu') as HTMLElement).getByText(option));
}

async function openFiles() {
  render(<MemoryRouter><SeedSpaces /></MemoryRouter>);
  await waitFor(() => expect(api.listRecipes).toHaveBeenCalled());
  await pick('Recipe', /^Recipe A$/);
  await waitFor(() => expect(api.getRecipe).toHaveBeenCalled());
  await pick('Snapshot', new RegExp(SNAP.name));
  await screen.findByRole('checkbox', { name: 'Row avatars/a.jpg' });
}

const box = (key: string) => screen.getByRole('checkbox', { name: `Row ${key}` }) as HTMLInputElement;

async function saveBody() {
  await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }));
  await waitFor(() => expect(api.putRecipe).toHaveBeenCalled());
  return api.putRecipe.mock.calls.at(-1)!;
}

it('lists the files with their size and Kept because text', async () => {
  await openFiles();
  expect(api.listFiles).toHaveBeenCalledWith(SNAP.id, 'r1', expect.objectContaining({ page: 1 }));
  expect(screen.getByText('Avatar of Person A (people)')).toBeTruthy();
  expect(screen.getByText('Unticked by hand (Avatar of Person X (people))')).toBeTruthy();
  expect(screen.getByText('Ticked by hand')).toBeTruthy();
  expect(screen.getByText('1.5 KB')).toBeTruthy();
  expect(box('avatars/a.jpg').checked).toBe(true);
  expect(box('avatars/x.jpg').checked).toBe(false);
  expect(box('misc/c.pdf').checked).toBe(true);
  expect(box('assets/b.jpg').checked).toBe(false);
});

it('unticking a referenced file saves false, with the tables unchanged', async () => {
  await openFiles();
  fireEvent.click(box('avatars/a.jpg'));
  expect(box('avatars/a.jpg').checked).toBe(false);
  expect(screen.getByText('Unticked by hand (Avatar of Person A (people))')).toBeTruthy();
  const [id, body] = await saveBody();
  expect(id).toBe('r1');
  expect(body).toEqual({
    name: 'Recipe A', tables: TABLES,
    files: { 'avatars/a.jpg': false, 'misc/c.pdf': true, 'avatars/x.jpg': false, 'gone/old.png': true },
  });
});

it('re-ticking an unticked referenced file removes its override', async () => {
  await openFiles();
  fireEvent.click(box('avatars/x.jpg'));
  expect(box('avatars/x.jpg').checked).toBe(true);
  expect(screen.getByText('Avatar of Person X (people)')).toBeTruthy();
  const [, body] = await saveBody();
  expect(body.files).toEqual({ 'misc/c.pdf': true, 'gone/old.png': true });
});

it('ticking an unreferenced file saves true; unticking it again removes the override', async () => {
  await openFiles();
  fireEvent.click(box('assets/b.jpg'));
  expect(box('assets/b.jpg').checked).toBe(true);
  fireEvent.click(box('misc/c.pdf'));
  expect(box('misc/c.pdf').checked).toBe(false);
  const [, body] = await saveBody();
  expect(body.files).toEqual({ 'assets/b.jpg': true, 'avatars/x.jpg': false, 'gone/old.png': true });
});

it('Check all with a filter saves every matching key across pages', async () => {
  const many = Array.from({ length: 1203 }, (_, i) => ({
    key: `wiki/f${i}.png`, size: 1, kept: false, because: '—', reference: null,
  }));
  serveFiles([...FILES, ...many]);
  await openFiles();
  await userEvent.type(screen.getByLabelText('Filter'), 'wiki/');
  await waitFor(() => expect(api.listFiles).toHaveBeenLastCalledWith(
    SNAP.id, 'r1', expect.objectContaining({ filter: 'wiki/', page: 1 })));
  await userEvent.click(screen.getByRole('button', { name: 'Check all' }));
  await waitFor(() => expect(box('wiki/f0.png').checked).toBe(true));
  expect(api.listFiles).toHaveBeenCalledWith(SNAP.id, 'r1', { page: 2, size: 1000, filter: 'wiki/' });
  const [, body] = await saveBody();
  expect(Object.keys(body.files).filter((k) => k.startsWith('wiki/'))).toHaveLength(1203);
  expect(Object.values(body.files).filter((v) => v === true)).toHaveLength(1203 + 2);
  expect(body.files['avatars/a.jpg']).toBeUndefined();
});

it('Deselect all with no filter unticks every file', async () => {
  await openFiles();
  await userEvent.click(screen.getByRole('button', { name: 'Deselect all' }));
  await waitFor(() => expect(box('avatars/a.jpg').checked).toBe(false));
  const [, body] = await saveBody();
  expect(body.files).toEqual({ 'avatars/a.jpg': false, 'avatars/x.jpg': false, 'gone/old.png': true });
});

it('shift-click gives every file between the second one\'s state', async () => {
  await openFiles();
  fireEvent.click(box('avatars/a.jpg'));                     // off
  fireEvent.click(box('misc/c.pdf'), { shiftKey: true });    // off: a, x, c
  expect(box('avatars/x.jpg').checked).toBe(false);
  expect(box('misc/c.pdf').checked).toBe(false);
  const [, body] = await saveBody();
  expect(body.files).toEqual({ 'avatars/a.jpg': false, 'avatars/x.jpg': false, 'gone/old.png': true });
});

it('files answering snapshot_not_open re-open the snapshot', async () => {
  api.listFiles.mockRejectedValueOnce(new ApiError(409, 'snapshot_not_open'));
  await openFiles();
  expect(api.openSnapshot).toHaveBeenCalledTimes(2);
});

it('Save recipe needs change', async () => {
  perms.change = false;
  await openFiles();
  expect((screen.getByRole('button', { name: 'Save recipe' }) as HTMLButtonElement).disabled).toBe(true);
});

it('Save re-reads the recipe and sends its tables and name as saved now', async () => {
  await openFiles();
  fireEvent.click(box('avatars/a.jpg'));
  const NEWER = { people: { mode: 'rows', pks: [{ id: '1' }, { id: '2' }] } };
  api.getRecipe.mockClear();
  api.getRecipe.mockResolvedValueOnce({ ...RECIPE_A, name: 'Recipe A2', tables: NEWER, files: {} });
  const [id, body] = await saveBody();
  expect(api.getRecipe).toHaveBeenCalledWith('r1');
  expect(api.getRecipe.mock.invocationCallOrder[0]).toBeLessThan(api.putRecipe.mock.invocationCallOrder[0]);
  expect(id).toBe('r1');
  expect(body).toEqual({
    name: 'Recipe A2', tables: NEWER,
    files: { 'avatars/a.jpg': false, 'misc/c.pdf': true, 'avatars/x.jpg': false, 'gone/old.png': true },
  });
});

it('Check all is disabled while it runs, and its answer is dropped if the recipe changed meanwhile', async () => {
  await openFiles();
  let finish: (v: unknown) => void = () => {};
  api.listFiles.mockImplementationOnce(() => new Promise((res) => { finish = res; }));
  await userEvent.click(screen.getByRole('button', { name: 'Check all' }));
  expect((screen.getByRole('button', { name: 'Check all' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Deselect all' }) as HTMLButtonElement).disabled).toBe(true);
  await pick('Recipe', /^Recipe B$/);
  await waitFor(() => expect(api.listFiles).toHaveBeenLastCalledWith(SNAP.id, 'r2', expect.anything()));
  finish({ files: FILES, total: FILES.length });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Check all' }) as HTMLButtonElement).disabled).toBe(false));
  const [id, body] = await saveBody();
  expect(id).toBe('r2');
  expect(body.files).toEqual({ 'avatars/a.jpg': false });
});

it('a slow recipe answer doesn\'t replace the recipe picked after it', async () => {
  let finishA: (v: unknown) => void = () => {};
  api.getRecipe.mockImplementation((id: string) => (id === 'r1'
    ? new Promise((res) => { finishA = res; }) : Promise.resolve(RECIPE_B)));
  render(<MemoryRouter><SeedSpaces /></MemoryRouter>);
  await waitFor(() => expect(api.listRecipes).toHaveBeenCalled());
  await pick('Recipe', /^Recipe A$/);
  await pick('Recipe', /^Recipe B$/);
  await pick('Snapshot', new RegExp(SNAP.name));
  await screen.findByRole('checkbox', { name: 'Row avatars/a.jpg' });
  finishA(RECIPE_A);
  await new Promise((r) => setTimeout(r, 20));
  expect(api.listFiles).not.toHaveBeenCalledWith(SNAP.id, 'r1', expect.anything());
  expect(box('avatars/a.jpg').checked).toBe(false);   // Recipe B unticks it
});

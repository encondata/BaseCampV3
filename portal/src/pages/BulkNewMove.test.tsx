// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { MoveSetupDraft, SiteItem, StatusValue } from '../lib/api';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 60, godMode: false,
    can: () => true, preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));
const api = vi.hoisted(() => ({
  listSites: vi.fn(), listClients: vi.fn(), listPartners: vi.fn(),
  listInitiativeStatuses: vi.fn(), listInitiativeTypes: vi.fn(), listInitiativeSubTypes: vi.fn(),
  listShippingTypes: vi.fn(), listContainerTypes: vi.fn(),
  getNextInitiativeColor: vi.fn(), createMoveSetup: vi.fn(), patchMoveSetup: vi.fn(),
  getMoveSetup: vi.fn(), deleteMoveSetup: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
const { default: BulkNewMove } = await import('./BulkNewMove');

const SITES = [
  { id: 's-sjc', name: 'San Jose DC', code: 'SJC', archived_at: null, clients: [] },
  { id: 's-dal', name: 'Dallas DC', code: 'DAL', archived_at: null, clients: [] },
] as unknown as SiteItem[];

function draft(over: Partial<MoveSetupDraft> = {}): MoveSetupDraft {
  return {
    id: 'd1', status: 'preview', error: null, initiative_id: null, total_rows: 0,
    processed_rows: 0, results: null, created_at: '2026-09-24T00:00:00Z', previews: null,
    payload: { move: { name: 'SJC to DAL' }, assets: null, crates: null, trucks: null },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listSites.mockResolvedValue(SITES);
  for (const fn of [api.listClients, api.listPartners, api.listInitiativeStatuses,
    api.listInitiativeSubTypes, api.listShippingTypes, api.listContainerTypes]) {
    fn.mockResolvedValue([]);
  }
  api.listInitiativeTypes.mockResolvedValue([{ key: 'move', label: 'Move' }] as StatusValue[]);
  api.getNextInitiativeColor.mockResolvedValue('#8b3fb8');
  api.createMoveSetup.mockResolvedValue(draft());
  api.patchMoveSetup.mockResolvedValue(draft());
  api.deleteMoveSetup.mockResolvedValue(undefined);
});
afterEach(cleanup);

function mount() {
  return render(
    <MemoryRouter initialEntries={['/bulk/new-move']}>
      <Routes>
        <Route path="/bulk/new-move" element={<><Link to="/initiatives">Elsewhere</Link><BulkNewMove /></>} />
        <Route path="/initiatives" element={<p>Initiatives page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const heading = (text: string) => screen.findByRole('heading', { name: text });

async function fillMove(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getAllByRole('textbox')[0]!, 'SJC to DAL');
  const [origin, destination] = screen.getAllByPlaceholderText('Type to search sites…');
  await user.click(origin!);
  await user.click(await screen.findByText('San Jose DC'));
  await user.click(destination!);
  await user.click(await screen.findByText('Dallas DC'));
}

it('step 1 names what is missing, then creates the draft as a move', async () => {
  const user = userEvent.setup();
  mount();
  await heading('Step 1 of 5 · The move');
  expect(screen.queryByRole('button', { name: 'Skip this step' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByText('The move needs a name, an origin site, and a destination site.')).toBeTruthy();
  expect(api.createMoveSetup).not.toHaveBeenCalled();

  await fillMove(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await heading('Step 2 of 5 · From-To assets');
  expect(api.createMoveSetup).toHaveBeenCalledWith(expect.objectContaining({
    initiative_type: 'move', name: 'SJC to DAL',
    origin_site_id: 's-sjc', destination_site_id: 's-dal',
  }));
});

it('Back keeps what was entered and Next then updates the same draft', async () => {
  const user = userEvent.setup();
  mount();
  await heading('Step 1 of 5 · The move');
  await fillMove(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await heading('Step 2 of 5 · From-To assets');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await heading('Step 1 of 5 · The move');
  expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('SJC to DAL');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await heading('Step 2 of 5 · From-To assets');
  expect(api.createMoveSetup).toHaveBeenCalledTimes(1);
  expect(api.patchMoveSetup).toHaveBeenCalledWith('d1', { move: expect.objectContaining({ name: 'SJC to DAL' }) });
});

it('Skip this step saves the skip and moves on, with crates prefilled from the site codes', async () => {
  const user = userEvent.setup();
  mount();
  await heading('Step 1 of 5 · The move');
  await fillMove(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await heading('Step 2 of 5 · From-To assets');
  await user.click(screen.getByRole('button', { name: 'Skip this step' }));
  await heading('Step 3 of 5 · Crates');
  expect(api.patchMoveSetup).toHaveBeenCalledWith('d1', { skip: ['assets'] });
  expect((screen.getByLabelText('Naming convention') as HTMLInputElement).value).toBe('CRT-SJC-DAL-xxx');
});

it('leaving with a draft open asks first, and Discard deletes the draft', async () => {
  const user = userEvent.setup();
  mount();
  await heading('Step 1 of 5 · The move');
  await user.click(screen.getByText('Elsewhere'));              // no draft yet: just leaves
  expect(await screen.findByText('Initiatives page')).toBeTruthy();
  cleanup();

  mount();
  await heading('Step 1 of 5 · The move');
  await fillMove(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await heading('Step 2 of 5 · From-To assets');
  await user.click(screen.getByText('Elsewhere'));
  expect(await screen.findByRole('heading', { name: 'Discard this move setup?' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.queryByText('Discard this move setup?')).toBeNull();
  await user.click(screen.getByText('Elsewhere'));
  await user.click(await screen.findByRole('button', { name: 'Discard' }));
  expect(await screen.findByText('Initiatives page')).toBeTruthy();
  await waitFor(() => expect(api.deleteMoveSetup).toHaveBeenCalledWith('d1'));
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const authMock = vi.hoisted(() => ({
  canSites: true, canWorkers: true, canTrucks: true, canInitiatives: true, canAssets: true,
  canTime: true,
  denied: new Set<string>(),       // resource:action pairs refused on top of the flags
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 60, godMode: false,
    can: (resource: string, action = 'view') => !authMock.denied.has(`${resource}:${action}`) &&
      (resource === 'sites' ? authMock.canSites
        : resource === 'workers' ? authMock.canWorkers
        : resource === 'trucks' ? authMock.canTrucks
        : resource === 'initiatives' ? authMock.canInitiatives
        : resource === 'assets' ? authMock.canAssets
        : resource === 'time' ? authMock.canTime : true),
    preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));
afterEach(() => {
  cleanup();
  authMock.canSites = true;
  authMock.canWorkers = true;
  authMock.canTrucks = true;
  authMock.canInitiatives = true;
  authMock.canAssets = true;
  authMock.canTime = true;
  authMock.denied.clear();
});
const { default: BulkActions } = await import('./BulkActions');

it('renders the empty state until tools are added', () => {
  authMock.canSites = false;
  authMock.canWorkers = false;
  authMock.canTrucks = false;
  authMock.canInitiatives = false;
  authMock.canAssets = false;
  authMock.canTime = false;
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Bulk Actions' })).toBeTruthy();
  expect(screen.getByText('Nothing here yet')).toBeTruthy();
  expect(screen.getByText('Bulk tools will appear here as they are added.')).toBeTruthy();
});

it('lists the sites card when the viewer can add sites', () => {
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.getByText('Add or update sites in bulk')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(7);
});

it('lists the workers card only when the viewer can add workers', () => {
  authMock.canWorkers = false;
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.queryByText('Add or update workers in bulk')).toBeNull();
  cleanup();
  authMock.canWorkers = true;
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.getByText('Add or update workers in bulk')).toBeTruthy();
});

it('lists the trucks card only when the viewer can add trucks', () => {
  authMock.canTrucks = false;
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.queryByText('Add or update trucks in bulk')).toBeNull();
  cleanup();
  authMock.canTrucks = true;
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.getByText('Add or update trucks in bulk')).toBeTruthy();
});

it(`links the "Add or update a job's team in bulk" card to /bulk/initiative-people when the viewer can change initiatives`, () => {
  render(
    <MemoryRouter initialEntries={['/bulk']}>
      <Routes>
        <Route path="/bulk" element={<BulkActions />} />
        <Route path="/bulk/initiative-people" element={<div>initiative-people page</div>} />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByText("Add or update a job's team in bulk")).toBeTruthy();
  const card = screen.getByText("Add or update a job's team in bulk").closest('.bulk-card') as HTMLElement;
  fireEvent.click(within(card).getByRole('button', { name: 'Open' }));
  expect(screen.getByText('initiative-people page')).toBeTruthy();
});

it('lists the assets card only when the viewer can change assets, and links it to /bulk/assets', () => {
  authMock.canAssets = false;
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.queryByText('Update assets in bulk')).toBeNull();
  cleanup();
  authMock.canAssets = true;
  render(
    <MemoryRouter initialEntries={['/bulk']}>
      <Routes>
        <Route path="/bulk" element={<BulkActions />} />
        <Route path="/bulk/assets" element={<div>assets bulk page</div>} />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByText('Update assets in bulk')).toBeTruthy();
  const card = screen.getByText('Update assets in bulk').closest('.bulk-card') as HTMLElement;
  fireEvent.click(within(card).getByRole('button', { name: 'Open' }));
  expect(screen.getByText('assets bulk page')).toBeTruthy();
});

it('lists the "Create a move in steps" card and links it to /bulk/new-move', () => {
  render(
    <MemoryRouter initialEntries={['/bulk']}>
      <Routes>
        <Route path="/bulk" element={<BulkActions />} />
        <Route path="/bulk/new-move" element={<div>new move page</div>} />
      </Routes>
    </MemoryRouter>,
  );
  const card = screen.getByText('Create a move in steps').closest('.bulk-card') as HTMLElement;
  expect(within(card).getByText(
    'The move, its From-To assets, crates, and trucks — reviewed, then created together.')).toBeTruthy();
  fireEvent.click(within(card).getByRole('button', { name: 'Open' }));
  expect(screen.getByText('new move page')).toBeTruthy();
});

it('hides the "Create a move in steps" card from an admin without trucks:add or containers:add', () => {
  for (const missing of ['trucks:add', 'containers:add']) {
    authMock.denied.clear();
    authMock.denied.add(missing);
    render(<MemoryRouter><BulkActions /></MemoryRouter>);
    expect(screen.queryByText('Create a move in steps'), missing).toBeNull();
    expect(screen.getByText('Add or update sites in bulk')).toBeTruthy();     // others unchanged
    cleanup();
  }
});

it('lists the time punches card only for time:add', () => {
  authMock.denied.add('time:add');
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.queryByText('Add time punches in bulk')).toBeNull();
  cleanup();
  authMock.denied.clear();
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.getByText('Add time punches in bulk')).toBeTruthy();
  expect(screen.getByText('Load shifts from a spreadsheet or another timekeeping system. Workers, jobs, and sites are matched by name; review every shift before adding.')).toBeTruthy();
});

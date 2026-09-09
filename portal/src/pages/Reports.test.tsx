// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ReportDefinition, ReportRun, UiPreferences } from '../lib/api';

const auth = vi.hoisted(() => ({ can: (_r: string, _a?: string): boolean => true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can, godMode: false,
    preferences: { accent: 'blue', theme: 'dark', density: 'comfortable', motion: true,
      notif: { critical: true, email: true, maint: true, digest: true }, list_prefs: {} } satisfies UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));
vi.mock('../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({ status: { read_only: false, read_only_message: '', workers_paused: false, banner: null }, refresh: vi.fn() }),
}));
const api = vi.hoisted(() => ({
  listReportDefinitions: vi.fn(), cloneReportDefinition: vi.fn(), updateReportDefinition: vi.fn(),
  deleteReportDefinition: vi.fn(), listReportRuns: vi.fn(), getReportRun: vi.fn(),
  getReportRunDownloadUrl: vi.fn(), createReportRun: vi.fn(), setReportRunNotify: vi.fn(),
  listInitiatives: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));

const DEFS: ReportDefinition[] = [
  { id: 'd1', name: 'Move Report', description: 'The full move report', report_type: 'move_report',
    options: { summary: true, assets_by_source: true, assets_by_destination: true, size_weight: true,
      rail_usage: true, collisions: true, source_racks: true, destination_racks: true },
    is_system: true, updated_at: '2026-09-09T10:00:00Z' },
  { id: 'd2', name: 'Racks only', description: '', report_type: 'move_report',
    options: { summary: false, assets_by_source: false, assets_by_destination: false, size_weight: false,
      rail_usage: false, collisions: false, source_racks: true, destination_racks: true },
    is_system: false, updated_at: '2026-09-09T11:00:00Z' },
];
const RUNS: ReportRun[] = [];

const { default: Reports } = await import('./Reports');

function renderPage(path = '/reports') {
  return render(<MemoryRouter initialEntries={[path]}><Reports /></MemoryRouter>);
}

beforeEach(() => {
  auth.can = () => true;
  api.listReportDefinitions.mockResolvedValue(DEFS);
  api.listReportRuns.mockResolvedValue(RUNS);
  api.listInitiatives.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('lists definitions with section counts and a System badge', async () => {
  renderPage();
  await screen.findByText('Move Report', { selector: '.cell-primary' });
  expect(screen.getByText('Racks only')).toBeTruthy();
  expect(screen.getAllByText('8 of 8')[0]).toBeTruthy();
  expect(screen.getByText('2 of 8')).toBeTruthy();
  expect(screen.getAllByText('System')).toHaveLength(1);
});

it('row actions: Generate always; Edit/Clone/Delete by permission; Delete hidden on system rows', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Move Report', { selector: '.cell-primary' });
  const triggers = screen.getAllByRole('button', { name: /actions/i });
  await user.click(triggers[0]);                           // Move Report (system)
  expect(screen.getByText('Generate')).toBeTruthy();
  expect(screen.getByText('Edit')).toBeTruthy();
  expect(screen.getByText('Clone')).toBeTruthy();
  expect(screen.queryByText('Delete')).toBeNull();
  await user.keyboard('{Escape}');
  await user.click(triggers[1]);                           // Racks only (custom)
  expect(screen.getByText('Delete')).toBeTruthy();
});

it('hides Edit/Delete without change/delete; Generate and Clone need add', async () => {
  auth.can = (_r, a) => a === 'view' || a === 'add';
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Move Report', { selector: '.cell-primary' });
  await user.click(screen.getAllByRole('button', { name: /actions/i })[1]);
  expect(screen.getByText('Generate')).toBeTruthy();
  expect(screen.queryByText('Edit')).toBeNull();
  expect(screen.getByText('Clone')).toBeTruthy();
  expect(screen.queryByText('Delete')).toBeNull();
});

it('clone calls the API and reloads', async () => {
  const user = userEvent.setup();
  api.cloneReportDefinition.mockResolvedValue({ ...DEFS[1], id: 'd3', name: 'Racks only (copy)' });
  renderPage();
  await screen.findByText('Racks only');
  await user.click(screen.getAllByRole('button', { name: /actions/i })[1]);
  await user.click(screen.getByText('Clone'));
  await waitFor(() => expect(api.cloneReportDefinition).toHaveBeenCalledWith('d2'));
  expect(api.listReportDefinitions).toHaveBeenCalledTimes(2);
});

it('edit modal saves name and toggled defaults', async () => {
  const user = userEvent.setup();
  api.updateReportDefinition.mockResolvedValue({ ...DEFS[1], name: 'Racks!' });
  renderPage();
  await screen.findByText('Racks only');
  await user.click(screen.getAllByRole('button', { name: /actions/i })[1]);
  await user.click(screen.getByText('Edit'));
  const name = screen.getByLabelText('Name');
  await user.clear(name);
  await user.type(name, 'Racks!');
  await user.click(screen.getByLabelText(/^Summary/));    // turn summary on
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateReportDefinition).toHaveBeenCalledWith('d2', {
    name: 'Racks!', description: '',
    options: { ...DEFS[1].options, summary: true },
  }));
});

it('delete confirms then calls the API', async () => {
  const user = userEvent.setup();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.deleteReportDefinition.mockResolvedValue(undefined);
  renderPage();
  await screen.findByText('Racks only');
  await user.click(screen.getAllByRole('button', { name: /actions/i })[1]);
  await user.click(screen.getByText('Delete'));
  await waitFor(() => expect(api.deleteReportDefinition).toHaveBeenCalledWith('d2'));
});

it('tab query switches to History', async () => {
  renderPage('/reports?tab=history');
  await waitFor(() => expect(api.listReportRuns).toHaveBeenCalled());
  expect(screen.getByRole('tab', { name: /History/ }).className).toContain('on');
});

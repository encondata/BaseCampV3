// @vitest-environment jsdom
/**
 * /labels/containers — the three-step page (Initiative / Containers /
 * Generate): initiative picker, `ContainerPickList` wiring, Download PDF
 * (browser-side, via the shared `containerLabelSheet` module — mocked
 * here so this file tests wiring, not the drawing routine itself, which
 * has its own exactness tests), and "Generate as report" queueing.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ContainerItem, InitiativeItem, ReportDefinition, ReportRun } from '../lib/api';

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(), listContainers: vi.fn(), listReportDefinitions: vi.fn(),
  createReportRun: vi.fn(), getReportRun: vi.fn(), getReportRunDownloadUrl: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));

const sheet = vi.hoisted(() => ({ buildContainerLabelPdf: vi.fn(), save: vi.fn() }));
vi.mock('../labels/containerLabelSheet', async (importActual) => ({
  ...(await importActual<typeof import('../labels/containerLabelSheet')>()),
  buildContainerLabelPdf: sheet.buildContainerLabelPdf,
}));

const adapters = vi.hoisted(() => ({ loadTagImages: vi.fn() }));
vi.mock('../labels/containerLabelAdapters.browser', () => ({
  browserContainerLabelAdapters: { barcode: vi.fn(), qr: vi.fn() },
  loadTagImages: adapters.loadTagImages,
}));

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { default: ContainerLabels } = await import('./ContainerLabels');

const ini = (id: string, name: string, status: string): InitiativeItem => ({
  id, name, status, status_label: status, status_color: '#000', initiative_type: 'move',
  type_label: 'Move', type_color: '#000', client_name: 'Acme', archived_at: null,
  scheduled_start: '2026-10-01T00:00:00Z', scheduled_end: null,
  origin_site_name: 'NAP11', destination_site_name: 'NAP22',
  created_at: '2026-09-01T00:00:00Z',
} as unknown as InitiativeItem);
const INIS = [ini('i1', 'Zeta', 'completed'), ini('i2', 'NAP11 Hall Migration', 'in_progress')];

const container = (over: Partial<ContainerItem> = {}): ContainerItem => ({
  id: 'c1', name: 'Rack Cart 1', rfid_tag: null, container_type: 'cart', type_label: 'Cart',
  type_color: '#1890ff', status: 'available', status_label: 'Available', status_color: '#22aa55',
  site_id: null, site_name: null, location_detail: '', asset_count: 3,
  last_audit_at: null, last_validated_at: null, archived_at: null, created_at: '2026-09-01T00:00:00Z',
  initiative_id: 'i2', initiative_name: 'NAP11 Hall Migration',
  ...over,
});
const CONTAINERS = [
  container({ id: 'c1', name: 'Rack Cart 1' }),
  container({ id: 'c2', name: 'Server Bin' }),
];

const DEF: ReportDefinition = {
  id: 'd9', name: 'Container Labels', description: '', report_type: 'container_labels',
  is_system: true, updated_at: '2026-09-12T00:00:00Z', options: {},
};

const run = (over: Partial<ReportRun> = {}): ReportRun => ({
  id: 'r1', definition_id: 'd9', definition_name: 'Container Labels', report_type: 'container_labels',
  initiative_id: 'i2', initiative_name: 'NAP11 Hall Migration', options: {}, status: 'queued', error: null,
  requested_by: 'p1', requested_by_name: 'Alice', requested_rank: 40, notify: false, filename: null,
  size_bytes: null, started_at: null, finished_at: null, created_at: '2026-09-12T00:00:00Z', ...over,
});

beforeEach(() => {
  api.listInitiatives.mockResolvedValue(INIS);
  api.listContainers.mockResolvedValue(CONTAINERS);
  api.listReportDefinitions.mockResolvedValue([DEF]);
  api.createReportRun.mockResolvedValue(run());
  api.getReportRun.mockResolvedValue(run());
  api.getReportRunDownloadUrl.mockResolvedValue('https://spaces/x.pdf');
  adapters.loadTagImages.mockResolvedValue({});
  sheet.buildContainerLabelPdf.mockReturnValue({ save: sheet.save });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderAt() {
  return render(
    <MemoryRouter initialEntries={['/labels/containers']}>
      <Routes><Route path="/labels/containers" element={<ContainerLabels />} /></Routes>
    </MemoryRouter>,
  );
}

async function pickInitiativeAndContainers(user: ReturnType<typeof userEvent.setup>) {
  renderAt();
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByText('NAP11 Hall Migration'));
  await screen.findByText('Rack Cart 1');
  await user.click(screen.getByText('Rack Cart 1'));   // select c1
}

it('renders the eyebrow, title, and description', () => {
  renderAt();
  expect(screen.getByText('Labels')).not.toBeNull();
  expect(screen.getByRole('heading', { name: 'Container Labels' })).not.toBeNull();
  expect(screen.getByText(/Avery 5164 sheets/)).not.toBeNull();
});

it('shows the "select an initiative" empty state, then loads that initiative\'s containers', async () => {
  const user = userEvent.setup();
  renderAt();
  expect(screen.getByText('Select an initiative to view containers')).not.toBeNull();
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByText('NAP11 Hall Migration'));
  expect(await screen.findByText('Rack Cart 1')).not.toBeNull();
  expect(screen.getByText('Server Bin')).not.toBeNull();
  expect(api.listContainers).toHaveBeenCalledWith({ initiative_id: 'i2' });
});

it('shows "no containers" when the initiative has none', async () => {
  api.listContainers.mockResolvedValue([]);
  const user = userEvent.setup();
  renderAt();
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByText('NAP11 Hall Migration'));
  expect(await screen.findByText('No containers on this initiative')).not.toBeNull();
});

it('Download PDF calls save with "Container-Labels-<initiative name>.pdf" and the right input, loading only tags in use', async () => {
  const user = userEvent.setup();
  await pickInitiativeAndContainers(user);
  await user.click(screen.getByRole('button', { name: /Download PDF/ }));

  await waitFor(() => expect(sheet.save).toHaveBeenCalledWith('Container-Labels-NAP11 Hall Migration.pdf'));
  expect(adapters.loadTagImages).toHaveBeenCalledWith([]);   // nothing tagged yet
  const [input] = sheet.buildContainerLabelPdf.mock.calls[0];
  expect(input.move).toEqual({
    id: 'i2', name: 'NAP11 Hall Migration', sourceSite: 'NAP11', destSite: 'NAP22',
    scheduledStart: '2026-10-01T00:00:00Z',
  });
  expect(input.containers).toEqual([{ id: 'c1', name: 'Rack Cart 1', tag: null }]);
  expect(input.tagImages).toEqual({});
});

it('Download PDF passes tag images only for tags actually in use', async () => {
  const user = userEvent.setup();
  adapters.loadTagImages.mockResolvedValue({ priority: 'data:image/png;base64,AAA' });
  await pickInitiativeAndContainers(user);
  await user.click(screen.getByLabelText('Tag for Rack Cart 1'));
  await user.click(await screen.findByRole('menuitem', { name: /Priority/ }));

  await user.click(screen.getByRole('button', { name: /Download PDF/ }));
  await waitFor(() => expect(sheet.save).toHaveBeenCalled());
  expect(adapters.loadTagImages).toHaveBeenCalledWith(['priority']);
  const [input] = sheet.buildContainerLabelPdf.mock.calls.at(-1)!;
  expect(input.containers).toEqual([{ id: 'c1', name: 'Rack Cart 1', tag: 'priority' }]);
  expect(input.tagImages).toEqual({ priority: 'data:image/png;base64,AAA' });
});

it('Generate as report posts {container_ids, tags} against the container_labels definition', async () => {
  const user = userEvent.setup();
  await pickInitiativeAndContainers(user);
  await user.click(screen.getByLabelText('Tag for Rack Cart 1'));
  await user.click(await screen.findByRole('menuitem', { name: /Vendor/ }));

  await user.click(screen.getByRole('button', { name: 'Generate as report' }));
  await waitFor(() => expect(api.createReportRun).toHaveBeenCalledWith({
    definition_id: 'd9', initiative_id: 'i2',
    options: { container_ids: ['c1'], tags: { c1: 'vendor' } }, notify: false,
  }));
});

it('disables Generate as report with a hint when the definition is missing', async () => {
  api.listReportDefinitions.mockResolvedValue([]);
  const user = userEvent.setup();
  await pickInitiativeAndContainers(user);
  expect(await screen.findByText(/Container Labels report isn.t set up yet/))
    .not.toBeNull();
  expect((screen.getByRole('button', { name: 'Generate as report' }) as HTMLButtonElement).disabled)
    .toBe(true);
});

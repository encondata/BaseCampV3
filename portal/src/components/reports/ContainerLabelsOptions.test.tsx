// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ContainerItem, InitiativeItem, ReportDefinition } from '../../lib/api';

/** ContainerPickList reads `preferences.list_size` for the shared column floors
 *  (listScale, lib/listTools); nothing else in this tree touches auth. */
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ preferences: { list_size: 'default' } }),
}));

const api = vi.hoisted(() => ({ listContainers: vi.fn(), updateContainer: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: ContainerLabelsOptions } = await import('./ContainerLabelsOptions');

const DEF: ReportDefinition = {
  id: 'd9', name: 'Container Labels', description: 'Avery 5164 sheets.', report_type: 'container_labels',
  is_system: true, updated_at: '2026-09-12T00:00:00Z', options: {},
};

const INITIATIVE = {
  id: 'i2', name: 'NAP11 Hall Migration', client_name: 'Acme',
} as unknown as InitiativeItem;

const container = (over: Partial<ContainerItem> = {}): ContainerItem => ({
  id: 'c1', name: 'Rack Cart 1', rfid_tag: null, container_type: 'cart', type_label: 'Cart',
  type_color: '#1890ff', status: 'available', status_label: 'Available', status_color: '#22aa55',
  site_id: null, site_name: null, location_detail: '', asset_count: 3,
  last_audit_at: null, last_validated_at: null, archived_at: null, created_at: '2026-09-01T00:00:00Z',
  initiative_id: 'i2', initiative_name: 'NAP11 Hall Migration',
  ...over,
});
const CONTAINERS = [container({ id: 'c1', name: 'Rack Cart 1' }), container({ id: 'c2', name: 'Server Bin' })];

beforeEach(() => {
  api.listContainers.mockResolvedValue(CONTAINERS);
  api.updateContainer.mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('loads the initiative\'s containers and shows the preview count', async () => {
  render(<ContainerLabelsOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={() => {}} />);
  expect(await screen.findByText('Rack Cart 1')).toBeTruthy();
  expect(api.listContainers).toHaveBeenCalledWith({ initiative_id: 'i2' });
  expect(screen.getByText('2 containers on this initiative.')).toBeTruthy();
});

it('shows "no containers" when the initiative has none, and disables Generate', async () => {
  api.listContainers.mockResolvedValue([]);
  render(<ContainerLabelsOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={() => {}} />);
  expect(await screen.findByText('No containers on this initiative.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement).disabled).toBe(true);
});

it('Generate is disabled until at least one container is selected, then posts {container_ids, tags}', async () => {
  const user = userEvent.setup();
  const onGenerate = vi.fn();
  render(<ContainerLabelsOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={onGenerate} />);
  await screen.findByText('Rack Cart 1');
  expect((screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement).disabled).toBe(true);

  await user.click(screen.getByText('Rack Cart 1'));
  await user.click(screen.getByLabelText('Tag for Rack Cart 1'));
  await user.click(await screen.findByRole('menuitem', { name: /Ewaste|E-Waste/ }));
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));

  await waitFor(() => expect(onGenerate).toHaveBeenCalledWith({
    initiative_id: 'i2', options: { container_ids: ['c1'], tags: { c1: 'ewaste' } }, notify: false,
  }));
});

it('excludes a selected container currently hidden by the search box (V2 parity)', async () => {
  const user = userEvent.setup();
  const onGenerate = vi.fn();
  render(<ContainerLabelsOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={onGenerate} />);
  await screen.findByText('Rack Cart 1');
  await user.click(screen.getByText('Rack Cart 1'));
  await user.click(screen.getByText('Server Bin'));
  await user.type(screen.getByPlaceholderText('Search containers…'), 'rack'); // hides Server Bin

  expect(screen.getByText('2 selected · 1 hidden by search — 1 sheet.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  await waitFor(() => expect(onGenerate).toHaveBeenCalledWith({
    initiative_id: 'i2', options: { container_ids: ['c1'], tags: {} }, notify: false,
  }));
});

it('initializes tags from each container\'s stored label_tag', async () => {
  api.listContainers.mockResolvedValue([
    container({ id: 'c1', name: 'Rack Cart 1', label_tag: 'vendor' }),
    container({ id: 'c2', name: 'Server Bin', label_tag: null }),
  ]);
  render(<ContainerLabelsOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={() => {}} />);
  expect((await screen.findByLabelText('Tag for Rack Cart 1')).textContent).toContain('Vendor');
  expect(screen.getByLabelText('Tag for Server Bin').textContent).toContain('No tag');
});

it('a row tag change PATCHes that container with {label_tag} and refreshes the list', async () => {
  const user = userEvent.setup();
  render(<ContainerLabelsOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByText('Rack Cart 1');
  api.listContainers.mockClear();

  await user.click(screen.getByLabelText('Tag for Rack Cart 1'));
  await user.click(await screen.findByRole('menuitem', { name: /Priority/ }));

  await waitFor(() => expect(api.updateContainer).toHaveBeenCalledWith('c1', { label_tag: 'priority' }));
  await waitFor(() => expect(api.listContainers).toHaveBeenCalledWith({ initiative_id: 'i2' }));
});

it('bulk Set tag PATCHes only the selected containers, never an unselected one', async () => {
  api.listContainers.mockResolvedValue([
    ...CONTAINERS, container({ id: 'c3', name: 'Cable Tote' }),
  ]);
  const user = userEvent.setup();
  render(<ContainerLabelsOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByText('Rack Cart 1');
  await user.click(screen.getByText('Rack Cart 1'));
  await user.click(screen.getByText('Server Bin'));   // Cable Tote (c3) stays unselected

  await user.click(screen.getByRole('button', { name: 'Vendor' }));

  await waitFor(() => expect(api.updateContainer).toHaveBeenCalledWith('c1', { label_tag: 'vendor' }));
  expect(api.updateContainer).toHaveBeenCalledWith('c2', { label_tag: 'vendor' });
  expect(api.updateContainer).not.toHaveBeenCalledWith('c3', expect.anything());
  expect(api.updateContainer).toHaveBeenCalledTimes(2);
});

it('reverts a container\'s tag and shows the error strip when its PATCH is rejected', async () => {
  api.updateContainer.mockRejectedValue(new Error('nope'));
  const user = userEvent.setup();
  render(<ContainerLabelsOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByText('Rack Cart 1');

  await user.click(screen.getByLabelText('Tag for Rack Cart 1'));
  await user.click(await screen.findByRole('menuitem', { name: /Priority/ }));

  expect(await screen.findByText(/Couldn.t save one or more tags/)).toBeTruthy();
  await waitFor(() => expect(screen.getByLabelText('Tag for Rack Cart 1').textContent).toContain('No tag'));
});

it('a concurrent second tag change is not undone when an earlier one\'s PATCH later rejects', async () => {
  let rejectC1: (err: unknown) => void = () => {};
  const c1Pending = new Promise((_resolve, reject) => { rejectC1 = reject; });
  api.updateContainer.mockImplementation((id: string) => (id === 'c1' ? c1Pending : Promise.resolve({})));
  const user = userEvent.setup();
  render(<ContainerLabelsOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByText('Rack Cart 1');

  await user.click(screen.getByLabelText('Tag for Rack Cart 1'));
  await user.click(await screen.findByRole('menuitem', { name: /Priority/ }));
  expect(screen.getByLabelText('Tag for Rack Cart 1').textContent).toContain('Priority');

  await user.click(screen.getByLabelText('Tag for Server Bin'));
  await user.click(await screen.findByRole('menuitem', { name: /Vendor/ }));
  await waitFor(() => expect(screen.getByLabelText('Tag for Server Bin').textContent).toContain('Vendor'));

  rejectC1(new Error('nope'));
  await waitFor(() => expect(screen.getByLabelText('Tag for Rack Cart 1').textContent).toContain('No tag'));
  expect(screen.getByLabelText('Tag for Server Bin').textContent).toContain('Vendor');
});

it('Back calls onBack', async () => {
  const user = userEvent.setup();
  const onBack = vi.fn();
  render(<ContainerLabelsOptions definition={DEF} initiative={INITIATIVE}
                                  onBack={onBack} onGenerate={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(onBack).toHaveBeenCalled();
});

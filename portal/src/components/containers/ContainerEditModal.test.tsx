// @vitest-environment jsdom
/**
 * Container Labels task 3 added the Initiative ComboBox to this modal
 * (containers.initiative_id — migration 0057). This file only covers
 * that field: it seeds from the container, sends `initiative_id` (or
 * `null` when cleared) on submit, and stays optional/backward-compatible
 * for callers (e.g. Warehouse.tsx) that don't pass `initiatives` at all.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ContainerItem, InitiativeItem } from '../../lib/api';

const api = vi.hoisted(() => ({ createContainer: vi.fn(), updateContainer: vi.fn(), listContainerAssets: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { default: ContainerEditModal } = await import('./ContainerEditModal');

const CONTAINER: ContainerItem = {
  id: 'c1', name: 'Rack Cart 1', rfid_tag: null, container_type: null, type_label: null,
  type_color: null, status: 'available', status_label: 'Available', status_color: '#22aa55',
  site_id: null, site_name: null, location_detail: '', asset_count: 0,
  last_audit_at: null, last_validated_at: null, archived_at: null, created_at: '2026-09-01T00:00:00Z',
  initiative_id: 'i1', initiative_name: 'NAP11 Hall Migration',
  label_tag: 'priority',
};

const INITIATIVES: InitiativeItem[] = [
  { id: 'i1', name: 'NAP11 Hall Migration', client_name: 'Acme' } as unknown as InitiativeItem,
  { id: 'i2', name: 'Zeta Decommission', client_name: 'Globex' } as unknown as InitiativeItem,
];

beforeEach(() => {
  api.updateContainer.mockResolvedValue({ ...CONTAINER });
  api.createContainer.mockResolvedValue({ ...CONTAINER, id: 'c9' });
  api.listContainerAssets.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('seeds the Initiative field from the container and submits its id unchanged', async () => {
  const user = userEvent.setup();
  render(<ContainerEditModal container={CONTAINER} statuses={[]} types={[]} sites={[]}
                              initiatives={INITIATIVES} canChange
                              onClose={() => {}} onSaved={() => {}} />);
  expect(screen.getByDisplayValue('NAP11 Hall Migration')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateContainer).toHaveBeenCalled());
  expect(api.updateContainer.mock.calls[0][1]).toMatchObject({ initiative_id: 'i1' });
});

it('picking a different initiative sends its id', async () => {
  const user = userEvent.setup();
  render(<ContainerEditModal container={CONTAINER} statuses={[]} types={[]} sites={[]}
                              initiatives={INITIATIVES} canChange
                              onClose={() => {}} onSaved={() => {}} />);
  await user.click(screen.getByDisplayValue('NAP11 Hall Migration'));
  await user.click(await screen.findByText('Zeta Decommission'));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateContainer).toHaveBeenCalled());
  expect(api.updateContainer.mock.calls[0][1]).toMatchObject({ initiative_id: 'i2' });
});

it('clearing the initiative sends null', async () => {
  const user = userEvent.setup();
  render(<ContainerEditModal container={CONTAINER} statuses={[]} types={[]} sites={[]}
                              initiatives={INITIATIVES} canChange
                              onClose={() => {}} onSaved={() => {}} />);
  const wrap = screen.getByDisplayValue('NAP11 Hall Migration').closest('.combo-wrap') as HTMLElement;
  await user.click(within(wrap).getByRole('button', { name: 'Clear' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateContainer).toHaveBeenCalled());
  expect(api.updateContainer.mock.calls[0][1]).toMatchObject({ initiative_id: null });
});

it('renders with no `initiatives` prop at all (Warehouse.tsx-style caller) without crashing', () => {
  render(<ContainerEditModal container={CONTAINER} statuses={[]} types={[]} sites={[]} canChange
                              onClose={() => {}} onSaved={() => {}} />);
  expect(screen.getByDisplayValue('NAP11 Hall Migration')).toBeTruthy(); // still shows the seeded label
});

it('seeds the Label tag field from the container and submits it unchanged', async () => {
  const user = userEvent.setup();
  render(<ContainerEditModal container={CONTAINER} statuses={[]} types={[]} sites={[]}
                              initiatives={INITIATIVES} canChange
                              onClose={() => {}} onSaved={() => {}} />);
  expect(screen.getByDisplayValue('Priority')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateContainer).toHaveBeenCalled());
  expect(api.updateContainer.mock.calls[0][1]).toMatchObject({ label_tag: 'priority' });
});

it('picking a different label tag sends its key', async () => {
  const user = userEvent.setup();
  render(<ContainerEditModal container={CONTAINER} statuses={[]} types={[]} sites={[]}
                              initiatives={INITIATIVES} canChange
                              onClose={() => {}} onSaved={() => {}} />);
  await user.click(screen.getByDisplayValue('Priority'));
  await user.click(await screen.findByText('Vendor'));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateContainer).toHaveBeenCalled());
  expect(api.updateContainer.mock.calls[0][1]).toMatchObject({ label_tag: 'vendor' });
});

it('clearing the label tag sends null', async () => {
  const user = userEvent.setup();
  render(<ContainerEditModal container={CONTAINER} statuses={[]} types={[]} sites={[]}
                              initiatives={INITIATIVES} canChange
                              onClose={() => {}} onSaved={() => {}} />);
  const wrap = screen.getByDisplayValue('Priority').closest('.combo-wrap') as HTMLElement;
  await user.click(within(wrap).getByRole('button', { name: 'Clear' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateContainer).toHaveBeenCalled());
  expect(api.updateContainer.mock.calls[0][1]).toMatchObject({ label_tag: null });
});

it('create mode starts with no label tag selected', () => {
  render(<ContainerEditModal container={null} statuses={[]} types={[]} sites={[]}
                              initiatives={INITIATIVES} canChange
                              onClose={() => {}} onSaved={() => {}} />);
  expect(screen.getByPlaceholderText('None')).toBeTruthy();
});

it('sorts initiative options newest-first without filtering any out', async () => {
  const user = userEvent.setup();
  const initiatives: InitiativeItem[] = [
    { id: 'old', name: 'Old One', client_name: 'A', created_at: '2026-01-01T00:00:00Z' } as unknown as InitiativeItem,
    { id: 'new', name: 'New One', client_name: 'B', created_at: '2026-09-01T00:00:00Z' } as unknown as InitiativeItem,
  ];
  render(<ContainerEditModal container={{ ...CONTAINER, initiative_id: null, initiative_name: null }}
                              statuses={[]} types={[]} sites={[]} initiatives={initiatives} canChange
                              onClose={() => {}} onSaved={() => {}} />);
  await user.click(screen.getByPlaceholderText('Type to search initiatives…'));
  const items = screen.getAllByRole('button').filter((b) => b.className.includes('kbar-item'));
  expect(items).toHaveLength(2);
  expect(items[0].textContent?.startsWith('New One')).toBe(true);
  expect(items[1].textContent?.startsWith('Old One')).toBe(true);
});

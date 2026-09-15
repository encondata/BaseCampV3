// @vitest-environment jsdom
/**
 * InitiativeEditModal — the Color field. Covers: create mode opening the
 * wheel on the color GET /initiatives/next-color would assign (and the
 * hint that says so), a failed lookup falling back to the first palette
 * color without blocking the modal, edit mode opening on the stored color
 * and falling back to the status color when there is none, the new color
 * reaching the save payload, and the existing error surface still showing
 * a mapped message.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, type InitiativeItem, type OrgRef, type SiteItem, type StatusValue,
} from '../../lib/api';

const api = vi.hoisted(() => ({
  getNextInitiativeColor: vi.fn(),
  createInitiative: vi.fn(),
  updateInitiative: vi.fn(),
  archiveInitiative: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { default: InitiativeEditModal } = await import('./InitiativeEditModal');

// RTL's auto-cleanup only self-registers when `afterEach` is a real global
// (vitest globals: true); this repo doesn't set that.
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.getNextInitiativeColor.mockResolvedValue('#8b3fb8');
});

function initiative(over: Partial<InitiativeItem> = {}): InitiativeItem {
  return {
    id: 'i1', name: 'Denver DC migration', description: null,
    initiative_type: 'project', type_label: 'Project', type_color: '#1668a7',
    sub_type: null, sub_type_label: null, sub_type_color: null,
    status: 'planned', status_label: 'Planned', status_color: '#178a4c',
    color: null,
    client_id: null, client_name: null, site_id: null, site_name: null,
    location: null,
    scheduled_start: null, scheduled_end: null,
    sky_command_project_id: null,
    origin_site_id: null, origin_site_name: null,
    destination_site_id: null, destination_site_name: null,
    real_start_at: null, real_end_at: null, priority_devices: null,
    shipping_types: [],
    shipping_partner_id: null, shipping_partner_name: null,
    origin_tech_partner_id: null, origin_cable_partner_id: null,
    origin_logistics_partner_id: null, destination_tech_partner_id: null,
    destination_cable_partner_id: null, destination_logistics_partner_id: null,
    origin_vendor_involved: null, destination_vendor_involved: null,
    people_count: 0, links_count: 0,
    archived_at: null, created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const vocab = (key: string, label: string, color: string): StatusValue => ({
  record_type: 'initiative', key, label, description: '', color,
  sort_order: 1, is_active: true, usage_count: null, progress_weight: null,
});

const STATUSES = [vocab('planned', 'Planned', '#178a4c')];
const TYPES = [vocab('project', 'Project', '#1668a7')];
const SITES: SiteItem[] = [];
const ORGS: OrgRef[] = [];

function renderModal(row: InitiativeItem | null) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<InitiativeEditModal
    initiative={row}
    statuses={STATUSES} types={TYPES} subTypes={[]} shippingTypes={[]}
    sites={SITES} clients={ORGS} partners={ORGS}
    isAdmin canChange onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}

const hexField = () => screen.getByLabelText('Hex') as HTMLInputElement;
// The modal's own labels are siblings of their inputs (no htmlFor), so the
// Name box is reached positionally: it is the first textbox in the form.
const nameField = () => screen.getAllByRole('textbox')[0] as HTMLInputElement;

it('create mode opens the wheel on the color a create would assign', async () => {
  renderModal(null);

  await waitFor(() => expect(hexField().value).toBe('#8b3fb8'));
  expect(api.getNextInitiativeColor).toHaveBeenCalledTimes(1);
  expect(screen.getByText(
    'Assigned automatically — spin the wheel to choose your own.')).toBeTruthy();
});

it('a failed next-color lookup falls back without blocking the modal', async () => {
  api.getNextInitiativeColor.mockRejectedValue(new ApiError(500, 'boom'));
  renderModal(null);

  await waitFor(() => expect(hexField().value).toBe('#1668a7'));
  expect(document.querySelector('.pf-error')).toBeNull();
  const save = screen.getByRole('button', { name: 'Create initiative' });
  expect((save as HTMLButtonElement).disabled).toBe(false);
});

it('edit mode opens on the stored color and asks for no new one', async () => {
  renderModal(initiative({ color: '#c03540' }));

  expect(hexField().value).toBe('#c03540');
  await waitFor(() => expect(api.getNextInitiativeColor).not.toHaveBeenCalled());
});

it('edit mode falls back to the status color when none was ever set', () => {
  renderModal(initiative({ color: null, status_color: '#178a4c' }));

  expect(hexField().value).toBe('#178a4c');
});

it('a new color from the wheel reaches the update payload', async () => {
  const user = userEvent.setup();
  api.updateInitiative.mockResolvedValue(initiative());
  const { onSaved } = renderModal(initiative({ color: '#c03540' }));

  await user.clear(hexField());
  await user.type(hexField(), '#6d4fc4');
  await user.tab();   // commit on blur
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.updateInitiative).toHaveBeenCalledTimes(1));
  expect(api.updateInitiative).toHaveBeenCalledWith(
    'i1', expect.objectContaining({ color: '#6d4fc4' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

it('create sends the assigned color with the rest of the form', async () => {
  const user = userEvent.setup();
  api.createInitiative.mockResolvedValue(initiative());
  renderModal(null);

  await waitFor(() => expect(hexField().value).toBe('#8b3fb8'));
  await user.type(nameField(), 'Phoenix refresh');
  await user.click(screen.getByRole('button', { name: 'Create initiative' }));

  await waitFor(() => expect(api.createInitiative).toHaveBeenCalledTimes(1));
  expect(api.createInitiative).toHaveBeenCalledWith(expect.objectContaining({
    name: 'Phoenix refresh', color: '#8b3fb8',
  }));
});

it('a save failure still surfaces the mapped error message', async () => {
  const user = userEvent.setup();
  api.updateInitiative.mockRejectedValue(new ApiError(422, 'name_required'));
  renderModal(initiative({ color: '#c03540' }));

  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('Name is required.')).toBeTruthy();
});

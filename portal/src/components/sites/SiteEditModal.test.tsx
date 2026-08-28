// @vitest-environment jsdom
/**
 * The create-mode retry trap described in this modal's header comment: once
 * createSite succeeds, a retry after a failed client-link step must NOT
 * re-create the site.
 *
 * lib/sites.test.ts already covers needsSiteCreate and afterSiteClientsFailure
 * as pure functions. What is asserted here is the wiring those helpers depend
 * on — that createdId survives the failed link and re-routes the second submit
 * onto the update path. Nothing but the header comment guarded that before.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type SiteItem, type SiteLookup, type SurveySchema } from '../../lib/api';
import { SITE_CREATED_UNLINKED_MESSAGE } from '../../lib/sites';

const api = vi.hoisted(() => ({
  createSite: vi.fn(),
  updateSite: vi.fn(),
  setSiteClients: vi.fn(),
  listSiteSurvey: vi.fn(),
  putSiteSurveyValue: vi.fn(),
  clearSiteSurveyValue: vi.fn(),
  archiveSite: vi.fn(),
  getSurveySchema: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const CLIENTS = [{ id: 'client-1', name: 'Northwind Traders' }];

function lookup(key: string, label: string): SiteLookup {
  return { key, label, description: '', sort_order: 0, icon: null, color: null };
}

const STATUSES = [lookup('active', 'Active')];
const TYPES = [lookup('depot', 'Depot')];

beforeEach(() => {
  vi.clearAllMocks();
  api.getSurveySchema.mockResolvedValue({ groups: [] });
  api.listSiteSurvey.mockResolvedValue([]);
  api.createSite.mockResolvedValue({ id: 'site-99', archived_at: null });
  api.updateSite.mockResolvedValue({ id: 'site-99' });
});

afterEach(cleanup);

const { default: SiteEditModal } = await import('./SiteEditModal');

const SITE: SiteItem = {
  id: 'site-1', name: 'Depot 7', code: 'D7',
  site_type: 'depot', type_label: 'Depot', type_color: null,
  status: 'active', status_label: 'Active', status_color: '#178a4c',
  address_line1: null, address_line2: null, city: null, region: null,
  postal_code: null, country: 'US', latitude: null, longitude: null,
  timezone: null, dc_provider: null, partner_id: null, partner_name: null,
  notes: null, archived_at: null, created_at: '2026-07-15T00:00:00Z',
  clients: [],
};

const SURVEY_SCHEMA: SurveySchema = { groups: [{ key: 'dock', label: 'Dock', fields: [
  { key: 'dock_hours', label: 'Dock hours', kind: 'text', options: [] },
] }] };

function renderEditModal() {
  const onSaved = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <SiteEditModal
      site={SITE}
      types={TYPES}
      statuses={STATUSES}
      clients={CLIENTS}
      partners={[]}
      canChange
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onSaved, onClose };
}

function renderCreateModal() {
  const onSaved = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <SiteEditModal
      site={null}
      types={TYPES}
      statuses={STATUSES}
      clients={CLIENTS}
      partners={[]}
      canChange
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onSaved, onClose };
}

it('does not re-create the site when a retry follows a failed client link', async () => {
  const user = userEvent.setup();
  api.setSiteClients.mockRejectedValueOnce(new ApiError(409, 'unknown_error'));

  renderCreateModal();

  // name is the only required field
  const name = document.querySelector<HTMLInputElement>('.pf-form input')!;
  await user.type(name, 'Depot 7');

  // link a client so the create path reaches setSiteClients
  await user.click(screen.getByPlaceholderText('Add a client…'));
  await user.click(await screen.findByText('Northwind Traders'));

  await user.click(screen.getByRole('button', { name: 'Create site' }));

  // the site exists but is unlinked — the modal says so and stays open
  expect(await screen.findByText(SITE_CREATED_UNLINKED_MESSAGE)).toBeDefined();
  expect(api.createSite).toHaveBeenCalledTimes(1);

  // the modal has flipped itself to edit mode — the create affordance is gone
  expect(screen.queryByRole('button', { name: 'Create site' })).toBeNull();

  // RETRY
  api.setSiteClients.mockResolvedValueOnce(undefined);
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.updateSite).toHaveBeenCalledTimes(1));

  // the trap: still exactly one create, and the retry updated the created id
  expect(api.createSite).toHaveBeenCalledTimes(1);
  expect(api.updateSite).toHaveBeenCalledWith('site-99', expect.anything());
});

/**
 * Survey save loop (SiteEditModal ~submit): per-field PUT/DELETE against the
 * loaded baseline, diffed on CLEANED values via lib/sites.ts's
 * `surveySaveOps` (unit-tested exhaustively in lib/sites.test.ts). These
 * integration tests drive the real modal/SurveyForm wiring end to end —
 * proving the component actually calls the diffed ops, not just that the
 * pure function returns the right thing.
 */
describe('survey save loop', () => {
  beforeEach(() => {
    api.getSurveySchema.mockResolvedValue(SURVEY_SCHEMA);
    api.listSiteSurvey.mockResolvedValue([
      { field_key: 'dock_hours', label: 'Dock hours', group: 'dock', group_label: 'Dock',
        kind: 'text', options: [], value: 'Dock A', raw_id: 1,
        updated_by: null, updated_by_name: null, updated_at: null },
    ]);
  });

  it('a changed field fires exactly one PUT with the right key+value', async () => {
    const user = userEvent.setup();
    renderEditModal();

    const field = await screen.findByDisplayValue('Dock A');
    await user.clear(field);
    await user.type(field, 'Dock B');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.putSiteSurveyValue).toHaveBeenCalledTimes(1));
    expect(api.putSiteSurveyValue).toHaveBeenCalledWith('site-1', 'dock_hours', 'Dock B');
    expect(api.clearSiteSurveyValue).not.toHaveBeenCalled();
  });

  it('a field cleared (baseline answered, now empty) fires exactly one clear call', async () => {
    const user = userEvent.setup();
    renderEditModal();

    const field = await screen.findByDisplayValue('Dock A');
    await user.clear(field);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.clearSiteSurveyValue).toHaveBeenCalledTimes(1));
    expect(api.clearSiteSurveyValue).toHaveBeenCalledWith('site-1', 'dock_hours');
    expect(api.putSiteSurveyValue).not.toHaveBeenCalled();
  });

  it('an untouched field makes no survey call', async () => {
    const user = userEvent.setup();
    renderEditModal();

    await screen.findByDisplayValue('Dock A');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateSite).toHaveBeenCalledTimes(1));
    expect(api.putSiteSurveyValue).not.toHaveBeenCalled();
    expect(api.clearSiteSurveyValue).not.toHaveBeenCalled();
  });

  it('a no-op edit that differs only pre-cleaning (trailing whitespace) makes no call', async () => {
    const user = userEvent.setup();
    renderEditModal();

    const field = await screen.findByDisplayValue('Dock A');
    await user.type(field, '  ');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateSite).toHaveBeenCalledTimes(1));
    expect(api.putSiteSurveyValue).not.toHaveBeenCalled();
    expect(api.clearSiteSurveyValue).not.toHaveBeenCalled();
  });
});

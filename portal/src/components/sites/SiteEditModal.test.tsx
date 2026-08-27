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
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type SiteLookup } from '../../lib/api';
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

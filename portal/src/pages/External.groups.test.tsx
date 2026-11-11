// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ExternalPersonItem } from '../lib/api';

afterEach(cleanup);

const auth = vi.hoisted(() => ({ global: true }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => true,
    godMode: false,
    scope: { global: auth.global, client_ids: auth.global ? [] : ['c1'], partner_ids: [] },
  }),
}));

const api = vi.hoisted(() => ({
  patchContactLink: vi.fn(() => Promise.resolve({})),
  removeContactLink: vi.fn(() => Promise.resolve()),
  addContactLink: vi.fn(() => Promise.resolve()),
  listOrgContacts: vi.fn(),
  listClientGroups: vi.fn(),
}));

vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), ...api }));

import { EditPersonModal } from './External';

const person = (tier: string, kind = 'client'): ExternalPersonItem => ({
  person_id: 'p1', display_name: 'Pat Doe', first_name: 'Pat', last_name: 'Doe',
  email: 'pat@x.com', phone: null, avatar_url: null, has_login: true,
  login_status: 'active',
  links: [{ kind, org_id: 'c1', org_name: 'Acme', tier, org_title: null, functions: [] }],
} as unknown as ExternalPersonItem);

const GROUPS = [
  { id: 'g1', name: 'Dallas', aliases: [], asset_count: 3, people_count: 1 },
  { id: 'g2', name: 'Austin', aliases: [], asset_count: 2, people_count: 0 },
];

function open(p: ExternalPersonItem) {
  return render(
    <EditPersonModal person={p} allOrgs={[]} loadAllOrgs={() => {}} functionTags={[]}
      canClients canPartners canUsers canGrantLogin={false}
      onClose={() => {}} onChanged={() => {}} />,
  );
}

function contact(tier: string, group_ids: string[], restricted: boolean) {
  api.listOrgContacts.mockResolvedValue([{ person_id: 'p1', tier, group_ids, restricted }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.global = true;
  api.listClientGroups.mockResolvedValue(GROUPS);
});

it('offers Individual for client links to staff, never for partner links', async () => {
  contact('viewer', [], false);
  const { unmount } = open(person('viewer'));
  const sel = (await screen.findAllByRole('combobox'))[0] as HTMLSelectElement;
  expect(within(sel).queryByRole('option', { name: 'Individual' })).not.toBeNull();
  unmount();
  open(person('viewer', 'partner'));
  const sel2 = (await screen.findAllByRole('combobox'))[0] as HTMLSelectElement;
  expect(within(sel2).queryByRole('option', { name: 'Individual' })).toBeNull();
});

it('saves chips as group_ids', async () => {
  contact('viewer', [], false);
  open(person('viewer'));
  const input = await screen.findByPlaceholderText('All groups.');
  fireEvent.focus(input);
  fireEvent.mouseDown(await screen.findByText('Dallas'));
  await waitFor(() => expect(api.patchContactLink)
    .toHaveBeenCalledWith('client', 'c1', 'p1', { group_ids: ['g1'] }));
});

it('shows saved chips dimmed with the note on an owner link', async () => {
  contact('owner', ['g1'], true);
  open(person('owner'));
  expect(await screen.findByText('Owners and admins see every group.')).not.toBeNull();
  expect(screen.getByText('Dallas')).not.toBeNull();
});

it('says what an individual with no chips sees', async () => {
  contact('individual', [], true);
  open(person('individual'));
  expect(await screen.findByPlaceholderText('No groups — sees no assets.')).not.toBeNull();
});

it('a client login sees the tier locked and no Remove on a restricted contact, and no chips', async () => {
  auth.global = false;
  contact('individual', ['g1'], true);
  open(person('individual'));
  await waitFor(() => expect(api.listOrgContacts).toHaveBeenCalled());
  await waitFor(() => expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).disabled).toBe(true));
  expect(screen.queryByTitle('Remove link')).toBeNull();
  expect(screen.queryByText('Groups')).toBeNull();
  expect(api.listClientGroups).not.toHaveBeenCalled();
});

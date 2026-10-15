// @vitest-environment jsdom
/** The Users list expansion offers a Full details link to the detail page. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LIST_FIT } from '../lib/listTools';

const auth = vi.hoisted(() => ({ maxRank: 100, passwordMinLength: 8 }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: auth.maxRank, godMode: false,
    passwordMinLength: auth.passwordMinLength,
    can: () => true,
    preferences: { list_prefs: {}, list_size: 'default' }, updatePreferences: vi.fn(),
  }),
}));

const sys = vi.hoisted(() => ({ email_enabled: false }));
vi.mock('../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({ status: { email_enabled: sys.email_enabled }, refresh: () => {} }),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('../lib/notificationsContext', async (importActual) => ({
  ...(await importActual<typeof import('../lib/notificationsContext')>()),
  useToast: () => toast,
}));

const ROW = {
  person_id: 'p1', first_name: 'Wan', last_name: 'Worker', preferred_name: null, display_name: 'Wan Worker',
  job_title: null, phone: null, contact_email: null, login_email: 'wan@x.test', roles: ['staff'],
  status: 'active', must_change_password: false, last_login_at: null, account_created_at: '2026-01-01T00:00:00Z',
  archived_at: null, avatar_url: null, max_rank: 40,
};

beforeEach(() => {
  auth.maxRank = 100;
  auth.passwordMinLength = 8;
  sys.email_enabled = false;
  toast.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([ROW]), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const { default: Users } = await import('./Users');

it('the Actions menu shows a Full details link to /people/users/:id, without expanding the row', async () => {
  render(
    <MemoryRouter initialEntries={['/people/users']}>
      <Routes>
        <Route path="/people/users" element={<Users />} />
        <Route path="/people/users/:personId" element={<div>DETAIL PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('Wan Worker');
  fireEvent.click(screen.getAllByRole('button', { name: /actions/i })[0]);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Full details' }));
  expect(await screen.findByText('DETAIL PAGE')).toBeTruthy();
});

it('a manage-able row lists Full details, Edit profile, Reset password, Manage roles, Disable account', async () => {
  render(
    <MemoryRouter initialEntries={['/people/users']}>
      <Routes>
        <Route path="/people/users" element={<Users />} />
        <Route path="/people/users/:personId" element={<div>DETAIL PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('Wan Worker');
  fireEvent.click(screen.getAllByRole('button', { name: /actions/i })[0]);
  expect(await screen.findByRole('menuitem', { name: 'Full details' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Edit profile' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Reset password' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Manage roles' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Disable account' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Demote to worker' })).toBeTruthy();
});

it('Demote to worker from the row menu confirms, posts, and reloads the list', async () => {
  render(
    <MemoryRouter initialEntries={['/people/users']}>
      <Routes>
        <Route path="/people/users" element={<Users />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('Wan Worker');
  fireEvent.click(screen.getAllByRole('button', { name: /actions/i })[0]);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Demote to worker' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Demote' }));
  // This file mocks the global `fetch` rather than `lib/api.ts` (no
  // hoisted `api` object here), so "posts, and reloads the list" is
  // verified against that fetch mock's calls: a POST to the demote
  // endpoint, then a second GET of the list.
  const calls = () => vi.mocked(fetch).mock.calls;
  await waitFor(() => expect(calls().some(([url, init]) =>
    String(url).endsWith('/p1/demote') && (init as RequestInit | undefined)?.method === 'POST',
  )).toBe(true));
  await waitFor(() => expect(calls().filter(([url, init]) =>
    String(url).endsWith('/users') && !(init as RequestInit | undefined)?.method,
  ).length).toBe(2));
});

it('the self row and an outranked row do not list Demote to worker', async () => {
  auth.maxRank = 60;   // an admin: can't touch another admin (rank 60), can't target self
  const SELF = { ...ROW, person_id: 'me-1', display_name: 'Me Myself', first_name: 'Me', last_name: 'Myself',
    login_email: 'me@x.test', max_rank: 60 };
  const PEER = { ...ROW, person_id: 'p2', display_name: 'Ada Admin', first_name: 'Ada', last_name: 'Admin',
    login_email: 'ada@x.test', roles: ['admin'], max_rank: 60 };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([SELF, PEER]), { status: 200 })));
  render(
    <MemoryRouter initialEntries={['/people/users']}>
      <Routes>
        <Route path="/people/users" element={<Users />} />
      </Routes>
    </MemoryRouter>,
  );
  for (const name of ['Me Myself', 'Ada Admin']) {
    const row = (await screen.findByText(name)).closest('.dir-row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /actions/i }));
    expect(await screen.findByRole('menuitem', { name: 'Full details' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Demote to worker' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Full details' })).toBeNull());
  }
});

it('clicking the Actions trigger does not expand the row', async () => {
  const { container } = render(
    <MemoryRouter initialEntries={['/people/users']}>
      <Routes>
        <Route path="/people/users" element={<Users />} />
        <Route path="/people/users/:personId" element={<div>DETAIL PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('Wan Worker');
  fireEvent.click(screen.getAllByRole('button', { name: /actions/i })[0]);
  await screen.findByRole('menuitem', { name: 'Full details' });
  // Expansion is driven by the `open` class on `.dir-row` (CSS
  // grid-rows collapse, not conditional mounting), so the real signal
  // that the row did NOT expand is the class staying off, not the
  // detail markup's absence from the tree.
  const row = container.querySelector('.dir-row');
  expect(row?.className).not.toMatch(/\bopen\b/);
});

it('Users list: column floors, shared template + minimum, sideways-scroll card', async () => {
  render(
    <MemoryRouter initialEntries={['/people/users']}>
      <Routes>
        <Route path="/people/users" element={<Users />} />
        <Route path="/people/users/:personId" element={<div>DETAIL PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
  const row = (await screen.findByText('Wan Worker')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});

/* ── Add person ──────────────────────────────────────────────────── */

const role = (name: string, label: string, rank: number, scope_anchor: string) => ({
  name, label, rank, scope_anchor, color: null, description: '', is_system: true,
  member_count: 0, matrix: {}, totp_required: false,
});
const SUMMARY = {
  two_factor_enabled: true,
  stats: { members: 0, roles: 6, groups: 0, gated_resources: 0, overrides: 0 },
  resources: [], groups: [],
  roles: [
    role('admin', 'Admin', 60, 'global'), role('staff', 'Staff', 40, 'global'),
    role('client_admin', 'Client admin', 20, 'client'), role('vendor_admin', 'Vendor admin', 20, 'partner'),
    role('worker', 'Worker', 10, 'self'), role('external', 'External', 5, 'self'),
  ],
};

/** fetch stub: the summary, POST /users, and the list for everything else. */
function stubFetch(postUsers: () => Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/access/summary')) return new Response(JSON.stringify(SUMMARY), { status: 200 });
    if (u.endsWith('/users') && init?.method === 'POST') return postUsers();
    return new Response(JSON.stringify([ROW]), { status: 200 });
  }));
}

function renderUsers() {
  return render(
    <MemoryRouter initialEntries={['/people/users']}>
      <Routes>
        <Route path="/people/users" element={<Users />} />
        <Route path="/people/users/:personId" element={<div>DETAIL PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openAdd() {
  renderUsers();
  await screen.findByText('Wan Worker');
  fireEvent.click(screen.getByRole('button', { name: '+ Add person' }));
  await screen.findByRole('button', { name: 'Staff' });
  return document.querySelector('.modal-card') as HTMLElement;
}

const accountBox = (modal: HTMLElement) =>
  within(modal).getByText('Create a login account now').querySelector('input') as HTMLInputElement;
const tempInput = (modal: HTMLElement) =>
  within(modal).getByText('Temporary password *').parentElement!.querySelector('input') as HTMLInputElement;

it('Add person: the temporary password follows the session minimum', async () => {
  auth.passwordMinLength = 20;
  stubFetch(() => new Response('{}', { status: 201 }));
  const modal = await openAdd();
  expect(tempInput(modal).minLength).toBe(20);
  expect(tempInput(modal).value.length).toBeGreaterThanOrEqual(22);
});

it('Add person: role chips come from the summary — labels, no client/vendor, nothing at or above the actor', async () => {
  auth.maxRank = 60;
  stubFetch(() => new Response('{}', { status: 201 }));
  const modal = await openAdd();
  const chips = [...modal.querySelectorAll('.role-pick')].map((b) => b.textContent);
  expect(chips).toEqual(['Staff', 'Worker', 'External']);
  expect(within(modal).getByRole('button', { name: 'Staff' }).getAttribute('aria-pressed')).toBe('true');
});

it('Add person: the no-login hint follows the chosen roles', async () => {
  stubFetch(() => new Response('{}', { status: 201 }));
  const modal = await openAdd();
  fireEvent.click(accountBox(modal));
  expect(within(modal).getByText(
    "Without a login or the Worker role they won't appear in any list. Add the Worker role, or create a login.",
  )).toBeTruthy();
  fireEvent.click(within(modal).getByRole('button', { name: 'External' }));
  expect(within(modal).getByText(
    "Without a login they won't be in the Users list; you'll find them under People › External.",
  )).toBeTruthy();
  fireEvent.click(within(modal).getByRole('button', { name: 'Worker' }));
  expect(within(modal).getByText(
    "Without a login they won't be in the Users list; you'll find them under People › Workers.",
  )).toBeTruthy();
});

it('Add person: creating without a login sends the chosen roles and just closes the dialog', async () => {
  stubFetch(() => new Response(JSON.stringify({ person_id: 'p7', login_email: null }), { status: 201 }));
  const modal = await openAdd();
  const inputs = modal.querySelectorAll<HTMLInputElement>('.pf-form input');
  fireEvent.change(inputs[0], { target: { value: 'New' } });
  fireEvent.change(inputs[1], { target: { value: 'Person' } });
  fireEvent.click(within(modal).getByRole('button', { name: 'Worker' }));
  fireEvent.click(accountBox(modal));
  fireEvent.click(within(modal).getByRole('button', { name: 'Create person' }));
  await waitFor(() => expect(document.querySelector('.modal-card')).toBeNull());
  const post = vi.mocked(fetch).mock.calls.find(([url, init]) =>
    String(url).endsWith('/users') && (init as RequestInit | undefined)?.method === 'POST');
  const body = JSON.parse(String((post![1] as RequestInit).body));
  expect(body).toMatchObject({ roles: ['staff', 'worker'], create_account: false, login_email: null });
  expect(screen.queryByText('DETAIL PAGE')).toBeNull();
  expect(screen.getByText('Wan Worker')).toBeTruthy();
});

it('Add person: a server password_too_short names its minimum', async () => {
  stubFetch(() => new Response(
    JSON.stringify({ detail: { code: 'password_too_short', min_length: 20 } }), { status: 422 }));
  const modal = await openAdd();
  const inputs = modal.querySelectorAll<HTMLInputElement>('.pf-form input');
  fireEvent.change(inputs[0], { target: { value: 'New' } });
  fireEvent.change(inputs[1], { target: { value: 'Person' } });
  const login = within(modal).getByText('Login email *').parentElement!.querySelector('input')!;
  fireEvent.change(login, { target: { value: 'new@x.test' } });
  fireEvent.click(within(modal).getByRole('button', { name: 'Create person' }));
  expect(await within(modal).findByText('Temporary passwords need at least 20 characters.')).toBeTruthy();
});

it('Add person: when the role list fails, nothing is sent behind the scenes — no hidden default role', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/access/summary')) return new Response('{}', { status: 403 });
    if (u.endsWith('/users') && init?.method === 'POST') {
      return new Response(JSON.stringify({ person_id: 'p8', login_email: null }), { status: 201 });
    }
    return new Response(JSON.stringify([ROW]), { status: 200 });
  }));
  renderUsers();
  await screen.findByText('Wan Worker');
  fireEvent.click(screen.getByRole('button', { name: '+ Add person' }));
  const modal = document.querySelector('.modal-card') as HTMLElement;
  expect(await within(modal).findByText(
    "Couldn't load the role list — this person will be added with no roles.")).toBeTruthy();
  const inputs = modal.querySelectorAll<HTMLInputElement>('.pf-form input');
  fireEvent.change(inputs[0], { target: { value: 'New' } });
  fireEvent.change(inputs[1], { target: { value: 'Person' } });
  fireEvent.click(accountBox(modal));
  fireEvent.click(within(modal).getByRole('button', { name: 'Create person' }));
  await waitFor(() => expect(document.querySelector('.modal-card')).toBeNull());
  const post = vi.mocked(fetch).mock.calls.find(([url, init]) =>
    String(url).endsWith('/users') && (init as RequestInit | undefined)?.method === 'POST');
  expect(JSON.parse(String((post![1] as RequestInit).body)).roles).toEqual([]);
});

it('Add person, email off: no Sign-in choice; the temporary password is sent as today', async () => {
  stubFetch(() => new Response(JSON.stringify({ person_id: 'p7', login_email: 'new@x.test' }), { status: 201 }));
  const modal = await openAdd();
  expect(within(modal).queryByRole('group', { name: 'Sign-in' })).toBeNull();
  expect(within(modal).getByText('Must change password at first sign-in')).toBeTruthy();
  const inputs = modal.querySelectorAll<HTMLInputElement>('.pf-form input');
  fireEvent.change(inputs[0], { target: { value: 'New' } });
  fireEvent.change(inputs[1], { target: { value: 'Person' } });
  const login = within(modal).getByText('Login email *').parentElement!.querySelector('input')!;
  fireEvent.change(login, { target: { value: 'new@x.test' } });
  const temp = tempInput(modal).value;
  fireEvent.click(within(modal).getByRole('button', { name: 'Create person' }));
  await screen.findByText('DETAIL PAGE');
  const post = vi.mocked(fetch).mock.calls.find(([url, init]) =>
    String(url).endsWith('/users') && (init as RequestInit | undefined)?.method === 'POST');
  const body = JSON.parse(String((post![1] as RequestInit).body));
  expect(body).toMatchObject({ create_account: true, temp_password: temp, must_change_password: true });
  expect(body).not.toHaveProperty('invite');
});

it('Add person, email on: invite is the default and the body has invite: true, no temp_password', async () => {
  sys.email_enabled = true;
  stubFetch(() => new Response(JSON.stringify({ person_id: 'p7', login_email: 'new@x.test' }), { status: 201 }));
  const modal = await openAdd();
  expect(within(modal).getByRole('group', { name: 'Sign-in' })).toBeTruthy();
  expect(within(modal).getByRole('button', { name: 'Email an invite link' })
    .getAttribute('aria-pressed')).toBe('true');
  expect(within(modal).queryByText('Temporary password *')).toBeNull();
  expect(within(modal).queryByText('Must change password at first sign-in')).toBeNull();
  const inputs = modal.querySelectorAll<HTMLInputElement>('.pf-form input');
  fireEvent.change(inputs[0], { target: { value: 'New' } });
  fireEvent.change(inputs[1], { target: { value: 'Person' } });
  const login = within(modal).getByText('Login email *').parentElement!.querySelector('input')!;
  fireEvent.change(login, { target: { value: 'new@x.test' } });
  fireEvent.click(within(modal).getByRole('button', { name: 'Create person' }));
  await screen.findByText('DETAIL PAGE');
  const post = vi.mocked(fetch).mock.calls.find(([url, init]) =>
    String(url).endsWith('/users') && (init as RequestInit | undefined)?.method === 'POST');
  const body = JSON.parse(String((post![1] as RequestInit).body));
  expect(body).toMatchObject({
    create_account: true, login_email: 'new@x.test', invite: true, temp_password: null,
  });
});

it('Add person, email on: "Set a temporary password" shows the fields and sends temp_password', async () => {
  sys.email_enabled = true;
  stubFetch(() => new Response(JSON.stringify({ person_id: 'p7', login_email: 'new@x.test' }), { status: 201 }));
  const modal = await openAdd();
  fireEvent.click(within(modal).getByRole('button', { name: 'Set a temporary password' }));
  expect(within(modal).getByText('Must change password at first sign-in')).toBeTruthy();
  const temp = tempInput(modal).value;
  const inputs = modal.querySelectorAll<HTMLInputElement>('.pf-form input');
  fireEvent.change(inputs[0], { target: { value: 'New' } });
  fireEvent.change(inputs[1], { target: { value: 'Person' } });
  const login = within(modal).getByText('Login email *').parentElement!.querySelector('input')!;
  fireEvent.change(login, { target: { value: 'new@x.test' } });
  fireEvent.click(within(modal).getByRole('button', { name: 'Create person' }));
  await screen.findByText('DETAIL PAGE');
  const post = vi.mocked(fetch).mock.calls.find(([url, init]) =>
    String(url).endsWith('/users') && (init as RequestInit | undefined)?.method === 'POST');
  const body = JSON.parse(String((post![1] as RequestInit).body));
  expect(body).toMatchObject({ temp_password: temp, must_change_password: true });
  expect(body).not.toHaveProperty('invite');
});

/* ── Invited accounts ────────────────────────────────────────────── */

const INVITED = {
  ...ROW, person_id: 'p2', first_name: 'Ina', last_name: 'Invitee', display_name: 'Ina Invitee',
  login_email: 'ina@x.test', status: 'invited', last_login_at: null,
};

function stubInvited() {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/p2/invite') && init?.method === 'POST') return new Response(null, { status: 204 });
    return new Response(JSON.stringify([ROW, INVITED]), { status: 200 });
  }));
}

it('Invited: an amber chip, and an Invited filter with its count', async () => {
  stubInvited();
  renderUsers();
  const row = (await screen.findByText('Ina Invitee')).closest('.dir-row') as HTMLElement;
  const chip = within(row.querySelector('.row-main') as HTMLElement).getByText('Invited');
  expect(chip.closest('.chip')?.className).toContain('c-amber');
  const pill = screen.getByRole('button', { name: /^Invited/ });
  expect(pill.querySelector('.n')?.textContent).toBe('1');
  fireEvent.click(pill);
  await waitFor(() => expect(screen.queryByText('Wan Worker')).toBeNull());
  expect(screen.getByText('Ina Invitee')).toBeTruthy();
});

it('Invited: the row offers Resend invite instead of Reset password, and toasts on send', async () => {
  stubInvited();
  renderUsers();
  const row = (await screen.findByText('Ina Invitee')).closest('.dir-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: /actions/i }));
  expect(await screen.findByRole('menuitem', { name: 'Resend invite' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Reset password' })).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Resend invite' }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith('Invite sent to ina@x.test.'));
  expect(vi.mocked(fetch).mock.calls.some(([url, init]) =>
    String(url).endsWith('/users/p2/invite') && (init as RequestInit | undefined)?.method === 'POST',
  )).toBe(true);
});

it('Invited: a refused resend toasts the friendly reason', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/p2/invite') && init?.method === 'POST') {
      return new Response(JSON.stringify({ detail: { code: 'not_invited' } }), { status: 409 });
    }
    return new Response(JSON.stringify([ROW, INVITED]), { status: 200 });
  }));
  renderUsers();
  const row = (await screen.findByText('Ina Invitee')).closest('.dir-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: /actions/i }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Resend invite' }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("They've already set a password."));
});

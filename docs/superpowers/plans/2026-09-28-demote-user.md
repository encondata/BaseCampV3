# Demote User to Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One admin action, "Demote to worker," that removes a person's portal login and every kind of portal access in a single transaction while leaving the person, their badge/RFID and their history in place.

**Architecture:** A new `POST /users/{person_id}/demote` endpoint next to `disable_account` reuses `_load_target`, `_revoke_all_sessions` and `totp_service.reset`, revokes roles, deletes group memberships and the account row, and writes one `account.demote` audit row. The portal adds `demoteUser()`, a `DemoteUserModal` in the shared admin-modals file, and a button/row action on the user detail page and Users list.

**Tech Stack:** FastAPI + SQLAlchemy async (real Postgres tests); React 18 + TypeScript + Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-demote-user-design.md`

## Global Constraints

- American English in all copy, comments and commit messages.
- Endpoint (exact): `POST /users/{person_id}/demote` → 204; permission `users:change`; uses `_load_target` (global actor, not self, account must exist → 404 `user_not_found`, rank check). Audit action (exact): `account.demote` with `changes = {"login_email", "roles", "access_groups", "notification_groups"}`. Session revoke reason (exact): `"demoted"`.
- Untouched by demotion: the `people` row (including `badge_uid`, `rfid_tag`, `archived_at`), time entries, scans, assignments, notes, prior audit rows.
- Portal copy (exact): button/menu label **Demote to worker**; modal title `Demote to worker — {display_name}`; body "Demote {display_name} to a worker? Their portal login, roles, access groups, notification groups, two-factor setup and remembered browsers are removed, and they're signed out everywhere. Their badge, RFID and history stay; they leave this Users list but remain under People, and can be given a login again later."; confirm button **Demote** (danger), **Cancel**.
- Typography guardrail: no new CSS; reuse `mini-btn danger`, `btn-solid btn-danger`, `set-note`, `pf-error`.
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

**Environment (worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/demote-user`):** `api/.venv`, `portal/node_modules` are symlinks; `.env` copied. API tests: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_demote .venv/bin/pytest tests/<file> -q` — FOREGROUND, long timeout, never background, never pip/npm install, never `git stash`. Portal: `cd portal && npx vitest run <paths>`; `npx tsc -b`.

---

### Task 1: `POST /users/{person_id}/demote`

**Files:**
- Modify: `api/src/serversherpa/api/routes/users.py` (after `enable_account`, ~line 595)
- Test: `api/tests/test_account_mgmt.py` (append)

**Interfaces:**
- Produces: `POST /users/{person_id}/demote` (204), as in Global Constraints. Task 2 calls it.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_account_mgmt.py` (existing helpers: `_mk_user(db, first=, last=, email=, roles=)`, `_headers(client, email)`, `_login(client, email)`, `login_admin(client, db, seeded_user)`; existing imports cover `Person`, `PersonRole`, `UserAccount`, `datetime`, `UTC`):

```python
# ── admin: demote to worker ────────────────────────────────────────

from sqlalchemy import select  # noqa: E402

from serversherpa.db.models import (  # noqa: E402
    AccessGroup, AccessGroupMember, AuditLog, NotificationGroup, NotificationGroupMember,
    PasswordHistory, TrustedDevice,
)


async def test_demote_removes_login_and_every_access_but_keeps_the_person(client, seeded_user, db):
    worker = await _mk_user(db, first="Wan", last="Worker",
                            email="wan@test.example.com", roles=("worker", "staff"))
    worker.rfid_tag = "E200ABCDEF"
    badge = worker.badge_uid
    account = await db.get(UserAccount, worker.id)
    account.totp_secret_enc = b"secret"
    account.totp_confirmed_at = datetime.now(UTC)
    ag = AccessGroup(name="Dock crew")
    ng = NotificationGroup(name="On-call")
    db.add_all([ag, ng])
    await db.flush()
    db.add_all([
        AccessGroupMember(group_id=ag.id, person_id=worker.id),
        NotificationGroupMember(group_id=ng.id, person_id=worker.id),
        TrustedDevice(person_id=worker.id, token_hash="t" * 64, user_agent="UA",
                      last_used_at=datetime.now(UTC),
                      expires_at=datetime.now(UTC) + timedelta(days=7)),
    ])
    await db.commit()
    worker_session = await _headers(client, "wan@test.example.com")
    admin = await login_admin(client, db, seeded_user)

    resp = await client.post(f"/users/{worker.id}/demote", headers=admin)
    assert resp.status_code == 204, resp.text

    # signed out, and there is nothing left to sign in to
    assert (await client.get("/auth/me", headers=worker_session)).status_code == 401
    login = await _login(client, "wan@test.example.com")
    assert login.status_code == 401
    assert login.json()["detail"]["code"] == "invalid_credentials"

    db.expire_all()
    assert await db.get(UserAccount, worker.id) is None
    assert list(await db.scalars(select(PasswordHistory).where(
        PasswordHistory.person_id == worker.id))) == []
    active_roles = list(await db.scalars(select(PersonRole.role).where(
        PersonRole.person_id == worker.id, PersonRole.revoked_at.is_(None))))
    assert active_roles == []
    revoked = list(await db.scalars(select(PersonRole).where(
        PersonRole.person_id == worker.id, PersonRole.revoked_at.is_not(None))))
    assert {r.role for r in revoked} == {"worker", "staff"}
    assert list(await db.scalars(select(AccessGroupMember).where(
        AccessGroupMember.person_id == worker.id))) == []
    assert list(await db.scalars(select(NotificationGroupMember).where(
        NotificationGroupMember.person_id == worker.id))) == []
    assert list(await db.scalars(select(TrustedDevice).where(
        TrustedDevice.person_id == worker.id, TrustedDevice.revoked_at.is_(None)))) == []

    person = await db.get(Person, worker.id)
    assert person is not None and person.archived_at is None
    assert person.badge_uid == badge and person.rfid_tag == "E200ABCDEF"

    listed = (await client.get("/users", headers=admin)).json()
    assert all(u["person_id"] != str(worker.id) for u in listed)
    assert (await client.get(f"/users/{worker.id}", headers=admin)).status_code == 404

    rows = list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "user_account", AuditLog.entity_id == str(worker.id),
        AuditLog.action == "account.demote")))
    assert len(rows) == 1
    assert rows[0].changes["login_email"] == "wan@test.example.com"
    assert sorted(rows[0].changes["roles"]) == ["staff", "worker"]
    assert rows[0].changes["access_groups"] == ["Dock crew"]
    assert rows[0].changes["notification_groups"] == ["On-call"]

    # the person can be promoted again
    again = await client.post(f"/users/{worker.id}/account", headers=admin, json={
        "login_email": "wan@test.example.com", "temp_password": "Temp-pw-9999",
        "must_change_password": True})
    assert again.status_code == 201, again.text


async def test_demote_refusals(client, seeded_user, db):
    staff = await _headers(client, "alice@test.example.com")
    me = (await client.get("/auth/me", headers=staff)).json()["person"]
    resp = await client.post(f"/users/{me['id']}/demote", headers=staff)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "cannot_target_self"

    contact = Person(first_name="No", last_name="Login", email="nologin@test.example.com")
    db.add(contact)
    await db.commit()
    assert (await client.post(f"/users/{contact.id}/demote", headers=staff)).status_code == 404

    boss = await _mk_user(db, first="Big", last="Boss", email="boss@test.example.com",
                          roles=("admin",))
    resp = await client.post(f"/users/{boss.id}/demote", headers=staff)
    assert resp.status_code == 403
```

Add `timedelta` to the file's `from datetime import UTC, datetime` line.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_demote .venv/bin/pytest tests/test_account_mgmt.py -q -k demote`
Expected: FAIL — `POST …/demote` returns 404/405 (route missing).

- [ ] **Step 3: Implement the endpoint**

In `api/src/serversherpa/api/routes/users.py`, add to the `serversherpa.db.models` import block: `AccessGroup`, `AccessGroupMember`, `NotificationGroup`, `NotificationGroupMember` (keep the ones already imported), and `delete` to the `sqlalchemy` import. Then, directly after `enable_account`:

```python
@router.post("/{person_id}/demote", status_code=204)
async def demote_to_worker(
    person_id: uuid.UUID,
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("users", "change"),
) -> None:
    """Someone quit: take away the portal login and every kind of portal
    access in one transaction, but keep the person — badge, RFID, time
    entries, scans and assignments stay, so they remain a worker and can
    be given a login again later with POST /{person_id}/account."""
    _, account, _ = await _load_target(db, actor, person_id)
    now = datetime.now(UTC)
    login_email = account.email

    roles = sorted(await db.scalars(
        select(PersonRole.role).where(PersonRole.person_id == person_id,
                                      PersonRole.revoked_at.is_(None))))
    access_groups = sorted(await db.scalars(
        select(AccessGroup.name)
        .join(AccessGroupMember, AccessGroupMember.group_id == AccessGroup.id)
        .where(AccessGroupMember.person_id == person_id)))
    notification_groups = sorted(await db.scalars(
        select(NotificationGroup.name)
        .join(NotificationGroupMember, NotificationGroupMember.group_id == NotificationGroup.id)
        .where(NotificationGroupMember.person_id == person_id)))

    await _revoke_all_sessions(db, person_id, "demoted")
    await totp_service.reset(db, account, actor_id=actor.person.id, ip=client_ip(request))
    await db.execute(
        update(PersonRole)
        .where(PersonRole.person_id == person_id, PersonRole.revoked_at.is_(None))
        .values(revoked_at=now, revoked_by=actor.person.id, updated_at=now))
    await db.execute(delete(AccessGroupMember).where(AccessGroupMember.person_id == person_id))
    await db.execute(delete(NotificationGroupMember)
                     .where(NotificationGroupMember.person_id == person_id))
    await db.delete(account)   # password_history cascades

    audit(db, actor_id=actor.person.id, entity_type="user_account",
          entity_id=str(person_id), action="account.demote",
          changes={"login_email": login_email, "roles": roles,
                   "access_groups": access_groups,
                   "notification_groups": notification_groups},
          ip=client_ip(request))
    await db.commit()
```

`Request`, `client_ip`, `totp_service`, `audit`, `update`, `select` are already imported in this file (check the header; add any that aren't).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_demote .venv/bin/pytest tests/test_account_mgmt.py tests/test_users_api.py tests/test_totp_admin_api.py -q`
Expected: PASS. If `db.delete(account)` fails on a foreign key (a table referencing `user_accounts` without CASCADE), report which table in the report and use an explicit `delete(...)` for it before the account, keeping the spec's "person untouched" rule.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/users.py api/tests/test_account_mgmt.py
git commit -m "feat(api): POST /users/{id}/demote turns a portal user back into a worker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Portal — modal, detail-page button, list row action

**Files:**
- Modify: `portal/src/lib/api.ts` (next to `adminAccountStateRequest`, ~line 563)
- Modify: `portal/src/components/UserAdminModals.tsx` (after `AccountStateModal`)
- Modify: `portal/src/pages/UserDetail.tsx`
- Modify: `portal/src/pages/Users.tsx`
- Tests: `portal/src/pages/UserDetail.test.tsx`, `portal/src/pages/Users.test.tsx`

**Interfaces:**
- Consumes: `POST /users/{id}/demote` (Task 1).
- Produces: `adminDemoteRequest(personId: string): Promise<void>` in `lib/api.ts`; `DemoteUserModal({ user: ManagedUser, onClose, onDone })` exported from `UserAdminModals.tsx`.

- [ ] **Step 1: Write the failing tests**

`portal/src/pages/UserDetail.test.tsx`: add `adminDemoteRequest: vi.fn(() => Promise.resolve())` to the hoisted `api` object (next to `revokeAllUserSessions`), and append:

```tsx
it('Demote to worker confirms, posts, and returns to the Users list', async () => {
  renderAt('/people/users/p1');
  await screen.findByRole('heading', { level: 1, name: /Wan Worker/ });
  fireEvent.click(screen.getByRole('button', { name: 'Demote to worker' }));
  expect(await screen.findByText(/Their badge, RFID and history stay/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Demote' }));
  await waitFor(() => expect(api.adminDemoteRequest).toHaveBeenCalledWith('p1'));
  await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: /Wan Worker/ })).toBeNull());
  expect(screen.getByText('USERS LIST')).toBeTruthy();
});

it('an outranked person gets no Demote button', async () => {
  auth.maxRank = 10;   // below the fixture's max_rank — see the read-only test above for the mechanism
  renderAt('/people/users/p1');
  await screen.findByRole('heading', { level: 1, name: /Wan Worker/ });
  expect(screen.queryByRole('button', { name: 'Demote to worker' })).toBeNull();
});
```

`renderAt` must render a `/people/users` route with `<div>USERS LIST</div>` — look at how the file's `renderAt` builds its `<Routes>` and add that route if it isn't there. For the outranked case, reuse whatever the existing "an outranked person is read-only" test does to make the actor outranked (copy its setup verbatim instead of the `auth.maxRank` line if it differs).

`portal/src/pages/Users.test.tsx`: extend the existing "a manage-able row lists …" test with `expect(screen.getByRole('menuitem', { name: 'Demote to worker' })).toBeTruthy();` and append:

```tsx
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
  await waitFor(() => expect(api.adminDemoteRequest).toHaveBeenCalledWith('p1'));
  await waitFor(() => expect(api.listUsers).toHaveBeenCalledTimes(2));
});
```

(Use the file's actual mock names: check the hoisted `api` object for the list-users function name and the fixture's `person_id`; add `adminDemoteRequest: vi.fn(() => Promise.resolve())` to it.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd portal && npx vitest run src/pages/UserDetail.test.tsx src/pages/Users.test.tsx`
Expected: the new cases FAIL (no such button / menu item).

- [ ] **Step 3: API helper**

In `portal/src/lib/api.ts`, after `adminAccountStateRequest`:

```ts
/** Someone quit: drop their login and every portal access, keep the person. */
export async function adminDemoteRequest(personId: string): Promise<void> {
  const resp = await apiFetch(`/users/${personId}/demote`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}
```

- [ ] **Step 4: Modal**

In `portal/src/components/UserAdminModals.tsx`, import `adminDemoteRequest` from `../lib/api` and add after `AccountStateModal`:

```tsx
/* ── demote to worker ───────────────────────────────────────────── */

export function DemoteUserModal({ user, onClose, onDone }: {
  user: ManagedUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setSaving(true); setError('');
    try {
      await adminDemoteRequest(user.person_id);
      onDone();
    } catch (err) {
      setError(errText(err));
      setSaving(false);
    }
  };
  return (
    <Modal title={`Demote to worker — ${user.display_name}`} onClose={onClose}>
      <div className="modal-body">
        <p className="set-note" style={{ padding: 0, margin: 0 }}>
          Demote {user.display_name} to a worker? Their portal login, roles, access groups,
          notification groups, two-factor setup and remembered browsers are removed, and
          they&apos;re signed out everywhere. Their badge, RFID and history stay; they leave this
          Users list but remain under People, and can be given a login again later.
        </p>
      </div>
      <div className="modal-foot">
        <button className="btn-solid btn-danger" onClick={() => void run()} disabled={saving}>
          {saving ? 'Working…' : 'Demote'}
        </button>
        <button className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
        {error && <span className="pf-error">{error}</span>}
      </div>
    </Modal>
  );
}
```

- [ ] **Step 5: Detail page**

In `portal/src/pages/UserDetail.tsx`:
- `Action` type: add `| { kind: 'demote' }`.
- Import `DemoteUserModal` alongside the other modals from `../components/UserAdminModals`.
- In the `mode === 'manage' && canManageUsers` button group, after the Disable/Enable button, add:

```tsx
                <button className="mini-btn danger" onClick={() => setAction({ kind: 'demote' })}>Demote to worker</button>
```

- Next to the `action?.kind === 'state'` modal render, add:

```tsx
      {action?.kind === 'demote' && (
        <DemoteUserModal user={managed}
          onClose={() => setAction(null)}
          onDone={() => { setAction(null); navigate('/people/users'); }} />
      )}
```

(`navigate` is already in scope — it's used for "Go to My profile".)

- [ ] **Step 6: Users list**

In `portal/src/pages/Users.tsx`:
- `ManageAction` type: add `| { kind: 'demote'; user: UserItem }`.
- Import `DemoteUserModal`.
- In `rowActions`, after the disable/enable entry inside the `canManageUsers` spread, add:

```tsx
      ...(canManageUsers ? [{
        key: 'demote', label: 'Demote to worker', destructive: true,
        onSelect: () => setManage({ kind: 'demote', user: u }),
      }] : []),
```

- Next to the `manage?.kind === 'state'` render, add:

```tsx
      {manage?.kind === 'demote' && (
        <DemoteUserModal user={manage.user}
          onClose={() => setManage(null)}
          onDone={() => { setManage(null); void load(); }} />
      )}
```

- [ ] **Step 7: Run the tests, guardrail and type check**

Run: `cd portal && npx vitest run src/pages/UserDetail.test.tsx src/pages/Users.test.tsx src/components src/styles/listTypography.test.ts && npx tsc -b`
Expected: PASS; `tsc` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add portal/src/lib/api.ts portal/src/components/UserAdminModals.tsx portal/src/pages/UserDetail.tsx portal/src/pages/Users.tsx portal/src/pages/UserDetail.test.tsx portal/src/pages/Users.test.tsx
git commit -m "feat(portal): Demote to worker on the user page and the Users row menu

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Full suites (controller)

```bash
cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_demote_full .venv/bin/pytest -q
cd ../portal && npx vitest run && npx tsc -b && npm run build
```

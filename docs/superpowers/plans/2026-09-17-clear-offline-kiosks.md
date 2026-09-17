# Clear Offline and Expired Kiosks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single admin-only button on `/hardware/kiosks` that permanently deletes kiosk rows which are both unregistered-or-expired AND unseen for 24 hours, after showing exactly which ones will go.

**Architecture:** One endpoint owns the match rule and runs it against the database clock. A dry run fills a confirmation modal; the confirm call re-evaluates every submitted id against the same rule before deleting, so nothing is deleted on stale evidence and the endpoint cannot be used as a general-purpose delete. Two authorization gates: the `scanning_hardware:delete` permission, plus a hard rank floor of 60 (admin) that a runtime permission-matrix edit cannot lift.

**Tech Stack:** FastAPI / SQLAlchemy 2 async / pytest; React + TypeScript / Vitest.

## Global Constraints

- Branch `kiosk-clear-offline`, off `main` @ `0af9b35`. Worktree: `.claude/worktrees/timeclock`. Run every command from the worktree root.
- **API tests:** `PYTHONPATH=api/src api/.venv/bin/python -m pytest ...` from the worktree root. Omitting PYTHONPATH tests the main checkout's source and gives false greens.
- **Only ONE pytest run against the test database at a time.** Check `pgrep -f "pytest api/tests"` first. Concurrent runs deadlock on `clean_db`'s TRUNCATE and fail in unrelated files.
- **Do NOT run the full API suite per task** — it takes ~21 minutes. Targeted files per task; the full suite runs ONCE, at the end.
- **Portal: run the WHOLE suite** (`npm --prefix portal test`, ~20s), never a single file, plus `npx --prefix portal tsc --noEmit -p portal/tsconfig.json`. Do NOT run `npm install`.
- No migration. This feature adds no columns; migration head stays `0066`.
- American English in all copy and comments.
- `api/src/serversherpa/_dev_reload.py` churns whenever the dev API runs — never commit it.
- End commit messages with: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Key facts established by exploration

- `Device.last_seen_at` is real and actively written: `api/src/serversherpa/api/routes/kiosk.py` stamps it on pairing (`:213`, `:226`) and on kiosk actions (`:697`, `:812`, `:948`, `:1157`, `:1298`).
- Registration is derived from `token_expires_at` alone — `portal/src/lib/devices.ts` `tokenExpiryState` / `registrationLabel` give Registered / Expires soon / Expired / Unregistered.
- `admin` is rank **60**, which equals `GATE_BYPASS_RANK` in `api/src/serversherpa/access/defaults.py`. The rank-gate idiom is `api/src/serversherpa/api/routes/access.py:107`.
- `staff` holds only `scanning_hardware: ("view",)` today, but the matrix is runtime-editable, which is why the rank gate is not redundant.
- `DELETE /devices/{id}` (`routes/devices.py:239`) is a hard delete with one audit row; `devices` has no `archived_at`.
- `_err(status, code)` is the route file's error helper (`routes/devices.py:26`).
- House modal division of labor: the modal is presentational and hands the decision back via `onConfirm`; the page owns the API call and reload (`components/hardware/RegisterDaysModal.tsx`).
- `useAuth()` exposes `can` and `maxRank` (`portal/src/auth/AuthContext.tsx:85`).

---

### Task 1: The endpoint

**Files:**
- Modify: `api/src/serversherpa/api/routes/devices.py`
- Modify: `api/src/serversherpa/api/schemas.py`
- Test: `api/tests/test_devices_clear_offline_api.py` (new)

**Interfaces produced:**
- `OFFLINE_HOURS = 24` and `_offline_kiosk_clause(now)` in `routes/devices.py`.
- `POST /devices/kiosks/clear-offline`, body `ClearOfflineKiosksIn {dry_run: bool = True, ids: list[UUID] | None = None}`, response `ClearOfflineKiosksOut {dry_run: bool, kiosks: [...], skipped: [...]}` where `ClearOfflineKioskItem` is `{id, name, sub_type, registration, last_seen_at}` and `registration` is `"unregistered"` or `"expired"`.

Task 2's modal renders `kiosks`; Task 3 posts to this route twice.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_devices_clear_offline_api.py`. Copy the fixture header and actor-building helpers from an existing device test such as `api/tests/test_kiosk_devices_api.py` — read it first rather than assuming fixture names.

```python
"""POST /devices/kiosks/clear-offline — the match rule, the re-check before
deleting, and the two authorization gates."""

from datetime import UTC, datetime, timedelta

CLEAR = "/devices/kiosks/clear-offline"


async def _kiosk(db, name, *, expires_in_hours=None, seen_hours_ago=None):
    """A kiosk row. expires_in_hours None -> Unregistered; negative -> Expired.
    seen_hours_ago None -> never seen."""
    now = datetime.now(UTC)
    device = Device(
        device_type="kiosk", name=name, sub_type="laptop",
        token_expires_at=None if expires_in_hours is None else now + timedelta(hours=expires_in_hours),
        last_seen_at=None if seen_hours_ago is None else now - timedelta(hours=seen_hours_ago))
    db.add(device)
    await db.commit()
    return device


async def test_dry_run_matches_only_stale_and_unregistered(client, db, admin_headers):
    await _kiosk(db, "dead-expired", expires_in_hours=-48, seen_hours_ago=72)
    await _kiosk(db, "dead-never", expires_in_hours=None, seen_hours_ago=None)
    await _kiosk(db, "idle-but-registered", expires_in_hours=240, seen_hours_ago=48)
    await _kiosk(db, "alive-but-expired", expires_in_hours=-1, seen_hours_ago=0)

    body = (await client.post(CLEAR, json={"dry_run": True}, headers=admin_headers)).json()
    assert body["dry_run"] is True
    assert {k["name"] for k in body["kiosks"]} == {"dead-expired", "dead-never"}
    assert body["skipped"] == []
    # a dry run deletes nothing
    assert await db.scalar(select(func.count()).select_from(Device)) == 4


async def test_expires_soon_is_still_registered(client, db, admin_headers):
    """tokenExpiryState calls a token inside the warning window 'soon', not
    expired — a kiosk with one must survive however long it has been quiet."""
    await _kiosk(db, "soon-and-stale", expires_in_hours=1, seen_hours_ago=120)
    body = (await client.post(CLEAR, json={"dry_run": True}, headers=admin_headers)).json()
    assert body["kiosks"] == []


async def test_confirm_deletes_and_audits(client, db, admin_headers):
    dead = await _kiosk(db, "dead-expired", expires_in_hours=-48, seen_hours_ago=72)
    keep = await _kiosk(db, "keeper", expires_in_hours=240, seen_hours_ago=0)

    body = (await client.post(CLEAR, json={"dry_run": False, "ids": [str(dead.id)]},
                              headers=admin_headers)).json()
    assert [k["name"] for k in body["kiosks"]] == ["dead-expired"]
    assert body["skipped"] == []
    assert await db.get(Device, dead.id) is None
    assert await db.get(Device, keep.id) is not None
    rows = (await db.execute(select(AuditLog).where(AuditLog.entity_id == str(dead.id)))).scalars().all()
    assert any(r.action == "delete" for r in rows)


async def test_an_id_that_no_longer_matches_is_skipped_not_deleted(client, db, admin_headers):
    """The re-check: a kiosk that heartbeats between the dry run and the
    confirm is alive, and must survive being named in `ids`."""
    alive = await _kiosk(db, "came-back", expires_in_hours=-48, seen_hours_ago=72)
    alive.last_seen_at = datetime.now(UTC)          # heartbeat lands
    await db.commit()

    body = (await client.post(CLEAR, json={"dry_run": False, "ids": [str(alive.id)]},
                              headers=admin_headers)).json()
    assert body["kiosks"] == []
    assert [k["name"] for k in body["skipped"]] == ["came-back"]
    assert await db.get(Device, alive.id) is not None


async def test_a_non_kiosk_id_is_never_deleted(client, db, admin_headers):
    """The endpoint is not a general-purpose delete."""
    router_row = Device(device_type="router", name="edge-router", token_expires_at=None,
                        last_seen_at=None)
    db.add(router_row)
    await db.commit()
    body = (await client.post(CLEAR, json={"dry_run": False, "ids": [str(router_row.id)]},
                              headers=admin_headers)).json()
    assert body["kiosks"] == []
    assert await db.get(Device, router_row.id) is not None


async def test_staff_with_delete_granted_is_still_refused_by_rank(client, db, staff_headers):
    """The gate that looks redundant today and is not: the permission matrix
    is runtime-editable, so scanning_hardware:delete can be granted to staff.
    Rank 60 is what actually keeps this button admin-only."""
    await _grant(db, "staff", "scanning_hardware", "delete")
    resp = await client.post(CLEAR, json={"dry_run": True}, headers=staff_headers)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden_rank"
```

Write `_grant(db, role, resource, action)` beside the helpers, inserting the row the access matrix reads; copy its shape from whatever an existing access test uses to add a grant.

- [ ] **Step 2: Run them to verify they fail**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_devices_clear_offline_api.py -v`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Add the schemas**

In `api/src/serversherpa/api/schemas.py`, beside the other device models:

```python
class ClearOfflineKiosksIn(BaseModel):
    """`dry_run` True previews and deletes nothing. False deletes, and `ids`
    names the rows the operator confirmed — every one is re-checked against
    the same rule first, so a kiosk that came back to life is skipped."""
    dry_run: bool = True
    ids: list[uuid.UUID] | None = None


class ClearOfflineKioskItem(BaseModel):
    id: uuid.UUID
    name: str
    sub_type: str | None
    registration: Literal["unregistered", "expired"]
    last_seen_at: datetime | None


class ClearOfflineKiosksOut(BaseModel):
    """`kiosks` is what WOULD be deleted on a dry run and what WAS deleted on
    a confirm. `skipped` is always empty on a dry run; on a confirm it holds
    ids that no longer match the rule and were therefore left alone."""
    dry_run: bool
    kiosks: list[ClearOfflineKioskItem]
    skipped: list[ClearOfflineKioskItem]
```

Add `Literal` to the file's typing import if absent.

- [ ] **Step 4: Add the route**

In `api/src/serversherpa/api/routes/devices.py`, import `and_`, `or_` from sqlalchemy and `GATE_BYPASS_RANK` from `serversherpa.access.defaults`, then:

```python
# Hardcoded to match the button's own label; deliberately not configurable.
OFFLINE_HOURS = 24


def _offline_kiosk_clause(now: datetime):
    """A kiosk is clearable when it is BOTH unregistered-or-expired AND
    unseen for OFFLINE_HOURS. Deliberately AND, not OR: a kiosk heartbeating
    right now with a lapsed token is alive and needs re-registering, not
    deleting, and one registered moments ago has a NULL last_seen_at."""
    return and_(
        Device.device_type == "kiosk",
        or_(Device.token_expires_at.is_(None), Device.token_expires_at < now),
        or_(Device.last_seen_at.is_(None),
            Device.last_seen_at < now - timedelta(hours=OFFLINE_HOURS)),
    )


def _clear_item(device: Device) -> ClearOfflineKioskItem:
    return ClearOfflineKioskItem(
        id=device.id, name=device.name, sub_type=device.sub_type,
        registration="unregistered" if device.token_expires_at is None else "expired",
        last_seen_at=device.last_seen_at)


@router.post("/kiosks/clear-offline", response_model=ClearOfflineKiosksOut)
async def clear_offline_kiosks(
    body: ClearOfflineKiosksIn, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "delete"),
) -> ClearOfflineKiosksOut:
    """Delete kiosks that are both unregistered/expired and unseen for a day.

    Admin and above only. The permission alone is not enough: the matrix is
    runtime-editable, so scanning_hardware:delete can be granted to staff —
    the rank floor is what keeps this irreversible bulk action admin-only.
    (Idiom: api/routes/access.py:107.)"""
    if actor.access.max_rank < GATE_BYPASS_RANK:
        raise _err(403, "forbidden_rank")

    # The DATABASE clock, never the caller's: a skewed laptop must not decide
    # what "24 hours" means for a delete that cannot be undone.
    now = await db.scalar(select(func.now()))

    if body.dry_run:
        matches = (await db.execute(
            select(Device).where(_offline_kiosk_clause(now))
            .order_by(Device.name))).scalars().all()
        return ClearOfflineKiosksOut(dry_run=True,
                                     kiosks=[_clear_item(d) for d in matches],
                                     skipped=[])

    ids = body.ids or []
    if not ids:
        return ClearOfflineKiosksOut(dry_run=False, kiosks=[], skipped=[])

    named = (await db.execute(
        select(Device).where(Device.id.in_(ids)).order_by(Device.name))).scalars().all()
    still_matching = {d.id for d in (await db.execute(
        select(Device).where(Device.id.in_(ids), _offline_kiosk_clause(now)))).scalars()}

    deleted, skipped = [], []
    for device in named:
        if device.id not in still_matching:
            skipped.append(_clear_item(device))
            continue
        deleted.append(_clear_item(device))
        audit(db, actor_id=actor.person.id, entity_type="device",
              entity_id=str(device.id), action="delete",
              changes={"name": device.name, "device_type": device.device_type,
                       "serial": device.serial, "reason": "clear_offline_kiosks"})
        await db.delete(device)
    await db.commit()
    return ClearOfflineKiosksOut(dry_run=False, kiosks=deleted, skipped=skipped)
```

Import the three new schema names at the top of the route file.

**Route ordering matters:** `/kiosks/clear-offline` must be declared BEFORE `@router.delete("/{device_id}")` and any other `/{device_id}` route, or FastAPI may try to parse `kiosks` as a device id. Place it above them and confirm with the tests.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_devices_clear_offline_api.py -v`
Expected: PASS, all six.

- [ ] **Step 6: Run the neighboring device tests**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/ -k "device" -q`
Expected: PASS — in particular nothing about `DELETE /devices/{id}` regressed from the new route's path.

- [ ] **Step 7: Commit**

```bash
git add api/src/serversherpa/api/routes/devices.py api/src/serversherpa/api/schemas.py api/tests/test_devices_clear_offline_api.py
git commit -m "feat(hardware): endpoint to clear offline and expired kiosks

Deletes kiosks that are BOTH unregistered-or-expired AND unseen for 24
hours, judged against the database clock. A dry run previews; the
confirm re-checks every submitted id against the same rule, so a kiosk
that heartbeats in between is skipped rather than deleted on stale
evidence, and the endpoint cannot delete an arbitrary device id.

Admin and above: the permission matrix is runtime-editable, so the rank
floor is what actually keeps this irreversible bulk action admin-only.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The confirmation modal

**Files:**
- Create: `portal/src/components/hardware/ClearOfflineKiosksModal.tsx`
- Create: `portal/src/components/hardware/ClearOfflineKiosksModal.test.tsx`

**Interfaces:**
- Consumes: the `ClearOfflineKioskItem` shape from Task 1, declared in `portal/src/lib/api.ts` in Task 3.
- Produces: `ClearOfflineKiosksModal` with props `{ kiosks: ClearOfflineKioskItem[]; busy: boolean; onConfirm: () => void; onClose: () => void }`.

Presentational only — it never calls the API. The page owns the call and the reload, the same division of labor `RegisterDaysModal.tsx` uses. Read that file first and follow its modal-scrim / modal-card skeleton and its house header.

- [ ] **Step 1: Write the failing tests**

```tsx
const ROWS = [
  { id: 'a', name: 'kiosk-dock-01', sub_type: 'laptop', registration: 'expired', last_seen_at: '2026-09-14T10:00:00Z' },
  { id: 'b', name: 'kiosk-pi-07', sub_type: 'pi', registration: 'unregistered', last_seen_at: null },
] as const;

it('names every kiosk that will be deleted', () => {
  render(<ClearOfflineKiosksModal kiosks={[...ROWS]} busy={false} onConfirm={() => {}} onClose={() => {}} />);
  expect(screen.getByText('kiosk-dock-01')).toBeTruthy();
  expect(screen.getByText('kiosk-pi-07')).toBeTruthy();
  expect(screen.getByText('Unregistered')).toBeTruthy();
  expect(screen.getByText('Expired')).toBeTruthy();
});

it('says never for a kiosk that has never been seen', () => {
  render(<ClearOfflineKiosksModal kiosks={[...ROWS]} busy={false} onConfirm={() => {}} onClose={() => {}} />);
  expect(screen.getByText('Never')).toBeTruthy();
});

it('counts the kiosks in the confirm button', () => {
  render(<ClearOfflineKiosksModal kiosks={[...ROWS]} busy={false} onConfirm={() => {}} onClose={() => {}} />);
  expect(screen.getByRole('button', { name: /Delete 2 kiosks/ })).toBeTruthy();
});

it('offers only Close when nothing matches', () => {
  render(<ClearOfflineKiosksModal kiosks={[]} busy={false} onConfirm={() => {}} onClose={() => {}} />);
  expect(screen.getByText(/Nothing to clear/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
});

it('disables the confirm while a delete is in flight', () => {
  render(<ClearOfflineKiosksModal kiosks={[...ROWS]} busy onConfirm={() => {}} onClose={() => {}} />);
  expect(screen.getByRole('button', { name: /Deleting/ })).toHaveProperty('disabled', true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix portal test -- src/components/hardware/ClearOfflineKiosksModal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Build the modal**

A `modal-scrim` / `modal-card` skeleton like `RegisterDaysModal`, with the house header (eyebrow "Kiosk devices", title "Clear offline and expired kiosks", description naming the rule and saying it cannot be undone), then a real table of name / type / registration / last seen, then Cancel + `Delete N kiosks`.

For the empty case render "Nothing to clear — every kiosk is either registered or has been seen in the last 24 hours" with a single Close button and no confirm.

Reuse `subTypeLabel` from `portal/src/lib/devices.ts` for the type cell and `relativeTime` from `portal/src/lib/format.ts` for last seen, falling back to the literal `Never` when `last_seen_at` is null. Registration renders as `Unregistered` / `Expired` chips using the existing `chip c-slate` / `chip c-red` classes.

- [ ] **Step 4: Verify**

Run: `npm --prefix portal test` (whole suite) and `npx --prefix portal tsc --noEmit -p portal/tsconfig.json`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/hardware/ClearOfflineKiosksModal.tsx portal/src/components/hardware/ClearOfflineKiosksModal.test.tsx
git commit -m "feat(hardware): confirmation modal for clearing offline kiosks

Lists every kiosk that will be deleted with its registration state and
last-seen time, so the rule is visible before an irreversible bulk
delete rather than trusted blind. An empty match offers only Close.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire it into the Kiosk Devices page

**Files:**
- Modify: `portal/src/pages/KioskDevices.tsx`
- Modify: `portal/src/lib/api.ts`
- Test: `portal/src/pages/KioskDevices.test.tsx`

**Interfaces:**
- Consumes: the endpoint from Task 1, the modal from Task 2.
- Produces: `clearOfflineKiosks(body)` in `lib/api.ts` returning `ClearOfflineKiosksOut`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('hides the clear button below rank 60', () => {
  renderPage({ maxRank: 40 });
  expect(screen.queryByRole('button', { name: /Clear offline/ })).toBeNull();
});

it('shows the clear button for an admin', () => {
  renderPage({ maxRank: 60 });
  expect(screen.getByRole('button', { name: /Clear offline/ })).toBeTruthy();
});

it('opens the modal with the dry-run matches', async () => {
  clearOfflineKiosks.mockResolvedValueOnce({ dry_run: true, kiosks: [MATCH], skipped: [] });
  renderPage({ maxRank: 60 });
  fireEvent.click(screen.getByRole('button', { name: /Clear offline/ }));
  expect(await screen.findByText('kiosk-dock-01')).toBeTruthy();
  expect(clearOfflineKiosks).toHaveBeenCalledWith({ dry_run: true });
});

it('confirms with the previewed ids and reports what actually happened', async () => {
  clearOfflineKiosks
    .mockResolvedValueOnce({ dry_run: true, kiosks: [MATCH, MATCH_B], skipped: [] })
    .mockResolvedValueOnce({ dry_run: false, kiosks: [MATCH], skipped: [MATCH_B] });
  renderPage({ maxRank: 60 });
  fireEvent.click(screen.getByRole('button', { name: /Clear offline/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Delete 2 kiosks/ }));
  expect(clearOfflineKiosks).toHaveBeenLastCalledWith({ dry_run: false, ids: [MATCH.id, MATCH_B.id] });
  expect(await screen.findByText(/Deleted 1 kiosk/)).toBeTruthy();
  expect(screen.getByText(/1 skipped/)).toBeTruthy();
});
```

Match the file's existing render helper and API mocking style — read it before writing these.

- [ ] **Step 2: Run them to verify they fail, then implement**

Add to `lib/api.ts`:

```ts
export interface ClearOfflineKioskItem {
  id: string; name: string; sub_type: string | null;
  registration: 'unregistered' | 'expired'; last_seen_at: string | null;
}
export interface ClearOfflineKiosksOut {
  dry_run: boolean; kiosks: ClearOfflineKioskItem[]; skipped: ClearOfflineKioskItem[];
}
export function clearOfflineKiosks(
  body: { dry_run: boolean; ids?: string[] },
): Promise<ClearOfflineKiosksOut> {
  return post('/devices/kiosks/clear-offline', body);
}
```
Follow the file's own request helper rather than assuming `post` — read a neighboring function.

In `KioskDevices.tsx`, add a `Clear offline` button to the `.dir-head` actions beside `+ New kiosk`, rendered only when `maxRank >= ADMIN_RANK` (add `const ADMIN_RANK = 60;` with a comment tying it to `GATE_BYPASS_RANK` in `access/defaults.py`). Clicking runs the dry run and opens the modal; confirming posts the previewed ids, closes the modal, reloads the list, and raises a notice built from the response:

- `kiosks` non-empty, `skipped` empty → `Deleted N kiosk(s)`
- both non-empty → `Deleted N kiosk(s) · M skipped, seen since the preview`
- `kiosks` empty, `skipped` non-empty → `Nothing deleted — M kiosk(s) have been seen since the preview`

**Report the response, never the predicted count.** The whole point of the server re-check is that these can differ.

- [ ] **Step 3: Verify**

Run: `npm --prefix portal test` (whole suite) and `npx --prefix portal tsc --noEmit -p portal/tsconfig.json` and `npm --prefix portal run build`
Expected: PASS and clean.

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/KioskDevices.tsx portal/src/lib/api.ts portal/src/pages/KioskDevices.test.tsx
git commit -m "feat(hardware): Clear offline button on the Kiosk Devices page

Admin and above only — hidden below rank 60 rather than disabled, since
a disabled destructive control advertises a capability the viewer will
never have. The success notice reports what the server actually deleted,
not what the preview predicted; the two differ whenever a kiosk comes
back to life between the two calls.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Full suite and live verification

Not a code task.

- [ ] **Step 1:** With `pgrep -f "pytest api/tests"` clear, run the whole API suite once: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/ -q`. Expected: no failures. If unrelated files fail (sites, surveys, kiosk, import), that is the known concurrent-session signature — re-run those files in isolation before believing it.

- [ ] **Step 2:** On the running dev stack, open `/hardware/kiosks` as an admin. Confirm the button appears, the modal lists the expected kiosks with correct registration states and last-seen values, and a dry run deletes nothing (re-check the row count in the database).

- [ ] **Step 3:** Confirm a real delete: note the ids, confirm, then verify in the database that exactly those rows are gone and that each has an audit row with `action='delete'` and `changes.reason='clear_offline_kiosks'`.

- [ ] **Step 4:** Confirm the rank gate live — as a staff-level actor, the button is absent, and a direct POST to the endpoint returns 403 `forbidden_rank`.

- [ ] **Step 5:** Report findings with a screenshot of the modal. Any defect goes back through the normal fix-and-review loop.

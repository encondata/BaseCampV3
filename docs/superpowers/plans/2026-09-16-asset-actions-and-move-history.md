# Asset Actions Menu and Move History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the assets list a consolidated Actions menu visible while rows are collapsed, and give the existing asset detail page a History tab carrying move history alongside the scan history it already has.

**Architecture:** One new read endpoint returns an asset's move roster rows, scoped by initiative so a client-anchored user cannot see another client's move through a shared asset. The list reuses the shared `RowActionsMenu` exactly as the Users list does. The detail page gains a `segmented` tab strip and one new panel; its existing chrome and panels are untouched.

**Tech Stack:** FastAPI + SQLAlchemy async + pytest against real Postgres; React 18 + TypeScript + react-router + vitest/jsdom.

**Spec:** `docs/superpowers/specs/2026-09-16-asset-actions-and-move-history-design.md`

## Global Constraints

- Work in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail` on branch `user-detail`. Never `cd` to the main checkout.
- Every python command sets `PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src` and `SS_TEST_DB=serversherpa_test_user_detail`; the venv is symlinked at `api/.venv`.
- Run suites in the FOREGROUND in one continuous command with an explicit timeout (600000 ms). Never background a suite and end the turn waiting.
- Lint gate: `api/.venv/bin/ruff check --select F401,E501 <files>` run from the `api` directory. Ruff line length 100.
- Never commit `api/src/serversherpa/_dev_reload.py`. Never `git add portal/node_modules` (a symlink).
- No migration. No new npm or python dependencies.
- American English everywhere.
- jest-dom matchers are NOT registered in this project. Assert the `disabled` property directly.
- The list typography guardrail `portal/src/styles/listTypography.test.ts` must stay green: no raw `<table>` outside `DataTable`, no typography properties outside `directory.css`.
- `scheduled_start` / `scheduled_end` are date-only at midnight UTC. Render them with `parseApiDay` (`portal/src/lib/timeline.ts`) fed into `longDateOf` (`portal/src/lib/format.ts`). Never `longDate`.
- Commit after each task with the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
|---|---|
| `api/src/serversherpa/api/schemas.py` | `AssetMoveRow` |
| `api/src/serversherpa/api/routes/assets.py` | `GET /assets/{id}/moves` |
| `api/tests/test_asset_moves_api.py` (new) | endpoint shape, ordering, scope refusal |
| `portal/src/lib/api.ts` | `AssetMoveRow` type, `listAssetMoves` |
| `portal/src/components/assets/AssetMoveHistory.tsx` (new) | the move history panel |
| `portal/src/pages/AssetDetail.tsx` | Overview/History tabs |
| `portal/src/App.tsx` | `/assets/:assetId/history` route |
| `portal/src/pages/Assets.tsx` | inline Actions column; expansion loses Edit |

---

### Task 1: `GET /assets/{asset_id}/moves`

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (append near the other asset schemas)
- Modify: `api/src/serversherpa/api/routes/assets.py` (after `get_asset`, ~line 133)
- Test: `api/tests/test_asset_moves_api.py` (create)

**Interfaces:**
- Consumes: `_get_asset(db, asset_id, actor)` (404s for missing AND out-of-scope), `_err`, `scope_conditions`, `require_permission` — all already in `assets.py`.
- Produces: `GET /assets/{asset_id}/moves -> list[AssetMoveRow]` with fields `row_id, initiative_id, initiative_name, initiative_status, initiative_status_label, initiative_status_color, asset_status, asset_status_label, asset_status_color, scheduled_start, scheduled_end, added_at`. The portal mirrors these names in Task 2.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_asset_moves_api.py`:

```python
"""An asset's move history: which move rosters it has appeared on. Scoped by
initiative, not just by asset — an asset can sit on two clients' moves and a
client-anchored user must not learn about the other client's move through it."""

import uuid
from datetime import UTC, datetime

from serversherpa.db.models import (
    Asset, Client, Initiative, InitiativeAsset, Person, PersonRole,
)
from tests.test_assets_api import login, make_login


async def _asset(db, *, name="rack-unit", client_id=None):
    asset = Asset(name=name, client_id=client_id)
    db.add(asset)
    await db.flush()
    return asset


async def _move(db, *, name, client_id=None, start=None, status="planned"):
    init = Initiative(name=name, initiative_type="move", status=status,
                      client_id=client_id, scheduled_start=start)
    db.add(init)
    await db.flush()
    return init


async def _roster(db, init, asset, *, status="loaded_in_system"):
    row = InitiativeAsset(initiative_id=init.id, asset_id=asset.id, status=status)
    db.add(row)
    await db.flush()
    return row


async def test_returns_every_move_newest_scheduled_first(client, db, seeded_user):
    hdrs = await login(client)
    asset = await _asset(db)
    older = await _move(db, name="Older move",
                        start=datetime(2026, 1, 1, tzinfo=UTC))
    newer = await _move(db, name="Newer move", status="in_progress",
                        start=datetime(2026, 6, 1, tzinfo=UTC))
    row_old = await _roster(db, older, asset)
    row_new = await _roster(db, newer, asset, status="staged")
    await db.commit()

    resp = await client.get(f"/assets/{asset.id}/moves", headers=hdrs)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [r["initiative_name"] for r in body] == ["Newer move", "Older move"]
    assert body[0]["row_id"] == str(row_new.id)
    assert body[0]["initiative_id"] == str(newer.id)
    assert body[0]["initiative_status"] == "in_progress"
    assert body[0]["initiative_status_label"]      # resolved from the vocabulary
    assert body[0]["asset_status"] == "staged"
    assert body[0]["asset_status_label"]
    assert body[0]["scheduled_start"] is not None
    assert body[1]["row_id"] == str(row_old.id)


async def test_asset_with_no_moves_returns_empty(client, db, seeded_user):
    hdrs = await login(client)
    asset = await _asset(db, name="never-moved")
    await db.commit()
    resp = await client.get(f"/assets/{asset.id}/moves", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json() == []


async def test_unscheduled_move_still_returned(client, db, seeded_user):
    hdrs = await login(client)
    asset = await _asset(db)
    init = await _move(db, name="Unscheduled", start=None)
    await _roster(db, init, asset)
    await db.commit()

    body = (await client.get(f"/assets/{asset.id}/moves", headers=hdrs)).json()

    assert len(body) == 1
    assert body[0]["scheduled_start"] is None
    assert body[0]["scheduled_end"] is None
    assert body[0]["added_at"] is not None


async def test_unknown_asset_is_404(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get(f"/assets/{uuid.uuid4()}/moves", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "asset_not_found"


async def test_client_contact_sees_only_their_own_clients_moves(client, db, seeded_user):
    """The security case: one asset, two clients' moves. The contact of client
    A must see A's move and must NOT learn B's move exists."""
    org_a = Client(name="Alpha Corp")
    org_b = Client(name="Beta Corp")
    db.add_all([org_a, org_b])
    await db.flush()

    asset = await _asset(db, name="shared-unit", client_id=org_a.id)
    move_a = await _move(db, name="Alpha move", client_id=org_a.id,
                         start=datetime(2026, 3, 1, tzinfo=UTC))
    move_b = await _move(db, name="Beta move", client_id=org_b.id,
                         start=datetime(2026, 4, 1, tzinfo=UTC))
    await _roster(db, move_a, asset)
    await _roster(db, move_b, asset)

    contact = Person(first_name="Ann", last_name="Alpha")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=org_a.id))
    await db.commit()
    hdrs = await make_login(db, client, contact, "ann@alpha.test.example.com")

    body = (await client.get(f"/assets/{asset.id}/moves", headers=hdrs)).json()

    names = [r["initiative_name"] for r in body]
    assert names == ["Alpha move"]
    assert "Beta move" not in names

    # the unscoped admin still sees both, so the filter is scope, not a bug
    admin = await login(client)
    all_names = [r["initiative_name"] for r in
                 (await client.get(f"/assets/{asset.id}/moves", headers=admin)).json()]
    assert set(all_names) == {"Alpha move", "Beta move"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail .venv/bin/pytest -q --no-header -p no:cacheprovider tests/test_asset_moves_api.py
```
Expected: FAIL — the route does not exist, so every test gets 404 with a FastAPI `Not Found` body rather than the `asset_not_found` code.

If `Initiative(...)` or `InitiativeAsset(...)` rejects a keyword, read the class in `api/src/serversherpa/db/models.py` and supply every column without a server default. Do not change the models. If `make_login` is not exported from `tests/test_assets_api.py` under that name, read that file and use whatever helper it provides.

- [ ] **Step 3: Add the schema**

Append to `api/src/serversherpa/api/schemas.py`, near the other asset schemas:

```python
class AssetMoveRow(BaseModel):
    """One move roster row an asset has appeared on — the compact history
    line. Rack, RU, disposition and verification live on the move-row page
    this links to, deliberately not here."""

    row_id: uuid.UUID            # initiative_assets.id — the move-row page key
    initiative_id: uuid.UUID
    initiative_name: str
    initiative_status: str
    initiative_status_label: str
    initiative_status_color: str
    asset_status: str
    asset_status_label: str
    asset_status_color: str
    scheduled_start: datetime | None
    scheduled_end: datetime | None
    added_at: datetime
```

- [ ] **Step 4: Add the endpoint**

In `api/src/serversherpa/api/routes/assets.py`, add `AssetMoveRow` to the `from serversherpa.api.schemas import (...)` block and `Initiative, InitiativeAsset` to the `from serversherpa.db.models import (...)` block. Add after `get_asset`:

```python
@router.get("/{asset_id}/moves", response_model=list[AssetMoveRow])
async def list_asset_moves(
    asset_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("assets", "view"),
) -> list[AssetMoveRow]:
    """Every move roster this asset has appeared on, newest scheduled first.

    Scoped by INITIATIVE, not only by asset: one asset can sit on two
    clients' moves, and a client-anchored actor must not learn another
    client's move exists through an asset they can legitimately see."""
    await _get_asset(db, asset_id, actor)

    query = (
        select(InitiativeAsset, Initiative)
        .join(Initiative, Initiative.id == InitiativeAsset.initiative_id)
        .where(InitiativeAsset.asset_id == asset_id)
        .order_by(Initiative.scheduled_start.desc().nullslast(),
                  InitiativeAsset.created_at.desc())
    )
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)
    rows = (await db.execute(query)).all()

    init_labels = await status_labels(db, "initiative")
    asset_labels = await status_labels(db, "asset")
    out: list[AssetMoveRow] = []
    for row, init in rows:
        i_label, i_color = init_labels.get(init.status, (init.status, UNKNOWN_COLOR))
        a_label, a_color = asset_labels.get(row.status, (row.status, UNKNOWN_COLOR))
        out.append(AssetMoveRow(
            row_id=row.id, initiative_id=init.id, initiative_name=init.name,
            initiative_status=init.status, initiative_status_label=i_label,
            initiative_status_color=i_color,
            asset_status=row.status, asset_status_label=a_label,
            asset_status_color=a_color,
            scheduled_start=init.scheduled_start, scheduled_end=init.scheduled_end,
            added_at=row.created_at))
    return out
```

Add `from serversherpa.status.labels import UNKNOWN_COLOR, status_labels` to the imports. If `assets.py` already builds status labels through its own `_statuses()` helper, read it first: reuse the existing helper for the asset vocabulary rather than importing a second mechanism, and only import `status_labels` for the initiative vocabulary. Say which shape you used in your report.

- [ ] **Step 5: Run the tests to verify they pass**

Run the Step 2 command. Expected: 5 passed.

If the scope test's contact gets 403 rather than a filtered list, the `client_viewer` role lacks `assets:view`; read `api/src/serversherpa/access/defaults.py` and use whichever client-anchored role does hold it, noting the substitution in your report.

- [ ] **Step 6: Lint and commit**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && .venv/bin/ruff check --select F401,E501 src/serversherpa/api/routes/assets.py src/serversherpa/api/schemas.py tests/test_asset_moves_api.py
```
Expected: clean.

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add api/src/serversherpa/api/routes/assets.py api/src/serversherpa/api/schemas.py api/tests/test_asset_moves_api.py && git commit -m "feat(api): GET /assets/{id}/moves returns an asset's move history, scoped by initiative

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Portal client and the move history panel

**Files:**
- Modify: `portal/src/lib/api.ts` (near `listAssetScans`, ~line 2073)
- Create: `portal/src/components/assets/AssetMoveHistory.tsx`
- Test: `portal/src/components/assets/AssetMoveHistory.test.tsx` (create)

**Interfaces:**
- Consumes: Task 1's payload; `DataTable` (`portal/src/components/DataTable`, props `columns: {key,label,align?,mono?,width?}[]`, `rows: {key, cells: ReactNode[]}[]`, `emptyText`, `ariaLabel`); `statusChip` from `portal/src/lib/chips`; `parseApiDay` from `portal/src/lib/timeline`; `longDateOf` from `portal/src/lib/format`.
- Produces: `AssetMoveRow` and `listAssetMoves(assetId)` in `api.ts`; `AssetMoveHistory` default export with prop `{ assetId: string }`.

- [ ] **Step 1: Write the failing test**

Create `portal/src/components/assets/AssetMoveHistory.test.tsx`:

```tsx
// @vitest-environment jsdom
/**
 * An asset's move history: compact by design — one line per move, with the
 * rack and RU detail behind the link to the move row.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AssetMoveRow } from '../../lib/api';

const api = vi.hoisted(() => ({ listAssetMoves: vi.fn() }));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const ROWS: AssetMoveRow[] = [
  {
    row_id: 'r1', initiative_id: 'i1', initiative_name: 'NAP11 Hall Migration',
    initiative_status: 'in_progress', initiative_status_label: 'In progress',
    initiative_status_color: '#d38b1d',
    asset_status: 'staged', asset_status_label: 'Staged', asset_status_color: '#178a4c',
    scheduled_start: '2026-06-01T00:00:00Z', scheduled_end: '2026-06-05T00:00:00Z',
    added_at: '2026-05-01T00:00:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.listAssetMoves.mockResolvedValue(ROWS);
});
afterEach(cleanup);

const { default: AssetMoveHistory } = await import('./AssetMoveHistory');

const renderPanel = () => render(
  <MemoryRouter><AssetMoveHistory assetId="a1" /></MemoryRouter>,
);

it('lists one line per move, linking to the move and its row', async () => {
  renderPanel();
  expect(await screen.findByRole('table', { name: 'Move history' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'NAP11 Hall Migration' })
    .getAttribute('href')).toBe('/initiatives/i1');
  expect(screen.getByText('In progress')).toBeTruthy();
  expect(screen.getByText('Staged')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open move row' })
    .getAttribute('href')).toBe('/initiatives/i1/assets/r1');
  await waitFor(() => expect(api.listAssetMoves).toHaveBeenCalledWith('a1'));
});

it('renders the scheduled day without shifting it west of UTC', async () => {
  renderPanel();
  await screen.findByRole('table', { name: 'Move history' });
  // midnight-UTC date-only values must not name 31 May in a negative offset
  expect(screen.queryByText(/31 May|May 31/)).toBeNull();
  expect(screen.getByText(/Jun(e)? 1|1 Jun/)).toBeTruthy();
});

it('shows the empty state when the asset has never moved', async () => {
  api.listAssetMoves.mockResolvedValue([]);
  renderPanel();
  expect(await screen.findByText('This asset has not been on a move.')).toBeTruthy();
});

it('offers a retry when the fetch fails', async () => {
  api.listAssetMoves.mockRejectedValueOnce(new Error('network'));
  renderPanel();
  expect(await screen.findByText('Could not load move history.')).toBeTruthy();
  api.listAssetMoves.mockResolvedValue(ROWS);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('table', { name: 'Move history' })).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/components/assets/AssetMoveHistory.test.tsx`
Expected: FAIL — module `./AssetMoveHistory` not found.

- [ ] **Step 3: Add the API client**

Insert after `listAssetScans` in `portal/src/lib/api.ts`:

```ts
/** One move roster row an asset has appeared on. Compact by design — rack,
 *  RU, disposition and verification live on the move-row page. */
export interface AssetMoveRow {
  row_id: string;
  initiative_id: string;
  initiative_name: string;
  initiative_status: string;
  initiative_status_label: string;
  initiative_status_color: string;
  asset_status: string;
  asset_status_label: string;
  asset_status_color: string;
  /** date-only, midnight UTC — render with parseApiDay + longDateOf */
  scheduled_start: string | null;
  scheduled_end: string | null;
  added_at: string;
}

export async function listAssetMoves(assetId: string): Promise<AssetMoveRow[]> {
  const resp = await apiFetch(`/assets/${assetId}/moves`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

- [ ] **Step 4: Create the panel**

Create `portal/src/components/assets/AssetMoveHistory.tsx`:

```tsx
/**
 * AssetMoveHistory — every move roster this asset has appeared on, one line
 * each. Deliberately compact: rack, RU, disposition and verification live on
 * the move-row page each line links to.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import DataTable from '../DataTable';
import { listAssetMoves, type AssetMoveRow } from '../../lib/api';
import { statusChip } from '../../lib/chips';
import { longDateOf } from '../../lib/format';
import { parseApiDay } from '../../lib/timeline';

/** scheduled_* are date-only at midnight UTC: parseApiDay keeps the day from
 *  sliding backwards for anyone west of UTC, which plain longDate does not. */
function scheduled(row: AssetMoveRow): string {
  if (!row.scheduled_start && !row.scheduled_end) return '—';
  const start = row.scheduled_start ? longDateOf(parseApiDay(row.scheduled_start)) : '—';
  if (!row.scheduled_end) return start;
  const end = longDateOf(parseApiDay(row.scheduled_end));
  return start === end ? start : `${start} – ${end}`;
}

export default function AssetMoveHistory({ assetId }: { assetId: string }) {
  const [rows, setRows] = useState<AssetMoveRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setRows(await listAssetMoves(assetId));
    } catch {
      setFailed(true);
    }
  }, [assetId]);

  useEffect(() => { void load(); }, [load]);

  if (failed) {
    return (
      <div className="dir-empty">
        <b>Could not load move history.</b>
        <button type="button" className="mini-btn" style={{ marginTop: 8 }}
                onClick={() => void load()}>Retry</button>
      </div>
    );
  }
  if (rows === null) {
    return <p className="set-note" style={{ padding: 0 }}>Loading…</p>;
  }

  return (
    <DataTable ariaLabel="Move history"
      emptyText="This asset has not been on a move."
      columns={[
        { key: 'move', label: 'Move' },
        { key: 'status', label: 'Status' },
        { key: 'asset', label: 'Asset status' },
        { key: 'scheduled', label: 'Scheduled' },
        { key: 'open', label: '' },
      ]}
      rows={rows.map((r) => ({
        key: r.row_id,
        cells: [
          <Link to={`/initiatives/${r.initiative_id}`}>{r.initiative_name}</Link>,
          statusChip(r.initiative_status_label, r.initiative_status_color),
          statusChip(r.asset_status_label, r.asset_status_color),
          scheduled(r),
          <Link className="mini-btn" to={`/initiatives/${r.initiative_id}/assets/${r.row_id}`}>
            Open move row
          </Link>,
        ],
      }))} />
  );
}
```

- [ ] **Step 5: Run the tests and type-check**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/components/assets/AssetMoveHistory.test.tsx src/styles/listTypography.test.ts && npx tsc -b --noEmit`
Expected: 4 passed, guardrail green, tsc clean, output pristine. If React warns about missing keys on `DataTable` cells, wrap each JSX cell in a keyed fragment.

- [ ] **Step 6: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add portal/src/lib/api.ts portal/src/components/assets/AssetMoveHistory.tsx portal/src/components/assets/AssetMoveHistory.test.tsx && git commit -m "feat(portal): asset move history panel

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Overview and History tabs on the asset page

**Files:**
- Modify: `portal/src/pages/AssetDetail.tsx`
- Modify: `portal/src/App.tsx` (after the `/assets/:assetId` route, ~line 100)
- Test: `portal/src/pages/AssetDetail.test.tsx` (create)

**Interfaces:**
- Consumes: `AssetMoveHistory` (Task 2); the page's existing `getAsset`, `AssetEditModal`, `NotesFilesPanel`, `ScanHistoryTable`.

- [ ] **Step 1: Write the failing test**

Create `portal/src/pages/AssetDetail.test.tsx`:

```tsx
// @vitest-environment jsdom
/**
 * /assets/:assetId — Overview keeps identity and location; History carries
 * move history above the scan history that was already there.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AssetItem } from '../lib/api';

const auth = vi.hoisted(() => ({ perms: new Set<string>(['assets:view', 'assets:change', 'scans:view']) }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (res: string, action = 'view') => auth.perms.has(`${res}:${action}`),
    godMode: false,
    preferences: { list_prefs: {} },
    updatePreferences: vi.fn(),
  }),
}));

const api = vi.hoisted(() => ({
  getAsset: vi.fn(),
  listAssetStatuses: vi.fn(async () => []),
  listClients: vi.fn(async () => []),
  listSites: vi.fn(async () => []),
  listAssets: vi.fn(async () => []),
  listAssetMoves: vi.fn(async () => []),
  listAssetScans: vi.fn(async () => []),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const ASSET = {
  id: 'a1', legacy_id: 100042, serial_number: 'SN-ALPHA', name: 'web-01',
  rfid_tag: null, model_id: null, model: null,
  client_id: null, client_name: 'Acme', site_id: null, site_name: 'DC1',
  location_detail: 'Rack 3', status: 'active', status_label: 'Active',
  status_color: '#178a4c', has_rails: null, last_seen_at: null,
  archived_at: null, created_at: '2026-08-05T00:00:00Z',
} as unknown as AssetItem;

beforeEach(() => {
  vi.clearAllMocks();
  auth.perms = new Set(['assets:view', 'assets:change', 'scans:view']);
  api.getAsset.mockResolvedValue(ASSET);
});
afterEach(cleanup);

const { default: AssetDetail } = await import('./AssetDetail');

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/assets/:assetId" element={<AssetDetail />} />
        <Route path="/assets/:assetId/history" element={<AssetDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

it('Overview shows identity and no history panels', async () => {
  renderAt('/assets/a1');
  expect(await screen.findByText('Identity')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByText('Move history')).toBeNull();
  expect(screen.queryByText('Scan History')).toBeNull();
});

it('History shows move history and scan history, not identity', async () => {
  renderAt('/assets/a1/history');
  expect(await screen.findByText('Move history')).toBeTruthy();
  expect(screen.getByText('Scan History')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByText('Identity')).toBeNull();
});

it('clicking History navigates to the history path', async () => {
  renderAt('/assets/a1');
  await screen.findByText('Identity');
  fireEvent.click(screen.getByRole('tab', { name: 'History' }));
  expect(await screen.findByText('Move history')).toBeTruthy();
});

it('hides the scan panel without scans:view but keeps move history', async () => {
  auth.perms = new Set(['assets:view']);
  renderAt('/assets/a1/history');
  expect(await screen.findByText('Move history')).toBeTruthy();
  expect(screen.queryByText('Scan History')).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/pages/AssetDetail.test.tsx`
Expected: FAIL — no tabs exist, so the `tab` role queries find nothing.

- [ ] **Step 3: Add the tabs**

In `portal/src/pages/AssetDetail.tsx`:

Add `useLocation, useNavigate` to the `react-router-dom` import and `import AssetMoveHistory from '../components/assets/AssetMoveHistory';`.

Inside the component, after the existing hooks:

```tsx
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const tab: 'overview' | 'history' = pathname.endsWith('/history') ? 'history' : 'overview';
  const base = `/assets/${assetId}`;
```

Directly after the closing `</div>` of `idet-header`, insert the tab strip:

```tsx
      <div className="segmented" role="tablist">
        {([['overview', 'Overview', base],
           ['history', 'History', `${base}/history`]] as const).map(([key, label, to]) => (
          <button key={key} role="tab" aria-selected={tab === key}
                  className={tab === key ? 'on' : ''}
                  onClick={() => navigate(to)}>
            {label}
          </button>
        ))}
      </div>
```

Wrap the three existing panels (Identity, Location & status, Notes & Files) in `{tab === 'overview' && (<>…</>)}`. Replace the existing scan-history block with the history tab:

```tsx
      {tab === 'history' && (
        <>
          <div className="init-panel">
            <p className="eyebrow-sm">Move history</p>
            <AssetMoveHistory assetId={asset.id} />
          </div>
          {canViewScans && (
            <div className="init-panel">
              <p className="eyebrow-sm">Scan History</p>
              <ScanHistoryTable assetId={asset.id} />
            </div>
          )}
        </>
      )}
```

The header, its Edit button and the edit modal stay outside the tab branches so both tabs keep them.

- [ ] **Step 4: Add the route**

In `portal/src/App.tsx`, directly after the `/assets/:assetId` route:

```tsx
                <Route path="/assets/:assetId/history" element={
                  <ProtectedRoute resource="assets"><AssetDetail /></ProtectedRoute>
                } />
```

- [ ] **Step 5: Run the tests, guardrail and type-check**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/pages/AssetDetail.test.tsx src/components/assets/AssetMoveHistory.test.tsx src/styles/listTypography.test.ts && npx tsc -b --noEmit`
Expected: all pass, guardrail green, tsc clean, output pristine.

- [ ] **Step 6: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add portal/src/pages/AssetDetail.tsx portal/src/pages/AssetDetail.test.tsx portal/src/App.tsx && git commit -m "feat(portal): asset page gains Overview and History tabs with move history

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Inline Actions menu on the assets list

**Files:**
- Modify: `portal/src/pages/Assets.tsx` (grid ~line 292, `.list-head`, the row, and `AssetRowDetail` ~lines 547-591)
- Test: `portal/src/pages/Assets.test.tsx` (append)

**Interfaces:**
- Consumes: `RowActionsMenu` from `portal/src/components/hardware/RowActionsMenu` (props `{ label?: string; actions: RowAction[] }`, `RowAction` = `{ key, label, onSelect, destructive?, disabled? }`).

- [ ] **Step 1: Write the failing tests**

Append to `portal/src/pages/Assets.test.tsx` (read its existing mocks and fixture first; the file already mocks `../auth/AuthContext` with `can: () => true` and `../lib/api`):

```tsx
it('each collapsed row carries an Actions menu with Full details and Edit', async () => {
  render(<MemoryRouter initialEntries={['/assets']}>
    <Routes>
      <Route path="/assets" element={<Assets />} />
      <Route path="/assets/:assetId" element={<div>ASSET PAGE</div>} />
    </Routes>
  </MemoryRouter>);
  const trigger = (await screen.findAllByRole('button', { name: /Actions/ }))[0];
  fireEvent.click(trigger);
  expect(await screen.findByText('Full details')).toBeTruthy();
  expect(screen.getByText('Edit')).toBeTruthy();
});

it('opening the Actions menu does not expand the row', async () => {
  render(<MemoryRouter><Assets /></MemoryRouter>);
  const trigger = (await screen.findAllByRole('button', { name: /Actions/ }))[0];
  fireEvent.click(trigger);
  expect(document.querySelector('.dir-row.open')).toBeNull();
});

it('Full details navigates to the asset page', async () => {
  render(<MemoryRouter initialEntries={['/assets']}>
    <Routes>
      <Route path="/assets" element={<Assets />} />
      <Route path="/assets/:assetId" element={<div>ASSET PAGE</div>} />
    </Routes>
  </MemoryRouter>);
  fireEvent.click((await screen.findAllByRole('button', { name: /Actions/ }))[0]);
  fireEvent.click(await screen.findByText('Full details'));
  expect(await screen.findByText('ASSET PAGE')).toBeTruthy();
});
```

Add `MemoryRouter, Route, Routes` and `fireEvent` to the file's imports if they are not already there. If the existing tests render `Assets` without a router, follow whatever pattern the file already uses and adapt these accordingly.

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/pages/Assets.test.tsx`
Expected: the three new tests FAIL — no Actions trigger exists.

- [ ] **Step 3: Wire the list**

In `portal/src/pages/Assets.tsx`:

Add `import { RowActionsMenu } from '../components/hardware/RowActionsMenu';` and `useNavigate` from `react-router-dom`, then `const navigate = useNavigate();` inside the component.

Change the grid (~line 292):

```tsx
  const grid = { gridTemplateColumns: `${shownCols.map((c) => c.width).join(' ')} 100px 30px` };
```

Add an empty header slot in `.list-head` immediately before the trailing chevron slot: `<span className="col-head" aria-hidden="true" />`.

Add a `rowActions` helper inside the component:

```tsx
  const rowActions = (a: AssetItem): RowAction[] => [
    { key: 'details', label: 'Full details', onSelect: () => navigate(`/assets/${a.id}`) },
    ...(canChange
      ? [{ key: 'edit', label: 'Edit', onSelect: () => setEditingId(a.id) }]
      : []),
  ];
```

Import the `RowAction` type alongside the component. In `row-main`, immediately before the `chevron-cell` div:

```tsx
                  <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}
                       onClick={(e) => e.stopPropagation()}>
                    <RowActionsMenu actions={rowActions(a)} />
                  </div>
```

In `AssetRowDetail`, drop the `canEdit`-gated Edit button and the `onEdit` prop entirely, and render `detail-actions` only when `godVisible`:

```tsx
      {godVisible && (
        <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
          <GodDeleteButton visible={godVisible} entityType="asset" entityId={asset.id}
                           label={asset.name ?? asset.serial_number ?? 'Asset'} pending={pending}
                           onChange={pending ? onUnmark : onMark} />
        </div>
      )}
```

Remove `onEdit` from the call site and the prop type. `canEdit` is still needed by `NotesFilesPanel`, so keep that prop. Update the component's doc comment, which currently says the Edit button is the only interactive element.

- [ ] **Step 4: Run the tests, guardrail and type-check**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/pages/Assets.test.tsx src/styles/listTypography.test.ts && npx tsc -b --noEmit`
Expected: all pass, guardrail green, tsc clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add portal/src/pages/Assets.tsx portal/src/pages/Assets.test.tsx && git commit -m "feat(assets): row actions collapse into one inline Actions menu

Full details and Edit live behind the shared RowActionsMenu in its own column,
visible while the row is collapsed. The expansion keeps notes, files and the
god-mode delete.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Full suites and live verification

- [ ] **Step 1: Full portal suite, type-check, build**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run && npx tsc -b --noEmit && npm run build`
Expected: all green.

- [ ] **Step 2: Full API suite**

It runs ~18 minutes, longer than the foreground timeout, so run it detached and poll:

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && rm -f .devlogs/api-assets.log && (PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail nohup api/.venv/bin/pytest -q --no-header -p no:cacheprovider api/tests > .devlogs/api-assets.log 2>&1 &) ; until grep -qE "^[0-9]+ (passed|failed)" .devlogs/api-assets.log 2>/dev/null; do sleep 20; done; tail -2 .devlogs/api-assets.log
```
Expected: no failures; the count rises by the five new tests.

- [ ] **Step 3: Live verification**

The dev stack for this branch runs on API 8001 and portal 5175 (8000/5173/5174 belong to another session — do not touch them). If they are down, start them detached exactly as `docs/superpowers/plans/2026-09-15-cascade-delete-override.md` Task 8 Step 3 describes.

Sign in at `http://localhost:5175` as `claude-dev@test.example.com` / `wt-verify-2026` (fill the fields with `form_input`, then `document.querySelector('form').requestSubmit()` — the login page's reveal animation does not run in the browser pane).

1. Open `/assets`. Every collapsed row shows **Actions ▾** in its own column. Screenshot.
2. Open a row's menu, confirm Full details and Edit, and check that opening the menu did not expand the row.
3. Take Full details to the asset page; confirm the Overview and History tabs.
4. On History, confirm the move history table. The seeded initiative "NAP11 Hall Migration (demo)" has a 15-asset roster, so pick one of those assets to see a populated table; confirm the move name links to the initiative and "Open move row" reaches the move row page.
5. Confirm an asset with no moves shows "This asset has not been on a move."

Fix anything that looks wrong in the source, re-screenshot, and commit as `fix(...)`.

- [ ] **Step 4: Report**

`git status` clean apart from `.devlogs/` and `portal/node_modules`; restore `api/src/serversherpa/_dev_reload.py` if the dev API touched it. Report the final commit, both suite counts, and what the screenshots showed.

---

## Self-review notes

- Spec coverage: endpoint with initiative scope (Task 1), portal client and panel with the date-only handling (Task 2), tabs and route (Task 3), list actions menu and the expansion's lost Edit button (Task 4), suites and live pass (Task 5).
- Type consistency: `AssetMoveRow`'s field names are identical in the pydantic schema (Task 1) and the TypeScript interface (Task 2); `AssetMoveHistory`'s single `assetId` prop matches its call site in Task 3; `rowActions` returns `RowAction[]` as `RowActionsMenu` expects.
- The spec's error-handling line about a failed move-history fetch is implemented in Task 2's component, not in the page, so the scan panel below it is unaffected — matching the spec.

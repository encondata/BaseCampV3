# Kiosk Asset Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only Asset Lookup tile on the kiosk (`/lookup`). Anyone signed in scans or types an asset tag, serial, RFID or name and sees the device's identity, source and destination. Admins and above also see its status, moves, current location and scan history.

**Architecture:**
- Three new read-only kiosk routes in `routes/kiosk.py`: lookup, details and scans.
- A new service, `services/asset_lookup.py`, holds the reach rules (which devices a person may find), the matching rules and the move list. The kiosk's move always comes from the registered Device, never from the request.
- The scans route shares one helper with the portal's `/scans/asset/{id}`, so the two can't drift.
- The kiosk adds an api client, an offline matcher over the synced `assets` store, the `AssetLookup` page and the tile, route and breadcrumb wiring.

**Tech Stack:** FastAPI + async SQLAlchemy + Postgres (`api/`), React 18 + Vite + vitest (`kiosk/`), one React-free helper moved in `portal/`.

**Spec:** `docs/superpowers/specs/2026-11-08-kiosk-asset-lookup-design.md`. It is binding for behavior and for every user-facing string it quotes.

## Global Constraints

- **Worktree:** work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/kiosk-asset-lookup` (branch `kiosk-asset-lookup`). Never touch the main checkout.
- **Worktree prep (once, before Task 1; skip any link that exists):**
  - `ln -s /Users/jrh1812/Developer/BaseCampV3/api/.venv api/.venv`
  - `ln -s /Users/jrh1812/Developer/BaseCampV3/.env .env`
  - `kiosk/node_modules` and `portal/node_modules` are already linked.
- **API tests:** `cd api && SS_TEST_DB=serversherpa_test_kiosk_lookup PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q -p no:cacheprovider <files>`. `PYTHONPATH` is required, because the linked venv's editable install points at the main checkout.
- **Kiosk tests:** `cd kiosk && npx vitest run <files relative to kiosk/>`. The build gate is `cd kiosk && npm run build`. DOM test files start with `// @vitest-environment jsdom`.
- **Portal tests:** `cd portal && npx vitest run <files>`. The build gate is `cd portal && npm run build`.
- **Never commit `api/src/serversherpa/_dev_reload.py`.** If it shows as modified, restore it with `git checkout -- api/src/serversherpa/_dev_reload.py` in this worktree only.
- **Never run bare `git stash`.** Every commit message ends with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Read-only:** no route or screen in this feature writes anything. That means no `raw_scans`, `processed_scans`, `audit_log` or outbox rows, and no `Device.last_seen_at` bump. No migration.
- **Admin line:** rank 60 (`GATE_BYPASS_RANK` in `access/defaults.py`; kiosk `isAdmin`), checked by rank only, as `require_rank` does. The server enforces the split. Below admin, `full` is `null`, and the scans route answers 403 `forbidden`.
- **Not found:** a device outside the person's reach answers 404 `asset_not_found`, the same as a missing one. An unknown kiosk serial answers 404 `device_not_found`. A move-password session on a kiosk set up for another move answers 403 `move_locked` (`_require_move`, as `enroll_rfid` does).
- **A "live move"** means `initiative_type == "move"` and `archived_at IS NULL`. Completed and cancelled moves are kept, as `/kiosk/sync/client-assets` keeps them.
- **Copy:** American English. Strings quoted in a task are exact. Times are 24-hour (`hourCycle: 'h23'`), never AM/PM. A blank value shows "—".
- **UI:** use only theme tokens, so the page follows light and dark. Reuse the existing classes: `.portal-page`, `.eyebrow`, `.page-title`, `.page-hint`, `.scan-input`, `.btn-solid`, `.mini-btn`, `.enroll-card`, `.enroll-card-name`, `.enroll-facts`, `.local-table`, `.chip`, `.form-error`. Tables wrap their cells and never scroll sideways, so no default browser scrollbar appears. New CSS uses only `lookup-*` rules.
- **Dependencies:** none new.

## Review Focus

1. **Staff (rank 40, global `assets:view`) is below admin.** Their portal scope must not widen their kiosk reach: they get the worker set and `full: null`. Test: `test_staff_gets_the_worker_reach_and_no_full_details` (Task 2).
2. **Odd typed input.** A value with `%` or `_`, a 23-digit number, a 30-character value or non-ASCII text must answer 200 with no match, never 500. That rules out a LIKE wildcard, a bigint overflow and an RFID that won't pad. Test: `test_odd_input_never_errors` (Task 1).
3. **A worker on a kiosk with no move** (setup cleared on the server) finds nothing and gets no error. An admin still follows their scope. Test: `test_a_kiosk_without_a_move_gives_a_worker_nothing` (Task 1).
4. **The laptop signed in offline.** When the edge answers 403 `cloud_sign_in_required`, or the network is down, the lookup must fall back to the synced devices with the offline notice, rather than showing an error. Test: `falls back to the synced devices when the cloud needs a sign-in` (Task 4).
5. **A no-match value stays in the box but must not swallow the next scan.** After "No asset matches …", the next scanner burst must replace the value, not append to it. Test: `after a miss the next scan replaces the value` (Task 5).

---

### Task 1: Reach and matching service, and `GET /kiosk/assets/lookup`

**Files:**
- Create: `api/src/serversherpa/services/asset_lookup.py`
- Modify: `api/src/serversherpa/api/schemas.py`. Add `KioskAssetLookupMatch` and `KioskAssetLookupOut` next to `KioskRfidEnrollOut`.
- Modify: `api/src/serversherpa/api/routes/kiosk.py`. Add a new section `# ── asset lookup (kiosk:view, read-only) ──` after the RFID enroll section. Declare `/assets/lookup` **before** any `/assets/{asset_id}` GET, so "lookup" is never parsed as a uuid.
- Test: `api/tests/test_kiosk_asset_lookup_api.py`

**Interfaces:**
- Produces, in `serversherpa.services.asset_lookup`:
  - `LOOKUP_CAP = 25`
  - `@dataclass(frozen=True) class LookupReach`, with these fields:
    - `admin: bool`
    - `kiosk_move_id: uuid.UUID | None`
    - `kiosk_client_id: uuid.UUID | None`
    - `locked_move_id: uuid.UUID | None`
    - `access: AccessInfo`
    - `person_id: uuid.UUID`
  - `async def lookup_reach(db, device: Device, *, access: AccessInfo, person_id: uuid.UUID, locked_move_id: uuid.UUID | None) -> LookupReach`. `admin` is `access.max_rank >= GATE_BYPASS_RANK`. `kiosk_client_id` is the kiosk move's `client_id`.
  - `def asset_reach(reach: LookupReach) -> ColumnElement[bool]`: a WHERE clause over `Asset`, always including `Asset.archived_at IS NULL`. "On move m" means `Asset.id IN (SELECT asset_id FROM initiative_assets WHERE initiative_id = m)`.
    - Locked session: on `locked_move_id` only.
    - Admin: either (`assets:view`, plus `scope_conditions("assets", …)` when not None), or on the kiosk move. With no `assets:view`, the kiosk move only.
    - Below admin:
      - With no kiosk move: `sa.false()`.
      - Otherwise, any of these: on the kiosk move; `Asset.client_id == kiosk_client_id`; or on any live move whose `client_id == kiosk_client_id`. The two client legs apply only when the client is not None.
      - This is exactly the `/kiosk/sync/assets` ∪ `/kiosk/sync/client-assets` set.
  - `def move_reach(reach: LookupReach) -> ColumnElement[bool]`: a WHERE clause over `Initiative`, always including the live-move test.
    - Locked: `Initiative.id == locked_move_id`.
    - Admin: `scope_conditions("initiatives", …)` (None means all), or the kiosk move.
    - Below admin: the kiosk move, or `Initiative.client_id == kiosk_client_id` (when not None).
  - `@dataclass(frozen=True) class LookupHit`: `asset: Asset`, `matched: list[str]`. The values are from `"asset_tag" | "serial" | "rfid" | "name"`.
  - `async def find_assets(db, reach: LookupReach, raw: str) -> tuple[list[LookupHit], bool]`: the hits and `truncated`.
  - `async def asset_in_reach(db, reach: LookupReach, asset_id: uuid.UUID) -> Asset | None`
- Produces, in `api/schemas.py`:
  - `KioskAssetLookupMatch`: `id: uuid.UUID`, `name: str | None`, `asset_tag: str` (`legacy_id` as text, `""` when unset), `serial_number: str | None`, `matched: list[Literal["asset_tag","serial","rfid","name"]]`.
  - `KioskAssetLookupOut`: `matches: list[KioskAssetLookupMatch]`, `truncated: bool = False`.
- Produces the HTTP contract: `GET /kiosk/assets/lookup?serial=<kiosk>&q=<value>` returns `200 KioskAssetLookupOut`. `q` is `Query(..., max_length=200)`. It is `kiosk:view` only.
- Consumes: `_kiosk_device`, `_require_move` and `_err` (`routes/kiosk.py`); `normalize_rfid` from `serversherpa.assets.bulk_update` (the **non-raising** one, which returns `None` when the value can't be a tag); `scope_conditions`; `natural`.

**Matching rules (`find_assets`).** The spec leaves the algorithm open, so it is fixed here.
1. `value = raw.strip()`. An empty value returns `([], False)`.
2. Exact hits, in this order:
   - **asset tag:** only when `value.isdigit()`, `value[0] != "0"` and `len(value) <= 18`, then `Asset.legacy_id == int(value)`. A zero-padded value is never an asset tag.
   - **serial:** `Asset.serial_number == value` (the column is CITEXT, so case is ignored).
   - **rfid:** `tag = normalize_rfid(value)`; when not None, `Asset.rfid_tag == tag`.

   Every query is ANDed with `asset_reach(reach)`. Hits are grouped by asset in first-seen order, with `matched` in the order above. They are capped at `LOOKUP_CAP`, with `truncated` true when more exist.
3. With no exact hit: `Asset.name.ilike(f"%{escaped}%", escape="\\")`, where `%`, `_` and `\` in the value are escaped. This is also ANDed with the reach. Order by `natural(Asset.name)`, then `Asset.legacy_id`. Fetch `LOOKUP_CAP + 1` rows, so `truncated = len > 25`. Each hit's `matched` is `["name"]`.

**Test world (`_world(db, client)`)**, in the new test file. Build it once and reuse it in Tasks 2 and 3.
- Clients "Atlas" (`cx`) and "Other Co" (`cy`). Sites "ATL1" and "ATL2".
- Moves:
  - `M` "ATL1 Move": client `cx`, origin ATL1, destination ATL2, status `in_progress`.
  - `M2` "ATL1 Wave 2": client `cx`.
  - `Y` "Other Move": client `cy`.
- A kiosk Device: serial `kiosk-lookup-1`, `current_initiative_id=M`, with a site and a checkpoint, as `tests/test_move_password_lock.py::_world` builds them. Seed `StatusValue` rows `container/available` and `truck/in_transit` if missing, the same way.
- Assets, each with `client_id=cx` unless noted:
  - `web`: `atl1-web-001`, `legacy_id=102466`, serial `SN-WEB-001`, `rfid_tag="0"*12+"E28011700000"`. On M, with source pod `P1`, rack `R12`, RU 14, and destination pod `P7`, rack `C03`, RU 22.
  - `twin`: `atl1-db-002`, `legacy_id=102467`, `rfid_tag="0"*18+"102466"`. On M.
  - `x_other`: `atl1-web-003`, on M2 only.
  - `x_loose`: `atl1-spare-004`, `location_detail="Cage 4"`, on no move.
  - `y_asset`: `atl1-web-900`, serial `SN-Y-900`, `client_id=cy`, on Y.
- Container `ATL1-W1M-DC-01` (initiative M) holding `web`, on Truck `ATL1-T01`.
- Logins, through `tests.test_status_values_write._make`: worker `w@test.example.com` (role `worker`), staff via the `seeded_user` fixture (`tests.test_sites_api.login`), and admin `adm@test.example.com` (role `admin`).

- [ ] **Step 1: Write the failing tests** (each calls `GET /kiosk/assets/lookup?serial=kiosk-lookup-1&q=…`)
  - `test_each_exact_key_finds_its_device` (worker):
    - `q=102467` → one match, `twin`, `matched == ["asset_tag"]`.
    - `q=" sn-web-001 "` → `web`, `["serial"]`.
    - `q=e28011700000` → `web`, `["rfid"]`.
    - `q="0"*12+"E28011700000"` → `web`, `["rfid"]`.
    - Each match has `asset_tag` `"102466"` or `"102467"` and `truncated is False`.
  - `test_asset_tag_and_rfid_on_different_devices_return_both`: `q=102466` → `[(web.id, ["asset_tag"]), (twin.id, ["rfid"])]`, in that order.
  - `test_rfid_never_matches_an_asset_tag`: `q="0"*18+"102466"` → only `twin`, `["rfid"]`.
  - `test_part_name_finds_several_in_reach` (worker): `q=WEB` → names `["atl1-web-001", "atl1-web-003"]`, each with `["name"]`. `atl1-web-900` is absent.
  - `test_name_results_stop_at_25_with_truncated`: add 30 assets `bulk-rack-01`…`bulk-rack-30` on M. `q=bulk-rack` → 25 matches, `truncated is True`, the first named `bulk-rack-01`.
  - `test_no_match_is_empty`: `q=nothing-here` → `{"matches": [], "truncated": False}`.
  - `test_worker_reach_is_the_synced_set`:
    - `q=atl1-spare` finds `x_loose`.
    - `q=SN-Y-900` → `[]`.
    - Adding `&initiative_id=<Y.id>` to the query still gives `[]`, because the device decides the move.
    - `serial=nope` → 404 `device_not_found`.
  - `test_move_password_session_stays_on_its_move`:
    - Set a kiosk password on M (admin `PATCH /initiatives/{M}` `{"kiosk_password": PW}`, then `POST /kiosk/move-login`, as `test_move_password_lock.py` does). `q=atl1` → only `{web, twin}`.
    - A second kiosk `kiosk-lookup-y` set up for Y → 403 `move_locked`.
  - `test_admin_follows_scope_plus_kiosk_move`:
    - The admin gets `q=SN-Y-900` → `y_asset`.
    - After adding `PermissionOverride(person_id=<admin>, resource="assets", action="view", allow=False)`: `q=SN-Y-900` → `[]`, but `q=SN-WEB-001` → `web`. That is the kiosk move.
  - `test_a_kiosk_without_a_move_gives_a_worker_nothing`: set `current_initiative_id=None`. The worker's `q=SN-WEB-001` → 200 `[]`. The admin's → `web`.
  - `test_archived_asset_is_not_found`: archive `web`. `q=SN-WEB-001` → `[]`.
  - `test_odd_input_never_errors`: `q` in `["%", "_", "1"*23, "A"*30, "Ünïcode", "a\\b"]` → 200 each. `%` and `_` return no match. They are not wildcards.

- [ ] **Step 2: Run them to verify they fail**

  Run: `cd api && SS_TEST_DB=serversherpa_test_kiosk_lookup PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q -p no:cacheprovider tests/test_kiosk_asset_lookup_api.py`
  Expected: FAIL with 404 or 422 on `/kiosk/assets/lookup`.

- [ ] **Step 3: Implement the service, schemas and route**

  The route is `async def kiosk_asset_lookup(db: DbSession, serial: str = Query(...), q: str = Query(..., max_length=200), actor: AuthContext = require_permission("kiosk", "view")) -> KioskAssetLookupOut`. It takes these steps:
  1. `device = await _kiosk_device(db, serial)`
  2. `_require_move(actor, device.current_initiative_id)`
  3. `reach = await lookup_reach(db, device, access=actor.access, person_id=actor.person.id, locked_move_id=actor.session.initiative_id)`
  4. `find_assets`, then map the hits to `KioskAssetLookupMatch`.

  It does no `commit` and no `last_seen_at` bump. Its docstring states the reach rules and that it is read-only.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: the Step 2 command. Expected: all PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add api/src/serversherpa/services/asset_lookup.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/kiosk.py api/tests/test_kiosk_asset_lookup_api.py
  git commit -m "feat(kiosk): asset lookup reach and GET /kiosk/assets/lookup"
  ```

---

### Task 2: `GET /kiosk/assets/{asset_id}`, the details card

**Files:**
- Modify: `api/src/serversherpa/services/asset_lookup.py`. Add `asset_moves`.
- Modify: `api/src/serversherpa/api/schemas.py`. Add `KioskAssetEndOut`, `KioskAssetRouteOut`, `KioskAssetMoveOut`, `KioskAssetFullOut` and `KioskAssetDetailOut`.
- Modify: `api/src/serversherpa/api/routes/kiosk.py`. Add the route after the lookup route.
- Test: `api/tests/test_kiosk_asset_lookup_api.py`

**Interfaces:**
- Consumes: Task 1's `lookup_reach`, `asset_in_reach` and `move_reach`; `asset_placements` (`assets/placement.py`); `asset_statuses` (`assets/items.py`); `status_labels(db, "initiative")` and `UNKNOWN_COLOR` (`status/labels.py`); `ru_plain` (`labels/generate/payloads.py`); `make_model_text` (`labels/label_values.py`).
- Produces, in the service: `async def asset_moves(db, reach: LookupReach, asset_id: uuid.UUID) -> list[tuple[InitiativeAsset, Initiative]]`. These are the asset's roster rows on moves passing `move_reach`. The kiosk move comes first, then the rest by `natural(Initiative.name)`.
- Produces, in the schemas:
  - `KioskAssetEndOut`: `site_name`, `pod`, `rack`, `ru` (`ru_plain` text), `position`. All are `str | None`.
  - `KioskAssetRouteOut`: `initiative_id: uuid.UUID`, `initiative_name: str`, `source: KioskAssetEndOut`, `destination: KioskAssetEndOut`. The source site is the move's origin site; the destination site is its destination site.
  - `KioskAssetMoveOut`: `initiative_id`, `initiative_name`, `status`, `status_label`, `status_color`. This is the move's own status.
  - `KioskAssetFullOut`: `status`, `status_label`, `status_color` (the asset's own status), `moves: list[KioskAssetMoveOut]`, `container_name: str | None`, `truck_name: str | None`, `location_detail: str`.
  - `KioskAssetDetailOut`: these fields:
    - `id`, `name: str | None`, `make: str | None`, `model: str | None`, `make_model: str`
    - `asset_tag: str`, `serial_number: str | None`, `rfid: str | None` (stored, padded)
    - `routes: list[KioskAssetRouteOut]`
    - `full: KioskAssetFullOut | None = None`
- HTTP: `GET /kiosk/assets/{asset_id}?serial=<kiosk>` returns `200 KioskAssetDetailOut`.

- [ ] **Step 1: Write the failing tests**
  - `test_worker_details_are_identity_source_and_destination`, for `web` as the worker:
    - `set(body) == {"id","name","make","model","make_model","asset_tag","serial_number","rfid","routes","full"}` and `body["full"] is None`.
    - `body["asset_tag"] == "102466"`.
    - `routes == [{"initiative_id": str(M), "initiative_name": "ATL1 Move", "source": {"site_name": "ATL1", "pod": "P1", "rack": "R12", "ru": "14", "position": None}, "destination": {"site_name": "ATL2", "pod": "P7", "rack": "C03", "ru": "22", "position": None}}]`.
    - `"ATL1-W1M-DC-01" not in resp.text`.
  - `test_staff_gets_the_worker_reach_and_no_full_details`: as staff, `web` has `full is None`. `y_asset` → 404 `asset_not_found`.
  - `test_admin_details_add_status_moves_and_location`, for `web` as the admin:
    - `full["status"] == "unknown"`, with a non-empty `status_label` and `status_color`.
    - `full["moves"] == [{"initiative_id": str(M), "initiative_name": "ATL1 Move", "status": "in_progress", …}]`.
    - `full["container_name"] == "ATL1-W1M-DC-01"` and `full["truck_name"] == "ATL1-T01"`.
  - `test_location_falls_back_to_location_text`: `x_loose` as the admin → `container_name is None`, `truck_name is None`, `location_detail == "Cage 4"`, `moves == []`, `routes == []`.
  - `test_routes_cover_each_live_move`:
    - Put `web` on M2 and on Y too, and also on an archived move.
    - The worker gets route names `["ATL1 Move", "ATL1 Wave 2"]`, with the kiosk move first and Y left out.
    - The admin gets `["ATL1 Move", "ATL1 Wave 2", "Other Move"]`.
    - The archived move never appears.
  - `test_details_out_of_reach_is_404`: the worker's `y_asset` and a random uuid → 404 `asset_not_found`. A move session's `x_other` → 404.

- [ ] **Step 2: Run them to verify they fail**

  Run: `cd api && SS_TEST_DB=serversherpa_test_kiosk_lookup PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q -p no:cacheprovider tests/test_kiosk_asset_lookup_api.py -k "details or location or routes or staff"`
  Expected: FAIL with 404 or 422 on `/kiosk/assets/{id}`.

- [ ] **Step 3: Implement `asset_moves`, the schemas and `async def kiosk_asset_detail(asset_id: uuid.UUID, db: DbSession, serial: str = Query(...), actor = require_permission("kiosk", "view")) -> KioskAssetDetailOut`**

  The route uses the same device, move-lock and reach steps as Task 1, then `asset_in_reach` (None → 404 `asset_not_found`).
  - The routes come from `asset_moves`, with the origin and destination `Site` names loaded in one query.
  - `full` is built only when `reach.admin`. Its location comes from `asset_placements(db, [asset.id], actor.access, actor.person.id)`.
  - It is read-only, with no commit.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: the whole file, with the Task 1 command. Expected: all PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add api/src/serversherpa/services/asset_lookup.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/kiosk.py api/tests/test_kiosk_asset_lookup_api.py
  git commit -m "feat(kiosk): asset lookup details, admin-only full card"
  ```

---

### Task 3: Shared scan-history helper and `GET /kiosk/assets/{asset_id}/scans`

**Files:**
- Modify: `api/src/serversherpa/api/routes/scans.py`. Extract the body of `list_asset_scans` (about line 296) into `asset_scan_history`, and have `list_asset_scans` call it. Its behavior is unchanged.
- Modify: `api/src/serversherpa/api/routes/kiosk.py`. Add the scans route.
- Test: `api/tests/test_kiosk_asset_lookup_api.py`. The existing `api/tests/test_scans_api.py` must stay green.

**Interfaces:**
- Produces: `async def asset_scan_history(db: AsyncSession, asset_id: uuid.UUID, limit: int) -> list[AssetScanItem]` in `serversherpa.api.routes.scans`. It returns non-archived `ProcessedScan` rows for the asset, newest first (`scanned_at desc, id`), capped at `limit`, built with `_vocab`, `_people_names`, `_site_names` and `_raw_context`, exactly as today.
- Consumes: Task 1's reach; Task 2's `asset_moves`; `require_rank`; `GATE_BYPASS_RANK`.
- HTTP: `GET /kiosk/assets/{asset_id}/scans?serial=<kiosk>&limit=50` returns `200 list[AssetScanItem]`, with `limit: int = Query(50, ge=1, le=500)`.
  - Below rank 60 → 403 `forbidden`, from the `require_rank` dependency, before any lookup.
  - Out of reach → 404 `asset_not_found`.
  - No move in `asset_moves` → `[]`.

- [ ] **Step 1: Write the failing tests**
  - `test_scans_are_admin_only`: the worker and staff on `web` → 403, `detail.code == "forbidden"`.
  - `test_scans_match_the_portal_rows`:
    - Add three `ProcessedScan` rows for `web` (`match_type="asset"`), one with `off_move=True`, plus one archived row.
    - As the admin, the kiosk route's JSON `==` the portal `GET /scans/asset/{web}?limit=50` JSON. There are three rows, newest first, and the off-move row has `off_move is True`.
  - `test_scans_cap_at_50_by_default`: 55 scans → 50 rows, the first being the newest.
  - `test_scans_empty_when_on_no_move`: `x_loose` with one processed scan → `[]`.
  - `test_scans_out_of_reach_is_404`: the admin with the `assets:view` override off, on `y_asset` → 404 `asset_not_found`.
  - `test_lookup_never_writes`:
    - Record the counts of `RawScan`, `ProcessedScan` and `AuditLog`, and the kiosk Device's `last_seen_at`.
    - As the worker, call lookup and details. As the admin, call lookup, details and scans.
    - All the counts and `last_seen_at` are unchanged.

- [ ] **Step 2: Run them to verify they fail**

  Run: `cd api && SS_TEST_DB=serversherpa_test_kiosk_lookup PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q -p no:cacheprovider tests/test_kiosk_asset_lookup_api.py -k "scans or never_writes"`
  Expected: FAIL. The scans route answers 404 or 405.

- [ ] **Step 3: Extract `asset_scan_history` and add `async def kiosk_asset_scans(asset_id: uuid.UUID, db: DbSession, serial: str = Query(...), limit: int = Query(50, ge=1, le=500), actor = require_permission("kiosk", "view"), _admin: AuthContext = require_rank(GATE_BYPASS_RANK)) -> list[AssetScanItem]`**

  Import `asset_scan_history` into `kiosk.py` from `serversherpa.api.routes.scans`. `kiosk.py` already imports from `routes.auth` and `routes.labels`, so this is an established pattern.

- [ ] **Step 4: Run the new tests and the portal scans tests**

  Run: `cd api && SS_TEST_DB=serversherpa_test_kiosk_lookup PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q -p no:cacheprovider tests/test_kiosk_asset_lookup_api.py tests/test_scans_api.py tests/test_kiosk_rfid_enroll_api.py tests/test_move_password_lock.py`
  Expected: all PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add api/src/serversherpa/api/routes/scans.py api/src/serversherpa/api/routes/kiosk.py api/tests/test_kiosk_asset_lookup_api.py
  git commit -m "feat(kiosk): admin scan history for asset lookup via a shared helper"
  ```

---

### Task 4: Kiosk api client, offline matcher and React-free `placementText`

**Files:**
- Create: `portal/src/lib/placement.ts`. Move `placementText` here unchanged, with its docstring.
- Modify: `portal/src/lib/assets.ts`. Replace the definition with `export { placementText } from './placement';`, so every portal caller keeps working. `lib/assets.ts` imports `./godEdit` (React), so the kiosk must not import it.
- Modify: `kiosk/src/lib/api.ts`. Add the types and three fetchers, after the RFID enroll block.
- Create: `kiosk/src/lib/assetLookup.ts`
- Test: `kiosk/src/lib/assetLookup.test.ts`, `kiosk/src/lib/api.test.ts` (the fetchers) and `portal/src/lib/assets.test.ts` (unchanged, must pass).

**Interfaces:**
- Produces, in `kiosk/src/lib/api.ts`. These mirror Tasks 1–3 field for field.
  - `export type LookupMatchKind = 'asset_tag' | 'serial' | 'rfid' | 'name'`
  - `KioskLookupMatch { id: string; name: string | null; asset_tag: string; serial_number: string | null; matched: LookupMatchKind[] }`
  - `KioskLookupResult { matches: KioskLookupMatch[]; truncated: boolean }`
  - `KioskAssetEnd { site_name, pod, rack, ru, position: string | null }`
  - `KioskAssetRoute { initiative_id: string; initiative_name: string; source: KioskAssetEnd; destination: KioskAssetEnd }`
  - `KioskAssetMove { initiative_id; initiative_name; status; status_label; status_color: string }`
  - `KioskAssetFull { status; status_label; status_color: string; moves: KioskAssetMove[]; container_name: string | null; truck_name: string | null; location_detail: string }`
  - `KioskAssetDetail { id; name: string | null; make; model: string | null; make_model: string; asset_tag: string; serial_number: string | null; rfid: string | null; routes: KioskAssetRoute[]; full: KioskAssetFull | null }`
  - `lookupAssets(serial: string, q: string): Promise<KioskLookupResult>`, which calls `GET /kiosk/assets/lookup?serial=…&q=…` (both `encodeURIComponent`).
  - `fetchAssetDetail(serial: string, assetId: string): Promise<KioskAssetDetail>`
  - `fetchAssetScans(serial: string, assetId: string, limit = 50): Promise<AssetScanRow[]>`, with `import type { AssetScanRow } from '@portal/lib/api'`. That is a type-only import, so the guardrail allows it.
  - All three use `apiFetch` + `jsonFrom`, so they throw `ApiError`.
- Produces, in `kiosk/src/lib/assetLookup.ts`:
  - `export const LOOKUP_CAP = 25`
  - `export const MATCH_LABEL: Record<LookupMatchKind, string> = { asset_tag: 'Asset tag', serial: 'Serial', rfid: 'RFID', name: 'Name' }`
  - `export interface LocalLookupData { assets: LocalAsset[]; containerNames: Map<string, string>; moveId: string; moveName: string; sourceSite: string | null; destinationSite: string | null }`
  - `LocalAsset` is the synced `KioskAssetOut` row subset this file reads: `id`, `asset_id`, `name`, `rfid`, `serial_number`, `make`, `model`, `make_model`, `container_id`, the source and destination `pod`/`rack`/`ru`/`position` fields, `asset_status`, `asset_status_label` and `location_detail`.
  - `export async function loadLocalLookup(): Promise<LocalLookupData>`:
    - It reads `getAll('assets')` and `getAll('containers')`.
    - The move id and name come from `readMeta('sync')` (`initiativeId`, `initiativeName`; the key is `sync.ts`'s private `META_KEY`).
    - The site names come from `readRawBody('assets_raw')` → `JSON.parse(text).label_context.source_site` / `.destination_site`, with `null` when missing.
  - `export function matchLocal(assets: readonly LocalAsset[], raw: string): KioskLookupResult`. It applies Task 1's rules in the browser:
    - **asset tag:** the trimmed value `===` `asset_id`.
    - **serial:** equal after trim and upper-case.
    - **rfid:** `padRfid(value).tag` (`lib/rfid.ts`) `===` `padRfid(asset.rfid).tag`, when both are non-null.
    - **name** is the fallback: a case-insensitive substring, sorted with `naturalCompare` (`@portal/lib/naturalSort`), capped at 25 with `truncated`.
  - `export function localDetail(asset: LocalAsset, data: LocalLookupData, admin: boolean): KioskAssetDetail`:
    - `routes` is one entry for the synced move.
    - `full` is `null` below admin.
    - For an admin, `full` is `{ status: asset_status, status_label: asset_status_label, status_color: '', moves: [], container_name: containerNames.get(container_id) ?? null, truck_name: null, location_detail }`.
  - `export async function findAssets(serial: string, raw: string): Promise<{ offline: boolean; result: KioskLookupResult }>`. It tries `lookupAssets`. On an `ApiError` with `status === 0` (`network`, which includes the edge's `edge_offline`) or code `cloud_sign_in_required`, it answers `matchLocal(…)` with `offline: true`. Any other error rethrows.
  - `export async function assetDetail(serial: string, id: string, offline: boolean, admin: boolean): Promise<{ offline: boolean; detail: KioskAssetDetail | null }>`. When offline, or when the online call fails the same way as above, it answers `localDetail`. `null` means the asset is not in the synced data.
  - `export function scanWhenText(iso: string): string`: `toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })`.

- [ ] **Step 1: Write the failing tests** (`assetLookup.test.ts`, with `fake-indexeddb/auto` for `loadLocalLookup`)
  - `matchLocal finds each exact key ignoring case and spaces`. With `WEB = { id: 'a-web', asset_id: '102466', name: 'atl1-web-001', serial_number: 'SN-WEB-001', rfid: '0'.repeat(12) + 'E28011700000', … }`:
    - `' sn-web-001 '` → `[{ id: 'a-web', matched: ['serial'] }]`.
    - `'e28011700000'` → `['rfid']`.
  - `matchLocal returns both devices when an asset tag is another device's RFID`. With `TWIN.rfid = '0'.repeat(18) + '102466'`, `'102466'` → `[a-web ['asset_tag'], a-twin ['rfid']]`.
  - `matchLocal never matches a padded RFID to an asset tag`: `'0'.repeat(18) + '102466'` → only `a-twin`.
  - `matchLocal falls back to part of a name and caps at 25`: with 30 `bulk-rack-NN` rows, `'BULK'` → 25 matches, `truncated: true`, the first named `bulk-rack-01`.
  - `localDetail hides the full card below admin and names the container for an admin`: with `containerNames` `{c1 → 'ATL1-W1M-DC-01'}`:
    - Admin → `full.container_name === 'ATL1-W1M-DC-01'`, `full.moves` is `[]` and `truck_name === null`.
    - Worker → `full === null`.
    - `routes[0].source.site_name` is the `label_context` source site.
  - `falls back to the synced devices when the network is down`: mock `lookupAssets` to reject with `new ApiError(0, 'network')` → `{ offline: true }`, with the local match.
  - `falls back to the synced devices when the cloud needs a sign-in`: `new ApiError(403, 'cloud_sign_in_required')` → `offline: true`.
  - `other errors are not hidden`: `new ApiError(500, 'unknown_error')` rejects.
  - `scanWhenText is 24-hour`: `scanWhenText('2026-11-08T23:05:00Z')` matches `/\d{2}:\d{2}/` and does not match `/AM|PM/i`.
  - In `api.test.ts`, `lookupAssets encodes the serial and query`: `lookupAssets('k 1', '10 2&3')` fetches `http://api.test/kiosk/assets/lookup?serial=k%201&q=10%202%263`.

- [ ] **Step 2: Run them to verify they fail**

  Run: `cd kiosk && npx vitest run src/lib/assetLookup.test.ts src/lib/api.test.ts`
  Expected: FAIL with "Failed to resolve import ./assetLookup".

- [ ] **Step 3: Move `placementText`, then implement the api additions and `assetLookup.ts`** with the signatures above.

- [ ] **Step 4: Run the tests and the guardrail**

  Run: `cd kiosk && npx vitest run src/lib/assetLookup.test.ts src/lib/api.test.ts src/portalImports.test.ts && cd ../portal && npx vitest run src/lib/assets.test.ts`
  Expected: all PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add portal/src/lib/placement.ts portal/src/lib/assets.ts kiosk/src/lib/api.ts kiosk/src/lib/assetLookup.ts kiosk/src/lib/assetLookup.test.ts kiosk/src/lib/api.test.ts
  git commit -m "feat(kiosk): asset lookup client and offline matcher"
  ```

---

### Task 5: The `AssetLookup` page

**Files:**
- Create: `kiosk/src/pages/AssetLookup.tsx`
- Modify: `kiosk/src/styles/kiosk.css`. Add only `lookup-*` rules, using tokens: the routes grid, the match table's pick button, the history wrap (`overflow-x: visible`, with cells `overflow-wrap: anywhere`) and the offline notice.
- Test: `kiosk/src/pages/AssetLookup.test.tsx`

**Interfaces:**
- Consumes: Task 4's `findAssets`, `assetDetail`, `fetchAssetScans`, `MATCH_LABEL`, `scanWhenText` and `LOOKUP_CAP`; `placementText` from `@portal/lib/placement`; `displayRfid` from `@portal/lib/format`; `useKioskAuth().isAdmin`; `useKioskSetup()`; `getIdentity().serial`.
- Produces: `export default function AssetLookup(): JSX.Element`.

**Screen.** The layout follows `Enroll.tsx`, and the strings below are exact.
- The header has eyebrow "Kiosk · Asset Lookup", h1 "Asset Lookup", and the hint `${initiativeName} · ${siteName}`.
- The input is `.scan-input` with `autoFocus`, `placeholder="Scan or type an asset tag, serial, RFID, or name"` and `aria-label="Asset lookup value"`. Enter is handled on keydown, as `Enroll.tsx` does.
- Beside the input sit a "Search" button (`btn-solid`) and a "Clear" button (`mini-btn`).
- After every lookup the input is refocused:
  - On a hit the input is emptied.
  - On no match it keeps the value, **selected**, so the next scan replaces it.
- **Offline notice:** "Offline — showing this move's devices only." (`role="status"`).
- **No match:** "No asset matches <value>." (`role="alert"`).
- **Several matches:** a `local-table` with the columns Name, Asset tag, Serial, plus Matched on when any match is not `name`. "Matched on" joins the `MATCH_LABEL` values with ", ". The Name cell is a button that opens that device. When `truncated` is set, show "Refine your search" below the table. A single match opens straight away.
- **Card for everyone** (`enroll-card`):
  - The name is shown large, or "Unnamed asset" when blank, followed by the make/model.
  - Facts: "Asset tag", "Serial", and "RFID" (`displayRfid`), each "—" when blank.
  - For each route, "Source" and "Destination" each list "Site", "Pod", "Rack", and "RU". When the RU is blank and a position is set, the label is "Position" instead.
  - When there are two or more routes, each route sits under an h3 with its move's name.
- **Admin additions** (only when `detail.full`):
  - "Status" (a chip, with `--chip: status_color` when it has a color, otherwise `chip tag`).
  - "Moves" (each move's name and status chip).
  - "Current location": `placementText(full) || '—'`.
  - "Scan history", only when `full.moves.length > 0`:
    - The table has the columns Status (a status chip, plus `<span className="chip c-amber">Off move</span>` when `off_move`), Scanned (`scanWhenText`), Method, Device, Operator, Site and Location. Blank cells show "—".
    - "Latest 50 scans shown." appears when there are 50 rows.
    - "No scans recorded for this asset." appears when there are none, and "Could not load scan history." on an error.
    - Offline it shows "Scan history needs a connection." instead.
- **Clear** empties the input, the matches, the card and every message.

- [ ] **Step 1: Write the failing tests.** Mock `../lib/api` (`lookupAssets`, `fetchAssetDetail`, `fetchAssetScans`) and `../auth/KioskAuthContext` with a hoisted `auth.isAdmin` toggle. Use `fake-indexeddb` and `writeKioskSetup(SETUP)`, as `Enroll.test.tsx` does. Use the spec's dev values: `atl1-web-001`, `102466`, `ATL1-W1M-DC-01`, `ATL1-T01`.
  - `one match opens the details`: typing `102466{Enter}` calls `lookupAssets(getIdentity().serial, '102466')`, then `fetchAssetDetail`. The heading `atl1-web-001` shows.
  - `several matches show the list, and tapping one opens it`: two `name` matches give a table of 2 rows with no "Matched on" column. Clicking `atl1-web-003` opens its card.
  - `exact hits on different devices show what each matched on`: the rows read "Asset tag" and "RFID".
  - `more than 25 matches say Refine your search`: with `truncated: true`, "Refine your search" is visible.
  - `no match says so and keeps the value`: "No asset matches nothing-here." shows. The input value is `nothing-here` and it is focused.
  - `after a miss the next scan replaces the value`: after the miss, `user.keyboard('102466{Enter}')` calls `lookupAssets` with `'102466'`, not `'nothing-here102466'`.
  - `a worker sees source and destination only`: with `isAdmin: false` and `full: null`, Source shows `ATL1`, `P1`, `R12` and `14`. The queries for "Status", "Current location" and "Scan history" are null, and `fetchAssetScans` is never called.
  - `an admin sees the full card`: Status, Moves "ATL1 Move" and Current location "ATL1-W1M-DC-01 · on ATL1-T01" show. A scan row shows "Off move" and a 24-hour time.
  - `scan history shows only when the device is on a move`: with `full.moves: []`, there is no "Scan history" heading and no `fetchAssetScans` call.
  - `offline, the lookup searches the synced devices and shows its notice`:
    - Seed the `assets` store (`replaceAll`) with `WEB`, and the `containers` store with `{ id: 'c1', name: 'ATL1-W1M-DC-01', … }`.
    - Make `lookupAssets` reject with `new ApiError(0, 'network')`.
    - `SN-WEB-001{Enter}` shows "Offline — showing this move's devices only." and the card.
    - For an admin it also shows "Scan history needs a connection." and the container name.
  - `the next scan replaces the result`: after `atl1-web-001` opens, scanning `102467{Enter}` shows `atl1-db-002`, and `atl1-web-001` is gone.
  - `Clear empties the screen`: after a result, clicking Clear removes the card, and the input is empty and focused.
  - `nothing is ever written to the outbox`: after an online hit, a miss and an offline hit, `await getAll('outbox')` is `[]`.

- [ ] **Step 2: Run them to verify they fail**

  Run: `cd kiosk && npx vitest run src/pages/AssetLookup.test.tsx`
  Expected: FAIL with "Failed to resolve import ./AssetLookup".

- [ ] **Step 3: Implement `AssetLookup.tsx` and the `lookup-*` CSS.** The detail's scan history is fetched only when `detail.full && detail.full.moves.length > 0 && !offline`. A newer lookup ignores the answer to an older one (keep a request counter), so a slow first answer never replaces the second.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `cd kiosk && npx vitest run src/pages/AssetLookup.test.tsx`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add kiosk/src/pages/AssetLookup.tsx kiosk/src/pages/AssetLookup.test.tsx kiosk/src/styles/kiosk.css
  git commit -m "feat(kiosk): Asset Lookup screen"
  ```

---

### Task 6: Tile, route and breadcrumb

**Files:**
- Modify: `kiosk/src/lib/features.ts`. Add `'lookup'` to the `KioskFeature['id']` union. Insert `{ id: 'lookup', path: '/lookup', title: 'Asset Lookup', blurb: 'Scan an asset to see what it is and where it goes.' }` **immediately after Trucks**. `STATION_TILES` is unchanged, so station laptops don't get it.
- Modify: `kiosk/src/App.tsx`. Add `const LOOKUP = FEATURES.find((f) => f.id === 'lookup')!;` and a route at `LOOKUP.path` wrapped in `KioskGuard` › `SetupGate feature={LOOKUP}` › `KioskShell` › `<AssetLookup />`, placed after the Trucks route.
- Test: `kiosk/src/lib/features.test.ts`, `kiosk/src/pages/Home.test.tsx` (update the pinned indexes) and `kiosk/src/lib/breadcrumbs.test.ts`.

**Interfaces:**
- Consumes: Task 5's `AssetLookup` default export.
- Produces: the `'lookup'` feature id. `breadcrumbs('/lookup')` derives from FEATURES with no code change.

- [ ] **Step 1: Write the failing tests**
  - In `features.test.ts`:
    - `Asset Lookup sits immediately after Trucks, with its own route`: its index is Trucks + 1, `path === '/lookup'`, `title === 'Asset Lookup'` and `placeholder` is undefined.
    - Add `lookup` to the "unavailable until setup is complete" and "developer mode overrides" loops.
    - `Asset Lookup shows on the web kiosk and on a laptop that is not a station, never on a station`:
      - `homeFeatures(false, undefined)` and `homeFeatures(true, undefined)` include `'lookup'`.
      - `homeFeatures(true, s)` for `s` in `rfid`, `label`, `timeclock` and `dock` does not include it.
  - In `Home.test.tsx`, as a worker (the existing auth mock):
    - Update the first test: `links` has length 9, `links[5]` is "Asset Lookup" → `/lookup`, and Settings moves to `links[8]`.
    - The incomplete-setup test already checks that every tile but Setup and Settings has `aria-disabled="true"`. Assert that the Asset Lookup tile is among them.
  - In `breadcrumbs.test.ts`, `Asset Lookup is a top-level page`: `trail('/lookup')` equals `['Home=/', 'Asset Lookup=/lookup']`, using the file's own `trail` helper.

- [ ] **Step 2: Run them to verify they fail**

  Run: `cd kiosk && npx vitest run src/lib/features.test.ts src/pages/Home.test.tsx src/lib/breadcrumbs.test.ts`
  Expected: FAIL. There is no `lookup` feature and 8 links.

- [ ] **Step 3: Add the feature entry and the route**

- [ ] **Step 4: Run them, then the whole kiosk suite and the build**

  Run: `cd kiosk && npx vitest run && npm run build`
  Expected: every test file passes, and `tsc -b && vite build` exits 0.

- [ ] **Step 5: Commit**

  ```bash
  git add kiosk/src/lib/features.ts kiosk/src/App.tsx kiosk/src/lib/features.test.ts kiosk/src/pages/Home.test.tsx kiosk/src/lib/breadcrumbs.test.ts
  git commit -m "feat(kiosk): Asset Lookup tile, route and breadcrumb"
  ```

---

### Task 7: Full suites and live check

**Files:** none, unless a suite finds a fix. A fix is committed with the task it belongs to.

- [ ] **Step 1: Run the full API suite in the foreground**

  Run: `cd api && SS_TEST_DB=serversherpa_test_kiosk_lookup PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q -p no:cacheprovider`
  Expected: `0 failed`.

- [ ] **Step 2: Run the portal suite and build**

  Run: `cd portal && npx vitest run && npm run build`
  Expected: all pass, and the build exits 0.

- [ ] **Step 3: Live check (controller, after merge, on the dev web kiosk `https://kiosk.dev.serversherpa.com`)**
  - Look up dev asset 102466 `atl1-web-001` by each of its four values: asset tag, serial, RFID and name.
  - As a worker, the card shows identity, source and destination only.
  - As an admin, it shows the full card with Current location "ATL1-W1M-DC-01 · on ATL1-T01" and scan history.
  - Check light and dark themes. A lookup creates no new rows in Scans › Raw.

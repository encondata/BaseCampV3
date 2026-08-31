# Scan-matching worker, status rules engine, and /admin/status-rules

**Date:** 2026-08-31
**Status:** Approved design
**Prior art:** BaseCampV2 `raw_scan_processor.py` + `process_engine_service.py` +
`StatusRulesDemo.jsx` (see `/Users/jrh1812/Developer/BaseCampV2-reference`);
V3 scans design `docs/superpowers/specs/2026-08-27-scans-design.md`.

## Summary

A new `scan-matching-worker` process consumes `raw_scans`, matches each scan to
an asset, container, or person, and moves it to `processed_scans` (true move —
insert + delete, per the 0025 design). In the same transaction it runs a
DB-driven **status rules engine**: admin-authored rules that trigger on the
scan's status checkpoint + match type and apply typed actions (status
assignments, location writes, audit touches) to the matched entity and its
active initiative. Rules are managed on a new `/admin/status-rules` portal
page.

This replaces V2's two daemons (`raw_scan_processor`, `process_engine_service`)
with one worker and one engine library, deliberately fixing V2's known defects:

| V2 defect | V3 fix |
|---|---|
| In-memory watermark; restarts re-scan everything | `raw_scans.match_attempted_at` column + slow retry sweep |
| Errors marked scans processed anyway (silent loss) | One txn per scan; errors roll back, row stays raw, retried |
| Four divergent copies of rule semantics | One engine implementation; UI driven by `GET /status-rules/schema` |
| f-string table/field names in UPDATEs | Typed action catalog — real Python, validated params, no dynamic SQL |
| `logic` AND/OR column stored but ignored | AND-only, no OR control shown |
| Executions table had no DDL | `status_rule_executions` created by migration |
| Backend checked only `portal_access` | New `status_rules` resource, per-action permission checks |
| No-active-move scans dropped silently | Per-action skip, recorded in the execution row |

## 1. Data model (migration 0035)

- **`raw_scans.match_attempted_at`** — nullable timestamptz, indexed. NULL =
  never attempted. Stamped after every attempt (matched rows are deleted, so
  in practice it marks unmatched rows).
- **`status_rules`** — `id` UUID PK, `name` (text, not unique — duplication
  produces "(Copy)" names), `description` (default `''`),
  `trigger_status` TEXT NOT NULL (composite FK →
  `status_values(record_type='asset')` via a GENERATED `trigger_status_record_type`
  column, same pattern as `raw_scans.status`), `trigger_match_type` TEXT NOT
  NULL (composite FK → `status_values(record_type='processed_scan')`:
  asset/container/person), `priority` INT NOT NULL DEFAULT 10 (lower runs
  first), `enabled` BOOL NOT NULL DEFAULT true, `created_by` → `people.id`,
  `created_at`/`updated_at`.
- **`status_rule_conditions`** — `id` UUID, `rule_id` FK ON DELETE CASCADE,
  `position` INT, `field` TEXT (key from the code-side context-field
  registry, e.g. `scan.device_id`), `operator` TEXT, `value` TEXT NULL.
- **`status_rule_actions`** — `id` UUID, `rule_id` FK ON DELETE CASCADE,
  `position` INT, `action_type` TEXT (key into the typed catalog),
  `params` JSONB NOT NULL DEFAULT `{}`.
- **`status_rule_executions`** — `id` BigInt Identity PK, `rule_id` UUID FK ON
  DELETE SET NULL, `rule_name` TEXT (denormalized copy, survives rule
  deletion), `processed_scan_id` UUID NULL FK → `processed_scans.id`
  (NULL for error rows — see §3), `conditions_met` BOOL, `actions_applied` JSONB (ordered list of
  `{action_type, applied|skipped, reason?}`), `error` TEXT NULL,
  `executed_at` timestamptz DEFAULT now(), `duration_ms` INT.
  Indexes: `rule_id`, `executed_at DESC`. Pruning is deferred (same posture
  as raw-scan pruning in the 0025 design).
- **Access resource** — add `Resource("status_rules", "Status rules",
  routes=("/admin/status-rules",), ...)` to
  `api/src/serversherpa/access/resources.py`; seed `role_permissions` grants
  in the migration following what 0025 did for `scans`.

No new vocabulary record types: triggers reuse the `asset` and
`processed_scan` vocabularies.

## 2. Worker: `scan-matching-worker`

Location: `api/src/serversherpa/scans/worker.py` (loop) +
`api/src/serversherpa/scans/matching.py` (ladder). Follows the house worker
template exactly (`cli.py` import-worker/notification-worker pattern):

- Typer command `serversherpa scan-matching-worker` with `--poll-seconds`
  (default 2.0), `--once`, `--reload` (mutually exclusive with `--once`,
  exit 1, message contains "cannot be combined"); `--reload` uses
  `watchfiles.run_process` over `api/src`.
- `run_forever`: `install("scan-matching-worker")` db logging,
  `start_heartbeat("scan-matching-worker", "worker")`, poll loop, heartbeat
  cancelled in `finally`. No signal handlers (house convention).
- One line in `Procfile.dev` (`scanmatch: api/.venv/bin/serversherpa
  scan-matching-worker --reload`). No portal/API monitor changes needed —
  `/system/processes` picks it up automatically.

### Poll cycle (`run_once`)

1. Fetch a batch (LIMIT 50) of `raw_scans WHERE match_attempted_at IS NULL
   ORDER BY id`.
2. Every `RETRY_SWEEP_SECONDS` (900), additionally fetch a capped batch of
   previously-attempted rows (`match_attempted_at < now() - interval '900s'`,
   oldest first) so scans that arrived before their tag/asset was registered
   eventually match.
3. Per scan, **one transaction** (row re-selected `FOR UPDATE SKIP LOCKED`;
   skip if gone): match → on success insert the `processed_scans` row
   (context copied per 0025, `processed_at = now()`), run the rules engine,
   delete the raw row, commit. On no-match: stamp `match_attempted_at`,
   commit. On any exception: roll back (raw row intact), then stamp
   `match_attempted_at` in a separate transaction and log the error — the
   sweep retries it later. Returns "worked" when it processed any rows, so
   the loop only sleeps when idle.

### Matching ladder

Candidates exclude archived entities (`archived_at IS NULL`). At each tier:
exactly one hit → matched; multiple hits → **ambiguous, stop the ladder**
(the value clearly refers to something; guessing or falling through would be
wrong) and leave the scan unmatched; zero hits → next tier.

1. **ID** — if `scanned_value` parses as a UUID: `assets.id`,
   `containers.id`, `people.id`. If numeric: `assets.legacy_id` (V2 labels
   carry numeric asset ids).
2. **RFID** — exact CITEXT equality on `rfid_tag`: assets → containers →
   people (each partial-unique, so at most one hit per table).
3. **Serial** — `assets.serial_number` (indexed, deliberately non-unique —
   dupes are ambiguous).
4. **Name** (deep fallback) — `assets.name`, then `containers.name`,
   single-hit only. No people-by-name matching: badge/person matching is
   RFID-only.

`match_type` and the target FK follow from the winning tier's table.

**Built-in side effect** (matcher, not a rule): on any asset match,
`assets.last_seen_at = GREATEST(COALESCE(last_seen_at, scanned_at), scanned_at)`.

## 3. Rules engine (`api/src/serversherpa/status_rules/`)

A library the worker calls in phase 2 of the scan transaction — no separate
process, no evaluation-state column on `processed_scans`.

- `engine.py` — context building, condition evaluation, action dispatch,
  execution logging, and a module-level rule cache (60s TTL, keyed by
  `(trigger_status, trigger_match_type)`, `ORDER BY priority ASC, id ASC`).
- `catalog.py` — the condition field registry, operator table, and typed
  action catalog.
- `schema.py` — serializes the registry/operators/catalog + trigger options
  for `GET /status-rules/schema`.

### Semantics

- Scans with `status IS NULL` (bare presence reads) skip the engine entirely.
- All enabled rules matching `(scan.status, match_type)` run, in priority
  order — no first-match-wins, matching V2.
- Every triggered rule writes one `status_rule_executions` row
  (`conditions_met` false ⇒ actions not run; still logged).

### Context

Built once per scan: `scan` (the processed row's values), the matched
`asset` / `container` / `person`, and — for asset matches — the **active
initiative**: the `initiative_assets` row (+ its `initiatives` row) for this
asset where the initiative's status is `in_progress`, tie-broken by
`scheduled_start` nearest to now (V3's equivalent of V2's
`find_active_move`, which used `move_status = 3`). Absent context keys are
simply missing (see per-action skip below).

### Conditions

AND-only. Operators (exactly these, no more offered anywhere):
`equals`, `not_equals`, `contains`, `is_null`, `is_not_null`,
`greater_than`, `greater_or_equal`, `less_than`, `less_or_equal`.
String comparison is case-insensitive; numeric operators coerce to float and
evaluate false on failure. The field registry curates dotted keys with a
display type so the UI can render the right control — initial set:
`scan.scan_type`, `scan.device_id`, `scan.site_id`, `scan.source`,
`scan.operator_id`, `asset.status`, `asset.site_id`, `asset.client_id`,
`asset.has_rails`, `container.status`, `container.site_id`, `person.id`,
`initiative.initiative_type`, `initiative.sub_type`, `initiative.status`,
`initiative_asset.status`, `initiative_asset.disposition`,
`initiative_asset.priority_wave`. A condition on a missing context key
evaluates per operator (`is_null` true, everything else false).

### Typed action catalog (v1)

Each action is a registered Python callable with a declared param schema
(validated at rule save time AND at execution). No dynamic table/field
identifiers anywhere.

| action_type | params | effect |
|---|---|---|
| `set_asset_status` | `status` (asset vocab key) | `assets.status` |
| `set_initiative_asset_status` | `status` (asset vocab key) | `initiative_assets.status` on the active-initiative roster row |
| `set_container_status` | `status` (container vocab key) | `containers.status` |
| `set_asset_location_from_scan` | — | `assets.site_id` ← `scan.site_id`, `assets.location_detail` ← `scan.location_detail` |
| `set_asset_location_from_initiative` | `side`: `source`\|`destination` | `assets.location_detail` ← `"{rack} RU{ru}"` composed from the roster row's rack/RU (each part omitted when absent); `assets.site_id` ← the initiative's origin/destination site |
| `set_initiative_asset_verified` | `side`: `source`\|`destination`, `value`: bool | `initiative_assets.source_verified` / `destination_verified` |
| `touch_container_audit` | — | `containers.last_audit_at` ← `scan.scanned_at`, `containers.audit_by` ← `scan.operator_id` |

An action whose required context is missing (e.g. an initiative action when
the asset has no active initiative, or a container action on an asset match)
is **skipped**, recorded as `{applied: false, reason}` in
`actions_applied`, and does not fail the rule or the scan. A real execution
error (DB failure, invalid state) raises → the scan transaction rolls back
(taking the in-flight execution rows with it) and the retry path applies;
the post-rollback stamping transaction then writes one execution row with
`error` set and `processed_scan_id` NULL, so failures are visible in the
Executions tab, not just the process logs. Status writes bump the entity's
`updated_at`.

## 4. API — `api/src/serversherpa/api/routes/status_rules.py`

Resource `status_rules`; per-action permission checks in the house style
(view/add/change/delete). Endpoints:

- `GET /status-rules` — full list, children eager-loaded (`selectinload`),
  nested conditions/actions in position order. No pagination (rule counts
  are small).
- `POST /status-rules` — create with nested children; validates trigger
  keys against vocabularies, condition fields/operators against the
  registry, action params against the catalog. 422 with a `detail.code` on
  failure.
- `GET /status-rules/{id}`
- `PUT /status-rules/{id}` — full replace including children (delete +
  re-insert; child ids are not stable and nothing may reference them).
- `PATCH /status-rules/{id}` — `{enabled: bool}` toggle only.
- `DELETE /status-rules/{id}` — hard delete; executions keep `rule_name`
  via SET NULL + denormalized name.
- `GET /status-rules/schema` — the single source of truth the portal
  builder renders from: trigger status options (from `status_values`),
  match types, condition field registry (key, label, type, options-source),
  operator list (with applicable types), action catalog (type, label,
  param schemas).
- `GET /status-rules/executions?rule_id=&limit=&offset=` — newest first,
  joined to scan/entity display fields.
- `GET /status-rules/executions/stats` — per-rule aggregates: run count,
  conditions-met count, last run, avg duration.

Create/update/toggle/delete are recorded through V3's existing audit
machinery (surfaced at `/admin/audit`) — no bespoke per-rule audit table;
V2's `process_engine_audit_log` is not ported.

No production seed rules. The dev seeding script gains 2–3 sample rules
(e.g. `rfid_4_into_cage` × asset → `set_asset_status` + location-from-scan)
for local testing.

## 5. Portal — `/admin/status-rules`

House style, no component library. Tabbed page like `Scans.tsx`
(`.sysconf-tabbar`): **Rules** and **Executions** tabs, components under
`portal/src/components/statusRules/`, page `portal/src/pages/StatusRules.tsx`.

**Rules tab** — directory-style list (`.dir-list` pattern per
`Notifications.tsx`): columns name (+description sub-line), trigger (status
chip in the vocab color + match-type tag), priority, conditions count,
actions count, enabled (inline switch, gated on `can('status_rules','change')`),
runs (count + last run from `/executions/stats`), updated. "+ New rule"
gated on `add`. Row menu: Edit, Duplicate (POSTs a disabled copy named
"… (Copy)"), Delete (confirm). Editor modal (create + edit), driven entirely
by the `/schema` payload:

1. *Basics* — name, description, priority ("lower runs first").
2. *Trigger* — "When a scan with status … matches a[n] asset/container/person".
3. *Conditions* — add/remove rows: field select → operator select (filtered
   by field type) → value control (status dropdown with color dots, site
   picker, boolean select, number, or text; none for `is_null`/`is_not_null`).
   Header states "all conditions must be true".
4. *Actions* — ordered rows: action select from the catalog + per-action
   param controls; reorder via up/down. Save requires name, trigger, and ≥1
   action.

**Executions tab** — paginated table: time, rule name, scan (status chip +
scanned value), matched entity, result chip (Executed / Conditions not met /
Error), actions summary (applied count, skipped count with reasons on
hover/expand), duration. Filterable by rule; deep-linked from a rule row's
run count.

**Registration checklist** (all hand-maintained): route in `App.tsx` under
the other `/admin/*` routes wrapped in `ProtectedRoute resource="status_rules"`;
Admin section item in `layout/navSections.tsx`; `CRUMBS` + `PAGES` in
`components/Topbar.tsx`; `navGated` entry in `components/CommandPalette.tsx`;
`ROUTE_RESOURCE` in `lib/access.ts`; typed client block in `lib/api.ts`
(list/create/get/put/patch/delete + schema + executions); constants/helpers
in `lib/statusRules.ts`; backend `resources.py` entry (§1).

## 6. Testing

**API** (house harness, `api/tests/`, dedicated migrated test DB):
- Matching ladder: each tier matches; ambiguity stops the ladder (dupe
  serials, dupe names); archived entities excluded; UUID/numeric ID parsing;
  tier precedence (RFID beats serial beats name).
- Worker loop: unmatched rows stamped and skipped next poll; retry sweep
  picks up old unmatched rows; matched rows moved (raw deleted, processed
  inserted, `last_seen_at` written); error path rolls back and stamps.
- Engine: trigger selection (status + match type, NULL status skips), AND
  conditions incl. missing-context semantics, every catalog action, per-action
  skip recording, priority ordering, execution rows, cache TTL behavior.
- CLI: mirror `test_cli_import_worker.py` (`--help` shows `--reload`,
  `--reload --once` conflict exits 1, watchfiles target/args).
- Routes: CRUD + validation 422s, toggle, schema payload shape, executions
  pagination/stats, permission denials per action.

**Portal**: `StatusRules.test.tsx` mirroring `Notifications.test.tsx`
(jsdom, mocked api/auth/router): renders rules from mock data, gates
buttons by permission, editor validation, executions tab rendering.

## Out of scope (deferred)

- Test/simulate dialog (V2's `TestRuleDialog`) — revisit once execution
  history proves the engine.
- Raw-scan pruning and any new ingest endpoints (unchanged from 0025).
- Execution-log retention/pruning.
- OR condition groups, list/range operators, free-form template actions.
- Notification actions from rules (the notification-worker is still a
  placeholder); the catalog is the extension point when that lands.

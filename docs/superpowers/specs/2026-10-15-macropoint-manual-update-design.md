# MacroPoint manual update — design

Date: 2026-10-15
Branch: `macropoint-manual-update` (worktree `.claude/worktrees/macropoint`, off main 838b6c51)

## Goal

Trucks are tracked by MacroPoint, but positions in V3 are still typed in by
hand. Until MacroPoint API access exists, ops staff receive MacroPoint
notification emails. This feature lets them drop those emails (`.eml` files)
or paste their text into the portal, and turns each one into a truck location
point or a trip event — on the right truck, without duplicates, with status
moving forward automatically.

Success: dropping a day's worth of MacroPoint emails onto the modal produces
a preview grouped by load, every load lands on the correct truck (matched
automatically or picked once and remembered), the Shipments dashboard map and
feed show the new points, and re-dropping the same emails changes nothing.

## Decisions (from brainstorming)

- Entry point: the existing **Manual update** item in the `/logistics/trucks`
  Actions menu (currently a disabled placeholder) opens a tabbed modal:
  **MacroPoint**, **Copeland**, **3rd-Party**. Only MacroPoint is built; the
  other two tabs show a "coming soon" note.
- MacroPoint tab input: file upload / drag-and-drop of one or many `.eml`
  files, **and** a text box for pasted email text. Either or both.
- Processing is **server-side** (approach A): a Python parser, a preview
  endpoint, and an apply endpoint. API calls to MacroPoint are a code stub
  only.
- **Matching:** the email's ID Number is matched against the truck's existing
  Tracking › Tracker id field (relabeled "Tracking name / ID"). On first match
  the MacroPoint order token is learned onto the truck so later emails match
  even if the ID text differs. Every group also gets a **typeable dropdown of
  active trucks** (pre-filled when matched) so the user can pick or override;
  picking saves the link.
- **Trip events change status**, forward only: Departed at Pickup →
  `in_transit`; Arrived at Drop-Off → `at_destination`. All other events are
  logged only.
- Every apply ends with a per-row summary and CSV download (bulk-actions rule).

## The emails (from the 455 samples in `Sample Data/macropoint`)

Two MacroPoint kinds, both `multipart/alternative` (text/plain + text/html):

**Location Update** (373) — subject `Location Update for ID Number '<id>'`.
Body fields:

```
Location Update from <carrier>
ID Number '<id>'
Date/Time: 6/7/2024 @ 6:24 PM PT
Location: 35.34956359,-115.94153837 (View All Updates)
Approximate Address(if available): Mojave Freeway (I-15) Nipton CA 92364 United States
Notes: <free text>
```

**Trip Event Update** (79) — subject `Trip Event Update for ID Number : <id>`.
Same header block; `ID Number : <id>` (colon form, no quotes); `Event:` instead
of Location/Address, e.g. `Arrived at Pickup`, `Departed at Pickup`,
`Arrived at Drop-Off`, `Departed at Drop-Off`, or a named stop such as
`Arrived at BROADCOM DRT ACC4` / `Departed at BROADCOM / EQUINIX`.

Observed variants the parser must handle:

- Carriers: `Landstar - ATL`, `Longboard Transportation`. Time zones: `PT`,
  `CT`, `ET` (map to America/Los_Angeles, America/Chicago, America/New_York,
  DST-aware via `zoneinfo`; also accept `MT` → America/Denver, `AKT`, `HT` if
  seen; an unknown zone is a row error).
- The **text/plain part is truncated at the first `&`** in some messages
  (`ID Number : JAMIE` for "JAMIE & PATRICK …"), and runs fields together
  without newlines (`… PTLocation: …`). The parser reads the **HTML part**
  (with `<br>` → newline, entities unescaped) and uses text/plain only when
  there is no HTML part.
- IDs contain `&`, `/`, `#`, hyphens and a trailing ` -`; whitespace
  around values and inside Notes is heavy and irregular.
- The "View All Updates" link carries `…OrderSetup.aspx?Mode=CreateWithQuery&Data=<token>`.
  Across the Landstar loads in the samples, every ID Number had exactly one
  token, shared by its Location and Trip Event emails. This is the **order
  token**. Tokens may contain `!` (`TU7xeFzI44nw4JRZWxxw!A__`).
- Newer emails (all Longboard ones, 2026) link to
  `visibility.macropoint.com/shipments?l=<value>` instead, and that value is
  **different in every message** — it is not a load key. Those emails have
  no order token and group/match by ID Number only.
- Addresses carry doubled spaces (`CA-99  Bakersfield`); Notes may be the
  literal `None`.
- Pasted text (copied from Outlook/Gmail) loses the link, so it has no order
  token; it may also include mail headers (From/Sent/To/Subject) and several
  emails pasted back to back.
- Two sample files are **Locus Traxx / Emerson Oversight** ("Last Reported
  Location …"), not MacroPoint — they belong to the future Copeland tab. The
  MacroPoint parser reports them as "not a MacroPoint email" rather than
  failing the batch.

## Architecture

### Parser — `api/src/serversherpa/trucks/macropoint/parse.py`

Pure functions, no DB:

- `parse_eml(data: bytes, filename: str) -> list[ParsedMessage | ParseError]`
  — uses the stdlib `email` package (`policy.default`), picks the HTML body,
  normalizes it to text, extracts the order token from the raw HTML, and calls
  `parse_text`. The `Date` header is kept as `sent_at`.
- `parse_text(text: str, source: str) -> list[ParsedMessage | ParseError]` —
  splits on each `(Location|Trip Event) Update from` header (so pasted text
  with several emails yields several messages) and parses each block with
  tolerant regexes (fields may be separated by newlines or nothing).
- `ParsedMessage` (dataclass): `kind` (`location` | `trip_event`), `carrier`,
  `id_number` (trimmed, inner whitespace collapsed), `order_token | None`,
  `recorded_at` (aware UTC), `lat`, `lng`, `address`, `event`, `event_kind`
  (`arrived` | `departed` | None), `stop` (`pickup` | `drop_off` | the named
  stop text), `notes`, `source` (filename or `Pasted text #n`), and
  `source_ref`.
- **Time:** the body's local `Date/Time` in its zone, converted to UTC. When
  an `.eml`'s `Date` header falls within 2 minutes of that, the header is used
  instead (it carries seconds). Minute precision otherwise.
- **`source_ref` (dedup key)** — must be identical for the same update whether
  it arrived as `.eml` or pasted text, so it does **not** include the order
  token: `sha256` of `macropoint|<kind>|<normalized id_number, casefolded>|
  <recorded_at to the minute, UTC>|<lat,lng to 5 dp or event text casefolded>`,
  hex, truncated to 32 chars.
- Location coordinates go through the existing `trucks/location.py`
  `parse_location` (range checks) and are stored with `format_location`.

`ParseError`: `source`, `reason` (`not_macropoint`, `missing_field:<name>`,
`bad_time`, `unknown_zone`, `bad_location`, `unreadable`).

### Placeholder API client — `api/src/serversherpa/trucks/macropoint/client.py`

`MacroPointClient` with `fetch_updates(order_token, since)` that raises
`NotImplementedError("MacroPoint API access is not set up yet")`, and a
docstring describing where it plugs in: it will return the same
`ParsedMessage` objects, so the apply path below takes API data unchanged.
Not wired to any route, setting, or UI.

### Matching and apply — `api/src/serversherpa/trucks/macropoint/apply.py`

**Groups.** Parsed messages group by `order_token` when present, otherwise by
normalized ID Number; a token-less group whose ID Number equals a token
group's ID Number merges into it. Each group has a stable `group_key`
(`order:<token>` or `id:<normalized id>`).

**Active trucks** = not archived and status not in `inactive`, `historical`.
These are the only match candidates and the only dropdown options.

**Match order** for a group:
1. an active truck whose `tracking_type.macropoint_order` equals the group's
   order token;
2. an active truck whose `tracking_type.tracker_id`, normalized the same way
   as the ID Number (trim, collapse whitespace, casefold), equals the group's
   ID Number;
3. otherwise unmatched. More than one candidate at a step → `ambiguous` (no
   pre-fill, the candidates are listed first in the dropdown).

**Apply, per group, in one transaction for the whole request:**
- Skip the group when the user left its truck empty (rows reported `skipped`).
- Validate the chosen truck is still active (else every row → `error`,
  `truck_not_active`).
- **Learn the link:** if the truck's `tracking_type` lacks
  `macropoint_order` (and the group has a token) set it; if `tracker_id` is
  blank set it to the group's ID Number; if `type` is blank set it to
  `MacroPoint`. Merge into a new dict (SQLAlchemy JSONB persistence rule from
  the bulk trucks import). Audited as an `update` with `tracking_type`
  from/to. Existing non-blank `tracker_id` / `macropoint_order` values are
  never overwritten — if the picked truck already has a different order token,
  the group's rows still apply and the summary notes "linked to a different
  MacroPoint order; not re-linked".
- Process the group's messages **oldest first**:
  - `location` → insert `truck_updates` (`source='macropoint'`,
    `source_ref`, `approximate_address`, canonical `location`, lat/lng)
    with `ON CONFLICT (truck_id, source_ref) DO NOTHING`; a conflict →
    row `duplicate`.
  - `trip_event` → insert `truck_events` the same way; then the status rule:
    - `departed` + `pickup`: if status in (`created`, `active`) → `in_transit`
      via `trip.apply_status_change(truck, 'in_transit', now=recorded_at)`, so
      the trip starts at the event time and the map's current-trip trail
      includes the locations that follow.
    - `arrived` + `drop_off`: if status in (`created`, `active`,
      `in_transit`) → `at_destination` via `apply_status_change`.
    - anything else: no status change.
    - A duplicate trip event never changes status.
    - Each status change is audited as an `update` with
      `changes={"status": {from, to}, "source": {"from": None, "to": "MacroPoint"}}`
      so the existing Shipments feed shows it (and the audit UI shows the
      source as an ordinary from/to field).
- Row results: `added`, `added + status → <label>`, `duplicate`, `skipped`,
  `error` (with reason). Parse errors from the preview also appear in the
  summary as `error` rows.

### Data — migration `0097_truck_macropoint`

(Check every worktree and the dev DB's `alembic_version` before numbering;
0096 is the current head on main.)

- `truck_updates.source_ref TEXT NULL`; unique constraint
  `uq_truck_updates_truck_source_ref (truck_id, source_ref)` — a plain
  (non-partial) constraint, since NULLs are distinct in Postgres manual rows
  never collide, and a plain target keeps `ON CONFLICT` free of the
  generic-plan trap. Per-truck so that re-assigning a load to the correct
  truck after a mistake still works.
- New table `truck_events`:
  `id uuid pk`, `truck_id → trucks ON DELETE CASCADE`, `recorded_at timestamptz`,
  `event text` (raw, e.g. "Departed at Pickup"), `event_kind text NULL`
  (`arrived`/`departed`), `stop text NULL` (`pickup`/`drop_off`/named stop),
  `source text default 'manual'`, `source_ref text NULL`, `created_by → people`,
  `created_at default now()`; unique constraint `(truck_id, source_ref)`;
  index `(truck_id, recorded_at DESC)` and `(recorded_at DESC)` for the feed.
- Model `TruckEvent` in `db/models.py`. No change to the `trucks` table — the
  learned link lives in the existing `tracking_type` JSONB
  (`type`, `update_type`, `tracker_id`, plus new key `macropoint_order`).

### API — `api/src/serversherpa/api/routes/trucks.py`

Thin route handlers in the existing trucks router (declared before the
`/{truck_id}` routes, like `/trucks/map`), delegating to
`trucks/macropoint/apply.py`.

- `POST /trucks/manual-update/macropoint/preview` — multipart: `files[]`
  (0..n `.eml`) and `text` (optional). Limits: 500 files, 2 MB per file,
  20 MB total, 1 MB of text; over → 413/422 with a clear code. Returns:
  ```
  { groups: [{ group_key, id_number, order_token, carrier,
               match: { truck_id|null, by: "order"|"tracker_id"|null,
                        ambiguous_ids: [] },
               rows: [{ source, kind, recorded_at, location, address,
                        event, status_to|null, duplicate: bool }],
               counts: { new, duplicate } }],
    errors: [{ source, reason }],
    trucks: [{ id, name, status, tracker_id, initiative_name }] }
  ```
  `trucks` is the active-truck list for the dropdowns. `duplicate` and
  `status_to` are computed against the matched truck (re-computed on apply).
  Read-only; nothing is written.
- `POST /trucks/manual-update/macropoint/apply` — multipart: the same
  `files[]` + `text` again, plus `assignments` (JSON `{group_key: truck_id|null}`).
  The server re-parses (deterministic) rather than trusting client-sent rows,
  applies as above in one transaction, and returns
  `{ rows: [{ source, group_key, truck_name, kind, recorded_at, detail,
  result, reason }], counts }`.
- Both require `trucks:change` (global scope — the trucks resource is
  global-only), and are blocked by read-only mode like every write.
- `DELETE /trucks/{id}/updates` ("Clear updates") also clears that truck's
  `truck_events`.
- `GET /trucks/{id}/events` (`trucks:view`) — newest first, for the detail page.

### Feed — `trucks/feed.py`

Add a third source: `truck_events` → `trip` events
(`id: "trip:<uuid>"`, `at = recorded_at`, `text = event`). Status changes from
apply already surface through the audit source; a status event whose audit
changes carry `source.to` gets `via` = that value ("MacroPoint"), shown after
the actor. Cursor/paging
rules unchanged. `trucks/feed.py` docstring updated.

### Portal

- `pages/Trucks.tsx`: enable **Manual update** (`trucks:change`) → opens
  `components/trucks/ManualUpdateModal.tsx`.
- `ManualUpdateModal`: the report-generate modal header pattern
  (eyebrow "Trucks", title "Manual update", description), a `segmented`
  `role="tablist"` with MacroPoint / Copeland / 3rd-Party; wide card sized to
  its content. Copeland and 3rd-Party panels: a short "coming soon" note.
- `components/trucks/MacroPointPanel.tsx`, three steps:
  1. **Input** — a new `components/MultiFileDropzone.tsx` (same
     `imp-dropzone` look and `formatBytes` as `FileDropzone`, but a file list
     with per-file remove; `FileDropzone` itself is untouched), accept `.eml`; plus a textarea "Or paste email text". Button
     **Parse**.
  2. **Review** — one card per group: ID Number, carrier, counts
     ("12 new · 3 already recorded"), a `ComboBox` of active trucks
     (typeable filter; label "name — status · move"), pre-filled from the
     match with a "Matched by MacroPoint order" / "Matched by Tracking name"
     hint, "Ambiguous — pick one" or "No match — pick a truck or leave blank
     to skip". Below it a real table of the group's rows (time in the
     viewer's zone, Location/Event, Address, "→ In transit" status preview,
     Duplicate tag). A separate list shows parse errors by source. Buttons
     **Back** / **Apply**.
  3. **Summary** — `components/trucks/MacroPointSummary.tsx` in the
     `BulkApplySummary` layout (`bulk-summary` classes, `DataTable`,
     `exportCsv`; `BulkApplySummary`'s fixed created/updated/skipped/unchanged
     set has no duplicate or error result) with per-row results and CSV
     download (`macropoint-update-summary`); **Done** closes the modal and refreshes
     the trucks list/map.
- `components/trucks/TruckEditModal.tsx` and `pages/TruckDetail.tsx`: relabel
  "Tracker id" → "Tracking name / ID"; show `macropoint_order` read-only on
  the detail tracking panel when present (editing it is out of scope).
- `pages/TruckDetail.tsx`: a **Trip events** table under Location updates
  (time, event, source), from `GET /trucks/{id}/events`.
- `pages/ShipmentsDashboard.tsx` feed: render `trip` events
  ("Departed at Pickup"), with an icon/color consistent with existing kinds.
- `lib/api.ts`: `previewMacroPoint`, `applyMacroPoint`, `listTruckEvents`;
  `lib/trucks.ts` types.
- All the portal guardrails apply (natural sort, list typography, modal
  dropdown portal, rounded scrollbars, no raw native controls).

## Error handling

- A single unreadable/non-MacroPoint file never fails the batch: it becomes an
  error row and the rest parse.
- Preview with zero parsed messages → the Review step shows only the errors
  and Apply is disabled.
- Apply re-validates truck activity and dedup inside the transaction; a race
  that inserts the same row in between yields `duplicate`, not an error.
- An unexpected exception rolls back the whole apply (nothing half-written)
  and the modal keeps the input so the user can retry.

## Testing

- **Fixtures:** copy a curated set of ~14 sample emails into
  `api/tests/fixtures/macropoint/` covering: Landstar PT location, Longboard
  CT location, an ET message, each of the four Pickup/Drop-Off events, a named
  stop event, the `&`-in-ID truncated-plain case, a `/` ID, the
  heavy-whitespace notes case, and one Locus Traxx file. Replace the `To:`
  address with `ops@example.com`. Plus text fixtures for pasted text
  (single, several back-to-back, with Outlook headers).
- **Parser unit tests:** every field per fixture; time-zone/DST conversion;
  `.eml` vs pasted text of the same email produce the same `source_ref`;
  non-MacroPoint and malformed inputs give the right `ParseError`.
- **API tests:** preview grouping/matching (order token, tracker_id,
  ambiguous, inactive trucks excluded, token-less merge); apply writes
  updates/events, learns the link without overwriting, skips blank
  assignments, forward-only status (no regression from `at_destination`),
  `trip_started_at` = event time, re-apply is all `duplicate`; permission
  (403 without `trucks:change`); size limits (read-only mode is enforced by
  the global write choke point and is not re-tested here); clear
  updates clears events; feed includes `trip` events and paging still holds.
- **Portal tests:** modal tabs, multi-file dropzone, parse → review →
  summary flow with mocked API, ComboBox lists only the returned active
  trucks, Manual update item enabled only with `trucks:change`, detail-page
  Trip events table, feed rendering of `trip`.
- **Live verify:** on the dev stack, drop the whole `Sample Data/macropoint`
  folder onto the modal against Demo Truck 1 / a test truck, confirm the map
  trail, feed and status, re-drop to see all-duplicate; revert via Clear
  updates + PATCH.

## Out of scope

- Real MacroPoint API calls (stub only), inbound email ingestion/forwarding.
- Copeland (Locus Traxx/Oversight) and 3rd-Party parsing.
- Matching named stops (e.g. "BROADCOM DRT ACC4") to V3 sites.
- Editing or clearing the learned `macropoint_order` from the UI.
- Status changes from location updates.

## Closeout

Update the wiki Features page row + change log, and the parity tracker
Google Sheet per `.claude/parity-sheet.md` (Manual update / live truck map
rows).

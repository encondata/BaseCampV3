# Natural sorting everywhere — design

**Date:** 2026-09-28 · **Branch:** `natural-sort` · **Source:** a tester's note — lists and dropdowns show "Rack 1, Rack 10, Rack 2".

## Goal

Every list, column sort and dropdown in the portal and kiosk orders text the way people read it: numbers inside names compare by value ("Rack 2" before "Rack 10"), case doesn't matter ("rack 1" next to "Rack 1"), and everything else stays alphabetical. Lists the server sorts are right at the source, so paginated lists page in the right order too.

## Decision

Fix all three layers (approach A, approved 2026-09-28):

1. **Database ordering.** A Postgres ICU collation named `natural` — numeric (`kn`), case-insensitive (`ks-level2`), `deterministic = false` — created by migration `0082_natural_collation` (`down_revision = "0080"`; the chain on main is `0073 → 0081 → 0080 → 0082`, since spec-lookup's 0080 was re-pointed onto 0081 when it merged). Verified on the dev server (Postgres 16.14, ICU available): `rack 1, Rack 1, Rack 1a, Rack 2, RACK 03, rack 3B, Rack 10`. The `wiki` branch re-points its own migrations onto the head when it merges.
2. **API.** `serversherpa.db.ordering.natural(column)` returns `column.collate("natural")`. Every `order_by` on a text column (names, labels, make/model, serial, alias, description, role, resource/action, person last/first name) uses it — in routes, services, reports, importers, label generation, the AI tools and the spec lookup. Numeric, timestamp, rank, position and sort-order columns are untouched. The collation is used for ordering only, never in `WHERE`, `LIKE`, `DISTINCT` or joins (a non-deterministic collation can't be used there, and equality semantics must not change).
   **Python-side sorts** of display text (rack pages and the By Source/Destination tables in the Move Report, the make/model load and rail summaries, label generation's other-site names) use `serversherpa.db.ordering.natural_key` — `sorted(names, key=natural_key)` — the same rule as the collation: digit runs by value, letters case-insensitively (`casefold`). Where rows already come back from the database in natural order, a Python re-sort on another key relies on sort stability instead of re-sorting the text (the access matrix preview sorts by flip count only).
3. **Portal.** One comparator in `portal/src/lib/naturalSort.ts`:
   - `naturalCompare(a: string, b: string): number` — one cached `Intl.Collator(undefined, { numeric: true, sensitivity: 'accent' })`, `null`/`undefined` treated as `''`. `'accent'` (not `'base'`) matches the collation's `ks-level2` exactly: case-insensitive but accent-sensitive, so "Café" and "Cafe" are distinct on both sides.
   - `compareOrdinal(a, b)` — plain code-unit order for machine strings (ISO timestamps, ids) whose order is never read as text.
   - `compareValues(a, b)` — list-column comparator; a total order over mixed input: `null`/`undefined` first, then numbers by value, then text naturally. Timestamp columns return `Date.parse(...)` numbers, not ISO strings.
   - `sortNatural<T>(items: T[], key: (t: T) => string): T[]` — a copy, sorted.
   - `lib/sites.ts` re-exports `naturalCompare` from the new module (nothing that imports it today breaks); its own collator is removed.
   - Every place that orders strings switches to it: `localeCompare` calls, bare `.sort()` on string arrays, and the list pages' column comparators (`sortValueFor(...)` → comparator). Numeric and date sorts stay as they are. Dropdown option lists (ComboBox/select options built by callers) sort with it too.
4. **Kiosk.** Imports `naturalCompare` through the `@portal/lib/naturalSort` alias (React-free `.ts`, allowed by the kiosk's import guardrail) wherever it orders names.
5. **Guardrail.** `portal/src/styles/naturalSort.test.ts` (next to the typography guardrail, same style): scans `portal/src` and `kiosk/src` (excluding tests) and fails on
   - any `localeCompare(` outside `portal/src/lib/naturalSort.ts`;
   - any `new Intl.Collator(` outside that file;
   - any bare `.sort()` or `.toSorted()` (no comparator). There is no allowlist: an id or timestamp array passes `compareOrdinal`, which says the intent in the code.
   Comment lines (trimmed text starting with `//` or `*`) are skipped. Violations print the file:line.

## Testing

- **Portal unit:** `naturalSort.test.ts`: `["Rack 10","Rack 2","rack 1","Rack 1a"]` → `["rack 1","Rack 1a","Rack 2","Rack 10"]`; case-insensitive ties keep a stable order; `null` sorts first; `sortNatural` doesn't mutate its input. The guardrail test above.
- **API:** `tests/test_natural_ordering.py`: create sites "Rack 10", "Rack 2", "rack 1" → `GET /sites` returns them as `rack 1, Rack 2, Rack 10`; same for containers and for people by last name ("Smith 10"/"Smith 2"); the migration test that asserts a single Alembic head passes; a direct SQL check that `SELECT … ORDER BY x COLLATE natural` orders the fixture list as above.
- **Kiosk:** existing tests plus the guardrail (it scans `kiosk/src`).
- **Final:** full API, portal and kiosk suites; `tsc`; portal build.

## Out of scope

- Changing search, filtering or uniqueness rules (the collation is ordering-only).
- Sorting inside generated documents that already have their own explicit order (report column order, label layouts) unless they order names.

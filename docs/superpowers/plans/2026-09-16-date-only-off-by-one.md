# Date-only off-by-one: Move Scan History + portal call sites

Follow-up to the `container-labels-zpl` whole-branch review (main = 9da05af).
`initiatives.scheduled_start` and friends are `TIMESTAMP(timezone=True)` columns
that carry a plain `YYYY-MM-DD` input as **midnight UTC**. Converting that into a
local zone lands on the previous evening anywhere west of UTC, so the printed day
is one earlier than the one the user picked. Fixed for the label pipeline on
2026-09-16 (`_stored_day`); still live in two other places.

## Audit result (what is actually broken on main)

API — both confirmed at the lines the review named:
- `api/src/serversherpa/reports/move_scan_history/pdf.py:119`
- `api/src/serversherpa/reports/move_scan_history/xlsx.py:47` (via `_fmt`, defined :27)

Portal — the review's four line numbers had drifted, and two of them named a
different helper. The real offenders, after sweeping every `scheduled_*` /
`real_*` render site:
1. `pages/ClientDashboard.tsx:336` — `longDate(i.scheduled_start)` / `longDate(i.scheduled_end)`
2. `pages/MoveDashboard.tsx:87` — local `fmtDate`, used only at :376 on `scheduled_start`/`scheduled_end`
3. `pages/Home.tsx:55` — the inner `fmt` inside `windowLines`, applied to `scheduled_start`/`scheduled_end`
4. `lib/reports.ts:68` — exported `fmtDate`, used **only** on date-only fields at
   `components/reports/GenerateReportModal.tsx:227` and
   `components/reports/ReportOptionsLayout.tsx:123` (the review missed the second)

Already correct, leave alone: `components/initiatives/InitiativeHoverCard.tsx`
(`day`/`range` use `longDateOf(parseApiDay(...))`), `components/assets/AssetMoveHistory.tsx`,
`lib/initiatives.ts` (`dateOnly`/`toDay` slice the ISO string), `lib/timeline.ts`,
`pages/Home.tsx` `fmtDay` (parses `${isoDay}T00:00:00` locally).

Genuine timestamps stay on the old path: `longDate(created_at)`, scan times,
`xlsx._fmt` at :55/:83/:108, `pdf.py`'s `generated_at` stamp,
`MoveScanHistoryOptions.fmtDateTime(last_scan_at)`, `TimeManagement.fmtDate(clock_in_at)`.

## Formatting is preserved, not unified

Only the *parse* is wrong; each site keeps the output format it has today.
`longDateOf(parseApiDay(iso))` applies where the site already renders
`{month:'short', day:'numeric', year:'numeric'}` (ClientDashboard, MoveDashboard).
Home's `fmt` has a conditional year and `lib/reports.ts`'s `fmtDate` is a bare
`toLocaleDateString()` — those swap `new Date(iso)` for `parseApiDay(iso)` and
keep their own options. Changing what these render is out of scope.

---

## Task 1 — API: promote `stored_day` to the shared helper module

Three call sites now need it, so it stops being label-private.

- Add `stored_day(value: datetime) -> date` to
  `api/src/serversherpa/services/timezone.py`. That module is already the shared
  home for the house date/time rules, is already imported by both the label
  pipeline and the reports, and pulls in nothing heavier than `zoneinfo` — so a
  report importing it does not drag in openpyxl/WeasyPrint, and vice versa.
  Carry over the explanatory docstring from `_stored_day` (why UTC date parts,
  what it means for a genuine timestamp), in American English.
- In `api/src/serversherpa/labels/generate/values.py`, delete the private
  `_stored_day` body and import the shared one. Keep the module-level comment
  about `report_timezone` staying importable for the monkeypatch test.
  `api/tests/test_label_generate_values.py::test_move_date_reads_the_stored_day_not_the_local_one`
  must still pass unchanged — it is the existing proof and must not be edited.
- New tests in `api/tests/test_services_timezone.py`: midnight UTC returns that
  same calendar day; a genuine mid-day timestamp returns its UTC day; a value in
  a non-UTC tzinfo is normalized to UTC before the date is read.

Verify: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_services_timezone.py api/tests/test_label_generate_values.py -q` from the repo root.

## Task 2 — API: fix the Move Scan History report (depends on Task 1)

Write the failing tests first; they must fail against today's code for the
off-by-one reason, not an import error.

- `pdf.py`: `render_html`'s `scheduled_start` line uses
  `stored_day(data.scheduled_start).strftime(_DATE_FMT)`. `tz` stays in the
  signature — it is still right for the `generated_at` stamp and the timezone
  labels. `_fmt`-style timestamp rendering elsewhere in the file is untouched.
- `xlsx.py`: only `_build_overview`'s `scheduled_start` (line 47) changes, to
  `stored_day(...).strftime(_DATE_FMT)`. **Do not touch `_fmt`** — its other
  three uses (:55, :83, :108) are genuine timestamps and are correct as they are.
  Drop `_DATE_FMT` from `_fmt`'s callers only; keep the constant.
- Regression tests in `api/tests/test_move_scan_history_pdf.py` and
  `api/tests/test_move_scan_history_xlsx.py`: a `scheduled_start` of
  `datetime(2026, 3, 15, tzinfo=UTC)` (midnight, not the 9:00 the existing
  fixtures use — that is exactly why they miss this) rendered with a west-of-UTC
  `tz` must print `03/15/2026`. Use the existing `TZ = ZoneInfo("America/New_York")`
  and say in the test name/docstring that midnight is the point.
  Leave the existing 9:00 fixtures alone.

Verify: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_move_scan_history_pdf.py api/tests/test_move_scan_history_xlsx.py -q` from the repo root.

## Task 3 — Portal: fix the four helpers (independent of Tasks 1-2)

`parseApiDay` from `lib/timeline.ts`, `longDateOf` from `lib/format.ts`.
`longDate` itself is unchanged and stays correct for genuine timestamps.

- `pages/ClientDashboard.tsx:336` — `longDateOf(parseApiDay(iso))` for both
  ends. `scheduled_start`/`scheduled_end` are nullable: keep today's `—`
  behavior for null (that is what `longDate(null)` returns), via a small local
  helper rather than repeating the guard inline. Drop `longDate` from the
  import on line 26 if nothing else in the file uses it.
- `pages/MoveDashboard.tsx:87` — the body becomes
  `longDateOf(parseApiDay(iso))`; its existing options already match
  `longDateOf` exactly, so output is unchanged. Keep the `—` null guard.
- `pages/Home.tsx` — inside `windowLines`, `const d = parseApiDay(iso)` instead
  of `new Date(iso)`; keep the conditional-year options as they are.
- `lib/reports.ts:68` — `parseApiDay(s).toLocaleDateString()`; keep the bare
  `toLocaleDateString()` so the format does not change. Both call sites are
  date-only, so this fixes GenerateReportModal and ReportOptionsLayout at once.

Each fixed helper gets a comment in the house style pointing at why
(date-only field, midnight UTC, `longDate` would name the day before).

Tests: extend the existing `lib/reports.test.ts` and add coverage for the page
helpers where they are exported or reachable. Pin a west-of-UTC zone — vitest
runs under whatever `TZ` the shell has, so set it explicitly per-test rather
than assuming. A midnight-UTC input must render its own calendar day.

Verify: `npm test` in `portal/`.

## Done when

- Both API suites above pass, plus `test_label_generate_values.py` unchanged.
- `portal/` `npm test` passes and `npx tsc -b` is clean.
- No genuine-timestamp render site changed.

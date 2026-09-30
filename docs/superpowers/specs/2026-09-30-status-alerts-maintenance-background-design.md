# Status page: ntfy alerts, maintenance, background processing — design

**Date:** 2026-09-30 · **Approved by:** Jimmy (chat, 2026-09-30)
**Builds on:** `2026-09-23-status-page-design.md`
**Branches:** status page work on `status-page`; the API change on
`public-background-status` (off `main`). Nothing merges to `main` without asking.

## Goal

1. Push an alert to phones (ntfy) when a service goes down, comes back, or
   maintenance mode starts/ends — so nobody has to be watching the page.
2. Show read-only maintenance mode and the broadcast announcement on the page, so a
   planned freeze doesn't read as an outage.
3. Add a "Background processing" card: red when any background worker has died.

## Non-goals

- No worker names anywhere public. No incident posts. No email/Slack. No alert when the
  status container itself dies (it is the watcher). No merge to `main`, CSP, compose
  hardening, response-time charts, or certificate checks (deferred by Jimmy).

## Rule carried forward

The page, `/api/summary`, and every alert show **service titles only — never URLs,
hostnames, or probe error detail**. The only link in an alert is the optional public
status page URL (`STATUS_PUBLIC_URL`) as the tap target.

## 1. API: public background summary (branch `public-background-status`)

`GET /system/status` (public) gains:

```json
"background": {"state": "running" | "down" | "paused", "running": 7, "total": 9}
```

or `"background": null` when no worker has ever registered.

- Rows: `processes` where `kind == "worker"` (services and probes ignored).
- Each row's status comes from the existing `derive_status(...)`.
- `stopped` (clean shutdown) rows are excluded entirely — a deliberate stop/deploy is
  not an outage.
- `total` = remaining rows; `running` = rows whose status is `running` or `paused`
  (alive); `state` = `down` if any row is `failed`, else `paused` if any is `paused`,
  else `running`.
- Names are never returned. Existing clients (portal, kiosk web, Android kiosk —
  `ignoreUnknownKeys = true`) ignore the new field.
- Caveat (documented): a retired worker whose last run crashed counts as down until its
  row is deleted.

## 2. Status page: maintenance + announcement

The API probe already fetches `/system/status`. On a successful API check the checker
parses that body (tolerantly — missing or malformed fields mean "not known"):

- `read_only` → maintenance active; `read_only_message` → maintenance message.
- `banner` → announcement.
- `background` → section 3.

Messages are trimmed, empty → none, capped at 500 characters, and rendered as plain text.
If the API check fails or its data is older than the stale window, maintenance and
announcement are "not known" and nothing is shown.

`/api/summary` gains:

```json
"maintenance": {"active": true, "message": "Cutover until 14:00"} | null,
"announcement": "Hello all" | null
```

`overall` gains `"maintenance"`. Precedence: `degraded` if any service is down →
`maintenance` if maintenance is active → `operational` if every service is up (or
paused) → `unknown`. A real outage is never hidden by maintenance.

Page: `maintenance` → amber banner "Scheduled maintenance" with the message beneath. The
announcement shows as a blue note under the header whenever present.

## 3. Status page: Background processing card

- Derived from the same API response — no extra request. Key `background`, title
  "Background processing". Shown only when the API reports `background` (or history
  exists); an older API without the field → no card.
- Each successful API check that includes `background` records a check for key
  `background`: ok unless `state == "down"`. The same 2-strike rule, history, 90-day
  bars, and staleness apply.
- Card state `paused` (amber chip "Paused") when the latest report is `paused` and the
  tracked state is up. Paused never counts as down.
- The card shows "Workers: 7 of 9 running" in place of response time.
- If the API check fails, no background check is recorded for that cycle (unknown, not
  down).

## 4. ntfy alerts

Config (all optional; alerts are off without a topic):

| Var | Default | Notes |
|---|---|---|
| `STATUS_NTFY_TOPIC` | unset | enables alerts; `[A-Za-z0-9_-]{1,64}`; use a hard-to-guess name on public ntfy.sh |
| `STATUS_NTFY_SERVER` | `https://ntfy.sh` | self-hosted ntfy works too |
| `STATUS_NTFY_TOKEN` | unset | `Authorization: Bearer` for a protected topic |
| `STATUS_PUBLIC_URL` | unset | tap target (e.g. `https://status.serversherpa.com`) |

Events, computed after each check cycle from the displayed states (never while seeding
from history on startup):

| Transition | Title | Priority | Tags |
|---|---|---|---|
| service up/unknown → down | "{Name} is down" | 4 (high) | `rotating_light` |
| service down → up | "{Name} is back up" + "Down for 14 min" when the start is known | 3 | `white_check_mark` |
| maintenance off → on | "Maintenance started" + message | 2 | `construction` |
| maintenance on → off | "Maintenance ended" | 2 | `white_check_mark` |

- Paused never alerts. The first observation of maintenance after a start does not alert
  (the previous value is unknown).
- Publishing: `POST {server}/` with JSON `{topic, title, message, priority, tags, click?}`,
  10 s timeout. Failures are logged and never affect checks.
- `python -m serversherpa_status test-alert` sends one test notification and exits 0 on
  success, 1 on failure (2 if alerts aren't configured).

## Testing

- API: pytest for the background aggregate (no rows → null; fresh → running; stale →
  down; stopped excluded; paused; service/probe ignored; no names in the body) plus the
  updated defaults test.
- Status: pytest for API-status parsing, background checks and paused display,
  maintenance/overall precedence, staleness, alert transition detection, ntfy publishing
  (respx), config validation, and the test-alert command. Vitest for the amber
  maintenance banner, announcement, Paused chip, and workers line.
- Live: the API branch on a spare port against the dev DB (which has dead workers — the
  card should read down); a local ntfy container receives the alerts.

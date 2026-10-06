# Sirdar dashboard — certificate expiry for every environment (design)

Status: approved by Jimmy 2026-10-06. Extends
`2026-10-06-sirdar-dashboard-spotlight-design.md`.

## Goal

Every environment with public hostnames shows its certificate expiry — the
pill the demo data shows ("Certificate: N days left", amber ≤ 14 days, red when
expired) — on the spotlight and on every environment card, not only
DigitalOcean environments.

## Decisions

| Topic | Decision |
|---|---|
| Source | A live TLS check: Sirdar connects to each public hostname on 443 (SNI = the hostname) and reads the served leaf certificate's `notAfter`. Works for DigitalOcean, Nginx Proxy Manager or anything else, and shows what visitors get. |
| Which date | The soonest expiry across the environment's public hostnames. |
| Detail | Hovering the pill lists each hostname with its date (or why it couldn't be checked). |
| Unreachable | "Certificate: couldn't check" in gray. Never an error banner. |
| DigitalOcean | Uses the same live check for the pill. Sirdar's own records (`cert_not_after`, renewals) are unchanged. |
| Where | Spotlight title row and every environment card. |

## Behavior

- Hostnames: the environment's `environment_services.hostname` values that are
  set (portal, api, kiosk, wiki, status — whatever has one).
- The check: TCP connect + TLS handshake with a short timeout (3 s connect,
  3 s handshake), **without** trust or hostname verification (we only read the
  date; an untrusted staging or self-signed certificate must still report its
  date), `getpeercert(binary_form=True)` parsed with `cryptography`.
- All hostnames of all environments are checked concurrently, bounded
  (e.g. 16 at a time), so a slow host never stalls the dashboard beyond the
  timeout.
- Results are cached per hostname for 1 hour (successes) and 5 minutes
  (failures); `?refresh=1` on the dashboard bypasses the cache.
- Placeholders and demo data are unaffected (demo keeps its fixed values).
- No network check runs in tests: the checker is injectable, with a fake.
- Security: only hostnames Sirdar itself manages are dialed (no user-supplied
  URLs at request time); nothing secret is involved.

## Data

`flow.certificate` keeps its shape and gains `hosts`, and `tone` gains
`unknown`:

```ts
certificate: {
  days_left: number | null; expires_at: string | null;
  tone: 'ok' | 'warn' | 'bad' | 'unknown';
  hosts: { hostname: string; expires_at: string | null; days_left: number | null;
           error: string | null }[];
} | null   // null only when the environment has no public hostnames
```

`days_left`/`expires_at` are from the soonest expiry among hosts that
answered; `tone` is `unknown` when none answered. `error` is our own short copy
("Couldn't connect", "Timed out", "No certificate"), never raw exception text.

## Web

- `CertPill` renders for any card whose `flow.certificate` is set: the existing
  wording and tones, plus "Certificate: couldn't check" (gray) for `unknown`.
  A `title` (tooltip) lists `hostname — N days left` / `hostname — couldn't
  check` per host.
- The pill appears in the spotlight title row (as now) and on each environment
  card.

## Testing

- API: a fake checker — soonest date wins; tones at 30/14/0/expired; one host
  failing still reports the others; all failing → `unknown`; caching (a second
  dashboard call doesn't re-check; `refresh=1` does); no hostnames → `null`;
  DigitalOcean uses the live check; the real checker against a local TLS server
  with a self-signed certificate reads its date (no verification).
- Web: the pill on cards and spotlight for LAN and DigitalOcean cards; the
  unknown state; the tooltip lists hosts.

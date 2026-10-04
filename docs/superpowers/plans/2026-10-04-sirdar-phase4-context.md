# Sirdar deploy phase 4 (DNS + proxy) — context and decisions

Spec: `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md`
(Architecture "dns / proxy / smoke modules", Section 2 steps 12–14, Section 3
`managed_records` + integration credentials, Section 4 Settings test buttons
and Delete environment, Section 5 "never touching unmanaged records, cert reuse
vs request incl. the 30-day window"). Phase 3 is merged (main = sirdar =
af99c4cb). Plans: `2026-10-04-sirdar-phase4a-backend.md` (API, pipeline,
playbook) then `2026-10-04-sirdar-phase4b-ui.md` (web + live verify).

## What exists now (phase 3)

- Steps 1–11 (`deploy/steps.py`), every one an Ansible playbook run by
  `deploy/runner.py`; the pipeline (`deploy/pipeline.py`) stops at the first
  failure, retries from a step, holds one running deployment per environment.
- `environment_services` already has `hostname` (public services only:
  api, portal, kiosk, wiki, spaces, status; mailpit is LAN only) and a
  `proxied` flag (default off, editable in the PATCH).
- `environments.proxy_ip` is `STACK_PROXY_IP`: NPM's LAN IP, used by the
  stacks for `extra_hosts` and `FORWARDED_ALLOW_IPS`.
- `deploy/vault.py` encrypts with `SIRDAR_SECRETS_KEY` (Fernet).
- The Settings page is read-only (`GET /api/settings`, env-derived values).
- No Delete environment yet.
- Live: `uat` (adopted, 10.10.48.63, hand-made DNS + NPM hosts for api, portal,
  kiosk, wiki, spaces, status — and a hand-made `mail.uat` record Sirdar never
  touches) and `uat2` (made by Sirdar in the phase 3 live verify, ports +100 on
  the same VM, no DNS or NPM yet).

## Decisions

Step numbering and plans
- New steps, numbered to the spec: 12 `dns` "DNS records", 13 `proxy` "Proxy
  hosts", 14 `smoke` "Smoke test" (Python, not Ansible); Delete environment
  adds 15 `teardown` "Remove environment" (Ansible, `teardown.yml`), 16
  `unproxy` "Remove proxy hosts", 17 `undns` "Remove DNS records" (Python).
  `StepDef` gains `runs: "ansible" | "python"`.
- Every data-touching mode (update, reset, restore_dump, rollback, with or
  without a snapshot) appends 12, 13, 14 when the deployment publishes. Two
  new deployment modes: `publish` (12, 13, 14 only — no SSH, never changes
  `current_sha` or the environment's status) and `teardown` (15, 16, 17 — the
  host goes first, so nothing is unpublished while it still runs; on success
  the environment row is deleted).
- Whether a deployment publishes is stored on it (`deployments.publish`) so
  retries, `plan_of` and the step list agree, as `snapshot_id` does for restores.

Publish switch
- `environments.publish` (boolean). New environments default to on (the New
  environment modal shows the switch); adopted environments and every
  environment that exists when migration 0006 runs (uat, uat2) start off, so
  no deploy of a hand-built environment suddenly fails or edits DNS. The
  switch lives on the new Publish tab (PATCH `publish`, `deploy:change`).
- Off: steps 12–14 aren't in the plan at all (not "skipped").
- On but an integration isn't configured: the deploy is refused up front
  (409 `integration_not_configured {kinds}`), not after a 30-minute build.

DNS (Cloudflare)
- One A record per public service, `<service>.<base_domain>`, content = the
  Cloudflare integration's **public IP** (a Settings field), TTL auto, DNS
  only unless that service's `proxied` flag is on (spec: flag stored for later).
- Comment on records Sirdar creates: `Managed by Sirdar (<env>/<service>)`.
- Blockers (the step changes nothing and fails): a non-A record or several A
  records at the name, an unmanaged A record (claimable), a record another
  environment manages, a name outside the zone, and a wildcard
  `*.<parent>` Sirdar didn't create (protects `*.dev.serversherpa.com`, which
  serves the Mac dev stack).
- The zone is read once per step (paged `dns_records` list) and matched
  locally; no `name=` filtering (wildcard names are matched exactly in code).

Proxy (Nginx Proxy Manager, REST API)
- Login `POST /api/tokens {identity, secret}`; on a 401 mid-step the client logs
  in again once (simpler than the refresh endpoint, same effect).
- One proxy host per public service: scheme http, forward to the service's
  `host_ip:port`, WebSockets on, Block common exploits on, HTTP/2 on and Force
  SSL on once it has a certificate; `spaces` gets `client_max_body_size 0;` in
  its advanced config on create (the uat README rule). Updates are
  read-modify-write: only the forward fields, WebSockets, certificate, Force
  SSL and HTTP/2 are Sirdar's; access lists, advanced config and anything else
  on a claimed host are kept.
- Certificates (spec): keep the host's certificate when it covers the name
  and has more than 30 days left; renew it (`/renew`) when it's Let's Encrypt
  with 30 days or less; else reuse any certificate covering the name with more
  than 30 days (exact name preferred over a wildcard); else request a new one
  (Let's Encrypt HTTP challenge — DNS is step 12, so the name already
  resolves). Sirdar records only certificates it requested.
- Certbot collisions ("Another instance of Certbot is already running", NPM's
  hourly renew) and "Some challenges have failed" (DNS not visible to Let's
  Encrypt yet) are retried after 30, 60, 120 and 240 s; the sleep is
  injectable. Then the step fails with our own copy.
- Blockers mirror DNS: unmanaged host for the name (claimable), several
  hosts, a host that also serves other names, a host another environment
  manages.

Ownership (`managed_records`)
- Columns: environment, service, kind (`dns_record` | `proxy_host` |
  `certificate`), external id, name, origin (`created` | `claimed`); unique per
  (environment, service, kind) and per (kind, external id).
- Every create is recorded at once in its own committed transaction.
- **Claim** (Publish tab, `deploy:change`, writes only Sirdar's DB): every
  claimable DNS record and proxy host becomes `claimed`. Claimed entries are
  kept up to date by later publishes but are never deleted: Delete environment
  forgets them and leaves them in place. That is how uat's hand-made records
  are imported without duplicates.
- A managed entry under an old name (base domain changed) is removed when it
  was created, forgotten when it was claimed, then the new name is published.

Smoke test
- Per public service, `GET https://<hostname><path>` without following
  redirects; pass = 200–399. Paths: api, wiki, spaces, status `/healthz`;
  portal and kiosk `/`.
- Sent to the environment's `proxy_ip` (NPM) with SNI and Host set to the
  hostname, so it checks NPM, the certificate (verified) and the app without
  depending on the router's hairpin NAT — the same reason the containers use
  `extra_hosts`. Public resolution is covered by step 12's Cloudflare check.
- Up to 6 attempts per URL, 10 s apart (injectable).

Delete environment
- `POST /environments/{name}/deployments {mode: "teardown", confirm_name}`
  (`deploy:change`, typed-name gate), shown as "Delete environment".
- Step 15 `teardown.yml`: `ss-stack down --volumes` (when the folder has a
  `.env` and `ss-stack`), then removes `/opt/serversherpa/<env>` (checkout,
  `.env`, backups) with become. Images stay (another environment may run the
  same commit).
- Steps 16/17 delete only `created` entries (a 404 counts as gone) and forget
  `claimed` ones. Then the pipeline writes `deploy.environment_delete` and
  deletes the row (deployments, steps, services, secrets and managed records
  go with it by cascade). The environment shows status `deleting` meanwhile;
  a failure leaves it `failed` with Retry.

Credentials
- New table `integrations` (kind `cloudflare` | `npm`, non-secret `config`
  JSON, `secret_enc` Fernet with `SIRDAR_SECRETS_KEY`). Cloudflare: zone
  (default `serversherpa.com`), public IP, API token. NPM: URL (e.g.
  `http://10.10.48.6:81`), login email, Let's Encrypt email (defaults to the
  login), password.
- Routes under `/api/deploy/integrations`: GET (`deploy:view`), PUT per kind,
  DELETE, POST `/{kind}/test` (all `deploy:change`). Write-only secrets: never
  returned, logged, audited or put in an exception; audits list changed field
  names only. Test accepts unsaved values (missing secret = the stored one).
- The UI lives on the Settings page as an "Integrations" section (visible
  with `deploy:view`). The spec's GitHub credential is not part of phase 4.

Testing
- Every outbound client takes an `httpx` transport; `outbound.transports()`
  is the one switch tests replace. Fakes: `tests/fake_cloudflare.py`,
  `tests/fake_npm.py` (stateful `MockTransport` handlers) and a smoke handler.
  An autouse conftest guard makes any real `httpx.AsyncHTTPTransport` request
  fail the test.
- Pipeline tests use a `FakePublisher` (like `FakeRunner`); the real
  `HttpPublisher` is tested against the fakes.

Migration
- 0006 (`down_revision = "0005"`): `integrations`, `managed_records`,
  `environments.publish` (default false), `deployments.publish`, status
  `deleting`, modes `publish` and `teardown`. Check every worktree and the dev
  `sirdar` DB before numbering (0005 is the newest on 2026-10-04).

## Open questions for Jimmy

1. **Delete environment when the host is gone.** Default: not offered — step
   15 needs SSH, so the delete fails and can be retried. Alternative: a
   "Remove from Sirdar only" choice that skips the host (and leaves its
   containers running if it ever comes back).
2. **Delete environment removes the backups folder.** Default: yes, the whole
   `/opt/serversherpa/<env>` goes (the typed name is the gate). Alternative:
   keep `backups/` on the host.
3. **Public IP for the A records.** Default: typed once in Settings ›
   Integrations › Cloudflare (Jimmy knows the WAN IP; no third-party lookup).
   Alternative: a Detect button that asks an IP echo service.
4. **Claimed records get updated.** Default: yes — once claimed, a publish
   corrects drift (e.g. a port change) on hand-made records and hosts, but
   never deletes them. Alternative: claimed entries are read-only and drift
   only reports.

## Constraints carried from phases 2–3 (binding)

All earlier global constraints still apply: secrets never in responses /
logs / audit / exceptions; unsafe extravars; allowlisted runner env; pinned
host keys; American English; modal header pattern + content-sized modals;
DataTable / ComboBox / segmented idioms; `.pf-form .field-label` for
non-label captions; modal-body sections in a `.pf-form` grid need
`grid-column: 1 / -1`; display copy "Canceled"; web tests
`// @vitest-environment jsdom`; API tests `SIRDAR_TEST_DB=<name>
.venv/bin/pytest -q` from `sirdar/api`, never the dev `sirdar` DB; no
`npm install` in worktrees; tests never call real Cloudflare or NPM.

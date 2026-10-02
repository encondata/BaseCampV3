# Sirdar deploy pipeline (deploy step 2) — design

Date: 2026-10-02
Status: approved in brainstorming, awaiting spec review
Builds on: `2026-10-01-sirdar-groundwork-design.md`, the deploy step 1 / saved SSH
targets / dashboard work already merged to main.

## Goal

From Sirdar, pick a target (for now a Custom SSH Ubuntu host on the same LAN as
Nginx Proxy Manager), and deploy a complete ServerSherpa environment to it: API
and every worker, portal, kiosk web, wiki, MinIO "spaces", Postgres, mailpit and
status. Seed it from a chosen data snapshot, publish it at
`<service>.<env>.serversherpa.com` through Cloudflare DNS and the local NPM, and
keep it updatable, resettable and roll-back-able from Sirdar.

The first user is dev/UAT on the LAN. The design must not block later targets
(DigitalOcean, GCP, AWS, multi-host, blue/green prod), but those are out of
scope here.

## Decisions (from brainstorming, 2026-10-02)

| Topic | Decision |
|---|---|
| Where the tool lives | Sirdar, as deploy step 2 — no new app |
| Network (dev) | Target and NPM always on the same LAN behind one WAN IP; proxy step is a swappable module so remote targets can use another proxy later |
| Image build | Build on the target from a git SHA now; Compose files take the image source as one setting so a registry (private GHCR) is a config change later |
| Repo visibility | Assume private from day one: per-target read-only GitHub deploy key; no self-hosted git or registry |
| Seed data | Named snapshots, chosen per deploy; scrub option deferred |
| DNS | Explicit A records per service (no wildcard record), two-level names, DNS-only (grey cloud); per-record proxy flag stored for later |
| DNS names | api, portal, kiosk, wiki, spaces, status — each `<name>.<env>.serversherpa.com` |
| NPM | One proxy host per service with its own forward IP:port, scheme http, WebSockets on, Force SSL on |
| Certificates | One certificate per proxy host, HTTP challenge as today; reuse an existing valid cert, request only when missing or within 30 days of expiry |
| Redeploy | Choose each time: Update (default, keeps data) or Reset data (typed-name gate); Update takes a pre-deploy DB dump |
| Rollback | Manual button, never automatic |
| Execution engine | Hybrid: Sirdar is the control plane; host work runs as Ansible playbooks via `ansible-runner`; Cloudflare / NPM / smoke tests are Python modules in Sirdar; Terraform is a future step 0 for cloud targets |
| CI | Out of scope; separate follow-up (test gate → GHCR images → auto-deploy dev). The deployer stays CI-ready |
| Snapshot from the Mac | Built locally by a script and uploaded to Sirdar; Sirdar never SSHes into the Mac |

## Architecture

```
Sirdar (control plane: UI, DB, audit, credentials)
 ├─ pipeline engine ── ansible-runner ──SSH──▶ target host (steps 1–11)
 ├─ dns module ───────────────────────────────▶ Cloudflare API (step 12)
 ├─ proxy module (npm) ───────────────────────▶ Nginx Proxy Manager API (step 13)
 └─ smoke module ─────────────────────────────▶ public https URLs (step 14)
```

Units and their single jobs:

- **Pipeline engine** — owns deployment records, step ordering, the
  per-environment lock, stop-on-failure, retry-from-step and rollback plans. It
  knows steps only by name and interface (`run(ctx) -> StepResult`).
- **Ansible playbooks** (`sirdar/deploy/ansible/`) — one playbook per host
  step, idempotent, parameterized only by an inventory and an extra-vars file
  Sirdar renders.
- **Config renderer** — turns an environment record + decrypted secrets into
  the `.env` files and Compose files for the target. Pure function.
- **DNS module** — create/update/delete Cloudflare A records it manages.
- **Proxy module** — interface `ensure_hosts(env)`, `remove_hosts(env)`; the
  only implementation now is `npm`. A later `caddy-on-target` implementation
  plugs in here.
- **Smoke module** — checks public URLs after a deploy.
- **Snapshot service** — validates, stores, lists, and hands bundles to the
  restore playbook.

## Section 1 — Target layout

### Images

| Image | Source | Used by |
|---|---|---|
| `serversherpa-api` | new `api/Dockerfile`, generalized from `wiki/Dockerfile.worker` | api, every worker, migrate |
| `serversherpa-portal` | new `portal/Dockerfile` (node build → Caddy static, same pattern as `kiosk/Dockerfile`) | portal |
| `serversherpa-kiosk` | existing `kiosk/Dockerfile` | kiosk web |
| `serversherpa-wiki` | existing `wiki/Dockerfile` | wiki web |
| `serversherpa-status` | existing `status/Dockerfile` | status |

Every image is tagged with the deployed git SHA.

### Stacks

Five Compose projects under `/opt/serversherpa/<env>/`, all on Docker network
`ss-<env>`; every container, network and volume name is prefixed with the env
so one host can hold several environments.

1. **db** — Postgres 16 (matches the dev stack, so dev snapshots restore), named
   volume. Dumps stream out through `docker compose exec` into the env's
   `backups/` directory on the host.
2. **storage** — MinIO, one-shot `minio-init` (creates buckets), mailpit.
3. **api** — `api` (uvicorn) plus one container per worker, same image,
   different `command:`: import, log, notification, scan-match, report, label,
   spec-lookup, db-testing, wiki, wiki-export. One-shot `migrate` (Alembic to
   head) must succeed before `api` and workers start.
4. **web** — portal, kiosk, wiki.
5. **status** — status with its own data volume (moves to its own host in prod).

Loki/Grafana are not included.

### Ports (defaults, editable per environment)

| Service | Port |
|---|---|
| api | 8000 |
| portal | 8091 |
| kiosk | 8090 |
| wiki | 8096 |
| spaces (MinIO S3) | 9000 |
| status | 8095 |
| mailpit UI | 8025 |

Published on the target's LAN IP. Postgres and the MinIO console are internal
only (Postgres may be bound to 127.0.0.1 for debugging).

### Rules

- Services are configured only through env vars (`SS_*` etc.). No hostnames or
  paths baked into images — moving to managed Postgres, S3 or a cloud load
  balancer is a config change.
- `SS_SPACES_ENDPOINT` is the public `https://spaces.<env>.serversherpa.com`
  (path-style) so presigned URLs work in browsers.
- SMTP always points at mailpit in dev environments; ntfy/outbound
  notifications are off.
- Every service with a published port has a healthcheck; workers rely on
  `restart: unless-stopped` and the API's worker-health summary. Start order
  is db → storage → migrate → api + workers → web → status.
- Containers that call the public names (api, workers, status) map every
  `<service>.<env>.serversherpa.com` to the NPM LAN IP (`extra_hosts`) so
  they never depend on the router's hairpin NAT.
- `*.dev.serversherpa.com` already serves the Mac dev stack, so the first LAN
  environment is named `uat` (`*.uat.serversherpa.com`).

## Section 2 — Deploy pipeline

A click on Deploy creates a `deployments` row (environment, resolved SHA, mode,
snapshot, actor) and runs:

| # | Step | Engine | Update | Reset |
|---|---|---|---|---|
| 1 | Preflight: SSH + TOFU host key, OS, disk, memory, sudo | Ansible | ✓ | ✓ |
| 2 | Bootstrap: Docker + Compose if missing, Sirdar SSH key, `deploy` user, `/opt/serversherpa/<env>` | Ansible | first run | first run |
| 3 | Fetch code: per-target deploy key, sparse checkout of the SHA | Ansible | ✓ | ✓ |
| 4 | Render config: `.env` + Compose files from the environment record | Ansible templates | ✓ | ✓ |
| 5 | Build images, tagged with the SHA | Ansible | ✓ | ✓ |
| 6 | Pre-deploy dump to `backups/`, keep the last N (default 5) | Ansible | ✓ | — |
| 7 | Reset data: stop stacks, remove volumes | Ansible | — | ✓ |
| 8 | Start db + storage, wait healthy | Ansible | ✓ | ✓ |
| 9 | Restore snapshot (DB + buckets) | Ansible | — | ✓ (also first deploy with a snapshot) |
| 10 | Migrate (one-shot container) | Ansible | ✓ | ✓ |
| 11 | Start api + workers → web → status, wait healthy | Ansible | ✓ | ✓ |
| 12 | DNS: ensure the 6 Cloudflare records | Python | when changed | when changed |
| 13 | Proxy: ensure the 6 NPM hosts + certificates | Python | when changed | when changed |
| 14 | Smoke: `https://<service>.<env>…/healthz` and portal login page | Python | ✓ | ✓ |

Step 0 (provision) is reserved for Terraform on cloud targets; it is a no-op
for SSH targets.

The first SSH connection uses the target's saved username/password (or key).
Step 2 installs Sirdar's own key and later connections use it.

### Failure handling

- Stop at the first failed step; the deployment is `failed` with that step's
  log. Steps 1–5 never disturb the running environment (old containers keep
  serving).
- **Retry from step** re-runs from the failed step (steps are idempotent).
- **Roll back** (offered after a failure in steps 6–11): redeploy the previous
  successful SHA and restore the step-6 dump. Manual, with confirmation.
- One deployment per environment at a time (DB lock); a second request gets
  `deploy_in_progress`.

## Section 3 — Data model, secrets, snapshots

### Tables (Sirdar migration 0004+)

- `environments` — name, type, target, base domain, git ref, current SHA, status.
- `environment_services` — per service: host IP, port, hostname, proxied flag
  (default off). The single source for DNS, NPM and `.env`. A service may
  point at a different host from its siblings.
- `deployments` — environment, SHA, mode, snapshot, actor, status, timings,
  failed step.
- `deployment_steps` — number, name, status, timings, log (streamed live,
  stored after).
- `snapshots` — name, source, created, size, Alembic revision, checksum,
  notes, bundle path.
- `managed_records` — Cloudflare record ids and NPM proxy-host / certificate
  ids created by Sirdar, per environment. Sirdar edits or deletes only what is
  listed here.

### Secrets

- Per-environment secrets (JWT, Postgres, MinIO) are generated on first deploy
  and stored encrypted (Fernet, new `SIRDAR_SECRETS_KEY`). Written to the
  target `.env` with mode 600; never shown after creation.
- Integration credentials — Cloudflare token (DNS edit on `serversherpa.com`),
  NPM URL + admin login, GitHub credential (fine-grained token or GitHub App,
  used to register per-target deploy keys) — follow the
  `deploy-targets.env` pattern: write-only in the UI.
- Shared app keys (e.g. Anthropic) come from Sirdar settings, overridable per
  environment.
- Secrets never appear in API responses, logs or Ansible output (`no_log` on
  secret-bearing tasks; the global 422 handler already strips input).

### Snapshots

Bundle = `.tar.zst` containing a `pg_dump` (custom format), one archive per
MinIO bucket, `manifest.json` (Alembic revision, buckets, checksums) and
`keys.enc` (`SS_PASSWORD_PEPPER` + `SS_TOTP_ENCRYPTION_KEY`, encrypted with
`SIRDAR_SECRETS_KEY`). Stored on a Sirdar volume, `sirdar/snapshots/`.

Created either by **Take snapshot** from a Sirdar-managed environment, or by
`scripts/make-seed-snapshot.sh` on the Mac dev stack and uploaded in Sirdar.

On restore the snapshot's pepper and TOTP key replace the environment's so
seeded users can sign in. Step 10 migrates from the snapshot's revision to the
code's head; a snapshot whose revision is newer than the code is refused.

## Section 4 — UI and permissions

Builds on the existing `/deploy` page and dashboard.

- **Environments tab** on `/deploy`: list (name, target, SHA/branch, status,
  last deploy). **New environment** modal with the report-generate header and
  steps Basics → Services (hostname → IP:port table, prefilled) → Data
  (snapshot or empty) → Review (lists the DNS records and NPM hosts to create).
- **Environment detail** `/deploy/environments/:name`, tabs:
  - Overview — running SHA, per-service health, public URLs + mailpit, Deploy.
  - Deploy modal — git ref resolved to a SHA; Update (default) or Reset data
    (snapshot + typed environment name).
  - Deployments — history; row opens the step list with live logs, Retry from
    step, Roll back.
  - Services — edit the map; save previews the DNS/NPM changes for the next
    deploy.
  - Backups — pre-deploy dumps with restore (typed-name gate).
- **Snapshots tab** — list, Upload, Take snapshot from environment, delete.
- **Settings** — Cloudflare / NPM / GitHub credentials (write-only) with a Test
  button each (zone scope, NPM login, repo access).
- **Dashboard** — Dev/Beta cards show real environments; Deploy opens the same
  modal. Blue/green stays "coming later".
- **Delete environment** — stops stacks, removes volumes, deletes only
  `managed_records` entries; typed-name gate.

Permissions reuse `deploy`:

| Level | Allows |
|---|---|
| `deploy:view` | environments, deployments, logs, snapshots |
| `deploy:add` | create environments, Update deploys, take/upload snapshots |
| `deploy:change` | Reset, roll back, restore backups, delete environments/snapshots, edit integration credentials |

Every action writes an audit row.

## Section 5 — Testing

- **Unit (pytest, no network)**: config rendering checked against the API's
  settings model so no required `SS_*` key can be missed; Cloudflare/NPM
  modules against recorded HTTP fixtures (create/update/no-op, never touching
  unmanaged records, cert reuse vs request incl. the 30-day window); pipeline
  engine (order, Update/Reset skips, stop on failure, retry, lock, rollback
  plan); snapshots (manifest, checksum mismatch, newer-revision refusal,
  `keys.enc` round-trip); permission level per endpoint; no secrets in
  responses or logs.
- **Playbooks**: run each against a disposable Ubuntu 24.04 container with
  Docker-in-Docker; `ansible-lint` in the suite; every playbook runs twice and
  the second run must report no changes.
- **End-to-end (before merge)**: throwaway LAN Ubuntu target; upload a snapshot
  from `make-seed-snapshot.sh`; create `uat-test` at `*.uat-test.serversherpa.com`
  names; Reset deploy → all 6 URLs on HTTPS, seeded user signs in with 2FA,
  wiki page with attachment opens, report downloads via `spaces.`; Update with a
  newer SHA keeps data and leaves a pre-deploy dump; forced failed migration →
  Roll back; tear down → managed DNS/NPM entries gone, hand-made ones untouched.

## Phasing

Each phase gets its own plan and merge.

1. **Containerize** — `api` and `portal` Dockerfiles, the five-stack Compose
   layout, a hand-written `.env`; deploy manually to a LAN box.
2. **Pipeline core** — environments / deployments / steps tables, ansible-runner
   engine, steps 1–11, Update/Reset, environment and deploy UI. DNS and NPM
   remain manual.
3. **Snapshots** — bundle format, Mac script, upload, take snapshot, restore,
   Backups tab and rollback.
4. **DNS + proxy** — Cloudflare and NPM modules, `managed_records`, smoke
   tests, teardown, Settings credential tests.

## Out of scope

- CI (test gate, GHCR publishing, auto-deploy) — separate project.
- Terraform / cloud provisioning, DigitalOcean / GCP / AWS deploys.
- Blue/green prod, load balancers, multi-host environments in practice (the
  data model allows per-service hosts; the pipeline targets one host for now).
- Data scrubbing for snapshots.
- Fixing the public one-liner installers for a private repo (noted follow-up).

# Sirdar phase 7 — DigitalOcean environments (design)

Status: approved by Jimmy 2026-10-05. Builds on the deploy pipeline spec
(`2026-10-02-sirdar-deploy-pipeline-design.md`) and phases 3–6 (snapshots,
DNS + proxy, Proxmox, ESXi). V2 production on DigitalOcean is **not touched**;
this phase only builds new environments.

## Goals

- Build complete ServerSherpa environments on DigitalOcean: droplets, a DO
  Managed Postgres database, a DO Spaces bucket and a DO Load Balancer.
- Blue/Green for production; the same model, optionally, for every other
  environment, so dev and UAT run exactly like prod.
- The dashboard's **Activate** toggle switches the load balancer between slots.
- The database only accepts connections from the environment's own droplets.
- The managed database and Spaces details go into the env file the api,
  portal, wiki and kiosk read.

## Decisions (Jimmy, 2026-10-05)

| Topic | Decision |
|---|---|
| Data between slots | One shared database and one shared bucket. Both slots run full stacks against them. |
| Slot shape | One droplet per slot running the whole app stack. Separate api / web droplets (option B) is a later phase. |
| TLS | Load balancer terminates HTTPS with a Let's Encrypt certificate. Sirdar issues the first one (DNS-01 via the Cloudflare integration); a `cert-worker` in the stack renews it; Sirdar is the backup renewer. |
| Hostname routing | Caddy in plain-HTTP mode on each droplet (new `proxy` stack). NPM stays for dev/uat on the LAN. |
| Seeding | Database locked to the environment's droplets from creation; the seed restore runs on the first slot's droplet over the VPC. |
| Slots | Production: two slots, **blue** and **green**, always. Every other environment: asked at create — one droplet, or two slots named **orange** and **purple**. Every DO environment has a load balancer. A one-slot environment can add its second slot later. |
| Deploy flow | Update deploys to the idle slot and smoke-tests it through the slot's own address. **Activate** re-checks and switches. Non-prod has an "activate automatically after a good deploy" setting; production always waits for the click. |
| Sizes | Defaults for every environment = current V2 production: droplet 2 vCPU / 4 GB / 80 GB (`s-2vcpu-4gb`), database 2 vCPU / 4 GB / 60 GB (`db-s-2vcpu-4gb`), single node; a standby-node option. Editable at create. |
| Delete | Sirdar takes a snapshot first, then removes everything it tagged. Production needs a second confirmation and must be marked **retiring** first; a live slot can't be deleted. |
| Existing V2 prod | Out of scope. A later cutover (snapshot old, seed new, switch DNS) gets its own plan. |
| DigitalOcean accounts | **Two DigitalOcean accounts** (API keys), e.g. *Production* and *Development*, each with its own region. Every DO environment is built in one account, chosen at create and frozen (it can't move later). Production environments default to the Production account. |
| Live test | Approved to spend money: a throwaway two-slot dev environment, built, seeded, switched, renewed, deleted the same day. Built in the *Development* account. |

## 1. Resources per environment

- A VPC (`ss-<env>`), so droplets reach the database privately.
- Droplets: one per slot (`ss-<env>-<slot>`), Ubuntu 24.04, Sirdar's generated
  SSH host key delivered through cloud-init user-data and pinned before first
  SSH (the ESXi approach), Sirdar's per-environment client key authorized.
- DO Managed Postgres 16 cluster (`ss-<env>-db`) in the VPC; database
  `serversherpa`, user `serversherpa`; **trusted sources = this environment's
  droplets by droplet ID** (never IPs, never Sirdar). Optional standby node.
- Spaces bucket (`ss-<env>-<short id>`) in the region, with a Spaces access key
  scoped to that bucket only.
- DO Load Balancer (`ss-<env>-lb`) in the VPC: HTTPS 443 → droplet HTTP 80,
  HTTP 80 → droplet HTTP 80 (redirect to HTTPS except the ACME path), health
  check `GET /healthz` on port 80; targets = the **active** slot's droplet only.
- A Let's Encrypt certificate covering the environment's public names, uploaded
  to DO as a custom certificate and attached to the load balancer.
- Cloudflare DNS A records for the public names pointing at the load
  balancer's IP (the phase 4 publisher, now with the LB IP as the target).

Every DO resource carries the tags `sirdar` and `sirdar-env-<environment id>`.
Sirdar acts only on resources it recorded **and** that still carry its tag
(the phase 4/5/6 ownership rule). Ownership rows live in a new `do_resources`
table (kind, DO id, name, slot, created/claimed).

## 2. Provisioning — step 0 "Prepare DigitalOcean"

Runs in Sirdar (Python, DO API v2 through an injectable client with a fake in
tests). Idempotent: it creates what is missing, grows sizes, never shrinks or
replaces. Order:

1. VPC.
2. Spaces bucket + scoped key (secret stored with the vault).
3. Droplets for the slots the environment has (wait for active + IP).
4. Database cluster (trusted sources = the droplets) — wait until online;
   store the connection details (host, port, user, password, CA cert) with the
   vault.
5. Certificate: if none or < 30 days left, issue via DNS-01 with the Cloudflare
   integration (ACME client in Sirdar, Let's Encrypt production by default with
   a staging switch for tests), upload to DO, record it.
6. Load balancer (created with the certificate; targets = active slot).
7. Host keys pinned (SSH host key from Sirdar's generated key, checked against
   the live server).

Sizes and slot count come from the environment's frozen `do` settings (like
`esxi_vms`), so later Settings edits only change new resources or explicit
grows.

## 3. The app stack on a DO droplet

- The existing Compose stacks **without** `db` and `storage`.
- Render writes into `.env`: `SS_DATABASE_URL` (asyncpg, `ssl=require`, the
  managed host on the VPC address), the Spaces endpoint/region/bucket/key/
  secret (`SS_SPACES_*`), and `STACK_EXTERNAL_DATA=1` so `ss-stack` skips the
  local data stacks. Restore and dump steps use the managed database through
  a one-off container on the droplet (it is a trusted source).
- New `proxy` stack: Caddy 2 (pinned image digest), `auto_https off`, port 80,
  host-based routes generated from `.env` to api / portal / kiosk / wiki /
  status, WebSocket-friendly, trusts the LB's `X-Forwarded-*`, serves
  `/healthz` and `/.well-known/acme-challenge/*` (proxied to the cert-worker).
- New `cert-worker` (in the api image, like the other workers):
  - daily check of the load balancer's certificate;
  - single active renewer via a Postgres advisory lock (both slots share the
    database);
  - at ≤ 30 days: HTTP-01 through the load balancer (the LB forwards the
    challenge path to the active slot), upload the new certificate, swap it on
    the load balancer, delete the old one;
  - DO token on the droplet is a **scoped** token (certificate create/read/
    delete, load balancer read/update) stored in `.env`; never the account token.
- Sirdar is the backup renewer: every deploy and a periodic check renew via
  DNS-01 if ≤ 14 days remain, and the dashboard warns at 14 days.

## 4. Blue/Green

- Environment fields: `slots` (`["blue","green"]`, `["orange","purple"]` or
  `["orange"]`), `active_slot`, `auto_activate` (non-prod only).
- **Update** targets the idle slot (the only slot for one-slot environments):
  steps run on that droplet; migrations run against the shared database; then
  a smoke test hits the slot's droplet directly (VPC address, Host header per
  service, through Caddy).
- **Activate** (`POST /deploy/environments/{name}/activate {slot}`):
  `deploy:change`, typed name for production; re-runs the smoke test on the
  slot, then sets the load balancer's targets to that slot's droplet; records
  an activation row (audit). Instant switch-back = Activate the other slot.
- `auto_activate` on non-prod activates after a successful deploy.
- Migrations must stay compatible with the slot still on the old code
  (expand/contract); documented in the README and the deploy modal.
- **Add a second slot** (Settings, non-prod): provisions the second droplet,
  adds it to the database's trusted sources, deploys the active commit to it.

## 5. Seeding

The first deploy of an environment created from a snapshot restores on the
first slot's droplet: the bundle is copied over SSH, the database is restored
into the managed cluster (`pg_restore` to an emptied schema, as phase 3),
objects are imported into the Spaces bucket, sessions are cleared, and the
sign-in keys come from the snapshot. The database is never reachable from
outside the VPC.

## 6. Delete environment (DO)

1. Refuse production unless marked **retiring**, and refuse while a slot is
   active for production; second confirmation for production.
2. Take a Sirdar snapshot (database + bucket objects) — the phase 3 snapshot
   job, run on a droplet.
3. Remove DNS records (phase 4 rules), the load balancer, the certificate, the
   droplets, the database, the bucket and its key, the VPC — each only if
   recorded **and** tagged for this environment. Forget each row as it goes;
   a retry resumes.

## 7. Dashboard

- The Production card reads real state: active slot, load balancer status,
  per-slot droplet and health, certificate expiry; its **Activate** button
  calls the Activate route.
- Other two-slot environments show the same slot pair and Activate on their
  card.

## 8. DigitalOcean accounts

- Settings › Integrations › DigitalOcean holds **two named accounts** (labels,
  default *Production* and *Development*), each with its own API token
  (vault-encrypted, write-only), default region and Test. The existing single
  DigitalOcean token becomes the *Production* account on migration; the
  `SIRDAR_DEPLOY_DO_TOKEN` env fallback stays attached to that account.
- The integration is stored per account (`integrations` gets an account key,
  or a new `do_accounts` table — the plan decides), so the two never share a
  token.
- New environment's DigitalOcean target asks which account; the choice is
  frozen on the environment and every resource, client call, Activate, renewal
  and delete for it uses that account's token. Removing an account is refused
  while environments use it, and so is changing an account's token to one
  that belongs to a different DigitalOcean team (checked through the account
  API's team UUID), so environments can't silently move.
- The dashboard's infrastructure view and the Deploy page connection test show
  both accounts.
- Each account's scoped droplet token (certificate/load balancer) is created
  in that account.

## 9. Security and secrets

- The DO account tokens stay in Sirdar (Settings › Integrations). Droplets get
  only the scoped certificate/load-balancer token.
- Database password, Spaces secret, scoped token, CA cert: vault-encrypted in
  Sirdar, written only into the droplet `.env` (mode 600), never in responses,
  logs or audit.
- ACME account key: per Sirdar, vault-encrypted.

## 10. Testing and verification

- `FakeDigitalOcean` (droplets, VPCs, databases, firewall/trusted sources,
  Spaces keys + buckets, load balancers, certificates, tags) behind the
  existing no-real-HTTP guard; a fake ACME directory for certificate flows.
- Caddy config generation tested by rendering and by a container run in the
  deploy suite (`SS_STACK_E2E`).
- Live verify: a throwaway two-slot dev environment (orange/purple) seeded from
  a snapshot; deploy; switch slots; force a renewal on the cert-worker; delete;
  confirm nothing tagged remains.

## Build order

- **7a**: the two DigitalOcean accounts, DO client + fake, `do_resources`, step 0, external-data stack
  (`STACK_EXTERNAL_DATA`, `.env` render), Caddy `proxy` stack, seeding, delete.
- **7b**: slots, Activate, auto-activate, add-a-slot, `cert-worker` + Sirdar
  backup renewal, dashboard and UI.

## Out of scope

- Separate api/web droplets per slot; several droplets per slot.
- Adopting or migrating V2 production.
- DigitalOcean DNS (Cloudflare stays authoritative).

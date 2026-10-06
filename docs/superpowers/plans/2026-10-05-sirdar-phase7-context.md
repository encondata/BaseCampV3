# Sirdar deploy phase 7 (DigitalOcean environments with Blue/Green): context and decisions

Spec (binding): `docs/superpowers/specs/2026-10-05-sirdar-digitalocean-environments-design.md`.
Phases 3–6 (snapshots, DNS + proxy, Proxmox, ESXi) and the DigitalOcean
integration token (migration 0009, `9202d797`) are the base. Their decisions
still bind unless this file says otherwise.

Plans:

- `2026-10-05-sirdar-phase7a-backend.md`: the two accounts, the DigitalOcean
  client and its fakes, migration 0010, step 0 "Prepare DigitalOcean", the
  external-data stack and the Caddy `proxy` stack, seeding, Delete. Buildable
  and testable on its own; the web keeps working through a compatibility alias.
- `2026-10-05-sirdar-phase7b-ui.md`: Activate, auto-activate, deactivate for a
  retiring production, add a second slot, size grows, the `cert-worker` in the
  api image and Sirdar's backup renewal, the dashboard's real production card,
  then all the web work and the live verify.

## What exists now (read from the code on 2026-10-05)

- `integrations` (0006–0009) holds `cloudflare`, `npm`, `proxmox`, `esxi`,
  `digitalocean`. The DigitalOcean row is one token; `SIRDAR_DEPLOY_DO_TOKEN`
  is its fallback (`integrations.load_digitalocean`, `digitalocean.resolve`).
  `deploy/digitalocean.py` has only read calls: the connection test, regions
  and the dashboard inventory (droplets, databases, load balancers).
- `outbound.transports()` is the one switch for outbound httpx clients; the
  autouse `no_real_http` guard fails any real request (async and sync httpx).
- Environments: `type` is `dev | beta | custom`; `target_id` is an SSH target,
  `proxmox` or `esxi`. VM environments run steps 0 / 15 through
  `vmsteps.HostProvisioner` (`runs="vm"`), with `VmOutcome(sha, vm_snapshot)`.
- The pipeline renders `.env` (`envfile.render_env`) from Sirdar's record; the
  stack (`deploy/stack`) has five Compose stacks (db, storage, api, web,
  status) driven by `ss-stack`. The api compose file hard-codes
  `SS_DATABASE_URL=…@postgres:5432/serversherpa`, `SS_DATABASE_SSL=disable`,
  the SeaweedFS `SS_SPACES_*` values, `FORWARDED_ALLOW_IPS=$STACK_PROXY_IP`,
  and `extra_hosts` that map every public name to `STACK_PROXY_IP` (NPM).
- ServerSherpa's API reads `SS_DATABASE_URL` (asyncpg URL; `sync_database_url`
  swaps the driver to psycopg for Alembic and the log handler, keeping any
  query string), `SS_DATABASE_SSL` (`require` → asyncpg `ssl=True`;
  psycopg gets libpq's default `sslmode=prefer`), and `SS_SPACES_ENDPOINT /
  REGION / BUCKET / ACCESS_KEY / SECRET_KEY / USE_PATH_STYLE` (boto3,
  presigned GET and PUT).
- Snapshots (phase 3): `export.yml` dumps through the `db` stack's container
  and exports objects with `bundle.py export-objects` (default endpoint
  `http://seaweedfs:8333`, key id `serversherpa`, secret `SNAP_S3_SECRET` or
  `SPACES_SECRET_KEY`); `restore.yml` runs `ss-stack restore` and
  `bundle.py import-objects`.
- Publishing (phase 4): `publish.ensure_dns` writes A records at the
  Cloudflare integration's `public_ip`; `smoke.run` checks public URLs through
  a given IP with SNI.
- The dashboard's ProductionFlow **Activate** button is a `SoonButton`; the
  production card is always empty (`service.build_dashboard`). Inventory
  groups resources by the tags `sirdar-env:<name>` and `sirdar-slot:<blue|green>`.
- Migrations: 0009 is the newest in every worktree and branch; the dev
  `sirdar` DB reports 0004. **0010 is free** (Task 1 of 7a checks again).

## Decisions

### Accounts (spec §8)

- **A new table `do_accounts`**, not an account key on `integrations`. Two fixed
  rows keyed `production` and `development` (labels editable, default
  "Production" / "Development"). Columns: `key` (PK), `label`, `region`,
  `token_enc`, `team_uuid`, `team_name`, `renewal_token_enc`, `updated_by`,
  `updated_at`. Why: `integrations.kind` is the primary key, so a second
  DigitalOcean row would need a new key shape; environments reference an
  account by a foreign key (`ON DELETE RESTRICT`); and the renewal token and
  team are per account.
- Migration 0010 moves the `integrations` `digitalocean` row into the
  Production account (same ciphertext) and deletes it; `integrations.kind`
  loses `digitalocean`. `SIRDAR_DEPLOY_DO_TOKEN` stays the Production
  account's fallback, and `SIRDAR_DEPLOY_DO_REGION` its region fallback.
- **Team check.** Saving a token reads `GET /v2/account` and stores
  `team.uuid` (`account.uuid` prefixed `personal:` when there is no team). A
  token from another team is refused (409 `do_team_changed`) while any
  environment uses the account. The same token in both accounts is refused
  (409 `do_token_shared`). Every environment freezes the account's
  `team_uuid` at create; step 0 refuses to act if the token now answers for
  another team.
- Clearing an account (DELETE) is refused while environments use it
  (409 `account_in_use {environments}`).
- 7a keeps `PUT/POST test/DELETE /deploy/integrations/digitalocean` and
  `Integrations.digitalocean` working as an alias for the Production account,
  so the current web works between 7a and 7b. 7b moves the web to the account
  routes and deletes the old DigitalOcean modal; the alias stays in the API (it
  only ever touches the Production account, and its tests cover the
  `SIRDAR_DEPLOY_DO_TOKEN` fallback), to be removed in a later cleanup.

### The droplet's renewal token (spec §3, §8; "scoped token")

- DigitalOcean's public API v2 has no endpoint that creates a personal access
  token (custom scopes are chosen in the control panel). **Jimmy creates one
  custom-scoped token by hand per account** (scopes: certificate
  create/read/delete, load_balancer read/update) and enters it in Settings ›
  Integrations › DigitalOcean as the account's **Renewal token**
  (vault-encrypted, write-only).
- Test checks it: certificate and load balancer reads must answer 200; a
  droplet read that also answers 200 is a warning ("this token can read
  droplets; give it only the certificate and load balancer scopes").
- Step 0 refuses to build an environment whose account has no renewal token
  (it is the only DigitalOcean credential that reaches a droplet).

### Records and ownership (spec §1, phase 4–6 rules)

- New tables (0010): `do_environments` (one row per DigitalOcean
  environment: the frozen `do` settings, the per-environment SSH key pair,
  connection details, vault-encrypted secrets), `do_slots` (one row per slot:
  the generated host key, the droplet's addresses, the commit deployed on it,
  the last slot smoke result) and `do_resources` (`kind, do_id, name, slot,
  origin='created'`, unique `(kind, do_id)`), the ownership record.
- **Tags.** Every resource that DigitalOcean can tag (droplets, database
  clusters) carries `sirdar`, `sirdar-env-<environment id>` (ownership) and
  `sirdar-env:<name>` plus, for droplets, `sirdar-slot:<slot>` (the
  dashboard's existing grouping). VPCs, load balancers, certificates, cloud
  firewalls, Spaces keys and buckets have no resource tags: for them
  "recorded **and** tagged" becomes "recorded **and** its exact name
  (`ss-<env>…`)", and the VPC also carries `sirdar:<environment id>` in its
  description. Sirdar acts only on what matches.
- Lost records: a droplet or database cluster tagged `sirdar-env-<id>` that
  isn't recorded is Sirdar's (the tag holds the environment's UUID): step 0
  adopts it into `do_resources`; Delete removes it.
- A recorded resource that no longer matches (tag or name) stops the step and
  changes nothing; one that is gone (404) is forgotten.

### Networking

- **Cloud firewall `ss-<env>-fw`** (not in the spec; needed so Caddy's plain
  HTTP isn't reachable around the load balancer): applies to droplets tagged
  `sirdar-env-<id>`; inbound TCP 80 only from the load balancer
  (`load_balancer_uids`), inbound TCP 22 from anywhere (key-only, pinned host
  key); outbound everything.
- App ports bind to `127.0.0.1` on droplets (`STACK_BIND_IP=127.0.0.1`); only
  Caddy publishes `:80`.
- The `ss-<env>` Docker network gets a fixed subnet `172.30.0.0/24` on
  droplets (`STACK_NETWORK_SUBNET`); Caddy is `172.30.0.2`, which is the
  environment's `proxy_ip`, so `FORWARDED_ALLOW_IPS` stays `STACK_PROXY_IP`.
  The public names resolve inside containers to the load balancer
  (`STACK_HOSTS_IP`), not to Caddy (Caddy has no TLS).
- Caddy trusts `X-Forwarded-*` only from the VPC's range
  (`STACK_TRUSTED_PROXIES`, read from the VPC) and sends the app a single
  `X-Forwarded-For: {client_ip}`.
- Containers can't reach the metadata service (169.254.169.254): bootstrap
  adds a persistent `DOCKER-USER` reject rule on DigitalOcean droplets,
  because the droplet's user-data holds its private host key.

### Database (spec §1, §3, §5)

- The cluster is created through the API (PG 16, `private_network_uuid` = the
  VPC, tags, size, `num_nodes` 1, or 2 with the standby option). Its firewall
  is set to the environment's droplets by droplet ID right after create
  (retried until the API accepts it) and again whenever a slot is added.
- **The role and database are created in SQL, not through the API**: step 0
  runs `psql` on the first slot's droplet as `doadmin` over the VPC
  (`postgresql-client` comes with cloud-init). PG 16 gives the creating role
  ADMIN OPTION on roles it creates, so `doadmin` can `GRANT serversherpa TO
  doadmin` and `CREATE DATABASE serversherpa OWNER serversherpa` — the app
  role then owns the database and its `public` schema, which `ss-stack
  restore`'s "empty schema" step needs. Users made through the API are owned
  by DigitalOcean's own superuser, so that wouldn't work.
- The role's password is the environment's existing `POSTGRES_PASSWORD`
  (generated hex). Sirdar sends PostgreSQL only its **SCRAM-SHA-256
  verifier** (`ALTER ROLE … PASSWORD 'SCRAM-SHA-256$…'`), so the plaintext
  never reaches the server or its logs. The `doadmin` password (from the
  create response) is vault-encrypted and travels only on the SSH session's
  stdin.
- Step 0 pins the droplets' host keys **before** the role setup (spec §2 lists
  pinning last): the SQL runs over SSH on the slot's droplet, so the key must
  be trusted first. The rest of §2's order holds (VPC, bucket, droplets,
  database, certificate, load balancer), with the cloud firewall last.
- `SS_DATABASE_URL` is rendered **without a query string** and TLS comes from
  `SS_DATABASE_SSL=require` (asyncpg `ssl=True`). Reason: `sync_database_url`
  hands the same URL to psycopg, and libpq rejects asyncpg's `ssl=` key; libpq's
  default `sslmode=prefer` negotiates TLS with DigitalOcean (which requires it).
  This is how the spec's "asyncpg, `ssl=require`" is met.

### Spaces (spec §1, §3)

- The bucket (`ss-<env>-<first 8 hex of the env id>`) is made through the S3
  API, signed with SigV4 by Sirdar's own small signer (`deploy/s3sig.py`;
  no boto3 in Sirdar: it would bypass the httpx guard). A **temporary
  full-access Spaces key** (`ss-<env>-setup`, recorded while it exists) signs
  the bucket create (and, at Delete, the emptying and the bucket delete); it
  is deleted right after. The app's key (`ss-<env>`) is per-bucket,
  `readwrite`, made after the bucket exists.
- The app gets `SS_SPACES_ENDPOINT=https://<region>.digitaloceanspaces.com`,
  `SS_SPACES_REGION=<region>`, `SS_SPACES_USE_PATH_STYLE=false`.

### Steps, plans and slots (spec §2, §4)

- New steps (`steps.py`): **0 `do_prepare` "Prepare DigitalOcean"** (`runs="vm"`,
  60 min), **13 `slot_smoke` "Smoke test (slot)"** (Ansible, on the slot's
  droplet), **14 `go_live` "Switch traffic"** (`runs="vm"`), **18
  `do_destroy` "Remove DigitalOcean resources"** (`runs="vm"`). They reuse the
  VM-step machinery: `vmsteps` dispatches a `DoContext` to the DigitalOcean
  provisioner.
- `deployments` gains `cloud` (its plan is a DigitalOcean plan), `slot` (the
  slot it deploys, smoke-tests or switches to) and `go_live` (its plan ends
  with 14). Plans:
  - update: `do_prepare, preflight, bootstrap, fetch, render, build, dump,
    [restore], up, dns, slot_smoke, [go_live]`;
  - snapshot: `preflight, export` (on the active slot);
  - teardown: `[export], undns, do_destroy`;
  - activate (7b): `slot_smoke, go_live`.
  No `data` step (no local data services) and no `proxy`/`smoke` steps
  (no NPM; `go_live` runs the public smoke test through the load balancer).
- **The slot smoke test runs on the droplet** (Ansible `uri` against Caddy at
  `http://127.0.0.1` with each public `Host`). Sirdar isn't in the VPC, so it
  can't call the droplet's VPC address; this is the spec's "through the
  slot's own address, through Caddy".
- **Which slot an Update targets** (`do_envs.target_slot`): the idle slot of a
  two-slot environment, the only slot of a one-slot environment, `slots[0]`
  for a first deploy.
- **When an Update goes live** (`do_envs.goes_live`): a first deploy (nothing
  is live yet, production included), every deploy of a one-slot environment
  (it replaces the live stack in place), and (7b) a non-production two-slot
  environment with `auto_activate`. Otherwise the slot waits for Activate.
- `go_live` points the load balancer at the slot's droplet, then runs the
  public smoke test through the load balancer's IP; if that fails it puts
  the previous targets back and fails.
- The environment's `current_sha` / `image_tag` are the **active** slot's;
  each slot's own commit is on `do_slots`.
- Production is a new environment type `production` (DigitalOcean only),
  always slots `blue, green`, never `auto_activate`, never ACME staging.
- **Phase 7 offers Update, Activate, Take snapshot, Publish, Delete and
  Retry on DigitalOcean.** Reset, Restore backup and Roll back answer 409
  `not_supported_on_digitalocean`: the database is shared by both slots, so
  each would also change the live slot; Roll back is "Activate the other
  slot". Pre-deploy dumps are still taken on the slot's droplet.

### Certificates (spec §1, §2.5, §3)

- **One ACME client, two copies**: `sirdar/api/src/sirdar_api/deploy/acme.py`
  (Sirdar, DNS-01) and `api/src/serversherpa/certs/acme.py` (the cert-worker,
  HTTP-01) are byte-identical; a Sirdar test fails when they differ (the
  pyVmomi pin-agreement pattern). Standard library + `cryptography` + `httpx`
  only, ES256 account keys.
- Sirdar's ACME account key is per Sirdar and per directory (table
  `acme_accounts`, vault-encrypted). Each environment's cert-worker has its
  own account key (generated at create, vault-encrypted on
  `do_environments`, rendered into `.env`), so Sirdar's key never reaches a
  droplet.
- No ACME contact email (optional in RFC 8555; Let's Encrypt no longer sends
  expiry mail).
- **ACME staging is a per-environment switch** (`do.acme_staging`, frozen at
  create, non-production only). The live verify uses it. Its smoke tests
  don't verify the certificate (a staging certificate isn't trusted).
- The certificate covers the public names `api., portal., kiosk., wiki.,
  status.<base_domain>` (`spaces.` isn't public on DigitalOcean: objects live
  in Spaces). Uploaded as a DigitalOcean custom certificate named
  `ss-<env>-<UTC yyyymmddhhmm>`.
- **Who renews**: the cert-worker on the slot the load balancer targets (its
  droplet ID is rendered into `.env` as `STACK_DROPLET_ID`; the scoped token
  reads the load balancer's targets), under a Postgres advisory lock. It
  renews at ≤ 30 days. Sirdar renews by DNS-01 at ≤ 14 days, in every step 0
  and in a periodic check (every 6 hours). The dashboard warns at 14 days.
- **The 30-day and 14-day rules, read together.** Spec §2 says step 0
  issues "if none or < 30 days left"; §3 makes the cert-worker the renewer at
  ≤ 30 days and Sirdar the backup at ≤ 14 days. Step 0 issues when there is
  no certificate and renews at ≤ 14 days; the 15–30 day window belongs to the
  cert-worker, so the two never race.
- **Sirdar's periodic check is a deployment.** Every 6 hours Sirdar starts a
  `renew` deployment (mode in 0010; one step, 19 `do_renew` "Renew
  certificate", `runs="vm"`) for each DigitalOcean environment whose
  certificate has ≤ 14 days left and that isn't deploying. Being a
  deployment gives it the one-running-deployment lock (it can't race a
  Switch traffic), a log and an audit row.
- **Reconcile**: the cert-worker swaps certificates without telling Sirdar.
  Step 0 and the periodic check read the load balancer's certificate; one
  that isn't recorded but is named `ss-<env>-…` and covers exactly the
  environment's names is recorded as Sirdar's, and a recorded one that is
  gone is forgotten.

### Seeding, snapshots and Delete (spec §5, §6)

- `ss-stack` gains an external mode (`STACK_EXTERNAL_DATA=1`): `up`/`down`
  skip the `db` and `storage` stacks (except `mailpit`), `dump`/`restore` use
  one-off `postgres:16-alpine` containers against the managed database
  (`PGPASSWORD` from `POSTGRES_PASSWORD`, `PGSSLMODE=require`), and new
  `pgdump` / `revision` commands serve the snapshot export. `STACK_CADDY=1`
  starts the new `proxy` stack.
- `export.yml` / `restore.yml` branch on `external_data`; `bundle.py`
  objects commands get the Spaces endpoint and key id as arguments, and the
  secret from `SS_SPACES_SECRET_KEY` (checked before `SPACES_SECRET_KEY`).
- **Delete** (`teardown` with `cloud`): a snapshot named
  `<env>-before-delete-<UTC yyyymmddThhmmssZ>` (export on the active slot),
  then 17 Remove DNS records, then 18: load balancer, certificates,
  firewall, droplets (pins forgotten), database cluster, Spaces key, bucket
  (emptied with a temporary full-access key), VPC (after its members are
  gone). Each row is forgotten as it goes; a retry resumes.
- Production: Delete needs `retiring`, no active slot (7b's Deactivate clears
  it), the typed name and a second typed phrase `delete production <name>`,
  and always takes the snapshot. Non-production may untick the snapshot
  (`snapshot: false`; an environment whose droplets are broken could
  otherwise never be deleted) — see open question 4.

### Ports, names and secrets

- DigitalOcean environments: `proxy_ip=172.30.0.2`, `bind_ip=127.0.0.1`,
  `publish` always on (its plan has DNS), `spaces_bucket` = the DO bucket.
- Secrets (account tokens, renewal tokens, `doadmin` password, Spaces secret,
  ACME keys, generated host keys) are vault-encrypted; never in responses,
  logs, audit rows, exceptions or `repr()`. The droplet `.env` (mode 600)
  holds only the app's database password, the bucket key, the renewal token
  and the worker's ACME key. Every DigitalOcean step redacts all of them.
- Errors are our own copy, never DigitalOcean's, ACME's or httpx's text. A
  DigitalOcean error `id` (like `unprocessable_entity`) may be named.

### Tests

- `FakeDigitalOcean` (`tests/fake_digitalocean.py`, an httpx MockTransport):
  account/team, regions, sizes, database options, VPCs (+ members), droplets
  (boot after N polls, tags, user-data), database clusters (online after N
  polls, firewall rules, CA, resize), Spaces keys with grants, certificates,
  load balancers (active + IP after N polls, PUT), cloud firewalls, tokens
  with scopes.
- `FakeSpaces` (S3: bucket create/list/delete objects/delete bucket) and
  `FakeAcme` (RFC 8555 directory; JWS checked; DNS-01 answered from
  `FakeCloudflare`'s TXT records, HTTP-01 through a callback; issues
  certificates from a test CA).
- All three answer through `outbound.transports()` kinds `digitalocean`,
  `spaces`, `acme`; the `no_real_http` guard stays as is.
- The tests' SSH server plays droplets at 127.0.0.1 (the ESXi approach: the
  generated host key is replaced by the server's key).

### Permissions

- `deploy:add`: create a DigitalOcean environment, Update, Take snapshot.
- `deploy:change`: account tokens, Activate, auto-activate, add a slot, size
  grows, `retiring`, Delete.
- `deploy:view`: the `do` block, slots, certificate expiry.

## Uncertain DigitalOcean API points (check in the live verify)

1. **Spaces bucket creation** goes through the S3 API, not v2: `PUT /` on
   `https://<bucket>.<region>.digitaloceanspaces.com` (virtual-hosted), SigV4
   with the region slug (`nyc3`) as the signing region and service `s3`.
   Whether DigitalOcean wants `us-east-1` instead, and whether path-style
   (`https://<region>.digitaloceanspaces.com/<bucket>`) is needed.
2. **Per-bucket Spaces keys**: `POST /v2/spaces/keys {name, grants:[{bucket,
   permission:"readwrite"}]}` → `{key:{access_key, secret_key, …}}`; a
   full-access key as `grants:[{bucket:"", permission:"fullaccess"}]`;
   `DELETE /v2/spaces/keys/{access_key}`. Whether the secret is returned only
   once, and whether a `readwrite` key can't delete the bucket itself (hence
   the temporary full-access key).
3. **Database firewall**: `PUT /v2/databases/{id}/firewall {rules:[{type:
   "droplet", value:"<id>"}]}`. Whether it is accepted while the cluster is
   `creating`; whether `private_network_uuid` at create places it in the
   VPC; `private_connection.host`; port 25060; `GET /v2/databases/{id}/ca` →
   `{ca:{certificate:<base64 PEM>}}`; that GET returns the `doadmin`
   password.
4. **Managed PostgreSQL privileges**: `doadmin` can `CREATE ROLE`,
   `CREATE DATABASE … OWNER`, and gets ADMIN OPTION on a role it created
   (PG 16), so `GRANT serversherpa TO doadmin` works.
5. **Load balancer**: forwarding rules `{entry_protocol:"https",
   entry_port:443, target_protocol:"http", target_port:80,
   certificate_id}` and `{entry_protocol:"http", entry_port:80,
   target_protocol:"http", target_port:80}`; `vpc_uuid`, `size_unit`,
   `redirect_http_to_https:false`; PUT needs the whole body; health check
   `{protocol:"http", port:80, path:"/healthz"}`; that the load balancer
   reaches droplets from the VPC range and sends `X-Forwarded-For` and
   `X-Forwarded-Proto`; that `droplet_ids: []` is accepted.
6. **Scoped tokens**: no API creates them; the scope names
   (`certificate:create/read/delete`, `load_balancer:read/update`); whether
   a scoped token can read `/v2/account` (Test doesn't rely on it).
7. **Custom certificates**: `POST /v2/certificates {name, type:"custom",
   private_key, leaf_certificate, certificate_chain}`; `not_after` and
   `dns_names` in the answer; a certificate in use by a load balancer can't
   be deleted.
8. **Account team**: `GET /v2/account` → `account.team.{uuid,name}`.
9. **Cloud firewall** `inbound_rules[].sources.load_balancer_uids`; whether
   cloud firewalls filter VPC traffic.
10. **VPC**: no resource tags; `description` is kept; `DELETE` fails while
    it has members; `GET /v2/vpcs/{id}/members`; the auto-assigned
    `ip_range`.
11. **Droplets**: `user_data` up to 64 KiB; the tag charset allows `:`;
    `networks.v4[].type` `public` / `private`.
12. Non-API points to confirm on the same run: Docker Compose nested
    interpolation (`${A:-${B}}`) on the droplet's Compose plugin; asyncpg
    `ssl=True` against DigitalOcean's certificate; boto3 presigned PUTs to
    Spaces with `SS_SPACES_REGION=<region>`.

## Open questions for Jimmy

1. **How many production environments at once?** Default: at most one
   production environment that isn't marked retiring (409
   `production_exists`), so a cutover can build the next one while the old
   one retires.
2. **Mail on DigitalOcean environments.** Default: `mailpit` catches mail as
   on dev/uat (nothing is sent); real SMTP comes with the V2 cutover plan.
3. **SSH to droplets.** Default: port 22 open to anywhere (key-only, pinned
   host key). Alternative: limited to addresses listed in Settings (Sirdar's
   public IP may change).
4. **Delete without a snapshot (non-production).** Default: allowed, by
   unticking "Take a snapshot first" in the Delete modal; production always
   snapshots.
5. **Reset data on DigitalOcean.** Default: not offered in phase 7 (it would
   wipe the database the live slot uses); reseeding means deleting and
   recreating the environment from a snapshot.

## Out of phase 7

- Adopting or migrating V2 production; DigitalOcean DNS; separate api/web
  droplets; several droplets per slot.
- Reset data, Restore backup and Roll back on DigitalOcean (see above).
- Real SMTP; Spaces CDN; a DigitalOcean container registry (images are
  built on each droplet, as on SSH targets).
- Resizing a droplet of the live slot (7b grows only the slot being
  deployed; a one-slot environment's grow briefly stops it, and the Settings
  copy says so).

## Constraints carried from phases 2–6 (binding)

- Secrets never appear in responses, logs, audit rows, exceptions or
  `repr()`; unsafe extravars; an allowlisted runner environment.
- Pinned host keys; Sirdar changes only what it records it made.
- American English; the report-generate modal header, sized to its content;
  `.pf-form` sections with `grid-column: 1/-1`; `.sirdar-integration-cards`,
  `.sirdar-kv` and `Breakable` on cards; ComboBox and segmented controls,
  never a raw `<select>`; "Canceled" for `cancelled`.
- Web tests start with `// @vitest-environment jsdom`; never `npm install`.
- API tests: `SIRDAR_TEST_DB=<name> .venv/bin/pytest -q` from `sirdar/api`,
  never against the dev `sirdar` DB. The full suite takes about 11 minutes:
  implementers run focused tests, the controller runs the full suite.
- Tests never call real DigitalOcean, Spaces, ACME, Cloudflare, NPM,
  Proxmox, Terraform or ESXi.
- Other agents commit in the same worktree: `git add <paths>` only, never
  `git stash`, retry when `index.lock` is busy.

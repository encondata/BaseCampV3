# Sirdar — step-by-step Deploy, LAN Blue/Green, fresh start (design)

Status: approved by Jimmy 2026-10-07. Builds on phase 7
(`2026-10-05-sirdar-digitalocean-environments-design.md`), the ESXi/Proxmox
VM targets (phases 5–6) and the spotlight dashboard.

## Goal

One step-by-step flow on the Deploy page creates **and** deploys a new
environment end to end: environment → servers → target → extras → traffic →
data → review & Deploy. LAN targets (ESXi, Proxmox) gain Blue/Green with
Nginx Proxy Manager as the switch. An unseeded environment gets its first super
admin from the flow.

## Decisions (Jimmy, 2026-10-07)

| Topic | Decision |
|---|---|
| Step 1 | Always a **new** environment: type (Production / Development / UAT / Custom) + name. Existing environments keep Update/Activate on their own pages. |
| LAN load balancer | **Nginx Proxy Manager** (already fronts dev/uat). Activate repoints the environment's proxy hosts to the live VM. |
| LAN Blue/Green data | A **dedicated data VM** (Postgres + object storage) shared by both app VMs. |
| Extras | Optional apps (Wiki, Kiosk, Status, Mailpit); hosting options (sizes, DO standby DB, test certificates, activate automatically); integrations (Cloudflare DNS publish, SMTP vs Mailpit, AI assistant key). |
| First super admin | **Typed** password → account created; email with a change-password link valid **4 hours**. **Generated** → never shown; an **invite** email with a set-password link valid **4 hours**. No password ever goes in an email. Mailpit is fine for testing. |

## 1. The Deploy page flow

Replaces the "New environment" dialog. The page keeps the Environments and
Snapshots lists below the flow; Targets / Connect / Trusted SSH hosts move into
the Target step (details collapsible).

| Step | Content | Rules |
|---|---|---|
| 1. Environment | Type (segmented), name | Name rules as today (`nameProblem`). Production needs DigitalOcean (today's rule); only one live production. |
| 2. Servers | Single server · Blue/Green | Production: Blue/Green only (blue/green). Others: Single (orange) or Blue/Green (orange/purple). SSH targets: Single only. |
| 3. Target | ESXi · Proxmox · DigitalOcean · SSH, then that target's details | Only configured + available targets are choosable; the Connect test runs inline. VM targets: host, sizes, IPs (one per app VM + the data VM). DigitalOcean: account, region, sizes. SSH: the target. |
| 4. Extras | Apps · Hosting · Integrations | Apps: API and Portal always on; Wiki, Kiosk, Status, Mailpit toggles. Hosting: per-target size/standby/test-certificate/auto-activate (Blue/Green only, not production). Integrations: Publish DNS (Cloudflare), Mail (Mailpit or SMTP host/port/user/password/from), AI assistant key. |
| 5. Traffic | Read-only plan of what routes traffic | DigitalOcean: the load balancer + certificate (as phase 7). LAN: the Nginx Proxy Manager proxy hosts (one per enabled public app) and which VM they'll point at first. |
| 6. Data | Seed from a snapshot · Start empty | Start empty → first super admin: first name, last name, email, and Password: **Type** (validated against the portal's password policy, fetched from the target environment's defaults) or **Generate & invite**. |
| 7. Review & Deploy | Every choice; one **Deploy** button | Creates the environment and starts its first deployment; the page follows the deployment. |

Every step validates before Next; Back keeps choices; errors from create map
back to their step (the existing `CODE_FIELD` approach). The flow is a page
section, not a modal, and keeps the report-generate header style for its step
titles.

## 2. LAN Blue/Green (ESXi and Proxmox)

- **VMs per environment:** `ss-<env>-data` (Postgres + SeaweedFS, data
  stacks only) and one app VM per slot, `ss-<env>-orange` /
  `ss-<env>-purple` (app stacks with `STACK_EXTERNAL_DATA=1`, pointing at the
  data VM over the LAN). Single-server LAN environments stay exactly as today
  (one VM, local data).
- **Records:** `vm_slots` (or reuse of `do_slots`' shape in a target-neutral
  table) — slot, VM id, IP, sha, image_tag; `environments.slots` /
  `active_slot` / `auto_activate` already exist and become valid for VM
  targets.
- **Update** deploys to the idle slot (same `target_slot` / `goes_live` rules),
  runs the slot smoke test against the VM directly, then **Activate**
  (optionally automatic) repoints traffic.
- **Activate on the LAN:** for each of the environment's NPM proxy hosts, set
  `forward_host` to the new slot's VM IP; then smoke-test the public hostnames
  through NPM; on failure put every proxy host back. The data VM is never
  switched.
- **Database access:** the data VM's Postgres listens on the LAN, allowed only
  from the environment's app VM IPs (pg_hba + the VM firewall); credentials in
  the app VMs' `.env` as today. TLS is not required on the LAN (as today's
  local stacks).
- **Delete** removes the app VMs and the data VM (after the snapshot), and the
  NPM proxy hosts and DNS as today.
- **Snapshots/backups** run on the data VM.

## 3. Fresh start: the first super admin

- **ServerSherpa API:** `bootstrap-admin` gains `--role super_admin`,
  `--password-stdin` (no prompt), and `--invite` (no password: the account is
  created without one and a set-password link is issued). Both paths issue a
  password-reset token valid for a given `--link-minutes` (240) and queue the
  email through the existing mail outbox: "Your ServerSherpa account is ready"
  with a change-password link (typed) or a set-password invite (generated).
- **Sirdar:** the environment stores the first admin's name/email and, for a
  typed password, the password encrypted with the vault; the first deploy's
  new step "Create the first admin" (after Start services, only when not
  seeded) runs the command inside the api container with the password on
  stdin, then forgets the password (row cleared). It never appears in
  responses, logs, audit or argv.
- **Password policy:** the typed password is checked by the API command against
  the environment's own policy; Sirdar's form shows the policy hint from the
  ServerSherpa defaults and surfaces the command's refusal as a field error on
  step 6.
- **Mail:** sent by the new environment's notification-worker — Mailpit on
  dev/uat, SMTP when configured in step 4.

## Build order

1. Fresh start (API command + Sirdar step).
2. LAN Blue/Green (data VM, slots on VM targets, NPM Activate).
3. The Deploy page flow (UI over 1 + 2 + existing DO/SSH creation).

## Out of scope

- Converting an existing environment between single and Blue/Green.
- Blue/Green on SSH targets.
- A load-balancer VM (NPM is the switch).

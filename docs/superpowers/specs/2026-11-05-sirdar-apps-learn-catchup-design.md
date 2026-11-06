# Sirdar: editable apps and mail, the learn app, and stack catch-up

Date: 2026-11-05. Branch: `sirdar` (fast-forwarded to main 4d0e1953).

## Why

Sirdar's code hasn't changed since 2026-10-08, and main has moved on since:

- The **learning site** (`learn`, port 8092) is in `deploy/stack`. Sirdar's app list doesn't know it, though, so it always writes a `STACK_APPS` without learn and `ss-stack up` scales learn to 0. As a result:
  - Learn gets no DNS record, proxy host, certificate or smoke check.
  - Its port is never allocated.
  - Adopting a `.env` that lists learn fails.
- **Kiosk biometric sign-in** needs `SS_KIOSK_SIGNING_DIGESTS`, but the stack never passes it to the API, so every enroll is refused.
- With the wiki off, the **portal** still shows a Wiki link and a Help button that leads to a site that isn't running.
- **Apps and mail can't be changed** after an environment is created. PATCH silently ignores them.

## Goals

1. Learn is a first-class optional app in Sirdar, the same as wiki and kiosk.
2. Apps and mail can be edited on an existing environment. The next Update applies them.
3. The portal hides app links for apps that are off.
4. The stack passes the kiosk signing digests through, and Sirdar can set them.
5. Empty first deploys can seed starter content.
6. A test catches drift between Sirdar's app list and the stack's.

## A. Portal knows which apps are on

- **API setting.** New setting `SS_APPS: list[str]`, comma-separated and lowercase, read with the same NoDecode/validator pattern as `kiosk_signing_digests`.
  - Unset or empty means every app counts as on. Dev and older stacks keep today's behavior.
  - `none` means none are on.
- **Status endpoint.** `GET /system/status` (`SystemStatusOut`) gains `apps: {wiki: bool, kiosk: bool, learn: bool}`.
- **Stack config.** In `deploy/stack/api/compose.yml` x-ss-env: `SS_APPS: ${STACK_APPS:-}`.
- **Portal.**
  - `NavItem` gains an optional `app?: 'wiki' | 'kiosk'`, set on the Kiosk and Wiki items in the Apps section.
  - The app shell hides an item whose app is off, using the system-status context the portal already polls.
  - `HelpButton` renders nothing when the wiki is off.
  - Wiki notification links in the inbox are unchanged.
  - Until status loads, links show as today. The status payload is cached, so they don't flash.

## B. Learn as a Sirdar app

- **App lists.**
  - `apps.OPTIONAL_APPS = ("wiki","kiosk","learn","status","mailpit")`.
  - `learn` goes in `_PUBLIC_APPS`.
  - The default apps for new environments include learn.
- **Rule: learn needs the wiki.** Learning documents render through the wiki container.
  - Sirdar's `check_apps` refuses learn without wiki, with error code `learn_needs_wiki` and the copy "The learning site needs the wiki: turn the wiki on, or turn learning off."
  - `ss-stack check_apps` dies with the same rule.
  - The Deploy flow and the Settings section both turn learn off when the wiki is turned off.
- **envfile.**
  - `learn` goes into `SERVICES` and `PUBLIC_SERVICES`.
  - `DEFAULT_PORTS["learn"] = 8092`, and `STACK_LEARN_PORT` goes into the rendered keys and `env.example`, both in the same order.
  - Shared SSH hosts allocate learn's port in `_free_ports` like any other service.
- **DigitalOcean:** `learn` goes into `certs.PUBLIC_SERVICES`, so it appears in the load balancer certificate's names, `SS_CERT_NAMES` and the LB smoke.
- **Smoke:** `PATHS["learn"] = "/"`.
- **Status page.**
  - The status app gains a monitor `("learn","Learning","STATUS_LEARN_URL",False)`.
  - The status compose sets `STATUS_LEARN_URL: ${STATUS_LEARN_URL-https://learn.${STACK_DOMAIN}}`, and ss-stack clears it when learn is off.
  - `learn.${STACK_DOMAIN}` is added to the api and status `extra_hosts`.
- **Migration 0015** (Sirdar DB):
  - Adds `learn` to `apps` for every environment that has `wiki` on, and changes the column default.
  - Inserts a `learn` `environment_services` row for every environment that lacks one:
    - `port` is 8092, or the next free port for environments that share an SSH host with others (`host_ip` taken from the portal row).
    - `hostname` is `learn.<base_domain>` when learn is on, otherwise NULL.
  - Downgrade removes learn from `apps` and deletes the rows.
  - Existing environments pick learn up on their next Update and publish.
- **Adopt** accepts `learn` in `STACK_APPS` and reads `STACK_LEARN_PORT`.
- **Web.** The Deploy flow's Extras step lists Learning (between Kiosk and Status) and applies the wiki rule. Fixtures and labels are updated.

## C. Apps and mail editable after create

- **API.**
  - `EnvironmentPatch` gains `apps: list[str] | None` and `mail: MailIn | None`.
  - `environments.update()` validates them with the create rules:
    - `check_apps`, including `learn_needs_wiki`;
    - `check_mail` (mailpit off requires SMTP; SMTP host, port and from must be set together);
    - `smtp_required_for_first_admin`.
  - The SMTP password keeps its existing path (`secrets.SS_SMTP_PASSWORD`). Switching mail to mailpit clears the stored SMTP columns and deletes that secret.
  - Changes are refused while a deploy is running (`deploy_in_progress`), as today.
- **Hostname recompute.** When `apps` changes, every service row's hostname is rebuilt with the same rule as create: `envfile.PUBLIC_SERVICES` for LAN/SSH/VM environments and `certs.PUBLIC_SERVICES` for DigitalOcean.
  - An app turned on gets its name, and one turned off has its name cleared.
  - `home` is untouched.
- **Applying.** Nothing runs right away. Copy: "Saved. The next deploy applies these settings."
  - The next Update rewrites `.env` with `STACK_APPS` and the `SS_SMTP_*` values.
  - `ss-stack up` starts or stops app containers. Volumes are kept.
  - Publish creates or removes DNS records and proxy hosts through the existing stale-row logic.
- **DigitalOcean certificates.** `_certificate` already reissues when a wanted name is missing. It now also reissues when the recorded certificate has names that are no longer wanted, so the exact-match ownership check keeps passing after an app is turned off.
- **Web.** The environment Settings tab gets an "Apps & mail" section, placed after Services.
  - It uses the Deploy flow's app toggles and mail controls, extracted from `ExtrasStep.tsx` into a shared component that both screens use.
  - It is locked while a deploy runs, and is saved by the existing "Save settings" button.
  - Error codes map to their fields.

## D. Kiosk signing digests

- **Stack.**
  - x-ss-env gets `SS_KIOSK_SIGNING_DIGESTS: ${SS_KIOSK_SIGNING_DIGESTS:-}`.
  - `env.example` gets an empty `SS_KIOSK_SIGNING_DIGESTS=` with a comment: comma-separated SHA-256 digests of the kiosk app signing certificates, release and Play.
- **Sirdar.**
  - Stored as a plain, non-secret environment column `kiosk_signing_digests text[] NOT NULL DEFAULT '{}'` (in migration 0015).
  - It is set at create time (Extras step) or edited in Settings › Apps & mail.
  - Each entry is validated as 64 hex characters, with optional colons, normalized to lowercase without colons. The error code is `signing_digest_invalid`.
  - It is rendered into `.env` by `env_extra`, and adopt reads it.

## E. Seed starter content

- **Option.** Data step option "Seed starter content", shown only for first deploys that don't restore a snapshot. It defaults to on.
  - It is stored on the deployment as `seed_content boolean`.
- **Run.** A new pipeline step runs after the first-admin step. It executes, in the api container:
  1. `serversherpa seed-label-fonts`
  2. `serversherpa seed-label-templates`
  3. `serversherpa learning-seed`, only when learn and wiki are both on.
- **Rules.**
  - Each command is idempotent.
  - A failure fails the step with the command's last output lines, and Retry runs the step again.
  - The step's log notes that Zebra's TT0003M_.TTF is uploaded by hand (Label builder › Fonts).

## F. Drift guard

- **App list.** A Sirdar test parses `deploy/stack/ss-stack` (`check_apps` case list) and asserts it equals `apps.OPTIONAL_APPS` as a set.
- **Ports.** A test asserts that every `STACK_*_PORT` key in `deploy/stack/env.example` maps to a Sirdar service and the reverse. That test may already exist; extend it to cover learn.

## Out of scope

- Automatic redeploy on save.
- Mail credentials in the portal.
- Learn-specific cookie or session changes. The live check covers this.
- Status monitors beyond learn.

## Testing

- **API:** `SS_APPS` parsing (unset, empty, `none`, list), the `/system/status` apps field.
- **Portal:** nav and Help hide when an app is off.
- **Sirdar:**
  - learn in the lists, its ports, `_free_ports`, certs, smoke;
  - the `learn_needs_wiki` rule (Sirdar and ss-stack);
  - migration 0015 upgrade and downgrade, including the head asserts;
  - PATCH: apps, mail, digests, hostname recompute for LAN and DO, the locks;
  - publish removes the DNS and proxy entries of an app turned off;
  - DO reissue on extra names;
  - the seed step (commands, conditional learning-seed, failure, retry);
  - adopt with learn;
  - drift tests;
  - web tests for the Extras step and the Settings section.
- **Deploy tests:** the ss-stack learn rule, `STATUS_LEARN_URL` clearing, x-ss-env keys.
- **Live (Tower, demo):**
  1. Update demo, which picks up learn and publishes `learn.demo.serversherpa.com`.
  2. Turn the wiki off, which forces learn off. Update.
  3. Check that the wiki and learn names are gone and that the portal has no Wiki link or Help button.
  4. Turn both back on.

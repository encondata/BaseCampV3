# Sirdar deploy phase 5 (Proxmox targets) — context and decisions

Spec: `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md`,
Section 6 "Proxmox targets", plus the parts it leans on: Section 2 (step 0,
failure handling, Roll back), Section 3 (secrets, `managed_records`-style
ownership), Section 4 (Settings credentials with Test, Delete environment
with the typed-name gate) and the phasing list ("5. Proxmox targets").
Phase 4 (DNS + proxy) is on branch `sirdar` and is the base for this phase.
Plans: `2026-10-04-sirdar-phase5a-backend.md` (API, pipeline, Terraform,
image) then `2026-10-04-sirdar-phase5b-ui.md` (web + live verify).

Jimmy's scope for phase 5:

- Terraform `bpg/proxmox` as step 0, building the Ubuntu VM before the SSH steps.
- VM snapshots before risky operations, and restoring from them.
- Destroy the VM when the environment is deleted.
- Proxmox is an option next to SSH targets.
- Hardware: a Supermicro D1518 (4 cores, 8 threads) with 64–96 GB, running
  Proxmox, with Ubuntu VMs. The existing uat VM (10.10.48.63) lives on that
  Proxmox host; it is the live-verify host. Jimmy enters the Proxmox API URL
  and token himself in Sirdar's Settings.

## What exists now (phases 2–4)

- Steps 1–17 (`deploy/steps.py`): 1–11 Ansible playbooks run by
  `deploy/runner.py` (`Runner` protocol, `FakeRunner` in tests); 12–14 and
  16–17 Python steps run by a `Publisher` (`publish.HttpPublisher`,
  `FakePublisher`); 15 `teardown.yml`. `StepDef.runs` is `"ansible"` or
  `"python"`. Step numbers are integers, unique within a deployment
  (`UNIQUE (deployment_id, number)`), and two steps may share a number when
  they never meet in one plan (9 `restore` / 9 `restore_dump`).
- `deployments` carries per-run flags that retries and `plan_of` reuse
  (`publish`, `snapshot_id`, `restore_dump`, `dump_path`, `previous_sha`).
- The environment's target is `environments.target_id`: `"ssh"` (installer)
  or `"ssh:<slug>"` (saved in `deploy-targets.env`). The pipeline, the routes
  and the Backups tab get its connection from `targets.ssh_config_for`.
  Branches and tags resolve to a commit with `git ls-remote` **on the target**
  (`gitref.resolve_ref`) before the deployment row exists.
- Host keys are trust-on-first-use in `ssh_known_hosts` (`known_hosts.trust`
  re-reads the live key and compares it with the fingerprint the user saw).
- `integrations` (migration 0006) holds Cloudflare and NPM credentials:
  non-secret `config` JSON plus a Fernet-encrypted `secret_enc`, write-only,
  with a Test button; `outbound.transports()` is the single switch every
  outbound `httpx` client reads, and an autouse conftest guard fails any real
  HTTP request.
- Sirdar has no SSH key of its own: every target logs in with its saved
  password or key file.
- The ServerSherpa repo `encondata/BaseCampV3` is **public** today, so a fresh
  VM clones it over https like any target (the spec's GitHub deploy-key
  credential stays a follow-up).
- Migrations: 0006 is the newest anywhere (every worktree checked on
  2026-10-04; the dev `sirdar` DB reports 0004). Phase 5 is **0007**.

## Decisions

The Proxmox credential: an integration kind, not a target type
- **`proxmox` is a third integration kind** in the existing `integrations`
  table, and an environment built on it has `target_id = "proxmox"`.
  Why: the integration store already gives exactly what the token needs
  (Fernet with `SIRDAR_SECRETS_KEY`, write-only secret, reuse only for the
  same URL, a Test button, audit of changed field names, the Settings card and
  modal). There is one Proxmox host (a cluster's API covers all its nodes
  anyway), so a list of saved Proxmox targets would be ceremony. A second
  host later becomes `proxmox:<slug>` without changing environments that use
  `proxmox`.
- Config fields: `url` (`https://host:8006`), `node`, `pool`, `storage`,
  `bridge`, optional `vlan_tag`, `template_vmid`, `tls_fingerprint`,
  `tls_cert_pem`, and `token_id` (the `user@realm!tokenid` part, shown so
  Jimmy can tell which token is stored). The secret is the whole token
  string `user@realm!tokenid=<uuid>`.
- The token is never in a response, log line, audit row, exception, `repr()`,
  Terraform file, Terraform output or stored step log: Terraform gets it only
  as the `PROXMOX_VE_API_TOKEN` environment variable of its own process, and
  every Proxmox step redacts both the whole token and its UUID part.
- Settings › Integrations removes Proxmox only when no environment uses it
  (409 `integration_in_use {environments}`): the VMs could not be destroyed
  without it.

TLS pinning (spec: "TLS fingerprint pinned trust-on-first-use")
- Save and Test fetch the server's certificate and answer 409 `tls_untrusted
  {fingerprint, subject, issuer, not_after, names}` until the request carries
  that fingerprint (the user clicked "Trust this certificate"); a different
  live certificate is 409 `tls_mismatch {expected, actual}`. Fingerprints are
  SHA-256, colon-separated uppercase hex (the format Proxmox's GUI shows).
- The pin is the certificate itself (`tls_cert_pem`), not only its hash:
  Python trusts it as the only anchor (`VERIFY_X509_PARTIAL_CHAIN`, hostname
  checked); Terraform gets it as `SSL_CERT_FILE` with `SSL_CERT_DIR` pointed
  at an empty folder, so Go trusts nothing else. The URL's host must be
  named in the certificate (Proxmox's own `pve-ssl.pem` names the node's IPs
  and hostname).
- Known risk for the live verify: Go accepts a leaf certificate that is
  itself in its root pool, which is what this relies on. If Terraform still
  refuses it, the fallback is to pin `pve-root-ca.pem` instead (a pasted PEM
  field); that is a follow-up, not phase 5 code.

The Terraform runner
- `deploy/terraform.py`: a `TerraformRunner` protocol (`run(TfRequest,
  on_output) -> TfResult`), the real `SubprocessTerraform`, and pure helpers
  (`render_config` → `main.tf.json`, `prepare_workdir`, `run_env`).
  `pipeline.make_terraform(settings)` builds it; tests replace that, like
  `make_runner`.
- One working folder per environment: `SIRDAR_TERRAFORM_DIR/<environment
  id>/` (default `/app/terraform`, mounted from `sirdar/terraform`, owned by
  uid 10001, mode 700, created by the installer, never served). It holds
  `main.tf.json`, the pinned `proxmox-ca.pem`, the state and `.terraform/`.
  The folder is keyed by id, not name, so a re-created environment of the
  same name never inherits a stale state. Destroy removes it.
- Terraform runs with an allowlisted environment (PATH, LANG, TZ, HOME = the
  folder's `home/`, `TF_CLI_CONFIG_FILE`, `TF_IN_AUTOMATION`, `TF_INPUT=0`,
  `CHECKPOINT_DISABLE`, `SSL_CERT_FILE`, `SSL_CERT_DIR`,
  `PROXMOX_VE_API_TOKEN`) and never sees `SIRDAR_*`. Cancel sends SIGINT
  (Terraform's graceful stop) and kills after 30 s.
- The image installs Terraform **1.16.5** and the `bpg/proxmox` provider
  **0.115.0** (both the newest on 2026-10-04), each checked against its
  published SHA-256 for amd64 and arm64, with the provider in a filesystem
  mirror so `terraform init` never goes online. A test fails when the
  Dockerfile's versions and `terraform.py`'s constants disagree.
- Tests never run a real Terraform: an autouse guard replaces the one
  function that starts the binary (`terraform._spawn`) and fails the test for
  anything but a `fake-*` script; pipeline and provisioner tests use
  `FakeTerraform`. A second autouse guard does the same for the raw TLS
  certificate fetch (`tls_pin._read_certificate`, only 127.0.0.1 allowed) and
  for the provisioner's TCP probe.

Steps and plans
- Step **0 `provision` "Prepare VM"** (runs `"vm"`, in Sirdar): reserve a VM id
  and record it before anything is created, `terraform apply` (create, or
  apply a changed size), wait for the guest agent's address, pin the SSH host
  key, point every service at the VM's address, resolve the git ref on the
  VM when the deployment has no commit yet, then take the VM snapshot when
  asked. Prepended to update, reset, restore_dump and rollback for a Proxmox
  environment. Snapshot jobs and publish jobs don't get it.
- Step **0 `vm_restore` "Restore VM snapshot"** (runs `"vm"`): its own mode,
  `vm_restore`, a plan of that step alone. Shares number 0 with `provision`
  (they never meet).
- Step **15 `destroy` "Destroy VM"** (runs `"vm"`) replaces 15 `teardown` in a
  Proxmox environment's Delete plan: `destroy`, `unproxy`, `undns`. The host
  goes first, as in phase 4. Shares number 15 with `teardown`.
- `deployments.vm` (boolean, like `publish`) says whether the plan has the VM
  steps, so retries and `plan_of` agree. Retry from step 0 is allowed
  (`from_step` ≥ 0; the route's `body.from_step or stopped` becomes an
  explicit None check, since 0 is falsy).

The VM
- Built by Terraform from the template: full clone into the pool as
  `ss-<env>`, tags `sirdar` and `ss-<env>`, CPU type `host`, VirtIO SCSI
  single, disk `scsi0` with discard, iothread and SSD on, `virtio` NIC on the
  bridge (VLAN tag when set), `on_boot` and `started` true, guest agent on,
  `stop_on_destroy` and `purge_on_destroy` true. cloud-init: user `deploy`
  with Sirdar's public key for this VM, and a static IPv4/CIDR + gateway or
  DHCP. The hostname is the VM name (Proxmox's cloud-init default).
- Sirdar generates **one ed25519 key pair per Proxmox environment** at create
  time (private half Fernet-encrypted in `proxmox_vms`). Ubuntu's cloud image
  gives the cloud-init user passwordless sudo, so the VM's `RunTarget` has no
  become password.
- Sizing defaults: 4 vCPU, 8 GB, 64 GB (limits 1–64 vCPU, 2–256 GB RAM,
  20–4096 GB disk). A size change applies on the next deploy's step 0
  (Terraform; Proxmox reboots when it must, and that shows in the log). A
  disk never shrinks (422 `vm_disk_shrink`). The network (static address or
  DHCP) is fixed at creation.
- **Host key: read through the guest agent, then checked live — no prompt.**
  Step 0 reads `/etc/ssh/ssh_host_ed25519_key.pub` with the agent's
  `file-read` over the pinned, token-authenticated Proxmox API, then calls
  `known_hosts.trust(ip, 22, that fingerprint)`, which re-reads the live key
  and refuses a mismatch. That is a stronger anchor than TOFU and needs no
  click mid-pipeline. When the agent later reports a different key (the VM was
  rebuilt or restored), step 0 re-pins it (audited with the previous
  fingerprint). Step 0 never pins an address that a saved SSH target uses.
- An address is refused at create (409 `ip_in_use`) when it is the proxy IP,
  a saved SSH target's host, another environment's service address or another
  VM's address; step 0 also refuses to create a VM whose static address
  already answers on port 22. That keeps 10.10.48.63 (uat) out of reach.
- Every service of a Proxmox environment points at the VM: the service
  addresses are managed (PATCH `host_ip` → 422 `host_ip_managed`), set to
  the static address at create (`0.0.0.0` for DHCP until step 0 reads it), and
  updated by step 0 whenever the VM's address changes.
- A branch or tag resolves on the VM in step 0 (the VM may not exist when
  Deploy is clicked), so a Proxmox deployment starts with `sha = ""` unless
  the ref is a full SHA; the Deploy route only checks the ref's shape.

Ownership (Sirdar manages only VMs it created)
- `proxmox_vms` (migration 0007) is the ownership record: one row per Proxmox
  environment, created with the environment, holding the reserved VM id, the
  name `ss-<env>`, sizing, network, the address, the key pair, `keep_snapshots`
  and `created`. The VM id is reserved (`/cluster/nextid`) and committed before
  `terraform apply`, so a half-finished create is still Sirdar's.
- There is no way to attach an existing VM: adopting with `target =
  "proxmox"` is 422 `adopt_not_allowed`. The adopted uat VM stays an SSH target.
- Destroy checks that VM `<vmid>` is still named `ss-<env>` and tagged
  `sirdar` before `terraform destroy`, refuses when Terraform's state is
  missing, and checks afterwards that the VM is gone. Anything else: the step
  fails, changing nothing.

VM snapshots (minimal and safe)
- Taken in step 0 (before step 1, so before every change on the VM) when the
  deployment asks: `take_vm_snapshot` on Update, Reset, Restore backup and Roll
  back; **default on** once the environment has been deployed (a VM that never
  ran a deploy has nothing to keep). Disk-only (`vmstate=0`; Proxmox freezes
  the file systems through the guest agent). Named `sirdar-YYYYMMDDTHHMMSSZ`
  (UTC), recorded in `deployments.vm_snapshot`; a retry keeps the first
  attempt's snapshot ("Keeping the VM snapshot from the first attempt").
- Kept: the newest `keep_snapshots` (default 3) of the snapshots Sirdar
  recorded for that environment; older ones Sirdar took are deleted after each
  new one. Snapshots taken by hand in Proxmox are never touched.
- **Restore VM snapshot** = mode `vm_restore` (`deploy:change` + typed name),
  offered on the Backups tab's "VM snapshots" list and in a failed
  deployment's Roll back panel. It rolls the VM back, starts it, waits for
  the agent and SSH, re-checks the host key, and sets the environment's
  commit to the one the snapshot holds (the taking deployment's
  `previous_sha`). Like a backup, a VM snapshot taken before a snapshot
  restore changed the sign-in keys is not restorable (409
  `vm_snapshot_keys_changed`).
- Delete takes no snapshot: Proxmox destroys a VM's snapshots with it. The
  typed-name gate is the protection.

Permissions (spec: unchanged levels)
- `deploy:add`: create a Proxmox environment, Update (with or without a VM
  snapshot). `deploy:change`: Proxmox credentials, PATCH sizing, Reset,
  Restore backup, Roll back, Restore VM snapshot, Delete (destroy).
  `deploy:view`: the VM card and the VM snapshot list.

Migration 0007 (`down_revision = "0006"`)
- `integrations.kind` may be `proxmox`; new table `proxmox_vms`;
  `deployments.vm`, `deployments.take_vm_snapshot`, `deployments.vm_snapshot`;
  mode `vm_restore`. Downgrade drops them and the `vm_restore` deployments and
  VM steps; environments with `target_id = 'proxmox'` are left (they become
  undeployable), since dropping them would orphan their VMs.

Out of phase 5
- "Prepare template" (Sirdar downloading the Ubuntu cloud image and building
  the template): the README gives the one-time commands; Test checks the
  template. "Fresh box" is what any new Proxmox environment already is.
- Importing a VM Sirdar didn't create; several Proxmox hosts; a Take VM
  snapshot button outside a deployment; cloud providers.

## Open questions for Jimmy

1. **Template preparation.** Default: Jimmy builds the Ubuntu 24.04 template
   once by hand with the README's commands (cloud image + `qemu-guest-agent`
   via `virt-customize`, template id 9000, in the pool); Sirdar checks it in
   Test. Alternative: a "Prepare template" button (needs the token to download
   images and, for the agent package, more than the API offers).
2. **VM snapshot default.** Default: on for every Update, Reset, Restore
   backup and Roll back of a deployed Proxmox environment, newest 3 kept.
   Alternative: on only for Reset, Restore backup and Roll back.
3. **Delete environment destroys the VM outright** (and its VM snapshots).
   Default: yes. Alternative: stop it and keep it for a grace period.
4. **Network default in New environment.** Default: Static (the NPM proxy
   hosts forward to an address, and a DHCP lease can move). Alternative: DHCP
   first, with a reservation set in the router.
5. **Sizing defaults.** Default: 4 vCPU, 8 GB RAM, 64 GB disk per environment
   (fits several on the D1518 with 64–96 GB). Alternative: Jimmy's numbers.
6. **A changed host key reported by the guest agent.** Default: step 0 re-pins
   it automatically (the agent channel is authenticated and pinned; the audit
   row keeps the previous fingerprint). Alternative: stop and ask, like an
   SSH target.

## Constraints carried from phases 2–4 (binding)

All earlier global constraints still apply: secrets never in responses / logs
/ audit / exceptions; unsafe extravars; allowlisted runner env; pinned host
keys; Sirdar changes only what it records it made; American English; modal
header pattern + content-sized modals; DataTable / ComboBox / segmented
idioms; `.pf-form .field-label` for non-label captions; modal-body sections in
a `.pf-form` grid need `grid-column: 1 / -1`; display copy "Canceled"; web
tests `// @vitest-environment jsdom`; API tests `SIRDAR_TEST_DB=<name>
.venv/bin/pytest -q` from `sirdar/api`, never the dev `sirdar` DB; no `npm
install` in worktrees; tests never call real Cloudflare, NPM, Proxmox or
Terraform.

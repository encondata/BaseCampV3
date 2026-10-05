# Sirdar deploy phase 6 (VMware ESXi targets): context and decisions

Spec: `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md`,
Section 6 ("Proxmox targets"), read with "Proxmox" replaced by "the VM host".
The design questions it answers for Proxmox (step 0, VM snapshots, Destroy VM,
ownership, address safety, TLS pinning) are answered again here for ESXi.
Phase 5 (Proxmox) is merged to main (b028efdb) and is the base. Its
decisions in `2026-10-04-sirdar-phase5-context.md` still bind, except where
this file says otherwise.
Plans: `2026-10-05-sirdar-phase6a-backend.md` (API, pipeline, image) then
`2026-10-05-sirdar-phase6b-ui.md` (web and the live verify).

## Why phase 6

Jimmy does **not** use Proxmox. He couldn't install it reliably, so phase 5
works but sits unused. His hypervisor is **VMware ESXi 7**:

- It is **standalone**: there is no vCenter, and he won't upgrade past 7.
- It is **licensed** (paid), so the vSphere API can make changes. Free ESXi
  is read-only through the API.

Phase 6 makes ESXi a VM host next to Proxmox. It reuses every safety rule
phase 5 built.

## What exists now (phase 5, merged)

- `integrations` has the kinds `cloudflare`, `npm` and `proxmox`. The Proxmox
  token is Fernet-encrypted and write-only. Test and Save use
  trust-on-first-use TLS pinning: the API answers 409 `tls_untrusted
  {fingerprint, subject, issuer, not_after, names}` until the request names
  the fingerprint. `tls_pin.pinned_context(pem)` trusts exactly one
  certificate and checks the host name.
- `proxmox_vms` (migration 0007) is the ownership record for each VM: the
  reserved `vmid`, the name `ss-<env>`, frozen clone inputs, sizing, network,
  address, a per-environment ed25519 key pair, `keep_snapshots` and
  `created`. Downgrade raises an error while the table has rows.
- `deploy/vms.py` holds the sizing and network checks, `address_in_use`, and
  `host_config`. `address_in_use` refuses every saved or installer SSH target
  (with names resolved), the Proxmox host, every proxy IP, other services and
  other VMs. It runs under a `pg_advisory_xact_lock`.
- `deploy/provision.py` holds `ProxmoxProvisioner`, which runs three `"vm"`
  steps:
  - **0 `provision` "Prepare VM"**: reserve the VM id, `terraform apply`,
    read the address from the guest agent, read the host key through the
    agent, pin it with `known_hosts.trust` (which re-reads the live key), and
    record the address under the lock. It snapshots before changes.
  - **0 `vm_restore` "Restore VM snapshot"**.
  - **15 `destroy` "Destroy VM"**: checks id, name and the `sirdar` tag
    before destroying, and checks after that the VM is gone.
- The pipeline:
  - `deployments.vm`, `take_vm_snapshot` and `vm_snapshot` drive the VM
    steps.
  - `plan_for(vm=True)` prepends step 0 to update, reset, restore_dump and
    rollback.
  - Teardown runs 15 `destroy`, then 16 and 17.
  - The SSH host is prepared after step 0.
- The routes:
  - `target = "proxmox"`.
  - `GET /environments/{name}/vm-snapshots`.
  - Mode `vm_restore`.
  - `take_vm_snapshot`.
  - PATCH `vm`.
  - Error codes `not_proxmox`, `vm_not_ready` and `vm_key_unreadable`.
- The UI:
  - the Proxmox card and modal under Settings › Integrations, with the
    certificate prompt;
  - the Machine step in New environment;
  - the Machine card on Overview, the Machine section in Settings and the
    Delete copy;
  - the VM snapshot choice in Deploy;
  - VM snapshots on the Backups tab, with Restore VM snapshot.
- Tests:
  - `FakeProxmox` (an httpx MockTransport) and `FakeTerraform`.
  - The autouse `no_real_http` and `no_real_hosts` guards, which cover
    `tls_pin._read_certificate`, `terraform._spawn` and `provision.tcp_open`.
  - The tests' own SSH server plays the VM at 127.0.0.1.
- Ledger follow-ups from phase 5 that ESXi must not repeat:
  - a partly built VM hidden from Sirdar becomes an orphan;
  - a snapshot is left unrecorded when waiting on its task fails.

## Decisions

### ESXi beside Proxmox, sharing one VM-host layer (not one generalized table)

- **ESXi is added alongside Proxmox.** It gets its own integration kind
  `esxi`, its own ownership table `esxi_vms`, its own client
  `deploy/esxi.py` and its own provisioner `deploy/esxi_provision.py`.
  Everything that doesn't depend on the hypervisor moves into one shared
  layer, which both kinds use:
  - `deploy/vmcommon.py`:
    - the address re-check and record under the advisory lock;
    - the "never pin a saved SSH target's address" rule;
    - the pin-and-confirm loop;
    - the VM snapshot record, the prune rule and the "only Sirdar-recorded
      snapshots" rule;
    - ref resolution on the VM;
    - `VmOutcome`, `VmPrepareError` and the `Provisioner` protocol.
  - `deploy/vmsteps.py` dispatches `prepare` and `run` by the environment's
    target.
  - `targets.VM_TARGETS = ("proxmox", "esxi")`, with the environment's
    `target_id` equal to its integration kind.
  - Kind-aware `vms.get_for`, `host_config`, `address_in_use` and `public`.
- Why not one generalized `vm_hosts` table:
  - The identity columns differ. Proxmox has an integer `vmid` it reserves
    first and reuses, plus the Terraform state folder. ESXi has a managed
    object id and an `instanceUuid` that ESXi assigns at create, a VM folder
    path, and a seed disk.
  - So do the constraints (`UNIQUE vmid` 100–999999999 against
    `UNIQUE instance_uuid`).
  - `proxmox_vms` already ships, with a downgrade guard and about 1,270
    green tests.
  - Merging the tables would rewrite a working migration and every Proxmox
    test for a host Jimmy won't run, and it would buy nothing the shared
    Python layer doesn't already give.
  - The deployment columns (`vm`, `take_vm_snapshot`, `vm_snapshot`), the
    steps, the plans and the routes are already hypervisor-neutral, so both
    kinds share them unchanged.
- Step keys and names stay as they are: 0 `provision` "Prepare VM",
  0 `vm_restore` "Restore VM snapshot", 15 `destroy` "Destroy VM".
  `steps.py` doesn't change, except for one copy string.
- An environment on ESXi has `target_id = "esxi"`. `GET /targets` lists
  `{id: "esxi", label: "VMware ESXi", kind: "esxi"}` once the integration is
  saved. `target_kind` is `"ssh" | "proxmox" | "esxi"`.
- Routes and codes that said Proxmox now cover both kinds:
  - `not_proxmox` becomes **`not_vm_environment`**;
  - `integration_not_configured {kinds: [env.target_id]}`;
  - `target_kind_locked` also blocks moving between Proxmox and ESXi;
  - `adopt_not_allowed` covers both.

### The ESXi client: pyVmomi, not govc

- **pyVmomi** (VMware's Python SDK for the vSphere SOAP API) behind one
  injectable seam: the `esxi.connect(cfg)` async context manager, which
  yields an `EsxiApi`. The real `PyvmomiEsxi` runs each blocking SOAP call on
  a single-thread executor for its session. Tests replace `esxi.connect`
  with `FakeEsxi.connect`. An autouse guard replaces `esxi._smart_connect`,
  the one function that opens a real session, and fails the test.
- Why not govc:
  - Terraform's vsphere provider can't clone on standalone ESXi, and govc
    would be a second Go binary to pin, a subprocess to drive and a JSON
    output to parse.
  - The ESXi password would have to reach govc through its environment
    (`GOVC_PASSWORD`). With pyVmomi it stays inside Sirdar's process.
  - TLS pinning uses the same `tls_pin.pinned_context` as Proxmox, with no
    new mechanism.
  - Every operation Sirdar needs exists on standalone ESXi with a paid
    license, as single API calls: `CreateVM_Task`, `CopyVirtualDisk_Task`,
    `ReconfigVM_Task`, snapshots, power and `Destroy_Task`.
  - Faults are typed objects (`vim.fault.InvalidLogin` and others), so
    mapping them to our own copy is a pure function that tests can cover
    with real pyVmomi fault objects built offline.
  - The fake is a Python object that implements the same protocol, so no
    fake binaries are needed.
- **Version: pyVmomi 8.0.3.0.1**, not the newest (9.1.1.0). pyVmomi
  supports the previous four vSphere releases. 8.0.3 (vSphere 8.0 U3) still
  covers 7.0 U3; 9.x does not promise to. The sdist (pure Python) needs
  `six`.
- **Pinned with SHA-256 checksums**, the way phase 5 pinned Terraform:
  - `sirdar/api/requirements-esxi.txt` lists
    `pyvmomi==8.0.3.0.1 --hash=sha256:db795c960159cfa3c81e6af4cf1f46618e61cf0349db1666de75df98a4f29c69`
    and `six==1.17.0` with both of its published hashes (wheel
    `4721f391…3274`, sdist `ff70335d…2a81`).
  - The image installs that file with `pip install --require-hashes
    --no-deps` before `pip install .`.
  - `pyproject.toml` pins the same `pyvmomi==8.0.3.0.1`.
  - A test fails when the two files disagree.

### TLS pinning for ESXi (spec: "TLS fingerprint pinned trust-on-first-use")

- Same flow and codes as Proxmox: 409 `tls_untrusted {…}` until the request
  names the fingerprint, then 409 `tls_mismatch {expected, actual}`. The pin
  is the certificate itself (`tls_cert_pem` in the config). The trust prompt
  in the UI is shared.
- **The host name is not checked for ESXi**
  (`pinned_context(pem, check_hostname=False)`):
  - ESXi's default certificate usually names only its host name (often
    `localhost.localdomain`), while Jimmy reaches it by IP.
  - The only trust anchor is that exact certificate, so a host-name check
    adds nothing.
- On top of that, pyVmomi is given the pinned SHA-256 fingerprint as its
  `thumbprint`, which it compares with the leaf's DER bytes before the
  login is sent. That makes two exact checks. Task 3 checks how the
  installed pyVmomi expects the thumbprint written.

### Credentials: the `esxi` integration

- Config fields:

  | Field | Example | Notes |
  |---|---|---|
  | `url` | `https://10.10.48.10` | port optional, 443 by default |
  | `user` | `sirdar` | shown on the card |
  | `datastore` | `datastore1` | |
  | `network` | `VM Network` | a standard port group |
  | `resource_pool` | `sirdar` | optional; empty means the host's root pool |
  | `source_vm` | `sirdar-ubuntu-2404-seed` | the seed VM |
  | `dns_servers` | `["10.10.48.1"]` | up to 3; empty means the VM's gateway |
  | `tls_fingerprint` | | |
  | `tls_cert_pem` | | stored, never returned |

- There is no folder field: standalone ESXi has one VM folder.
- The secret is the **password**, which is write-only. It is reused only for
  the same `url` and `user` (otherwise 422 `secret_required {reason}`).
- Settings › Integrations removes ESXi only when no environment uses it
  (409 `integration_in_use`).
- The password never appears in a response, log, audit row, exception,
  `repr()`, stored step log, or argv/env of any process. Every ESXi step
  redacts it.
- The README tells Jimmy to make a dedicated local ESXi user `sirdar` with
  the Administrator role on the host. Standalone ESXi can't scope a user to
  some VMs, so Sirdar's ownership checks are what protect the other VMs.

### Building a VM on standalone ESXi

- **Source: a seed VM, prepared once by hand.** Jimmy imports Canonical's
  `noble-server-cloudimg-amd64.ova` in the ESXi Host Client as
  `sirdar-ubuntu-2404-seed` and never powers it on. Test checks it:
  - it exists;
  - it is powered off;
  - it has exactly one disk;
  - it has no snapshots.
- **Create (step 0, first run):**
  1. `CreateVM_Task` makes an empty VM `ss-<env>` on the datastore and
     records `moref`, `instance_uuid` and `vm_path` at once. The VM has:
     - guest `ubuntu64Guest`;
     - a ParaVirtual SCSI controller;
     - a vmxnet3 NIC on the port group;
     - the extraConfig keys `sirdar.environment = <env id>`,
       `disk.EnableUUID = TRUE` and the cloud-init guestinfo keys;
     - the annotation `sirdar:<env id>` plus a sentence.
  2. `CopyVirtualDisk_Task` copies the seed's disk into the VM's own folder
     as `<name>-disk0.vmdk` (thin).
  3. A reconfigure attaches the disk; a second one grows it to `disk_gb`.
  4. Power on.
- **The order makes every half-finished create recoverable:**
  - The marker is written atomically with the VM. So a VM named `ss-<env>`
    that carries this environment's id is Sirdar's even if the record was
    lost (the phase 5 orphan follow-up). A retry adopts it; Destroy removes
    it.
  - The copied disk lives in the VM's own folder. A half-copied disk is
    deleted only at that exact path, and only when it isn't attached.
- Known risk for the live verify: `CopyVirtualDisk_Task` is expected to
  work directly on ESXi with a paid license (the Host Client copies VMDKs the
  same way). If it is refused, the fallback is `FileManager.CopyDatastoreFile_Task`
  on the descriptor. That would be a follow-up, not phase 6 code.
- **cloud-init via guestinfo** (VMware's datasource), base64-encoded:
  - `guestinfo.metadata`: `instance-id: sirdar-<env id>`,
    `local-hostname: ss-<env>`, and a netplan v2 network that matches the
    `vmxnet3` driver. The network is static (address, default route, DNS)
    or DHCP.
  - `guestinfo.userdata`:
    - the user `deploy` with Sirdar's public key and passwordless sudo,
      with password login off;
    - `ssh_deletekeys: true` and `ssh_genkeytypes: []`;
    - `ssh_keys` holding the **host key Sirdar generated**;
    - growpart on `/`.
- **Host key pinning: Sirdar generates the VM's SSH host key.** This is
  stronger than TOFU, and stronger than phase 5's read-back:
  - Sirdar makes an ed25519 host key pair per ESXi environment at create
    time.
  - The public half is stored in `esxi_vms.host_key_public`. The private
    half is stored Fernet-encrypted in `host_key_private_enc` only until it
    is delivered.
  - Step 0 then calls `known_hosts.trust(ip, 22, <that fingerprint>)`, which
    re-reads the live key and refuses a mismatch.
  - So the fingerprint is known before the VM first boots. No guest
    operations (which need guest credentials) and no guest-published
    guestinfo (whose visibility through the API on ESXi 7 isn't documented)
    are needed.
  - Once SSH answers with that key, step 0 **scrubs** the user-data
    (`guestinfo.userdata` is set to "", which deletes the key) and clears
    `host_key_private_enc`. From then on the private host key exists only on
    the VM's disk.
  - Metadata stays, so later boots keep the same instance id and cloud-init
    doesn't run again.
  - The key never changes, even after a VM snapshot restore, so Restore
    needs no re-pin.
- **Address:** VMware Tools reports it (`guest.net`, virtual NICs only,
  IPv4, not link-local). The Ubuntu cloud image ships open-vm-tools. A
  static address must be the one reported. DHCP takes the first one.
- **Sizing:**
  - Defaults and limits as in phase 5: 4 vCPU, 8 GB, 64 GB disk.
  - Changing vCPU or memory needs the VM off. Step 0 shuts the guest down
    (VMware Tools), waits up to 5 minutes, reconfigures, then powers it on.
    If the guest doesn't stop, the step fails and changes nothing (no hard
    power-off).
  - A disk never shrinks.
  - **ESXi can't grow a disk that has snapshots.** So a disk grow first
    deletes this environment's Sirdar-recorded VM snapshots, then grows the
    disk, then takes the new snapshot. A snapshot Sirdar didn't take makes
    the step fail with its name, changing nothing. The Settings Machine
    section says so when the disk grows.
- **Network** (static or DHCP) is fixed at create, as in phase 5.

### Ownership: Sirdar manages only VMs it created

- `esxi_vms` (migration **0008**) is the record. Identity is checked before
  any change by three things together:
  - **`instance_uuid`** (found with `SearchIndex.FindByUuid`), which is
    unique on the host;
  - the **name** `ss-<env>`;
  - the extraConfig **marker** `sirdar.environment == <env id>`.
- The marker lives in extraConfig because the annotation (Notes) can be
  edited in the Host Client and is shown only for people. A guest can't
  read or change a key that doesn't start with `guestinfo.`.
- A mismatch fails the step and changes nothing.
- A created VM that has disappeared is never rebuilt silently. A VM that was
  recorded but never finished and is now gone is created again.
- No route attaches an existing VM: adopt with `target = "esxi"` is 422
  `adopt_not_allowed`.
- **Destroy VM** checks the three things:
  - It finds the VM by name with the marker when the record was lost.
  - It powers the VM off, then runs `Destroy_Task` (which removes its files
    and snapshots).
  - It checks that `FindByUuid` finds nothing afterwards.
  - It forgets the VM's pinned host key.
  - A VM with the right name but no marker, or with the marker under
    another uuid, is refused.

### Address safety (unchanged rules, now over both tables)

- These are refused, at create (409 `ip_in_use`) and again in step 0 under
  the advisory lock before anything is written:
  - every saved or installer SSH target's host (with names resolved);
  - both VM hosts' own addresses (the Proxmox URL host and the ESXi URL
    host);
  - every proxy IP;
  - other environments' service addresses;
  - every address in `proxmox_vms` and `esxi_vms`.
- Step 0 refuses to create a VM whose static address already answers on
  port 22.
- It never pins a saved SSH target's address.
- It forgets a pin it made when the locked re-check fails.

### VM snapshots (the phase 5 rules, applied to ESXi)

- Disk only (`memory=False`), quiesced through VMware Tools. If quiescing
  fails, step 0 takes a crash-consistent snapshot and logs that it did.
- Named `sirdar-YYYYMMDDTHHMMSSZ` (UTC).
- **The name is recorded on the deployment before the snapshot task runs**,
  and cleared when the task fails. A retry checks that a kept snapshot
  still exists before keeping it (this fixes the phase 5 follow-up).
- Default on for Update, Reset, Restore backup and Roll back once the
  environment has been deployed. The newest `keep_snapshots` (default 3) of
  Sirdar's recorded snapshots are kept. Snapshots taken by hand are never
  touched. A snapshot name that appears twice is refused for restore.
- Restore VM snapshot: revert (the VM comes back powered off), power on,
  wait for Tools and SSH, confirm the pinned key, and record the address.
  The commit and keys-changed rules are as in phase 5.
- If the revert brought back older vCPU or memory sizes, the next step 0
  applies the recorded sizes again.

### Permissions (unchanged levels)

- `deploy:add`: create an ESXi environment, Update.
- `deploy:change`: the ESXi credentials, PATCH sizing, Reset, Restore
  backup, Roll back, Restore VM snapshot, Delete.
- `deploy:view`: the Machine card and the VM snapshot list.

### Migration 0008 (`down_revision = "0007"`)

- `integrations.kind` may be `esxi`. Adds the table `esxi_vms`.
- Downgrade raises an error while `esxi_vms` has rows. Once it is empty,
  downgrade drops the table and the `esxi` integration.
  Environments on target `esxi` are left (as for Proxmox).
- On 2026-10-05, 0007 was the newest in every worktree and on every branch,
  and the dev `sirdar` DB reported 0004. Task 1 checks again before writing
  the migration.

### UI

- Settings › Integrations:
  - **ESXi is a main card** next to Cloudflare and NPM.
  - **Proxmox moves into a collapsed "Other hosts" area.** When it is set
    up, it shows its full card there. When it isn't, there is a one-line
    "Proxmox · Not set up" row with Set up.
  - The certificate prompt becomes one shared component, used by both
    modals.
- The Deploy page shows an ESXi target card ("ESXi") once it is set up.
- New environment: ESXi is a target with the same Machine step; the copy
  names ESXi and the seed VM.
- Environment pages are hypervisor-neutral:
  - the Overview Machine card ("Host" row);
  - the Settings Machine section, with the ESXi disk-grow warning;
  - the Delete copy;
  - the Deploy modal copy;
  - VM snapshots on Backups and Restore VM snapshot.
- Power operations are internal to steps 0 and 15. There are no power
  buttons (see question 5).
- Conventions:
  - the report-generate modal header, sized to its content;
  - `.pf-form` sections with `grid-column: 1/-1` (`sirdar-span2`);
  - ComboBox and segmented controls, no raw `<select>`;
  - American English;
  - `// @vitest-environment jsdom`;
  - never `npm install`.

### Live verify (the last controller task in 6b)

- Jimmy enters the ESXi credentials himself.
- Build a throwaway environment `uat3` on ESXi, deploy it, take and restore
  a VM snapshot, then delete it and confirm in the Host Client that the VM
  is gone.
- **Where uat runs:** the uat VM (10.10.48.63, a saved SSH target on Tower)
  was described in phase 5 as a Proxmox VM, but Jimmy doesn't use Proxmox.
  The live verify first asks Jimmy which host runs it. If it is on this ESXi
  host, it records the VM's name and checks in the Host Client that the VM
  has no `sirdar.environment` key. Sirdar's address checks already refuse
  10.10.48.63, because it is a saved SSH target.
- Never touch any VM Sirdar didn't create.

### Out of phase 6

- A "Prepare seed" button (Sirdar downloading and importing the OVA).
- vCenter.
- Several ESXi hosts. A second host would later become `esxi:<slug>`
  without changing environments that use `esxi`.
- Importing existing VMs.
- Power buttons.
- Distributed switches (they need vCenter).
- Removing Proxmox code.

## Open questions for Jimmy

1. **Seed preparation.** Default: Jimmy imports Canonical's Ubuntu 24.04
   cloud image OVA once in the Host Client as `sirdar-ubuntu-2404-seed` and
   never powers it on (README steps); Test checks it. Alternative: a
   "Prepare seed" button that downloads, checks and imports the OVA from
   Sirdar.
2. **A disk grow deletes Sirdar's VM snapshots first** (ESXi can't grow a
   disk that has snapshots). Default: yes, with a warning in Settings, and a
   new snapshot is taken after the grow. Alternative: refuse the grow until
   he deletes them himself.
3. **Resizing vCPU, memory or disk shuts the VM down.** Default: a graceful
   guest shutdown, waiting up to 5 minutes; if the guest doesn't stop, the
   step fails and changes nothing. Alternative: a hard power-off after the
   wait (the VM snapshot taken just before covers it).
4. **Proxmox stays in the code**, hidden in Settings under a collapsed
   "Other hosts" area. Default: keep it. Alternative: remove the Proxmox
   kind (code, Terraform in the image, migration 0007's table) in a later
   cleanup.
5. **Power buttons on the Machine card.** Default: none; only the deploy
   steps power the VM on or off. Alternative: Start and Shut down buttons
   (`deploy:change`).
6. **Sizing defaults on his ESXi host.** Default: 4 vCPU, 8 GB RAM, 64 GB
   disk, a static address. Alternative: his numbers.

## Constraints carried from phases 2–5 (binding)

- Secrets never appear in responses, logs, audit rows or exceptions.
- Unsafe extravars.
- An allowlisted runner environment.
- Pinned host keys and pinned TLS certificates.
- Sirdar changes only what it records it made.
- American English.
- The modal header pattern and content-sized modals.
- The DataTable, ComboBox and segmented idioms.
- `.pf-form .field-label` for captions that aren't labels.
- Modal-body sections inside a `.pf-form` grid need `grid-column: 1 / -1`.
- Display copy "Canceled".
- Web tests start with `// @vitest-environment jsdom`.
- API tests run as `SIRDAR_TEST_DB=<name> .venv/bin/pytest -q` from
  `sirdar/api`, never against the dev `sirdar` DB.
- No `npm install` in worktrees.
- Tests never call real Cloudflare, NPM, Proxmox, Terraform or ESXi.
- Other agents commit in the same worktree: `git add <paths>` only, never
  `git stash`, and retry when `index.lock` is busy.

# Sirdar

## What Sirdar is

Sirdar is a standalone app for building, installing, and managing
ServerSherpa environments (portal, kiosk, wiki, API, database). It is one
central instance that manages many environments. This first piece is the
groundwork only: a Dockerized web app with its own database, sign-in for
portal users ranked admin or higher, and the portal's permission model.

## Local development

1. Start Sirdar's database: `docker compose -f docker-compose.dev.yml up -d sirdar-db`
2. Write the dev environment file: `sirdar/scripts/dev-env.sh`
3. Create the virtualenv and migrate:
   `cd sirdar/api && python3.13 -m venv .venv && .venv/bin/pip install -e '.[dev]' && .venv/bin/alembic upgrade head`
   Deploy runs also need sshpass for password-auth targets: brew install sshpass (ansible-playbook comes with the virtualenv).
4. Run the API (from `sirdar/api`):
   `.venv/bin/uvicorn --factory sirdar_api.api.app:create_app --port 8097 --reload`
5. Run the web app: `npm --prefix sirdar/web install && npm --prefix sirdar/web run dev`
   (http://localhost:5178)
6. Import eligible portal users: `sirdar/api/.venv/bin/sirdar import-users`

Ports: database 127.0.0.1:5434, API 8097, web 5178.

## Tests

- API (from `sirdar/api`): `.venv/bin/pytest -q`
- Deploy runner, end to end (opt-in; needs Docker and sshpass): SIRDAR_RUNNER_E2E=1 .venv/bin/pytest -q tests/test_runner_e2e.py
- Web: `npm --prefix sirdar/web test`
- Portal: `npm --prefix portal test`

## First sign-in

- `sirdar create-admin --email … --first-name … --last-name …` creates a local
  admin directly in Sirdar's database.
- `sirdar import-users` copies portal users who are eligible: they have a
  password, are not disabled or archived, and hold an active global role
  ranked admin (60) or higher. Their portal passwords and 2FA keep working.

## Deploy

One command downloads, installs and runs Sirdar (Docker + code):

```bash
curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/sirdar/install.sh | bash
```

Or, from a checkout: `bash sirdar/install.sh`. Re-run either one to update:
it pulls the branch, rebuilds, and restarts the stack. It never overwrites an
existing `sirdar/.env`.

**Install directory.** The default is `/opt/serversherpa/sirdar` on both Linux
and macOS. On a fresh interactive install the first prompt is
`Install directory [/opt/serversherpa/sirdar]:` (Enter accepts the default; the
answer must be an absolute path, and a leading `~/` is expanded). There is no
prompt when the default directory already exists (an existing install is just
updated), when `SIRDAR_DIR` is set, or when running non-interactively. To pick
a directory up front, including through the curl one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/sirdar/install.sh | SIRDAR_DIR=/srv/sirdar bash
```

The directory is the checkout root, so the app lives in `<dir>/sirdar/` and
its settings in `<dir>/sirdar/.env` (by default
`/opt/serversherpa/sirdar/sirdar/.env`). Creating it may need `sudo` (on macOS
too); the installer then hands the new directories to you.

Environment overrides:

| Variable | Default |
|---|---|
| `REPO_URL` | `https://github.com/encondata/BaseCampV3.git` |
| `SIRDAR_BRANCH` | `main` |
| `SIRDAR_DIR` | `/opt/serversherpa/sirdar` (Linux and macOS); setting it skips the directory prompt |
| `SIRDAR_PORT` | `8098` (used only when creating `.env`) |
| `SIRDAR_BIND` | `127.0.0.1` (used only when creating `.env`); the address the port is published on, default for the listen-address prompt |
| `SIRDAR_NONINTERACTIVE=1` | never prompt; generate every secret and print the admin commands |
| `SIRDAR_DOCKER_VERSION` | newest stable; Linux static installs only: the Docker Engine version to download (e.g. `29.8.2`) |
| `SIRDAR_FORCE_STATIC=1` | off; Linux static installs only: replace Docker binaries in `/usr/local/bin` that the installer didn't put there |

What it does:

- **Linux:** installs any missing `git`, `curl`, `openssl` and CA
  certificates, and Docker Engine with the compose (v2) and buildx plugins,
  the way the table under [Supported systems](#supported-systems) shows. If
  `docker info` already works, it installs nothing for Docker except missing
  compose/buildx plugins, and never starts a daemon. Otherwise it starts the
  daemon (now and at boot) and waits up to 60 s for it. It uses `sudo` only
  when not root, and stops if you are neither root nor have sudo. If Docker
  needs sudo, it adds you to the `docker` group (log out and back in for that
  to take effect; until then the `docker compose ...` admin commands it prints
  start with `sudo`). git must be 2.25 or newer (for sparse checkout). A
  Podman `docker` shim (podman-docker) isn't enough: the installer stops and
  asks for Docker Engine with the compose plugin.
- **macOS:** needs Docker Desktop already installed (it starts it if it isn't
  running) and git (`xcode-select --install`).
- **Other operating systems** (anything but Linux and macOS): stops with a
  message.
- Sparse-checks out `sirdar/` plus the portal files the SPA imports into
  `SIRDAR_DIR`, owned by you.
- **First run:** writes `sirdar/.env` (mode 600) from `.env.example`. With a
  terminal it asks for the port, listen address, cookie domain, public URL(s)
  for CORS, portal database URL, password
  pepper, 2FA key, JWT secret and database password; press Enter to accept
  the default or generate a secret. Without a terminal, or with
  `SIRDAR_NONINTERACTIVE=1`, it generates every secret. Prompts go to the terminal, not stdout, so
  `curl ... | bash > install.log` still shows them.
- **Later runs:** keeps your `.env`, and asks only for settings added since
  your install (`SIRDAR_BIND`, `SIRDAR_ALLOWED_ORIGINS`,
  `SIRDAR_PASSWORD_MIN_LENGTH`) that the file doesn't have yet; a line that is
  present, even blank, is never re-asked or rewritten. Answers are appended
  (mode 600, existing lines untouched). Without a terminal nothing is written
  and the installer lists which settings are using their defaults.
- Builds and starts the stack, waits for it to be healthy, and, when Sirdar
  has no users yet and a terminal is available, offers to create the first
  local admin (the first attempt plus up to 3 retries). It ends with the URL and the admin commands.

The app listens on 127.0.0.1:8098 by default; put a TLS reverse proxy in front.

### Listen address (`SIRDAR_BIND`)

The second first-install prompt, `Listen address`, sets `SIRDAR_BIND` in
`.env`: `127.0.0.1` (default) is this machine only, for a reverse proxy on the
same box; `0.0.0.0` publishes on every interface; or give a specific host IPv4.
Non-interactive installs use the `SIRDAR_BIND` environment variable, else
`127.0.0.1`. Existing installs without the line stay on `127.0.0.1`; add
`SIRDAR_BIND=0.0.0.0` to `.env` and re-run the installer to change it.

Example, an Unraid box at 10.10.48.14 with the reverse proxy elsewhere: bind
`0.0.0.0` and point the proxy at `http://10.10.48.14:8098`.

The app serves plain HTTP. The sign-in cookie is marked `Secure` (production)
and, when `SIRDAR_COOKIE_DOMAIN` is set, only works on that domain, so browsing
to `http://<ip>:<port>` directly will not keep you signed in. Use the proxy's
HTTPS hostname.

### Public URL for CORS (`SIRDAR_ALLOWED_ORIGINS`)

The fourth first-install prompt sets `SIRDAR_ALLOWED_ORIGINS`: the address
people use in the browser, e.g. `https://sirdar.example.com` (comma-separate
several; each is `http(s)://host[:port]`, no path, a trailing `/` is dropped).
Listed origins may call the API from the browser with credentials (allowed
headers: `Authorization`, `Content-Type`, `X-Totp-Challenge`). Blank, the
default, means same-origin only and sends no CORS headers; that is normal,
because the web app and API are served from the same origin. It is only needed
when another site calls the API. A bad value stops the API from starting.

### Minimum password length (`SIRDAR_PASSWORD_MIN_LENGTH`)

Minimum length for local passwords set with the CLI: 4 to 128, default 8 (the
portal's default). Asked about only when re-running the installer on a `.env`
that lacks it.

### Deployment targets (Deploy page)

Optional settings for the Deploy page (read-only cloud views and an SSH
connection test). The installer asks "Configure deployment targets now?" on a
first install, and once on a re-run when the `.env` has none of these keys;
answering no writes them blank. All are `SIRDAR_DEPLOY_*` keys in `.env`:

| Keys | Purpose |
|---|---|
| `DO_TOKEN`, `DO_REGION` | DigitalOcean read-only token; the region is optional (a default for the Deploy page's region list, which comes live from DigitalOcean) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | AWS read-only IAM user |
| `GCP_PROJECT_ID`, `GCP_CREDENTIALS_FILE`, `GCP_REGION` | Google Cloud project and service-account file name |
| `SSH_HOST`, `SSH_PORT` (22), `SSH_USER`, `SSH_PASSWORD`, `SSH_KEY_PATH`, `SSH_KEY_PASSPHRASE` | Custom SSH target |

The installer prompts for DigitalOcean and the SSH host (and for the key
passphrase, hidden, when you name a key file); edit `.env` for AWS and GCP.

**Saved SSH targets.** Custom (SSH) targets added on the Deploy page are saved
to `sirdar/config/deploy-targets.env` (git-ignored; the installer creates the
folder, mounted read-write at `/app/config`, and the app creates the file).
The format is plain `KEY=value` lines, one group per target. Passwords and key
passphrases are write-only: you can set, replace or clear them, but Sirdar
never shows them again. Back up `config/` together with `.env`. The container
runs as uid 10001, so the folder must be owned by it (the installer runs
`chown 10001:10001` and sets mode 700; the file is 600). The whole folder has to
be writable, not just the file: Sirdar saves by writing a temp file and a
`.lock` beside it and renaming over `deploy-targets.env`, which is why the
compose file mounts the folder and a single-file bind mount would break. You may
edit the file by hand; Sirdar re-reads it on each use.

**Key files.** Put private keys in `sirdar/deploy-keys/` (git-ignored; created
by the installer, mode 711) and give the bare file name in `SSH_KEY_PATH` or
`GCP_CREDENTIALS_FILE` (no `/` or `..`). The folder is mounted read-only at
`/app/deploy-keys`. The container runs as uid 10001, so that user must be able
to read the file:

    chmod 600 sirdar/deploy-keys/id_ed25519
    sudo chown 10001 sirdar/deploy-keys/id_ed25519

or, if you want to keep your own ownership, make it group-readable by a group
the container user is in (for example `chmod 640` plus a matching group id);
a world-readable key is not recommended. The installer warns when a named key
isn't readable by uid 10001. To keep keys elsewhere, set
`SIRDAR_DEPLOY_KEYS_DIR` to the host folder (relative to `docker-compose.yml`).

**Trusting a host (TOFU).** The first connection test to an SSH host shows its
host-key fingerprint and does not log in. Compare it with the server's real
fingerprint, then trust it on the Deploy page; later tests refuse a host whose
key has changed until you forget the old key and trust the new one. Secrets are
never shown or logged.

### Deploy pipeline (environments)

Sirdar deploys ServerSherpa environments (the five Compose stacks in
`deploy/stack`) to a saved Custom (SSH) target. This part is the API; the
web UI comes next.

**Secrets key.** `SIRDAR_SECRETS_KEY` (a Fernet key) encrypts every
environment's secrets in Sirdar's database. The installer generates it,
without a prompt, when `.env` has no such line. Back it up together with
`.env`: without it the stored secrets can't be read, and a different key
leaves existing environments undeployable. Blank means deploying is off
(`secrets_key_missing`).

**Runner folder.** Each step runs Ansible in a private folder under
`sirdar/runner/` (mounted at `/app/runner`, owned by uid 10001, mode 700).
A run's folder holds its secrets only while it runs and is deleted
afterwards. The installer creates the folder; by hand:
`mkdir -p sirdar/runner && sudo chown 10001:10001 sirdar/runner && sudo chmod 700 sirdar/runner`.

**Targets.** Ubuntu or Debian, with sudo and git. Sirdar logs in as the
target's saved SSH user. Root steps (installing Docker, creating
`/opt/serversherpa/<env>`) go through sudo with the saved SSH password, or
with the target's **sudo password** for key-only targets (write-only, like
the other target secrets). Trust the host key on the Deploy page first;
every run pins it. Code comes from `SIRDAR_DEPLOY_REPO_URL` (default
`https://github.com/encondata/BaseCampV3.git`); a branch or tag becomes a
commit through `git ls-remote` on the target.

**Steps.** 0 Prepare VM (Proxmox and ESXi environments) · 1 Preflight · 2 Bootstrap ·
3 Fetch code · 4 Render config · 5 Build images · 6 Pre-deploy dump (Update, a
seeded first deploy too) · 7 Reset data (Reset) · 8 Start data services ·
9 Restore snapshot or Restore backup · 10 Start services (migrate, then the
app) · 11 Take snapshot (a job of its own) · 12 DNS records · 13 Proxy hosts ·
14 Smoke test (when the environment publishes) · 15 Remove environment, or
Destroy VM on Proxmox or ESXi · 16 Remove proxy hosts · 17 Remove DNS records (Delete
environment). Restore VM snapshot (Proxmox or ESXi) is step 0 alone. The first
failure stops the deployment; retry re-runs from the failed step. One
deployment per environment at a time. Reset, Restore backup, Roll back,
Restore VM snapshot and Delete environment replace or remove data: they need
`deploy:change` and the environment's name typed back (`confirm_name`).

**Publishing (DNS + proxy).** With an environment's **Publish** switch on
(the default for new environments; off for adopted ones and for every
environment that existed before migration 0006), each deploy ends with
steps 12-14: a Cloudflare A record per public service
(`<service>.<base domain>` pointing at the public IP set in Settings, DNS
only unless the service's `proxied` flag is on), an Nginx Proxy Manager proxy
host per service (http to the service's host and port, WebSockets, Block
common exploits, HTTP/2, Force SSL, a Let's Encrypt certificate by HTTP
challenge, reused while it has more than 30 days left), and a smoke test that
asks every public URL through NPM's LAN IP (`proxy_ip`) with the public name
as SNI and Host. A **publish** deployment runs only those three. Credentials
live in Settings > Integrations (Cloudflare API token with DNS edit on the
zone; NPM URL, login and password), encrypted with `SIRDAR_SECRETS_KEY` and
never shown again; each has a Test button. A stored token or password is
reused (left blank on save or Test) only for the target it was entered for:
the same zone for Cloudflare, the same URL and login for NPM. Change the
target and the secret must be entered again.

Sirdar changes only what it records in `managed_records`: entries it
**created**, and hand-made ones someone **claimed** on the environment's
Publish tab. Any other record or proxy host at a wanted name, or a wildcard
such as `*.dev.serversherpa.com` that a new record would override, stops
the step before anything changes. Claimed entries are kept up to date but
never deleted. **Delete environment** stops the stacks, deletes the
volumes and `/opt/serversherpa/<env>` (backups included; the playbook checks
the folder against a fixed `/opt/serversherpa` root, so no variable can point
it elsewhere), removes the proxy hosts, certificates and DNS records Sirdar
created, forgets the claimed ones, and then removes the environment from
Sirdar. A certificate Sirdar created that a proxy host staying in place
(for example a claimed one) still uses is only forgotten, not deleted. Docker
images stay on the host.

**Adopting a hand-built environment** (`POST /api/deploy/environments` with
`"mode": "adopt"`): Sirdar reads `/opt/serversherpa/<name>/.env` and the
checkout's commit over SSH and imports them, secrets encrypted. Nothing on
the host changes. Keys Sirdar doesn't manage come back in `ignored_keys`
and are left out of `.env` on the next deploy.

**Proxmox targets.** Besides SSH targets, an environment can live on a VM
Sirdar builds on Proxmox (target `proxmox`). Step 0 runs Terraform
(`bpg/proxmox`, baked into the image with its checksum; no registry access) to
full-clone the Ubuntu 24.04 template into the pool as `ss-<env>` (tags
`sirdar`, `ss-<env>`), sized as the environment says (default 4 vCPU, 8 GB,
64 GB), with cloud-init for the `deploy` user, Sirdar's key for that VM and a
static address or DHCP. It then reads the VM's address and SSH host key
through the guest agent, pins the key, points every service at the VM and runs
the usual steps. Each Update, Reset, Restore backup or Roll back of a deployed
Proxmox environment first takes a VM snapshot (`sirdar-<UTC time>`, the newest
3 kept). Sirdar prunes and restores only the snapshots its own deployments
recorded: snapshots made by hand are never touched, whatever their names. The
Backups tab lists them with **Restore VM snapshot**. **Delete environment**
destroys the VM (only one Sirdar created: it checks the id, name and `sirdar`
tag) with its snapshots, then the DNS records and proxy hosts. Terraform state
lives in `sirdar/terraform/<environment id>/` (mounted at `/app/terraform`,
uid 10001, mode 700): back it up with the rest of `sirdar/`, and never edit or
delete these VMs in Proxmox by hand. Existing VMs can't be adopted onto
Proxmox: a hand-built VM (uat) stays an SSH target.

Safety checks. Sirdar pins exactly one certificate for the Proxmox API: the
one whose fingerprint you trusted. A PEM with extra certificates is refused,
so a CA can't ride along behind the leaf, and Terraform trusts that
certificate alone. Before every apply, restore and destroy, Sirdar looks the
VM id up across the whole cluster and refuses unless the VM there is named
`ss-<env>`, carries the `sirdar` tag and sits on the recorded node (Proxmox
reuses free ids). If a VM Sirdar created is gone from Proxmox, step 0 stops
instead of silently building a new one: delete the environment, or fix it by
hand, then retry. A VM's address, whether typed in or leased by DHCP, is
checked against everything that might use it: the proxy, every environment's
proxy, every saved SSH target (names are resolved, and an unreadable targets
file refuses), the Proxmox host, other environments' service addresses and
other VMs. The check runs under a database advisory lock held until the
address is recorded, so two creates can't claim the same address, and it runs
again before the address is written. A static address that already answers
SSH is refused before the VM is built.

A VM keeps the template, storage, pool, bridge and VLAN it was cloned with:
they are recorded when the environment is created, so changing them in
Settings › Integrations › Proxmox only affects new environments. Step 0 runs
`terraform plan`, reads the plan and refuses it if it would replace or remove
anything; only Delete environment destroys a VM. The VM snapshot is taken
before Terraform changes the VM, so it holds the old sizing too. A VM id
another environment reserved but hasn't built yet is skipped (the next 20 ids
are checked with Proxmox). Delete environment releases an id it reserved but
never built, and refuses when a VM it built is invisible to the token while
Terraform's state still has it (check the token's pool permissions).

Set up once on the Proxmox host (as root), then enter the URL, node, pool,
storage, bridge, template id and API token in Settings › Integrations ›
Proxmox, trust the certificate fingerprint it shows (compare it with
Datacenter › Node › System › Certificates), and press Test. The template must
be an Ubuntu 24.04 cloud image with `qemu-guest-agent` installed (Sirdar reads
the VM's address and host key through the agent), its boot disk on `scsi0`,
and VM id 9000 unless you enter another id:

```bash
# The template: Ubuntu 24.04 cloud image with the guest agent (id 9000)
apt-get install -y libguestfs-tools
wget https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
virt-customize -a noble-server-cloudimg-amd64.img --install qemu-guest-agent \
  --truncate /etc/machine-id
qm create 9000 --name ubuntu-2404-template --memory 2048 --cores 2 \
  --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-single --agent enabled=1 --ostype l26 \
  --serial0 socket --vga serial0
qm importdisk 9000 noble-server-cloudimg-amd64.img local-lvm
qm set 9000 --scsi0 local-lvm:vm-9000-disk-0,discard=on,ssd=1 --boot order=scsi0 \
  --ide2 local-lvm:cloudinit
qm template 9000
# The pool Sirdar works in, holding the template
pvesh create /pools --poolid sirdar
pvesh set /pools/sirdar --vms 9000
# A user and token that can act only in the pool, its storage and bridge
# (Proxmox 8: replace VM.GuestAgent.Audit VM.GuestAgent.FileRead with VM.Monitor)
pveum role add SirdarProvision -privs "VM.Allocate VM.Clone VM.Audit VM.PowerMgmt \
  VM.Config.CDROM VM.Config.CPU VM.Config.Cloudinit VM.Config.Disk VM.Config.HWType \
  VM.Config.Memory VM.Config.Network VM.Config.Options VM.Snapshot VM.Snapshot.Rollback \
  VM.GuestAgent.Audit VM.GuestAgent.FileRead Datastore.AllocateSpace Datastore.Audit \
  SDN.Use Pool.Audit Sys.Audit"
pveum user add sirdar@pve
pveum aclmod /pool/sirdar -user sirdar@pve -role SirdarProvision
pveum aclmod /storage/local-lvm -user sirdar@pve -role SirdarProvision
pveum aclmod /sdn/zones/localnetwork/vmbr0 -user sirdar@pve -role SirdarProvision
pveum aclmod /nodes/pve -user sirdar@pve -role SirdarProvision   # the bridge check (optional)
pveum user token add sirdar@pve sirdar --privsep 0               # shows the token once
```

The token (`sirdar@pve!sirdar=<uuid>`) is stored encrypted and never shown
again; Terraform gets it only through its environment. Proxmox can't be
removed from Settings while an environment uses it.

| API (under `/api/deploy`) | Needs |
|---|---|
| `PUT /integrations/proxmox`, `POST /integrations/proxmox/test`, `DELETE /integrations/proxmox` | `deploy:change` |
| `POST /environments` with `target: "proxmox"` and `vm` | `deploy:add` |
| `PATCH /environments/{name}` with `vm` (sizes, snapshots kept) | `deploy:change` |
| `GET /environments/{name}/vm-snapshots` | `deploy:view` |
| `POST /environments/{name}/deployments` (`mode`: `vm_restore`, with `vm_snapshot`) | `deploy:add` and `deploy:change` |

**VMware ESXi targets.** An environment can also live on a VM Sirdar builds
on one standalone, licensed ESXi 7 host (target `esxi`; no vCenter). Proxmox
stays supported beside it: in Settings › Integrations, ESXi is a main card
and Proxmox moves into the collapsed **Other hosts** area, where it is set up
and used exactly as described above.

What Sirdar does on ESXi:

- Step 0 creates the VM `ss-<env>` (Ubuntu 64-bit guest, ParaVirtual SCSI, a
  vmxnet3 NIC on the port group) on the datastore, copies the seed VM's disk
  into the VM's own folder as `ss-<env>-disk0.vmdk` (thin), attaches it,
  grows it to the environment's size (default 4 vCPU, 8 GB, 64 GB) and powers
  the VM on. The VM is recorded the moment ESXi creates it.
- cloud-init, through VMware's guestinfo datasource, sets up the user
  `deploy` with Sirdar's key for that VM (passwordless sudo, no password
  login), the static address or DHCP, and an SSH host key **Sirdar
  generated**. Its fingerprint is known before the VM first boots; step 0
  waits for VMware Tools to report the address (a static address must be the
  one reported), then pins the key with the live server, which must present
  exactly that key. Once SSH answers with it, step 0 **scrubs** the
  user-data holding the key's private half from the VM's settings
  (`guestinfo.userdata` is emptied, which deletes it) and from Sirdar's
  database: from then on the private key exists only on the VM's disk (but
  see `vmware.log` below). The metadata stays, so later boots keep the same instance id and cloud-init
  doesn't run again. The key never changes, so Restore VM snapshot needs no
  new pin.
- Each Update, Reset, Restore backup or Roll back of a deployed ESXi
  environment first takes a VM snapshot (`sirdar-<UTC time>`, disk only,
  quiesced through VMware Tools, or crash-consistent with a log line when
  quiescing fails). The name is recorded on the deployment before ESXi's task
  runs. Sirdar keeps the newest 3 of the snapshots it recorded; snapshots
  made by hand are never touched, and a name that appears twice is never
  picked for a delete or a restore.
- **Delete environment** destroys the VM (powered off first; ESXi removes its
  files and snapshots), checks that ESXi no longer finds it, and forgets its
  pinned host key. Because ESXi's destroy deletes every disk attached to the
  VM, it is refused (nothing removed) when the VM has any disk other than the
  one Sirdar copied into its folder: detach that disk first.

**One Sirdar per ESXi host.** Point only one Sirdar install at a given ESXi
host. Ownership is the `sirdar.environment` key holding an environment id,
and VM names are `ss-<env>`: two Sirdars with an environment of the same
name would contend for the same VM name, and neither can see the other's
address records.

**`vmware.log`.** ESXi may write the VM's settings, `guestinfo.userdata`
among them, into the VM's `vmware.log` in its datastore folder. Scrubbing
removes the key from the VM's settings, but a copy can stay in that log
until ESXi rotates it. Keep datastore access to administrators.

**Ownership.** Sirdar touches only a VM it created. Before step 0, a restore
or a destroy changes anything, the VM must match all three of: the recorded
instance UUID, the name `ss-<env>`, and the extraConfig key
`sirdar.environment` holding that environment's id. The key is written
together with the VM, so a VM named `ss-<env>` that carries it is this
environment's even if the record was lost: a retry picks it up and Delete
removes it. A VM with the right name but no key (or another environment's
id) is refused, and so is a VM with the key under a different instance UUID.
A mismatch fails the step and changes nothing. Never edit or remove that key,
and never rename these VMs. A VM Sirdar finished building that has gone
missing is never rebuilt silently; a half-built one that is gone is built
again. Existing VMs can't be adopted onto ESXi (422 `adopt_not_allowed`).

**Disks.** Sirdar checks that the VM has exactly one disk, the one it copied
into the VM's folder, before it changes anything. Once a VM has snapshots,
ESXi writes to a delta file (`…-disk0-000001.vmdk`); Sirdar follows the
disk's snapshot chain back to its base file, so the check holds through
snapshots. A disk it didn't put there stops the step. A half-copied disk left by an
earlier attempt is deleted only when no VM on the host has it attached.

**Sizing.** Changing vCPU, memory or the disk applies on the next deploy:

1. Step 0 first checks the VM's snapshots when the disk grows (ESXi can't
   grow a disk that has snapshots). A snapshot someone made by hand, or two
   with the same name, stops the step with their names, changing nothing.
   Delete them in the Host Client, then retry.
2. It shuts the guest down through VMware Tools and waits up to 5 minutes.
   If the guest doesn't stop, the step fails and nothing changes (there is
   no hard power-off).
3. For a disk grow, it deletes this environment's Sirdar snapshots.
4. It sets vCPU and memory, then grows the disk.
5. It powers the VM on (the guest grows its file system at boot), waits for
   the address and, after a grow, takes a new VM snapshot.

When vCPU and memory change but the disk doesn't, the VM snapshot is taken
before the shutdown, so it holds the old sizing too. A failure after the
shutdown leaves the VM off and says so; retry the deployment. Disks never
shrink. A VM snapshot restore that brings back older vCPU or memory sizes is
set back to the recorded sizes by the next step 0.

**Address safety.** A VM's address, typed in or leased by DHCP, is refused
when anything else might use it: the proxy, every environment's proxy, every
saved SSH target (names resolved; an unreadable targets file refuses), both
VM hosts' own addresses (the Proxmox and ESXi URL hosts), other
environments' service addresses, and every other Proxmox or ESXi VM. The
check runs at create (409 `ip_in_use`) and again in step 0 under a database
advisory lock held until the address is recorded. A static address is
checked again before the VM is created (on Proxmox, before its id is
reserved): it must pass the same check, no VM on the ESXi host may report it
through VMware Tools, and nothing may answer SSH there. Sirdar never pins a
saved SSH target's address, and forgets a pin it made when the locked
re-check fails.

Set up once, on the ESXi host:

- **License.** A paid license is needed. Free ESXi makes the API read-only;
  Test's License check says so.
- **The API user.** Make a dedicated local user:
  1. In the Host Client, go to Manage › Security & users › Users › Add user,
     and add `sirdar` with a long password.
  2. Go to Host › Actions › Permissions › Add user, and give `sirdar` the
     role Administrator. Standalone ESXi can't scope a user to some VMs;
     Sirdar's ownership checks are what protect the other VMs.
- **The seed VM** (one time):
  1. Download `noble-server-cloudimg-amd64.ova` from
     `https://cloud-images.ubuntu.com/noble/current/` and check it against
     that folder's `SHA256SUMS`. Ubuntu's cloud image ships open-vm-tools,
     which reports the VM's address.
  2. In the Host Client, go to Virtual Machines › Create / Register VM ›
     Deploy a virtual machine from an OVF or OVA file.
  3. Name it `sirdar-ubuntu-2404-seed`, pick the datastore and Thin
     provisioning, leave every property empty, and **uncheck "Power on
     automatically"**.
  4. Never power it on, and never take snapshots of it. Test checks that it
     exists, is powered off, has one disk and has no snapshots, and step 0
     checks again before it copies the disk.
- **The datastore and port group.** Note the datastore the VMs go on (for
  example `datastore1`) and a standard-switch port group (for example
  `VM Network`) on the network the VMs' addresses belong to. A resource pool
  is optional (empty means the host's root pool).

Then enter the URL (`https://<host>`, port 443 unless you add one), user,
password, datastore, port group, resource pool, seed VM name and up to 3 DNS
servers (empty means the gateway for a static address, or what DHCP hands
out) in Settings › Integrations › VMware ESXi, and press Test. The checks are ESXi, License, Datastore, Network,
Resource pool and Seed VM. A VM keeps the datastore, port group, resource
pool, seed and DNS servers it was created with; changing them only affects
new environments. Its network (static or DHCP) is fixed at create.

**The certificate.** Save or Test shows the host's certificate fingerprint
(SHA-256). Compare it with what the ESXi Shell prints for
`openssl x509 -in /etc/vmware/ssl/rui.crt -noout -fingerprint -sha256`, or
with the browser's certificate viewer on the Host Client, before you click
Trust. The host name isn't checked, because ESXi's certificate usually names
only `localhost.localdomain`; the pinned certificate is the only one trusted,
and pyVmomi checks the same fingerprint again before it sends the login. If
the host's certificate changes, steps can't connect and Save or Test answers
409 `tls_mismatch` until you trust the new one.

The password is stored encrypted and never shown again. It stays inside
Sirdar's process (no subprocess sees it) and is reused, when left blank, only
for the same URL and user. ESXi can't be removed from Settings, and its URL
can't change (409 `integration_in_use`, as for Proxmox's URL), while an
environment uses it. A VM stays on the host it was built on: if the URL
points elsewhere anyway, every step of its environments, Delete included,
stops and says so instead of calling the VM gone.

**Packages.** pyVmomi 8.0.3.0.1 (it still covers ESXi 7; 9.x doesn't promise
to) and six 1.17.0 are installed in the image with `--require-hashes` from
`sirdar/api/requirements-esxi.txt`. Bump them together with
`sirdar/api/pyproject.toml`; a test compares the two.

| API (under `/api/deploy`) | Needs |
|---|---|
| `PUT /integrations/esxi`, `POST /integrations/esxi/test`, `DELETE /integrations/esxi` | `deploy:change` |
| `POST /environments` with `target: "esxi"` and `vm` | `deploy:add` |
| `PATCH /environments/{name}` with `vm` (sizes, snapshots kept) | `deploy:change` |
| `GET /environments/{name}/vm-snapshots` | `deploy:view` |
| `POST /environments/{name}/deployments` (`mode`: `vm_restore`, with `vm_snapshot`) | `deploy:add` and `deploy:change` |

Routes for VMs answer 409 `not_vm_environment` on an SSH environment.

| API (under `/api/deploy`) | Needs |
|---|---|
| `GET /environments`, `GET /environments/{name}` | `deploy:view` |
| `POST /environments` (`mode`: `new` or `adopt`) | `deploy:add` |
| `PATCH /environments/{name}` | `deploy:change` |
| `POST /environments/{name}/deployments` (`mode`: `update` or `reset`) | `deploy:add`; Reset also `deploy:change` |
| `GET /environments/{name}/deployments`, `GET /deployments/{id}?tail=N` | `deploy:view` |
| `POST /deployments/{id}/cancel` | `deploy:change` |
| `POST /deployments/{id}/retry` | `deploy:add`; a Reset, Restore backup or Roll back deployment also `deploy:change` |
| `POST /environments` with `snapshot_id` (mode `new`) | `deploy:add` |
| `POST /environments/{name}/deployments` (`mode`: `restore_dump`, with `backup`) | `deploy:add` and `deploy:change` |
| `GET /environments/{name}/backups` | `deploy:view` |
| `POST /deployments/{id}/rollback` | `deploy:change` |
| `GET /snapshots` | `deploy:view` |
| `POST /snapshots?name=…&notes=…` (body: the bundle) | `deploy:add` |
| `POST /environments/{name}/snapshots` (take one) | `deploy:add` |
| `DELETE /snapshots/{id}` | `deploy:change` |
| `GET /integrations` | `deploy:view` |
| `PUT /integrations/cloudflare`, `PUT /integrations/npm`, `DELETE /integrations/{kind}`, `POST /integrations/{kind}/test` | `deploy:change` |
| `GET /environments/{name}/publish` | `deploy:view` |
| `POST /environments/{name}/publish/claim` | `deploy:change` |
| `POST /environments/{name}/deployments` (`mode`: `publish`) | `deploy:add` |
| `POST /environments/{name}/deployments` (`mode`: `teardown`, with `confirm_name`) | `deploy:change` |

**Snapshots.** A snapshot is one `.tar.gz`: `manifest.json`, `keys.enc` (the
source's `SS_PASSWORD_PEPPER` and `SS_TOTP_ENCRYPTION_KEY`, encrypted with
`SIRDAR_SECRETS_KEY`), `db.dump` (`pg_dump -Fc`) and `objects.tar` (every
object of the bucket, content types kept). Bundles live in
`sirdar/snapshots/` (mounted at `/app/snapshots`, owned by uid 10001, mode
700; the installer creates it) and are never served to browsers. Make one
from the Mac dev stack with `scripts/make-seed-snapshot.sh` and upload it on
the Deploy page, or take one from a deployed environment. A new environment
can start from a snapshot (its first deploy restores it) and Reset data can
restore one. Restoring replaces the environment's pepper and TOTP key with
the snapshot's, so its users sign in with their own passwords and 2FA, and
signs everyone out. A snapshot whose database is at a newer migration than
the commit being deployed is refused, by a Reset before Reset data deletes
anything. Uploads are capped at
`SIRDAR_SNAPSHOT_MAX_BYTES` (default 5 GiB); a reverse proxy in front must
accept bodies that large too.

**Backups and rollback.** Each Update's pre-deploy dump stays in
`<env-dir>/backups` (the newest `keep_dumps`). Restore backup puts one back
into an empty database, then migrates and starts the app. It runs the deployed
commit's code and config again first (Fetch code, Render config with Sirdar's
stored keys, Build images, cached), so a failed Update's checkout or `.env`
never decides what the backup is restored under. A backup taken before a
snapshot restore replaced the pepper and TOTP key can't be restored (its users'
keys no longer exist anywhere): the backups listing marks it
`"restorable": false` with a `reason`, and starting one answers 409
`backup_keys_changed`. Neither can the dump a seeded first deploy took of a
database that was already there, whatever the target's clock named it.
Roll back (offered
after a failed Update) deploys the previous commit and restores that
Update's dump. Uploaded files are never rolled back.

Deployments run inside Sirdar's single API process. Restarting Sirdar marks
running deployments `interrupted`; retry them.

### Supported systems

| Family | Detected from `/etc/os-release` (`ID`, else `ID_LIKE`) | Prerequisites with | Docker Engine + compose v2 |
|---|---|---|---|
| Debian | debian, ubuntu and derivatives (Mint, Pop!_OS, Raspberry Pi OS…) | `apt-get` | Docker's apt repository, mapped to the upstream release (`UBUNTU_CODENAME` / `DEBIAN_CODENAME`); static binaries if Docker has no repo for that release |
| Fedora / RHEL | fedora, rhel, centos, rocky, almalinux, ol, amzn | `dnf` (`yum` without dnf) | Docker's repository (`fedora`, `rhel`, else `centos`); static binaries if it has no repo for that release yet. Amazon Linux: the distro's `docker` package plus the compose/buildx plugins |
| SUSE | opensuse-leap, opensuse-tumbleweed, sles | `zypper` | `docker` + `docker-compose` packages |
| Arch | arch, manjaro, endeavouros | `pacman -Syu` (a full system upgrade) | `docker` + `docker-compose` (+ `docker-buildx`) packages |
| Alpine | alpine | `apk` | `docker` + `docker-cli-compose` packages, started with OpenRC |
| Void | void | `xbps-install` | `docker` + `docker-compose` packages, enabled as a runit service |
| Slackware | slackware (or `/etc/slackware-version`) | none: if something is missing it stops and tells you the `slackpkg install …` line (a full install includes them) | Docker's static binaries |
| Gentoo / other | anything else | the first package manager it finds (`emerge` included); otherwise it lists what is missing | Docker's static binaries |

**When packages fail.** Docker's static binaries are used only where they are
the design: Slackware, Gentoo and other systems, and Debian/Ubuntu or
Fedora/RHEL releases (or derivatives) that Docker's repository doesn't cover.
If a package step fails anywhere else (a download error, or another package
job holding the dpkg/rpm lock, such as unattended-upgrades), the installer
stops with the package manager's exit status and asks you to wait and re-run;
it never switches to the static binaries on its own. On Debian and Fedora it
adds Docker's source (`/etc/apt/sources.list.d/docker.list`,
`/etc/yum.repos.d/docker-ce.repo`) only after Docker's signing key downloaded,
and removes a source it just added if the packages then don't install.

**Arch:** pacman supports full upgrades only, so on Arch the installer runs
`pacman -Syu`, which upgrades the whole system along with installing what it
needs.

**Static binaries** (x86_64 and aarch64 only): the newest stable
`docker-X.Y.Z.tgz` from `https://download.docker.com/linux/static/stable/<arch>/`
(or `SIRDAR_DOCKER_VERSION`) goes into `/usr/local/bin` (`docker`, `dockerd`,
`containerd`, `containerd-shim-runc-v2`, `ctr`, `runc`, `docker-init`,
`docker-proxy`). The archive must list cleanly and `docker`/`dockerd` must be
Linux executables. A binary already in `/usr/local/bin` that the installer
didn't put there (it records its own in
`/usr/local/lib/sirdar-installer/static-docker-version`) is left alone with a
warning; set `SIRDAR_FORCE_STATIC=1` to replace it. The compose and buildx
plugins come from their latest GitHub releases into
`/usr/local/lib/docker/cli-plugins/`, checked against the release's published
SHA-256 (compose's `<asset>.sha256`, buildx's `checksums.txt`); a download
that doesn't match is deleted and the installer stops. The installer creates the
`docker` group, then starts `dockerd` by init system: a
`/etc/systemd/system/docker.service` with systemd, `/etc/init.d/docker` with
OpenRC, or, with no init it knows, `nohup dockerd` (with a warning that it
won't start at boot).

**Slackware:** it writes `/etc/rc.d/rc.docker` (`start|stop|restart|status`,
pidfile `/var/run/docker.pid`, log `/var/log/docker.log`), adds a
marked block to `/etc/rc.d/rc.local` that starts it at boot and one to
`/etc/rc.d/rc.local_shutdown` (created if missing) that stops it, then runs
`/etc/rc.d/rc.docker start`. An `rc.docker` you already have (e.g. from
SlackBuilds) is never edited or chmodded, and gets no rc.local block; it is
just started. If it isn't executable (Slackware's "disabled"), the installer
warns and starts it once with `sh /etc/rc.d/rc.docker start`. If `rc.local`
doesn't mention rc.docker, it warns that starting Docker at boot is up to you
(`chmod +x /etc/rc.d/rc.docker` and add it to `rc.local`). An existing
`rc.local` or `rc.local_shutdown` keeps its mode: if it isn't executable, the
installer warns instead of changing it. If `/sys/fs/cgroup` is empty it
tries to mount cgroup2 there first. Re-running doesn't add the blocks twice.

**Alpine:** the installer itself needs bash and curl, so run
`apk add bash curl` first; the one-liner is then unchanged. Running the script
with `sh` stops with a "run it with bash" message.


Admin commands (the installer prints them with your paths):

```bash
docker compose -f sirdar/docker-compose.yml --env-file sirdar/.env exec sirdar sirdar create-admin --email … --first-name … --last-name …
docker compose -f sirdar/docker-compose.yml --env-file sirdar/.env exec sirdar sirdar import-users
docker compose -f sirdar/docker-compose.yml --env-file sirdar/.env exec sirdar sirdar reset-password --email …
```

To run compose by hand instead, copy `sirdar/.env.example` to `sirdar/.env`,
fill in every secret, then
`docker compose -f sirdar/docker-compose.yml --env-file sirdar/.env up -d --build`.

## Security notes

- `SS_PASSWORD_PEPPER` and `SS_TOTP_ENCRYPTION_KEY` must equal the portal's
  values, or copied password hashes and 2FA seeds will not verify. The
  installer generates new ones unless you paste the portal's; to import
  portal users later, set them to the portal's values before creating local
  admins (changing the pepper invalidates local passwords; fix with
  `reset-password`).
- Point `SIRDAR_SOURCE_DATABASE_URL` at a read-only role that can only SELECT
  the tables the import reads. Leave it empty to disable the import.
- Sirdar must sit behind a trusted reverse proxy: the API trusts
  `X-Forwarded-For` for audit and session IPs, uvicorn runs with
  `--forwarded-allow-ips='*'`, and the port is bound to 127.0.0.1 by default.
  Never expose the container port directly. If you set `SIRDAR_BIND` beyond
  127.0.0.1, LAN clients can spoof `X-Forwarded-For` (audit and session IPs
  only); bind to the proxy-facing address or firewall the port to the proxy.
- Have the proxy rate-limit `/api/auth/*`; account lockout alone does not stop
  password guessing while an account is locked. (A locked account answers
  `account_locked` to every password and adds no strikes, so the lock never
  reveals whether a guess was right. The accepted trade-off: a locked account
  is distinguishable from an unknown email, which answers `invalid_credentials`.)
- The dev import uses the portal's own DB URL, but the import always runs in a
  READ ONLY transaction. In production, use a read-only role anyway.
- Local users created with `create-admin` have no 2FA.
- Never commit `sirdar/.env`.

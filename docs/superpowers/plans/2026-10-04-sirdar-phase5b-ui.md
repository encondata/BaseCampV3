# Sirdar deploy phase 5b (Proxmox targets: web UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give phase 5a's Proxmox API its UI — the Proxmox card and modal in Settings › Integrations (with the certificate trust prompt), Proxmox as a target in New environment with a Machine step, the VM on the environment's Overview and Settings tabs, the VM snapshot choice in the Deploy modal, VM snapshots with Restore on the Backups tab and in a failed deployment's Roll back panel, and Delete environment copy that says the VM goes — then live-verify it with a throwaway `uat3` VM on Jimmy's Proxmox host.

**Architecture:** Web code in `sirdar/web/src` over the `/api/deploy` routes of plan 5a. New files: `pages/settings/ProxmoxModal.tsx`, `pages/environments/VmSnapshots.tsx`, `pages/environments/RestoreVmSnapshotModal.tsx`. Existing pages grow the Proxmox pieces: `IntegrationsSection`, `Deploy`, `NewEnvironmentModal`, `EnvOverview`, `EnvSettings`, `DeleteEnvironmentModal`, `DeployModal`, `DeploymentView`, `BackupsTab`. Shared helpers stay in `lib/sirdarApi.ts`, `pages/environments/labels.tsx` and `testData.ts`.

**Tech Stack:** React 18 + TypeScript 5.6 + react-router-dom 6 + Vitest 3 / Testing Library (jsdom); portal components through `@portal` (`DataTable`, `ComboBox`, `AuthContext`, `lib/api`); Claude in Chrome for the live verify.

**Spec:** `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md` Section 6, with `docs/superpowers/plans/2026-10-04-sirdar-phase5-context.md`. Plan 5a (`docs/superpowers/plans/2026-10-04-sirdar-phase5a-backend.md`) must be done first.

## Interfaces from 5a

All under `/api/deploy` (the web client's paths start `/deploy`; `VITE_API_URL=/api`). Times are ISO 8601 strings.

- `Integrations.proxmox` = `{configured, url, node, pool, storage, bridge, vlan_tag: number|null, template_vmid: number|null, tls_fingerprint: string|null, token_id: string|null, token_set, updated_at, updated_by_name}`.
- `PUT /integrations/proxmox` (change) `{url, node, pool, storage, bridge, vlan_tag: number|null, template_vmid: number, tls_fingerprint: string|null, token?}` → `Integrations`. `POST /integrations/proxmox/test` (change), optional body = the PUT body → `{ok, target: "proxmox", checks, facts}` (labels Proxmox, Node, Pool, Template, Storage, Bridge). Both answer 409 `tls_untrusted {fingerprint, subject, issuer, not_after, names}` until the body names the live certificate's fingerprint (the stored one is reused for the same URL), 409 `tls_mismatch {expected, actual}`, 502 `connect_failed {reason}`, 422 `proxmox_url_invalid | node_invalid | pool_invalid | storage_invalid | bridge_invalid | vlan_tag_invalid | template_vmid_invalid | proxmox_token_invalid | secret_required {reason?}`. A token is reused only for the same URL.
- `DELETE /integrations/proxmox` (change) → 204, or 409 `integration_in_use {environments}`.
- `GET /targets` lists `{id: "proxmox", label: "Proxmox", kind: "proxmox", available: true, configured: true}` last, once Proxmox is set up.
- `GET /environment-defaults` adds `vm: {cores: 4, memory_mb: 8192, disk_gb: 64, keep_snapshots: 3, limits: {cores: [1, 64], memory_mb: [2048, 262144], disk_gb: [20, 4096], keep_snapshots: [1, 10]}}`.
- `POST /environments` mode `new`, `target: "proxmox"`, `vm: {cores?, memory_mb?, disk_gb?, ip_mode: "static"|"dhcp", ip_cidr?, gateway?}`. Errors: 409 `integration_not_configured {kinds}`, 409 `ip_in_use`, 422 `vm_cores_invalid | vm_memory_invalid | vm_disk_invalid | vm_ip_mode_invalid | vm_ip_invalid | vm_gateway_invalid | vm_not_allowed | adopt_not_allowed`.
- `PATCH /environments/{name}` takes `vm: {cores?, memory_mb?, disk_gb?, keep_snapshots?}`; 422 `vm_disk_shrink`, `vm_keep_snapshots_invalid`, `host_ip_managed {service}`, `target_kind_locked`.
- `Environment` adds `target_kind: "ssh"|"proxmox"`, `vm: {name, node, vmid, cores, memory_mb, disk_gb, ip_mode, ip_cidr, gateway, ip, keep_snapshots, created} | null`.
- `POST /environments/{name}/deployments`: `take_vm_snapshot?: boolean` (Proxmox update / reset / restore_dump; default true once deployed); `mode: "vm_restore"` with `vm_snapshot` and `confirm_name` (change). For a Proxmox environment the response's `sha` is `""` until step 0 resolves the ref. Errors add 422 `vm_snapshot_not_allowed | vm_snapshot_invalid`, 404 `vm_snapshot_not_found`, 409 `vm_snapshot_keys_changed {reason} | not_proxmox | vm_not_ready | vm_key_unreadable`.
- `DeploymentSummary` adds `vm: boolean`, `take_vm_snapshot: boolean`, `vm_snapshot: string|null`; `mode` may be `vm_restore`.
- `GET /environments/{name}/vm-snapshots` (view) → `{snapshots: [{name, taken_at, sha, deployment_id, description, restorable, reason}]}` newest first. Errors: 409 `not_proxmox`, 409 `integration_not_configured`, 502 `connect_failed {reason}`.
- Steps: 0 `provision` "Prepare VM", 0 `vm_restore` "Restore VM snapshot", 15 `destroy` "Destroy VM".

## Global Constraints

- Every new modal gets the report-generate header (eyebrow, title, description) and sizes to its content (a content-matched card width; dropdowns render through `portal`).
- Reuse the existing portal and Sirdar idioms (`DataTable`, `ComboBox`, segmented radio groups with `arrowNav`, chips, `.pf-form` with `.field-label` for non-label captions). No raw native `<select>`. Sections inside a `.pf-form` grid in a modal body get `grid-column: 1 / -1` (the `sirdar-span2` class).
- Typed-name gate (the environment's name typed exactly) for Restore VM snapshot and Delete environment, as the API requires.
- The Proxmox token is write-only in the UI: never prefilled, never shown (the card shows only the token id and "Set").
- Don't add reader-facing widgets that weren't asked for.
- American English in all copy; display "Canceled" for the `cancelled` status.
- Component tests start with `// @vitest-environment jsdom`, mock `../../lib/sirdarApi` (spreading the real module) and `@portal/auth/AuthContext` the way the existing environment tests do, set `Element.prototype.scrollIntoView = () => {}` when a ComboBox is used.
- No new `@portal` import: only `auth/AuthContext`, `components/DataTable`, `components/ComboBox` and `lib/api`, all allowlisted.
- `tsc` type-checks tests too (`noUnusedLocals`, `noUnusedParameters`).
- Web tests: `npm --prefix sirdar/web test`. Type-check and build: `npm --prefix sirdar/web run build`. Never run `npm install` in this worktree.
- Work in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Other agents may commit here at the same time: `git add` only your task's files, never `git stash`; retry when `.git/index.lock` is busy. If a file this plan edits has changed since the plan was written (another agent's fix), apply the same edit to the new text and keep their change. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

- Modify `sirdar/web/src/lib/sirdarApi.ts` (+ `sirdarApi.test.ts`) — Proxmox and VM types, `listVmSnapshots`, `PublishKind`, messages for every new code, `integration_in_use` names the environments.
- Modify `sirdar/web/src/pages/environments/labels.tsx` (+ `labels.test.ts`) — `vm_restore`, `envTargets`, `onProxmox`, `vmSize`, `vmNetwork`.
- Modify `sirdar/web/src/pages/environments/testData.ts` — Proxmox fixtures.
- Modify `sirdar/web/src/pages/settings/IntegrationModal.tsx` (type rename only), `IntegrationsSection.tsx` (+ test); create `pages/settings/ProxmoxModal.tsx` (+ test).
- Modify `sirdar/web/src/pages/Deploy.tsx` (+ test) — the Proxmox card.
- Modify `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx` (+ test) — Proxmox target, Machine step.
- Modify `EnvOverview.tsx`, `EnvSettings.tsx` (+ test), `DeleteEnvironmentModal.tsx` (+ test) — the VM.
- Modify `DeployModal.tsx` (+ test), `DeploymentView.tsx` (+ test) — VM snapshot choice, Restore VM snapshot after a failure.
- Create `VmSnapshots.tsx`, `RestoreVmSnapshotModal.tsx` (+ `VmSnapshots.test.tsx`); modify `BackupsTab.tsx`.
- Modify `sirdar/web/src/styles/sirdar.css`.

---

### Task 1: API client, labels and fixtures

**Files:**
- Modify: `sirdar/web/src/lib/sirdarApi.ts`, `sirdar/web/src/lib/sirdarApi.test.ts`
- Modify: `sirdar/web/src/pages/environments/labels.tsx`, `labels.test.ts`, `testData.ts`
- Modify: `sirdar/web/src/pages/settings/IntegrationModal.tsx`, `IntegrationsSection.tsx` (type rename only)

**Interfaces:**
- Produces (`lib/sirdarApi.ts`): `type PublishKind = 'cloudflare' | 'npm'`; `type IntegrationKind = PublishKind | 'proxmox'`; `INTEGRATION_LABEL.proxmox = 'Proxmox'`; `interface ProxmoxIntegration`; `Integrations.proxmox`; `interface ProxmoxBody { url; node; pool; storage; bridge; vlan_tag: number | null; template_vmid: number; tls_fingerprint: string | null; token? }`; `interface TlsCertificate { fingerprint; subject; issuer; not_after; names: string[] }`; `saveIntegration` / `testIntegration` accept `ProxmoxBody`; `interface EnvVm`; `Environment.target_kind`, `Environment.vm`; `interface VmDefaults`, `EnvironmentDefaults.vm`; `interface NewVm`, `NewEnvironmentBody.vm?`; `EnvironmentPatch.vm?`; `DeploymentMode` adds `'vm_restore'`; `DeploymentSummary.vm`, `take_vm_snapshot`, `vm_snapshot`; `DeploymentBody.mode` adds `'vm_restore'`, `take_vm_snapshot?`, `vm_snapshot?`; `interface VmSnapshot`; `listVmSnapshots(name)`; `DeployTarget.kind` may be `'proxmox'`.
- Produces (`labels.tsx`): `MODE_LABEL.vm_restore = 'Restore VM snapshot'`; `GATED_MODES` and `RETRY_MODES` include `'vm_restore'`; `envTargets(targets)` (configured SSH targets, then Proxmox when configured); `onProxmox(env)`; `vmSize(vm) -> "4 vCPU · 8 GB · 64 GB disk"`; `vmNetwork(vm) -> "10.10.48.70/24 via 10.10.48.1" | "DHCP"`.
- Produces (`testData.ts`): `ENV` gains `target_kind: 'ssh', vm: null`; deployments gain `vm: false, take_vm_snapshot: false, vm_snapshot: null`; `DEFAULTS.vm`; `INTEGRATIONS.proxmox` (configured) and `NO_INTEGRATIONS.proxmox`; new `PX_FINGERPRINT`, `PX_CERT`, `PX_CHECK`, `PX_TOKEN`, `PX_VM`, `PX_ENV`, `PX_NEW_ENV`, `PX_TARGETS`, `VM_SNAPSHOTS`, `VM_ROLLBACKABLE`.

- [ ] **Step 1: Write the failing tests**

In `sirdar/web/src/lib/sirdarApi.test.ts`, add these entries at the end of `CALLS` (before the closing `];`):

```ts
  { name: 'listVmSnapshots', call: () => sirdar.listVmSnapshots('uat3'),
    path: '/deploy/environments/uat3/vm-snapshots' },
  { name: 'saveIntegration (proxmox)', call: () => sirdar.saveIntegration('proxmox', {
      url: 'https://10.10.48.5:8006', node: 'pve', pool: 'sirdar', storage: 'local-lvm', bridge: 'vmbr0',
      vlan_tag: null, template_vmid: 9000, tls_fingerprint: null }),
    path: '/deploy/integrations/proxmox', method: 'PUT',
    body: { url: 'https://10.10.48.5:8006', node: 'pve', pool: 'sirdar', storage: 'local-lvm', bridge: 'vmbr0',
            vlan_tag: null, template_vmid: 9000, tls_fingerprint: null } },
  { name: 'startDeployment (restore a VM snapshot)',
    call: () => sirdar.startDeployment('uat3', { mode: 'vm_restore', vm_snapshot: 'sirdar-20261004T120000Z',
                                                 confirm_name: 'uat3' }),
    path: '/deploy/environments/uat3/deployments', method: 'POST',
    body: { mode: 'vm_restore', vm_snapshot: 'sirdar-20261004T120000Z', confirm_name: 'uat3' } },
```

In `deployCodes()`, replace:

```ts
  for (const file of ['api/routes/deploy.py', 'api/routes/integrations.py', 'deploy/environments.py',
                       'deploy/gitref.py', 'deploy/ssh_targets.py', 'deploy/snapshots.py', 'deploy/integrations.py']) {
    const src = readFileSync(join(root, file), 'utf8');
    for (const re of [/"code": "([a-z_]+)"/g,
                      /(?:EnvError|RefError|TargetError|SnapshotError|IntegrationError)\("([a-z_]+)"/g,
```

with:

```ts
  for (const file of ['api/routes/deploy.py', 'api/routes/integrations.py', 'deploy/environments.py',
                       'deploy/gitref.py', 'deploy/ssh_targets.py', 'deploy/snapshots.py', 'deploy/integrations.py',
                       'deploy/vms.py']) {
    const src = readFileSync(join(root, file), 'utf8');
    for (const re of [/"code": "([a-z_]+)"/g,
                      /(?:EnvError|RefError|TargetError|SnapshotError|IntegrationError|VmError)\("([a-z_]+)"/g,
                      /"(vm_[a-z_]+_invalid)"/g, /, "([a-z_]+_invalid)"\)/g,
```

and in `it('every error code the deploy routes can return has its own message', …)`, replace:

```ts
  for (const code of ['integration_not_configured', 'publish_off', 'nothing_to_claim', 'claim_conflict',
                      'token_invalid', 'npm_url_invalid', 'secret_required', 'publish_not_allowed']) {
```

with:

```ts
  for (const code of ['integration_not_configured', 'publish_off', 'nothing_to_claim', 'claim_conflict',
                      'token_invalid', 'npm_url_invalid', 'secret_required', 'publish_not_allowed',
                      'proxmox_url_invalid', 'node_invalid', 'template_vmid_invalid', 'proxmox_token_invalid',
                      'tls_untrusted', 'tls_mismatch', 'integration_in_use', 'vm_cores_invalid', 'vm_disk_shrink',
                      'vm_ip_invalid', 'ip_in_use', 'adopt_not_allowed', 'host_ip_managed', 'target_kind_locked',
                      'vm_snapshot_not_found', 'vm_snapshot_keys_changed', 'not_proxmox', 'vm_not_ready']) {
```

(The `, "…_invalid")` pattern finds the codes `integrations.py` passes to its `text(…)` and `_int_in(…)` helpers.)

Append to the end of `sirdar/web/src/lib/sirdarApi.test.ts`:

```ts
it('integration_in_use names the environments that still use it', () => {
  expect(sirdar.deployErrorText(new ApiError(409, 'integration_in_use',
    { code: 'integration_in_use', environments: ['uat3', 'uat4'] }), 'x'))
    .toBe('Environments still use it: uat3, uat4. Delete them first.');
  expect(sirdar.INTEGRATION_LABEL.proxmox).toBe('Proxmox');
});
```

In `sirdar/web/src/pages/environments/labels.test.ts`, replace the import block:

```ts
import {
  CERT_STATE, DEPLOYMENT_STATUS, ENV_STATUS, GATED_MODES, MODE_LABEL, PUBLISH_STATE, RETRY_MODES, STEP_STATUS,
  deploymentRunning, dumpTakenAt, duration, formatBytes, snapshotLabel, sshTargets, stoppedStep,
} from './labels';
import { ENV, FAILED, PUBLISHING, RUNNING, SNAP, SUCCEEDED, TARGETS, summary } from './testData';
```

with:

```ts
import {
  CERT_STATE, DEPLOYMENT_STATUS, ENV_STATUS, GATED_MODES, MODE_LABEL, PUBLISH_STATE, RETRY_MODES, STEP_STATUS,
  deploymentRunning, dumpTakenAt, duration, envTargets, formatBytes, onProxmox, snapshotLabel, sshTargets,
  stoppedStep, vmNetwork, vmSize,
} from './labels';
import {
  ENV, FAILED, PUBLISHING, PX_ENV, PX_TARGETS, PX_VM, RUNNING, SNAP, SUCCEEDED, TARGETS, summary,
} from './testData';
```

and append:

```ts
it('Proxmox: targets, the mode, and the VM in words', () => {
  expect(envTargets(TARGETS.targets).map((t) => t.id)).toEqual(['ssh:lab']);
  expect(envTargets(PX_TARGETS.targets).map((t) => t.id)).toEqual(['ssh:lab', 'proxmox']);
  expect(sshTargets(PX_TARGETS.targets).map((t) => t.id)).toEqual(['ssh:lab']);
  expect([onProxmox(ENV), onProxmox(PX_ENV)]).toEqual([false, true]);
  expect(MODE_LABEL.vm_restore).toBe('Restore VM snapshot');
  expect(GATED_MODES).toContain('vm_restore');
  expect(RETRY_MODES).toContain('vm_restore');
  expect(vmSize(PX_VM)).toBe('4 vCPU · 8 GB · 64 GB disk');
  expect(vmSize({ ...PX_VM, memory_mb: 12288 })).toBe('4 vCPU · 12 GB · 64 GB disk');
  expect(vmNetwork(PX_VM)).toBe('10.10.48.70/24 via 10.10.48.1');
  expect(vmNetwork({ ...PX_VM, ip_mode: 'dhcp', ip_cidr: null, gateway: null })).toBe('DHCP');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- --run src/lib/sirdarApi.test.ts src/pages/environments/labels.test.ts`
Expected: FAIL — `sirdar.listVmSnapshots is not a function`, missing exports from `labels` and `testData`.

- [ ] **Step 3: The API client**

In `sirdar/web/src/lib/sirdarApi.ts`:

Replace:

```ts
export interface DeployTarget {
  /** 'aws' | 'gcp' | 'digitalocean' | 'ssh' (installer) | 'ssh:<slug>' (saved). */
  id: string; label: string; kind?: 'aws' | 'gcp' | 'digitalocean' | 'ssh';
```

with:

```ts
export interface DeployTarget {
  /** 'aws' | 'gcp' | 'digitalocean' | 'ssh' (installer) | 'ssh:<slug>' (saved) | 'proxmox' (once set up). */
  id: string; label: string; kind?: 'aws' | 'gcp' | 'digitalocean' | 'ssh' | 'proxmox';
```

In `MESSAGES`, after the line `publish_not_allowed: …,` add:

```ts
  // Proxmox targets
  proxmox_url_invalid: 'Use the Proxmox address with https, like https://10.10.48.5:8006 (no path).',
  node_invalid: "That node name isn't valid.",
  pool_invalid: "That pool name isn't valid.",
  storage_invalid: "That storage name isn't valid, like local-lvm.",
  bridge_invalid: "That bridge name isn't valid, like vmbr0.",
  vlan_tag_invalid: 'Use a VLAN tag from 1 to 4094, or leave it empty.',
  template_vmid_invalid: "Use the template's VM id, a number from 100 up.",
  proxmox_token_invalid: "That doesn't look like a Proxmox API token (user@realm!tokenid=secret).",
  tls_untrusted: "Sirdar doesn't trust this Proxmox server's certificate yet.",
  tls_mismatch: "The Proxmox server's certificate doesn't match the one Sirdar trusted.",
  integration_in_use: 'Environments still use it. Delete them first.',
  vm_cores_invalid: 'Use 1 to 64 vCPUs.',
  vm_memory_invalid: 'Use 2 to 256 GB of memory.',
  vm_disk_invalid: 'Use a disk of 20 to 4096 GB.',
  vm_keep_snapshots_invalid: 'Keep 1 to 10 VM snapshots.',
  vm_ip_mode_invalid: 'Choose Static or DHCP.',
  vm_ip_invalid: 'Use an address with its prefix, like 10.10.48.70/24.',
  vm_gateway_invalid: "The gateway must be another address in the VM's network.",
  vm_not_allowed: 'Only a Proxmox environment has a VM.',
  vm_disk_shrink: "A VM's disk can grow but never shrink.",
  ip_in_use: 'That address is already used: by the proxy, an SSH target or another environment.',
  adopt_not_allowed: 'Only environments on SSH targets can be adopted. Proxmox environments are ones Sirdar builds.',
  host_ip_managed: "A Proxmox environment's services always run on its VM.",
  target_kind_locked: "An environment can't move between an SSH target and Proxmox.",
  vm_snapshot_not_allowed: 'Only a Proxmox environment takes VM snapshots.',
  vm_snapshot_invalid: "That isn't one of this environment's VM snapshots.",
  vm_snapshot_not_found: "That VM snapshot isn't one Sirdar took for this environment.",
  vm_snapshot_keys_changed: 'That VM snapshot was taken before the sign-in keys changed, so nobody could sign in after restoring it.',
  not_proxmox: "This environment isn't on Proxmox.",
  vm_not_ready: "This environment's VM isn't built yet. Deploy it first.",
  vm_key_unreadable: "Sirdar's key for this VM doesn't open with the current SIRDAR_SECRETS_KEY.",
```

In `deployErrorText`, replace:

```ts
  const d = errorDetail<{ reason?: unknown; missing?: unknown; key?: unknown; service?: unknown; kinds?: unknown }>(err);
  if (d && typeof d.reason === 'string' && d.reason) return d.reason;
```

with:

```ts
  const d = errorDetail<{
    reason?: unknown; missing?: unknown; key?: unknown; service?: unknown; kinds?: unknown; environments?: unknown;
  }>(err);
  if (d && typeof d.reason === 'string' && d.reason) return d.reason;
  if (d && Array.isArray(d.environments) && d.environments.length && err instanceof ApiError
      && err.code === 'integration_in_use') {
    return `Environments still use it: ${d.environments.join(', ')}. Delete them first.`;
  }
```

Replace:

```ts
export type DeploymentMode = DeployMode | 'adopt' | 'snapshot' | 'rollback' | 'publish' | 'teardown';
```

with:

```ts
export type DeploymentMode = DeployMode | 'adopt' | 'snapshot' | 'rollback' | 'publish' | 'teardown' | 'vm_restore';
```

In `DeploymentSummary`, replace:

```ts
  /** Its plan ends with steps 12–14 (DNS records, proxy hosts, smoke test). */
  publish: boolean;
```

with:

```ts
  /** Its plan ends with steps 12–14 (DNS records, proxy hosts, smoke test). */
  publish: boolean;
  /** Its plan has the VM steps (a Proxmox environment): 0 Prepare VM, 0 Restore VM snapshot or 15 Destroy VM. */
  vm: boolean;
  /** Step 0 takes a VM snapshot before anything changes. */
  take_vm_snapshot: boolean;
  /** The VM snapshot it took — for vm_restore, the one it restores. */
  vm_snapshot: string | null;
```

In `Environment`, replace:

```ts
  id: string; name: string; type: EnvType; target: string; base_domain: string; env_dir: string;
```

with:

```ts
  id: string; name: string; type: EnvType; target: string; base_domain: string; env_dir: string;
  /** 'proxmox': its host is a VM Sirdar builds (`vm`); 'ssh': a saved SSH target. */
  target_kind: 'ssh' | 'proxmox';
  vm: EnvVm | null;
```

After the `ManagedRecordRef` interface, add:

```ts
/** A Proxmox environment's VM. `vmid` is null until step 0 reserves it; `ip` until the guest agent reports it. */
export interface EnvVm {
  name: string; node: string; vmid: number | null; cores: number; memory_mb: number; disk_gb: number;
  ip_mode: 'static' | 'dhcp'; ip_cidr: string | null; gateway: string | null; ip: string | null;
  keep_snapshots: number; created: boolean;
}
export interface VmDefaults {
  cores: number; memory_mb: number; disk_gb: number; keep_snapshots: number;
  limits: Record<'cores' | 'memory_mb' | 'disk_gb' | 'keep_snapshots', [number, number]>;
}
export interface NewVm {
  cores?: number; memory_mb?: number; disk_gb?: number; ip_mode: 'static' | 'dhcp'; ip_cidr?: string; gateway?: string;
}
/** A VM snapshot Sirdar took (GET …/vm-snapshots): `sha` is the commit it holds. */
export interface VmSnapshot {
  name: string; taken_at: string; sha: string | null; deployment_id: string; description: string;
  restorable: boolean; reason: string | null;
}
```

In `EnvironmentDefaults`, replace:

```ts
  spaces_bucket: string; log_levels: string[]; optional_secrets: string[];
}
```

with:

```ts
  spaces_bucket: string; log_levels: string[]; optional_secrets: string[];
  vm: VmDefaults;
}
```

In `NewEnvironmentBody`, replace:

```ts
  /** Deploys publish DNS records and proxy hosts (the API's default: true). */
  publish?: boolean;
}
export interface AdoptEnvironmentBody
```

with:

```ts
  /** Deploys publish DNS records and proxy hosts (the API's default: true). */
  publish?: boolean;
  /** target 'proxmox' only: the VM step 0 builds. */
  vm?: NewVm;
}
export interface AdoptEnvironmentBody
```

In `EnvironmentPatch`, replace:

```ts
  secrets?: Record<string, string>;
  publish?: boolean;
}
```

with:

```ts
  secrets?: Record<string, string>;
  publish?: boolean;
  vm?: { cores?: number; memory_mb?: number; disk_gb?: number; keep_snapshots?: number };
}
```

In `DeploymentBody`, replace:

```ts
  mode: DeployMode | 'publish' | 'teardown'; git_ref?: string; confirm_name?: string;
```

with:

```ts
  mode: DeployMode | 'publish' | 'teardown' | 'vm_restore'; git_ref?: string; confirm_name?: string;
  /** Proxmox update / reset / restore_dump: a VM snapshot first (the API's default: yes once deployed). */
  take_vm_snapshot?: boolean;
  /** vm_restore only: a name from listVmSnapshots. */
  vm_snapshot?: string;
```

Replace:

```ts
export const listBackups = (name: string) => getJson<{ backups: Backup[] }>(`${envPath(name)}/backups`);
```

with:

```ts
export const listBackups = (name: string) => getJson<{ backups: Backup[] }>(`${envPath(name)}/backups`);
export const listVmSnapshots = (name: string) =>
  getJson<{ snapshots: VmSnapshot[] }>(`${envPath(name)}/vm-snapshots`);
```

Replace:

```ts
export type IntegrationKind = 'cloudflare' | 'npm';
export const INTEGRATION_LABEL: Record<IntegrationKind, string> = {
  cloudflare: 'Cloudflare', npm: 'Nginx Proxy Manager',
};
```

with:

```ts
/** The integrations Sirdar publishes with. */
export type PublishKind = 'cloudflare' | 'npm';
export type IntegrationKind = PublishKind | 'proxmox';
export const INTEGRATION_LABEL: Record<IntegrationKind, string> = {
  cloudflare: 'Cloudflare', npm: 'Nginx Proxy Manager', proxmox: 'Proxmox',
};
```

Replace:

```ts
export interface Integrations { secrets_key_configured: boolean; cloudflare: CloudflareIntegration; npm: NpmIntegration }
/** An omitted secret keeps the stored one. */
export interface CloudflareBody { zone: string; public_ip: string; token?: string }
export interface NpmBody { url: string; identity: string; letsencrypt_email?: string; password?: string }
```

with:

```ts
export interface ProxmoxIntegration {
  configured: boolean; url: string | null; node: string | null; pool: string | null; storage: string | null;
  bridge: string | null; vlan_tag: number | null; template_vmid: number | null;
  /** The pinned certificate's SHA-256 fingerprint, AB:CD:… */
  tls_fingerprint: string | null;
  /** user@realm!tokenid — the part of the token that isn't secret. */
  token_id: string | null; token_set: boolean; updated_at: string | null; updated_by_name: string | null;
}
export interface Integrations {
  secrets_key_configured: boolean; cloudflare: CloudflareIntegration; npm: NpmIntegration; proxmox: ProxmoxIntegration;
}
/** An omitted secret keeps the stored one. */
export interface CloudflareBody { zone: string; public_ip: string; token?: string }
export interface NpmBody { url: string; identity: string; letsencrypt_email?: string; password?: string }
/** tls_fingerprint: the certificate the user trusted (null: show it first). An omitted token keeps the stored one. */
export interface ProxmoxBody {
  url: string; node: string; pool: string; storage: string; bridge: string; vlan_tag: number | null;
  template_vmid: number; tls_fingerprint: string | null; token?: string;
}
/** A Proxmox server's certificate, as tls_untrusted describes it. */
export interface TlsCertificate { fingerprint: string; subject: string; issuer: string; not_after: string; names: string[] }
```

Replace:

```ts
export const saveIntegration = (kind: IntegrationKind, body: CloudflareBody | NpmBody) =>
```

with:

```ts
export const saveIntegration = (kind: IntegrationKind, body: CloudflareBody | NpmBody | ProxmoxBody) =>
```

and replace:

```ts
export const testIntegration = (kind: IntegrationKind, body?: CloudflareBody | NpmBody) =>
```

with:

```ts
export const testIntegration = (kind: IntegrationKind, body?: CloudflareBody | NpmBody | ProxmoxBody) =>
```

- [ ] **Step 4: Keep the publishing modal on the publish kinds**

The Cloudflare / NPM modal and the section's maps only know the two publishing kinds. In `sirdar/web/src/pages/settings/IntegrationModal.tsx`, replace every occurrence of `IntegrationKind` with `PublishKind` (the import and each use). In `sirdar/web/src/pages/settings/IntegrationsSection.tsx`, do the same (Task 2 adds Proxmox there).

- [ ] **Step 5: Labels**

In `sirdar/web/src/pages/environments/labels.tsx`:

Replace:

```ts
import type { DeployTarget, DeploymentStep, Environment, Snapshot } from '../../lib/sirdarApi';
```

with:

```ts
import type { DeployTarget, DeploymentStep, EnvVm, Environment, Snapshot } from '../../lib/sirdarApi';
```

Replace:

```ts
  restore_dump: 'Restore backup', rollback: 'Roll back', publish: 'Publish', teardown: 'Delete environment',
};
```

with:

```ts
  restore_dump: 'Restore backup', rollback: 'Roll back', publish: 'Publish', teardown: 'Delete environment',
  vm_restore: 'Restore VM snapshot',
};
```

Replace:

```ts
export const GATED_MODES = ['reset', 'restore_dump', 'rollback', 'teardown'];
export const RETRY_MODES = ['update', 'reset', 'restore_dump', 'rollback', 'publish', 'teardown'];
```

with:

```ts
export const GATED_MODES = ['reset', 'restore_dump', 'rollback', 'teardown', 'vm_restore'];
export const RETRY_MODES = ['update', 'reset', 'restore_dump', 'rollback', 'publish', 'teardown', 'vm_restore'];
```

Append to the end of the file:

```ts
/** Targets a new environment can use: configured SSH targets, then Proxmox once it is set up. */
export const envTargets = (targets: DeployTarget[]) =>
  [...sshTargets(targets), ...targets.filter((t) => t.id === 'proxmox' && t.configured)];

/** Its host is a VM Sirdar builds on Proxmox. */
export const onProxmox = (env: Environment) => env.target_kind === 'proxmox';

/** "4 vCPU · 8 GB · 64 GB disk" */
export const vmSize = (vm: Pick<EnvVm, 'cores' | 'memory_mb' | 'disk_gb'>) =>
  `${vm.cores} vCPU · ${Math.round((vm.memory_mb / 1024) * 10) / 10} GB · ${vm.disk_gb} GB disk`;

/** "10.10.48.70/24 via 10.10.48.1", or "DHCP". */
export const vmNetwork = (vm: Pick<EnvVm, 'ip_mode' | 'ip_cidr' | 'gateway'>) =>
  vm.ip_mode === 'static' ? `${vm.ip_cidr} via ${vm.gateway}` : 'DHCP';
```

- [ ] **Step 6: Fixtures**

In `sirdar/web/src/pages/environments/testData.ts`:

Replace the import block:

```ts
import type {
  Backup, Deployment, DeploymentStatus, DeploymentStep, DeploymentSummary, DeployTarget, Environment,
  EnvironmentDefaults, EnvService, IntegrationCheck, Integrations, PublishPlan, Snapshot, StepStatus,
} from '../../lib/sirdarApi';
```

with:

```ts
import type {
  Backup, Deployment, DeploymentStatus, DeploymentStep, DeploymentSummary, DeployTarget, EnvVm, Environment,
  EnvironmentDefaults, EnvService, IntegrationCheck, Integrations, PublishPlan, Snapshot, StepStatus, TlsCertificate,
  VmSnapshot,
} from '../../lib/sirdarApi';
```

In `ADOPTED`, replace:

```ts
  failed_step: null, dump_path: null, snapshot: null, restore_dump: null, rollback_available: false, publish: false,
  previous_sha: null, error: null, actor_name: 'Jimmy Henderson',
```

with:

```ts
  failed_step: null, dump_path: null, snapshot: null, restore_dump: null, rollback_available: false, publish: false,
  vm: false, take_vm_snapshot: false, vm_snapshot: null,
  previous_sha: null, error: null, actor_name: 'Jimmy Henderson',
```

In `ENV`, replace:

```ts
  id: 'e1', name: 'uat', type: 'dev', target: 'ssh:lab', base_domain: 'uat.serversherpa.com',
```

with:

```ts
  id: 'e1', name: 'uat', type: 'dev', target: 'ssh:lab', target_kind: 'ssh', vm: null,
  base_domain: 'uat.serversherpa.com',
```

In `DEFAULTS`, replace:

```ts
  optional_secrets: ['SS_ANTHROPIC_API_KEY', 'SS_DB_TESTING_PASSWORD'],
};
```

with:

```ts
  optional_secrets: ['SS_ANTHROPIC_API_KEY', 'SS_DB_TESTING_PASSWORD'],
  vm: { cores: 4, memory_mb: 8192, disk_gb: 64, keep_snapshots: 3,
        limits: { cores: [1, 64], memory_mb: [2048, 262144], disk_gb: [20, 4096], keep_snapshots: [1, 10] } },
};
```

In `deployment()`, replace:

```ts
    dump_path: null, snapshot: null, restore_dump: null, rollback_available: false, publish: false,
    previous_sha: SHA, error: null, actor_name: 'Jimmy Henderson',
```

with:

```ts
    dump_path: null, snapshot: null, restore_dump: null, rollback_available: false, publish: false,
    vm: false, take_vm_snapshot: false, vm_snapshot: null,
    previous_sha: SHA, error: null, actor_name: 'Jimmy Henderson',
```

In `summary()`, replace:

```ts
    restore_dump: d.restore_dump, rollback_available: d.rollback_available, publish: d.publish,
```

with:

```ts
    restore_dump: d.restore_dump, rollback_available: d.rollback_available, publish: d.publish,
    vm: d.vm, take_vm_snapshot: d.take_vm_snapshot, vm_snapshot: d.vm_snapshot,
```

In `INTEGRATIONS`, replace:

```ts
  npm: { configured: true, url: 'http://10.10.48.6:81', identity: 'admin@example.com',
         letsencrypt_email: 'admin@example.com', password_set: true,
         updated_at: '2026-10-04T15:05:00Z', updated_by_name: 'Jimmy Henderson' },
};
```

with:

```ts
  npm: { configured: true, url: 'http://10.10.48.6:81', identity: 'admin@example.com',
         letsencrypt_email: 'admin@example.com', password_set: true,
         updated_at: '2026-10-04T15:05:00Z', updated_by_name: 'Jimmy Henderson' },
  proxmox: { configured: true, url: 'https://10.10.48.5:8006', node: 'pve', pool: 'sirdar', storage: 'local-lvm',
             bridge: 'vmbr0', vlan_tag: null, template_vmid: 9000,
             tls_fingerprint: fingerprint(7),
             token_id: 'sirdar@pve!sirdar', token_set: true,
             updated_at: '2026-10-04T16:00:00Z', updated_by_name: 'Jimmy Henderson' },
};
```

In `NO_INTEGRATIONS`, replace:

```ts
  npm: { configured: false, url: null, identity: null, letsencrypt_email: null, password_set: false,
         updated_at: null, updated_by_name: null },
};
```

with:

```ts
  npm: { configured: false, url: null, identity: null, letsencrypt_email: null, password_set: false,
         updated_at: null, updated_by_name: null },
  proxmox: { configured: false, url: null, node: null, pool: null, storage: null, bridge: null, vlan_tag: null,
             template_vmid: null, tls_fingerprint: null, token_id: null, token_set: false, updated_at: null,
             updated_by_name: null },
};
```

Append to the end of the file:

```ts
/* ---- Proxmox (phase 5) ---- */
/** A made-up SHA-256 fingerprint in Proxmox's format: 32 hex pairs, AB:CD:… (95 characters). */
function fingerprint(seed: number): string {
  return Array.from({ length: 32 }, (_, i) => ((i * seed + 17) % 256).toString(16).toUpperCase().padStart(2, '0'))
    .join(':');
}
export const PX_FINGERPRINT = INTEGRATIONS.proxmox.tls_fingerprint!;
/** What tls_untrusted describes: a new server's certificate. */
export const PX_CERT: TlsCertificate = {
  fingerprint: fingerprint(13),
  subject: 'pve.lab', issuer: 'Proxmox Virtual Environment', not_after: '2027-10-04T00:00:00+00:00',
  names: ['pve', 'pve.lab', '10.10.48.5'],
};
export const PX_TOKEN = 'sirdar@pve!sirdar=1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
export const PX_CHECK: IntegrationCheck = {
  ok: true, target: 'proxmox',
  checks: [
    { label: 'Proxmox', status: 'pass', value: 'Version 9.0.10' },
    { label: 'Node', status: 'pass', value: 'pve' },
    { label: 'Pool', status: 'pass', value: 'sirdar · 1 VMs' },
    { label: 'Template', status: 'pass', value: 'ubuntu-2404-template (9000)' },
    { label: 'Storage', status: 'pass', value: 'local-lvm · 500 GB free' },
    { label: 'Bridge', status: 'pass', value: 'vmbr0' },
  ],
  facts: { url: 'https://10.10.48.5:8006', node: 'pve', version: '9.0.10', token_id: 'sirdar@pve!sirdar' },
};
export const PX_TARGETS = {
  ...TARGETS,
  targets: [...TARGETS.targets,
            { id: 'proxmox', label: 'Proxmox', kind: 'proxmox', available: true, configured: true } as DeployTarget],
};
export const PX_VM: EnvVm = {
  name: 'ss-uat3', node: 'pve', vmid: 120, cores: 4, memory_mb: 8192, disk_gb: 64, ip_mode: 'static',
  ip_cidr: '10.10.48.70/24', gateway: '10.10.48.1', ip: '10.10.48.70', keep_snapshots: 3, created: true,
};
/** uat3 on Proxmox, deployed. */
export const PX_ENV: Environment = {
  ...ENV, id: 'e3', name: 'uat3', target: 'proxmox', target_kind: 'proxmox', vm: PX_VM,
  base_domain: 'uat3.serversherpa.com', env_dir: '/opt/serversherpa/uat3', secrets_set: {},
  services: ENV.services.map((s) => ({
    ...s, host_ip: '10.10.48.70', hostname: s.hostname ? s.hostname.replace('.uat.', '.uat3.') : null })),
};
/** uat3 just created: no VM yet, never deployed. */
export const PX_NEW_ENV: Environment = {
  ...PX_ENV, status: 'new', current_sha: null, image_tag: null, last_deployment: null,
  vm: { ...PX_VM, vmid: null, ip: null, created: false },
};
export const VM_SNAPSHOTS: VmSnapshot[] = [
  { name: 'sirdar-20261004T120000Z', taken_at: '2026-10-04T12:00:00Z', sha: SHA, deployment_id: 'd10',
    description: 'Sirdar: before update of uat3', restorable: true, reason: null },
  { name: 'sirdar-20261002T080000Z', taken_at: '2026-10-02T08:00:00Z', sha: NEW_SHA, deployment_id: 'd9',
    description: 'Sirdar: before reset of uat3', restorable: false, reason: KEYS_CHANGED_REASON },
];
const VM_UPDATE_PLAN: [number, string, string][] = [[0, 'provision', 'Prepare VM'], ...UPDATE_PLAN];
const VM_UP_FAILED: StepStatus[] = [
  'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'failed'];
/** A failed Update of uat3 whose step 0 took a VM snapshot (and that can also roll back its dump). */
export const VM_ROLLBACKABLE = deployment('failed', VM_UP_FAILED, { 10: 'migrate exited 1\n' }, {
  id: 'd11', environment: 'uat3', vm: true, take_vm_snapshot: true, vm_snapshot: 'sirdar-20261004T120000Z',
  failed_step: 10, error: 'Step 10 (Start services) failed. See its log.',
  dump_path: '/opt/serversherpa/uat3/backups/20261004T120500Z.dump', rollback_available: true,
  steps: steps(VM_UPDATE_PLAN, VM_UP_FAILED, { 10: 'migrate exited 1\n' }),
});
```

`TARGETS`, `UPDATE_PLAN`, `steps`, `deployment`, `KEYS_CHANGED_REASON`, `SHA` and `NEW_SHA` are already defined above in this file; `fingerprint` is a function declaration, so `INTEGRATIONS` (earlier in the file) can call it.

- [ ] **Step 7: Run the tests and the type-check**

Run: `npm --prefix sirdar/web test -- --run src/lib/sirdarApi.test.ts src/pages/environments/labels.test.ts`
Expected: PASS.

Run: `npm --prefix sirdar/web run build`
Expected: the type-check and build succeed (every existing test fixture still satisfies the widened types).

Run: `npm --prefix sirdar/web test`
Expected: PASS (nothing else changed behavior).

- [ ] **Step 8: Commit**

```bash
git add sirdar/web/src/lib/sirdarApi.ts sirdar/web/src/lib/sirdarApi.test.ts \
  sirdar/web/src/pages/environments/labels.tsx sirdar/web/src/pages/environments/labels.test.ts \
  sirdar/web/src/pages/environments/testData.ts sirdar/web/src/pages/settings/IntegrationModal.tsx \
  sirdar/web/src/pages/settings/IntegrationsSection.tsx
git commit -m "feat(sirdar-web): Proxmox and VM shapes in the API client, labels and fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Proxmox in Settings › Integrations, and the Deploy page's Proxmox card

**Files:**
- Create: `sirdar/web/src/pages/settings/ProxmoxModal.tsx`, `sirdar/web/src/pages/settings/ProxmoxModal.test.tsx`
- Modify: `sirdar/web/src/pages/settings/IntegrationsSection.tsx`, `IntegrationsSection.test.tsx`
- Modify: `sirdar/web/src/pages/Deploy.tsx`, `sirdar/web/src/pages/Deploy.test.tsx`
- Modify: `sirdar/web/src/styles/sirdar.css`

**Interfaces:**
- Consumes: `saveIntegration`, `testIntegration`, `ProxmoxBody`, `TlsCertificate`, `Integrations` (Task 1); `CheckList`, `SecretField`.
- Produces: `ProxmoxModal({ current: Integrations; onSaved: (saved: Integrations) => void; onClose: () => void })` — dialog named "Proxmox"; a group named "Server certificate" while a certificate waits to be trusted, with "Trust this certificate" (tls_untrusted) or "Trust the new certificate" (tls_mismatch), each re-sending the same Test or Save with that fingerprint; the CheckList is named "Proxmox test".

- [ ] **Step 1: Write the failing modal tests**

Create `sirdar/web/src/pages/settings/ProxmoxModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ saveIntegration: vi.fn(), testIntegration: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import type { Integrations } from '../../lib/sirdarApi';
import { INTEGRATIONS, NO_INTEGRATIONS, PX_CERT, PX_CHECK, PX_FINGERPRINT, PX_TOKEN } from '../environments/testData';

import ProxmoxModal from './ProxmoxModal';

const UNTRUSTED = new ApiError(409, 'tls_untrusted', { code: 'tls_untrusted', ...PX_CERT });
const FIELDS = { url: 'https://10.10.48.5:8006', node: 'pve', pool: 'sirdar', storage: 'local-lvm', bridge: 'vmbr0',
                 vlan_tag: null, template_vmid: 9000 };

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.saveIntegration.mockResolvedValue(INTEGRATIONS);
  api.testIntegration.mockResolvedValue(PX_CHECK);
});
afterEach(cleanup);

function show(current: Integrations = NO_INTEGRATIONS) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<ProxmoxModal current={current} onSaved={onSaved} onClose={onClose} />);
  return { onSaved, onClose, dialog: screen.getByRole('dialog', { name: 'Proxmox' }) };
}

it('sets up Proxmox: the certificate is shown and trusted, then the same save is sent with it', async () => {
  api.saveIntegration.mockRejectedValueOnce(UNTRUSTED).mockResolvedValueOnce(INTEGRATIONS);
  const { onSaved, dialog } = show();
  expect(within(dialog).getByText('Integrations', { selector: '.eyebrow' })).toBeTruthy();
  expect((within(dialog).getByLabelText('Node') as HTMLInputElement).value).toBe('pve');
  expect((within(dialog).getByLabelText('Template VM id') as HTMLInputElement).value).toBe('9000');
  expect(within(dialog).getByText(/Not trusted yet/)).toBeTruthy();
  await userEvent.type(within(dialog).getByLabelText('URL'), 'https://10.10.48.5:8006');
  await userEvent.type(within(dialog).getByLabelText('API token'), PX_TOKEN);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  const prompt = await within(dialog).findByRole('group', { name: 'Server certificate' });
  expect(within(prompt).getByText(PX_CERT.fingerprint)).toBeTruthy();
  expect(within(prompt).getByText('pve, pve.lab, 10.10.48.5')).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
  await userEvent.click(within(prompt).getByRole('button', { name: 'Trust this certificate' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(INTEGRATIONS));
  expect(api.saveIntegration.mock.calls[0]).toEqual(['proxmox', { ...FIELDS, tls_fingerprint: null, token: PX_TOKEN }]);
  expect(api.saveIntegration.mock.calls[1]).toEqual(
    ['proxmox', { ...FIELDS, tls_fingerprint: PX_CERT.fingerprint, token: PX_TOKEN }]);
});

it('checks the fields before sending anything', async () => {
  const { dialog } = show();
  await userEvent.type(within(dialog).getByLabelText('URL'), 'http://pve:8006');
  await userEvent.type(within(dialog).getByLabelText('VLAN tag'), '5000');
  await userEvent.type(within(dialog).getByLabelText('API token'), 'root@pam');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(within(dialog).getByText('Start with https://, then the host and port only.')).toBeTruthy();
  expect(within(dialog).getByText('Use a VLAN tag from 1 to 4094, or leave it empty.')).toBeTruthy();
  expect(within(dialog).getByText('Paste the whole token: user@realm!tokenid=secret.')).toBeTruthy();
  expect(api.saveIntegration).not.toHaveBeenCalled();
});

it('editing keeps the trusted certificate and the stored token; Test lists the checks', async () => {
  const { dialog } = show(INTEGRATIONS);
  expect(within(dialog).getByText('API token: set')).toBeTruthy();
  expect(within(dialog).getByText(PX_FINGERPRINT)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  const list = await within(dialog).findByRole('list', { name: 'Proxmox test' });
  expect(within(list).getByText('Version 9.0.10')).toBeTruthy();
  expect(api.testIntegration).toHaveBeenCalledWith('proxmox', { ...FIELDS, tls_fingerprint: PX_FINGERPRINT });
  await userEvent.type(within(dialog).getByLabelText('Pool'), '2');
  expect(within(dialog).queryByRole('list', { name: 'Proxmox test' })).toBeNull();
});

it('another server needs its certificate and the token again', async () => {
  const { dialog } = show(INTEGRATIONS);
  const url = within(dialog).getByLabelText('URL');
  await userEvent.clear(url);
  await userEvent.type(url, 'https://10.10.48.9:8006');
  expect(within(dialog).getByText(/Not trusted yet/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(within(dialog).getByText('Enter the API token again for a different server.')).toBeTruthy();
  expect(api.saveIntegration).not.toHaveBeenCalled();
});

it('a changed certificate is shown side by side and trusted only on purpose', async () => {
  api.testIntegration.mockRejectedValueOnce(new ApiError(409, 'tls_mismatch',
    { code: 'tls_mismatch', expected: PX_FINGERPRINT, actual: PX_CERT.fingerprint }));
  const { dialog } = show(INTEGRATIONS);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  const prompt = await within(dialog).findByRole('group', { name: 'Server certificate' });
  expect(within(prompt).getByText(/renewed on purpose/)).toBeTruthy();
  expect(within(prompt).getByText(PX_CERT.fingerprint)).toBeTruthy();
  await userEvent.click(within(prompt).getByRole('button', { name: 'Trust the new certificate' }));
  await within(dialog).findByRole('list', { name: 'Proxmox test' });
  expect(api.testIntegration.mock.calls[1][1].tls_fingerprint).toBe(PX_CERT.fingerprint);
});

it('Check again forgets the pin so the next Test shows the live certificate', async () => {
  api.testIntegration.mockRejectedValueOnce(UNTRUSTED);
  const { dialog } = show(INTEGRATIONS);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Check again' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  await within(dialog).findByRole('group', { name: 'Server certificate' });
  expect(api.testIntegration.mock.calls[0][1].tls_fingerprint).toBeNull();
});

it('API errors land on their field; a failed test shows the reason', async () => {
  api.saveIntegration.mockRejectedValue(new ApiError(422, 'node_invalid', { code: 'node_invalid' }));
  api.testIntegration.mockRejectedValue(new ApiError(502, 'connect_failed',
    { code: 'connect_failed', reason: 'Proxmox rejected the API token.' }));
  const { dialog } = show(INTEGRATIONS);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText("That node name isn't valid.")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  expect(await within(dialog).findByText('Proxmox rejected the API token.')).toBeTruthy();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- --run src/pages/settings/ProxmoxModal.test.tsx`
Expected: FAIL — cannot resolve `./ProxmoxModal`.

- [ ] **Step 3: Write the modal**

Create `sirdar/web/src/pages/settings/ProxmoxModal.tsx`:

```tsx
/** Set up or change the Proxmox integration: where Sirdar builds Proxmox
 *  environments' VMs (URL, node, pool, storage, bridge, VLAN tag, template)
 *  and the API token, write-only. The server's TLS certificate is pinned
 *  trust-on-first-use: Test or Save first answers with the certificate, the
 *  user compares its fingerprint with Proxmox's own and trusts it, and the
 *  same request goes again with that fingerprint. */
import { type RefObject, useEffect, useRef, useState } from 'react';

import CheckList from '../../components/CheckList';
import SecretField, { type SecretAction } from '../../components/SecretField';
import {
  deployErrorText, errorDetail, saveIntegration, testIntegration,
  type IntegrationCheck, type Integrations, type ProxmoxBody, type TlsCertificate,
} from '../../lib/sirdarApi';
import { when } from '../environments/labels';

type Field = 'url' | 'node' | 'pool' | 'storage' | 'bridge' | 'vlan' | 'template' | 'secret' | 'form';
type Errors = Partial<Record<Field, string>>;
type What = 'test' | 'save';
/** A certificate waiting for the user: a new one (tls_untrusted) or a changed one (tls_mismatch). */
type Pending = { kind: 'untrusted'; what: What; cert: TlsCertificate }
  | { kind: 'changed'; what: What; expected: string; actual: string };
/** API error code → the field it belongs to. */
const CODE_FIELD: Record<string, Field> = {
  proxmox_url_invalid: 'url', node_invalid: 'node', pool_invalid: 'pool', storage_invalid: 'storage',
  bridge_invalid: 'bridge', vlan_tag_invalid: 'vlan', template_vmid_invalid: 'template',
  proxmox_token_invalid: 'secret', secret_required: 'secret',
};
const URL_RE = /^https:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?\/?$/;
const TOKEN_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z][A-Za-z0-9._-]+=[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function TextField({ id, label, value, error, hint, inputRef, inputMode, onChange }: {
  id: string; label: string; value: string; error?: string; hint?: string;
  inputRef?: RefObject<HTMLInputElement>; inputMode?: 'numeric'; onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} ref={inputRef} type="text" value={value} autoComplete="off" spellCheck={false}
             inputMode={inputMode} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="page-hint">{hint}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

export default function ProxmoxModal({ current, onSaved, onClose }: {
  current: Integrations; onSaved: (saved: Integrations) => void; onClose: () => void;
}) {
  const px = current.proxmox;
  const storedUrl = px.url ?? '';
  const [url, setUrl] = useState(storedUrl);
  const [node, setNode] = useState(px.node ?? 'pve');
  const [pool, setPool] = useState(px.pool ?? 'sirdar');
  const [storage, setStorage] = useState(px.storage ?? 'local-lvm');
  const [bridge, setBridge] = useState(px.bridge ?? 'vmbr0');
  const [vlan, setVlan] = useState(px.vlan_tag === null ? '' : String(px.vlan_tag));
  const [template, setTemplate] = useState(px.template_vmid === null ? '9000' : String(px.template_vmid));
  /** The certificate the next request trusts; null: let the server show it first. */
  const [fingerprint, setFingerprint] = useState<string | null>(px.tls_fingerprint);
  const [pending, setPending] = useState<Pending | null>(null);
  const [action, setAction] = useState<SecretAction>(px.token_set ? 'keep' : 'set');
  const [secret, setSecret] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<'' | What>('');
  const [result, setResult] = useState<IntegrationCheck | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  /** Bumped by every edit: an answer for values edited since is dropped. */
  const version = useRef(0);
  const firstRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const edited = () => { version.current += 1; setResult(null); setPending(null); };
  const edit = (set: (v: string) => void) => (v: string) => { set(v); edited(); };
  const editUrl = (v: string) => {
    setUrl(v);
    // The stored pin belongs to the stored server only.
    setFingerprint(v.trim().replace(/\/$/, '') === storedUrl ? px.tls_fingerprint : null);
    edited();
  };
  const otherServer = url.trim().replace(/\/$/, '') !== storedUrl;

  const body = (trusted: string | null): ProxmoxBody => ({
    url: url.trim(), node: node.trim(), pool: pool.trim(), storage: storage.trim(), bridge: bridge.trim(),
    vlan_tag: vlan.trim() ? Number(vlan.trim()) : null, template_vmid: Number(template.trim()),
    tls_fingerprint: trusted, ...(action === 'set' ? { token: secret.trim() } : {}),
  });

  const validate = (): Errors => {
    const e: Errors = {};
    if (!URL_RE.test(url.trim())) e.url = 'Start with https://, then the host and port only.';
    if (!NAME_RE.test(node.trim())) e.node = 'Enter the node name, like pve.';
    if (!NAME_RE.test(pool.trim())) e.pool = 'Enter the pool Sirdar works in.';
    if (!NAME_RE.test(storage.trim())) e.storage = 'Enter the storage for VM disks, like local-lvm.';
    if (!NAME_RE.test(bridge.trim())) e.bridge = 'Enter the network bridge, like vmbr0.';
    const tag = vlan.trim();
    if (tag && (!/^\d+$/.test(tag) || Number(tag) < 1 || Number(tag) > 4094)) {
      e.vlan = 'Use a VLAN tag from 1 to 4094, or leave it empty.';
    }
    if (!/^\d+$/.test(template.trim()) || Number(template.trim()) < 100) {
      e.template = "Use the template's VM id, a number from 100 up.";
    }
    if (action === 'set' && !TOKEN_RE.test(secret.trim())) e.secret = 'Paste the whole token: user@realm!tokenid=secret.';
    if (action === 'keep' && otherServer && px.token_set) e.secret = 'Enter the API token again for a different server.';
    return e;
  };

  const run = async (what: What, trusted: string | null = fingerprint) => {
    if (busyRef.current) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    busyRef.current = what;
    setBusy(what);
    setResult(null);
    setPending(null);
    const asked = version.current;
    try {
      if (what === 'test') {
        const checked = await testIntegration('proxmox', body(trusted));
        if (asked === version.current) setResult(checked);
      } else {
        onSaved(await saveIntegration('proxmox', body(trusted)));
      }
    } catch (err) {
      if (asked !== version.current) return;
      const code = (err as { code?: string }).code ?? '';
      const d = errorDetail<Record<string, unknown>>(err);
      if (code === 'tls_untrusted' && d) {
        setPending({ kind: 'untrusted', what, cert: d as unknown as TlsCertificate });
      } else if (code === 'tls_mismatch' && d) {
        setPending({ kind: 'changed', what, expected: String(d.expected), actual: String(d.actual) });
      } else {
        setErrors({ [CODE_FIELD[code] ?? 'form']: deployErrorText(err,
          what === 'test' ? "Couldn't test these settings." : "Couldn't save these settings.") });
      }
    } finally {
      busyRef.current = '';
      setBusy('');
    }
  };

  const trust = (value: string, what: What) => {
    setFingerprint(value);
    void run(what, value);
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-proxmox-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-proxmox-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Integrations</div>
            <h3 id="sirdar-proxmox-title">Proxmox</h3>
            <p className="page-hint">
              Sirdar builds each Proxmox environment's VM here: a full clone of the template, in the pool, on the
              storage and bridge below. The token needs the privileges the README lists on that pool, storage and
              bridge.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={!!busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form sirdar-proxmox-form">
          <div className="sirdar-span2">
            <TextField id="px-url" label="URL" value={url} error={errors.url} inputRef={firstRef}
                       hint="Where Sirdar reaches the Proxmox API, like https://10.10.48.5:8006." onChange={editUrl} />
          </div>
          <TextField id="px-node" label="Node" value={node} error={errors.node} onChange={edit(setNode)} />
          <TextField id="px-pool" label="Pool" value={pool} error={errors.pool}
                     hint="Sirdar sees and changes only VMs in it." onChange={edit(setPool)} />
          <TextField id="px-storage" label="Storage" value={storage} error={errors.storage}
                     onChange={edit(setStorage)} />
          <TextField id="px-bridge" label="Bridge" value={bridge} error={errors.bridge} onChange={edit(setBridge)} />
          <TextField id="px-vlan" label="VLAN tag" value={vlan} error={errors.vlan} inputMode="numeric"
                     hint="Empty: untagged." onChange={edit(setVlan)} />
          <TextField id="px-template" label="Template VM id" value={template} error={errors.template}
                     inputMode="numeric" hint="Ubuntu 24.04 cloud-init with qemu-guest-agent."
                     onChange={edit(setTemplate)} />
          <div className="sirdar-span2">
            <span className="field-label">Certificate</span>
            {fingerprint ? (
              <div className="sirdar-secret-row">
                <span className="mono sirdar-fingerprint">{fingerprint}</span>
                <button type="button" className="mini-btn" disabled={!!busy}
                        onClick={() => { setFingerprint(null); edited(); }}>Check again</button>
              </div>
            ) : (
              <p className="page-hint">Not trusted yet. Test or Save shows the server's certificate first.</p>
            )}
          </div>
          {pending && (
            <div className="sirdar-span2 sirdar-cert-prompt" role="group" aria-label="Server certificate">
              {pending.kind === 'untrusted' ? (
                <>
                  <p>Is this the certificate Proxmox shows under the node's System › Certificates?</p>
                  <dl className="sirdar-kv">
                    <dt>SHA-256 fingerprint</dt><dd className="mono sirdar-fingerprint">{pending.cert.fingerprint}</dd>
                    <dt>Subject</dt><dd>{pending.cert.subject}</dd>
                    <dt>Issued by</dt><dd>{pending.cert.issuer}</dd>
                    <dt>Expires</dt><dd className="mono">{when(pending.cert.not_after)}</dd>
                    <dt>Names</dt><dd className="mono">{pending.cert.names.join(', ')}</dd>
                  </dl>
                  <button type="button" className="btn-solid" disabled={!!busy}
                          onClick={() => trust(pending.cert.fingerprint, pending.what)}>Trust this certificate</button>
                </>
              ) : (
                <>
                  <p className="form-error">
                    The server's certificate changed. Trust the new one only if it was renewed on purpose.
                  </p>
                  <dl className="sirdar-kv">
                    <dt>Trusted</dt><dd className="mono sirdar-fingerprint">{pending.expected}</dd>
                    <dt>Now</dt><dd className="mono sirdar-fingerprint">{pending.actual}</dd>
                  </dl>
                  <button type="button" className="btn-ghost" disabled={!!busy}
                          onClick={() => trust(pending.actual, pending.what)}>Trust the new certificate</button>
                </>
              )}
            </div>
          )}
          <div className="sirdar-span2">
            <SecretField id="px-token" label="API token" isSet={px.token_set} adding={!px.token_set}
                         action={action} value={secret} error={errors.secret} clearable={false}
                         onAction={(a) => { setAction(a); setSecret(''); edited(); }}
                         onValue={(v) => { setSecret(v); edited(); }} />
            {px.token_id && action === 'keep' && <p className="page-hint mono">{px.token_id}</p>}
          </div>
          {result && (
            <div className="sirdar-span2">
              <CheckList label="Proxmox test" checks={result.checks} />
            </div>
          )}
          {errors.form && <p className="form-error sirdar-span2" role="alert">{errors.form}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={!!busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => void run('test')}>
            {busy === 'test' ? 'Testing…' : 'Test'}
          </button>
          <button type="button" className="btn-solid" disabled={!!busy} onClick={() => void run('save')}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Append to `sirdar/web/src/styles/sirdar.css`:

```css
/* Settings › Integrations › Proxmox: three columns of short fields; the URL,
   the certificate, its trust prompt and the token span the row. */
.modal-card.reports-modal-card.rgm-card.sirdar-proxmox-card { width: min(760px, 96vw); max-width: 96vw; }
.sirdar-proxmox-form { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.sirdar-proxmox-form .sirdar-span2 { grid-column: 1 / -1; }
.sirdar-fingerprint { overflow-wrap: anywhere; }
.sirdar-cert-prompt { display: flex; flex-direction: column; gap: 10px; align-items: flex-start;
  padding: 12px; border: 1px solid var(--border, rgba(127, 127, 127, .35)); border-radius: 8px; }
@media (max-width: 760px) { .sirdar-proxmox-form { grid-template-columns: 1fr; } }
```

- [ ] **Step 4: Run the modal tests to verify they pass**

Run: `npm --prefix sirdar/web test -- --run src/pages/settings/ProxmoxModal.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: The Proxmox card — failing tests**

Append to `sirdar/web/src/pages/settings/IntegrationsSection.test.tsx`:

```tsx
it('shows the Proxmox card: where it builds VMs, the token id, never the token', async () => {
  render(<IntegrationsSection />);
  const px = await screen.findByRole('group', { name: 'Proxmox' });
  expect(within(px).getByText('Configured')).toBeTruthy();
  expect(within(px).getByText('https://10.10.48.5:8006')).toBeTruthy();
  expect(within(px).getByText('Set (sirdar@pve!sirdar)')).toBeTruthy();
  expect(within(px).getByText('ubuntu template 9000 · local-lvm · vmbr0', { exact: false })).toBeTruthy();
  await userEvent.click(within(px).getByRole('button', { name: 'Edit Proxmox' }));
  expect(screen.getByRole('dialog', { name: 'Proxmox' })).toBeTruthy();
});

it('Proxmox can only be removed when no environment uses it', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.removeIntegration.mockRejectedValue(new ApiError(409, 'integration_in_use',
    { code: 'integration_in_use', environments: ['uat3'] }));
  render(<IntegrationsSection />);
  const px = await screen.findByRole('group', { name: 'Proxmox' });
  await userEvent.click(within(px).getByRole('button', { name: 'Remove Proxmox' }));
  expect(await within(px).findByText('Environments still use it: uat3. Delete them first.')).toBeTruthy();
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- --run src/pages/settings/IntegrationsSection.test.tsx`
Expected: FAIL — no group named "Proxmox".

- [ ] **Step 7: Add Proxmox to the section**

In `sirdar/web/src/pages/settings/IntegrationsSection.tsx` (after Task 1's rename):

Replace the module docstring's first two lines:

```tsx
/** Settings › Integrations: the credentials Sirdar publishes environments
 *  with (Cloudflare DNS, Nginx Proxy Manager). Secrets are write-only: a card
```

with:

```tsx
/** Settings › Integrations: the credentials Sirdar publishes environments
 *  with (Cloudflare DNS, Nginx Proxy Manager) and builds Proxmox VMs with.
 *  Secrets are write-only: a card
```

Replace:

```tsx
import IntegrationModal from './IntegrationModal';

const KINDS: PublishKind[] = ['cloudflare', 'npm'];
const PURPOSE: Record<PublishKind, string> = {
```

with:

```tsx
import IntegrationModal from './IntegrationModal';
import ProxmoxModal from './ProxmoxModal';

const KINDS: IntegrationKind[] = ['cloudflare', 'npm', 'proxmox'];
const PURPOSE: Record<IntegrationKind, string> = {
  proxmox: 'The Proxmox host Sirdar builds a VM on for each Proxmox environment.',
```

In the import from `../../lib/sirdarApi`, add `type IntegrationKind` next to `type PublishKind`.

Replace the start of `settingsOf`:

```tsx
function settingsOf(data: Integrations, kind: PublishKind): [string, string][] {
  const set = (on: boolean) => (on ? 'Set' : 'Not set');
```

with:

```tsx
function settingsOf(data: Integrations, kind: IntegrationKind): [string, string][] {
  const set = (on: boolean) => (on ? 'Set' : 'Not set');
  if (kind === 'proxmox') {
    const p = data.proxmox;
    const where = p.template_vmid === null ? '—'
      : `ubuntu template ${p.template_vmid} · ${p.storage} · ${p.bridge}${p.vlan_tag ? ` · VLAN ${p.vlan_tag}` : ''}`;
    return [['URL', p.url ?? '—'], ['Node and pool', p.node ? `${p.node} · ${p.pool}` : '—'], ['Builds from', where],
            ['Certificate', p.tls_fingerprint ? `${p.tls_fingerprint.slice(0, 23)}…` : '—'],
            ['API token', p.token_set ? `Set (${p.token_id})` : 'Not set']];
  }
```

Replace:

```tsx
  const [editing, setEditing] = useState<PublishKind | null>(null);
  const [results, setResults] = useState<Partial<Record<PublishKind, IntegrationCheck>>>({});
  const [problems, setProblems] = useState<Partial<Record<PublishKind, string>>>({});
  const [busy, setBusy] = useState<PublishKind | null>(null);
```

with:

```tsx
  const [editing, setEditing] = useState<IntegrationKind | null>(null);
  const [results, setResults] = useState<Partial<Record<IntegrationKind, IntegrationCheck>>>({});
  const [problems, setProblems] = useState<Partial<Record<IntegrationKind, string>>>({});
  const [busy, setBusy] = useState<IntegrationKind | null>(null);
```

(If Task 1's rename left `busy` typed differently, make all four `IntegrationKind`; `forget`, `test` and `remove` take `kind: IntegrationKind` too.)

In `remove`, replace the confirm text:

```tsx
    if (!window.confirm(`Remove the ${label} credentials? Publishing stops until they are set again; `
      + `nothing changes in ${label} itself.`)) return;
```

with:

```tsx
    if (!window.confirm(kind === 'proxmox'
      ? 'Remove the Proxmox credentials? Nothing changes in Proxmox itself.'
      : `Remove the ${label} credentials? Publishing stops until they are set again; `
        + `nothing changes in ${label} itself.`)) return;
```

Replace the intro paragraph:

```tsx
      <p className="page-hint">
        Environments with Publish on use these for their DNS records and proxy hosts. Tokens and passwords are stored
        encrypted and never shown again.
      </p>
```

with:

```tsx
      <p className="page-hint">
        Environments with Publish on use Cloudflare and Nginx Proxy Manager for their DNS records and proxy hosts;
        Proxmox environments are built on Proxmox. Tokens and passwords are stored encrypted and never shown again.
      </p>
```

Replace the modal at the end:

```tsx
      {editing && data && (
        <IntegrationModal kind={editing} current={data} onClose={() => setEditing(null)}
                          onSaved={(saved) => { setData(saved); forget(editing); setEditing(null); }} />
      )}
```

with:

```tsx
      {editing && data && editing !== 'proxmox' && (
        <IntegrationModal kind={editing} current={data} onClose={() => setEditing(null)}
                          onSaved={(saved) => { setData(saved); forget(editing); setEditing(null); }} />
      )}
      {editing === 'proxmox' && data && (
        <ProxmoxModal current={data} onClose={() => setEditing(null)}
                      onSaved={(saved) => { setData(saved); forget('proxmox'); setEditing(null); }} />
      )}
```

- [ ] **Step 8: The Deploy page's Proxmox card — failing test**

Append to `sirdar/web/src/pages/Deploy.test.tsx`:

```tsx
it('the Proxmox card points to Settings and New environment instead of testing here', async () => {
  api.getDeployTargets.mockResolvedValue({ ...TARGETS, targets: [...TARGETS.targets,
    { id: 'proxmox', label: 'Proxmox', kind: 'proxmox', available: true, configured: true }] });
  render(<MemoryRouter><Deploy /></MemoryRouter>);
  const card = await screen.findByRole('radio', { name: /Proxmox/ });
  expect(within(card).getByText('PVE')).toBeTruthy();
  await userEvent.click(card);
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  expect(screen.getByText(/Test Proxmox in Settings › Integrations/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(true);
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `npm --prefix sirdar/web test -- --run src/pages/Deploy.test.tsx`
Expected: FAIL — no "PVE" initials.

- [ ] **Step 10: The card**

In `sirdar/web/src/pages/Deploy.tsx`, replace:

```tsx
const INITIALS: Record<string, string> = { aws: 'AWS', gcp: 'GC', digitalocean: 'DO', ssh: 'SSH' };
```

with:

```tsx
const INITIALS: Record<string, string> = { aws: 'AWS', gcp: 'GC', digitalocean: 'DO', ssh: 'SSH', proxmox: 'PVE' };
```

Replace:

```tsx
  const canRun = !!selected && selected.available && selected.configured && !!type && nameOk && canAdd && !running;
```

with:

```tsx
  // Proxmox is tested in Settings › Integrations; its environments are made with New environment.
  const proxmoxSelected = !!selected && kindOf(selected) === 'proxmox';
  const canRun = !!selected && selected.available && selected.configured && !!type && nameOk && canAdd && !running
    && !proxmoxSelected;
```

and, right after the `{selected?.source === 'installer' && …}` line in the Target section, add:

```tsx
        {proxmoxSelected && (
          <p className="page-hint sirdar-envnote">
            Test Proxmox in Settings › Integrations. Environments on it are made with New environment, which builds
            their VM on the first deploy.
          </p>
        )}
```

- [ ] **Step 11: Run the tests, type-check and build**

Run: `npm --prefix sirdar/web test -- --run src/pages/settings src/pages/Deploy.test.tsx`
Expected: PASS.

Run: `npm --prefix sirdar/web run build`
Expected: success.

- [ ] **Step 12: Commit**

```bash
git add sirdar/web/src/pages/settings/ProxmoxModal.tsx sirdar/web/src/pages/settings/ProxmoxModal.test.tsx \
  sirdar/web/src/pages/settings/IntegrationsSection.tsx sirdar/web/src/pages/settings/IntegrationsSection.test.tsx \
  sirdar/web/src/pages/Deploy.tsx sirdar/web/src/pages/Deploy.test.tsx sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): Proxmox in Settings › Integrations with the certificate trust prompt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: New environment on Proxmox — the Machine step

**Files:**
- Modify: `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, `NewEnvironmentModal.test.tsx`

**Interfaces:**
- Consumes: `envTargets`, `sshTargets`, `vmSize`, `vmNetwork` (Task 1); `EnvironmentDefaults.vm`, `NewEnvironmentBody.vm`.
- Produces: with the target "Proxmox", Create runs Basics › Machine › Services › Data › Review and sends `vm: {cores, memory_mb, disk_gb, ip_mode, ip_cidr?, gateway?}` (memory entered in GB). Adopt offers SSH targets only.

- [ ] **Step 1: Write the failing tests**

In `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx`, replace:

```tsx
import { DEFAULTS, ENV, INTEGRATIONS, NO_INTEGRATIONS, SNAP, SNAP_TAKING, TARGETS } from './testData';
```

with:

```tsx
import {
  DEFAULTS, ENV, INTEGRATIONS, NO_INTEGRATIONS, PX_NEW_ENV, PX_TARGETS, SNAP, SNAP_TAKING, TARGETS,
} from './testData';
```

Append:

```tsx
async function pickProxmox() {
  await userEvent.click(screen.getByRole('combobox', { name: 'Target' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Proxmox' }));
}

it('Proxmox: a Machine step sizes the VM and sets its address; Review and the request carry it', async () => {
  api.getDeployTargets.mockResolvedValue(PX_TARGETS);
  api.createEnvironment.mockResolvedValue(PX_NEW_ENV);
  const { onCreated } = await open();
  await fillBasics('uat3');
  await pickProxmox();
  await next();
  expect(['Basics', 'Machine', 'Services', 'Data', 'Review'].every((s) => screen.getByText(s))).toBe(true);
  expect(screen.getByText(/into a VM named ss-uat3/)).toBeTruthy();
  expect((screen.getByLabelText('vCPUs') as HTMLInputElement).value).toBe('4');
  expect((screen.getByLabelText('Memory (GB)') as HTMLInputElement).value).toBe('8');
  expect((screen.getByLabelText('Disk (GB)') as HTMLInputElement).value).toBe('64');
  expect(screen.getByRole('radio', { name: 'Static' }).getAttribute('aria-checked')).toBe('true');
  await next();
  expect(screen.getByText('Enter the address with its prefix, like 10.10.48.70/24.')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Address'), '10.10.48.70/24');
  await userEvent.type(screen.getByLabelText('Gateway'), '10.10.48.1');
  const cores = screen.getByLabelText('vCPUs');
  await userEvent.clear(cores);
  await userEvent.type(cores, '2');
  await next();
  expect(within(screen.getByRole('table', { name: 'Services' })).getAllByText("The VM's address")).toHaveLength(7);
  await next();
  await next();
  expect(screen.getByText('2 vCPU · 8 GB · 64 GB disk · 10.10.48.70/24 via 10.10.48.1')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(PX_NEW_ENV));
  expect(api.createEnvironment.mock.calls[0][0]).toMatchObject({
    name: 'uat3', target: 'proxmox',
    vm: { cores: 2, memory_mb: 8192, disk_gb: 64, ip_mode: 'static', ip_cidr: '10.10.48.70/24', gateway: '10.10.48.1' },
  });
});

it('Proxmox: DHCP needs no address; sizes are checked against the limits', async () => {
  api.getDeployTargets.mockResolvedValue(PX_TARGETS);
  await open();
  await fillBasics('uat3');
  await pickProxmox();
  await next();
  await userEvent.click(screen.getByRole('radio', { name: 'DHCP' }));
  expect(screen.queryByLabelText('Address')).toBeNull();
  const memory = screen.getByLabelText('Memory (GB)');
  await userEvent.clear(memory);
  await userEvent.type(memory, '1');
  await next();
  expect(screen.getByText('Use 2 to 256 GB of memory.')).toBeTruthy();
  await userEvent.clear(memory);
  await userEvent.type(memory, '4');
  await next();
  expect(screen.getByRole('table', { name: 'Services' })).toBeTruthy();
});

it('Proxmox: an address in use sends you back to Machine', async () => {
  api.getDeployTargets.mockResolvedValue(PX_TARGETS);
  api.createEnvironment.mockRejectedValue(new ApiError(409, 'ip_in_use', { code: 'ip_in_use' }));
  await open();
  await fillBasics('uat3');
  await pickProxmox();
  await next();
  await userEvent.type(screen.getByLabelText('Address'), '10.10.48.63/24');
  await userEvent.type(screen.getByLabelText('Gateway'), '10.10.48.1');
  await next();
  await next();
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  expect(await screen.findByText(/That address is already used/)).toBeTruthy();
  expect(screen.getByLabelText('Address')).toBeTruthy();
});

it('Adopt offers SSH targets only', async () => {
  api.getDeployTargets.mockResolvedValue(PX_TARGETS);
  await open();
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  await userEvent.click(screen.getByRole('combobox', { name: 'Target' }));
  expect(screen.queryByRole('button', { name: 'Proxmox' })).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- --run src/pages/environments/NewEnvironmentModal.test.tsx`
Expected: FAIL — no "Proxmox" option.

- [ ] **Step 3: The Machine step**

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`:

Replace the module docstring:

```tsx
/** New environment: Create (Basics › Services › Data › Review) makes a new
 *  environment record with generated secrets, empty or seeded from a snapshot
 *  its first deploy restores; Adopt (Basics › Result) reads a hand-built
 *  environment's .env and checkout over SSH and changes nothing. */
```

with:

```tsx
/** New environment: Create (Basics › Services › Data › Review) makes a new
 *  environment record with generated secrets, empty or seeded from a snapshot
 *  its first deploy restores; on Proxmox a Machine step sizes the VM the
 *  first deploy builds and sets its address. Adopt (Basics › Result) reads a
 *  hand-built environment's .env and checkout over SSH and changes nothing. */
```

Replace the `./labels` import:

```tsx
import { TYPE_LABEL, snapshotLabel, sshTargets } from './labels';
```

with:

```tsx
import { TYPE_LABEL, envTargets, snapshotLabel, sshTargets, vmNetwork, vmSize } from './labels';
```

Replace:

```tsx
type Step = 'basics' | 'services' | 'data' | 'review' | 'result';
type DataMode = 'empty' | 'snapshot';
type Field = 'name' | 'target' | 'ref' | 'domain' | 'proxy' | 'bind' | 'services' | 'data' | 'form';
```

with:

```tsx
type Step = 'basics' | 'machine' | 'services' | 'data' | 'review' | 'result';
type DataMode = 'empty' | 'snapshot';
type IpMode = 'static' | 'dhcp';
type Field = 'name' | 'target' | 'ref' | 'domain' | 'proxy' | 'bind' | 'machine' | 'services' | 'data' | 'form';
```

Replace:

```tsx
const STEPS: Record<Mode, [Step, string][]> = {
  new: [['basics', 'Basics'], ['services', 'Services'], ['data', 'Data'], ['review', 'Review']],
  adopt: [['basics', 'Basics'], ['result', 'Result']],
};
```

with:

```tsx
const STEPS: Record<Mode, [Step, string][]> = {
  new: [['basics', 'Basics'], ['services', 'Services'], ['data', 'Data'], ['review', 'Review']],
  adopt: [['basics', 'Basics'], ['result', 'Result']],
};
const PROXMOX_STEPS: [Step, string][] = [
  ['basics', 'Basics'], ['machine', 'Machine'], ['services', 'Services'], ['data', 'Data'], ['review', 'Review'],
];
const IP_MODES: [IpMode, string][] = [['static', 'Static'], ['dhcp', 'DHCP']];
const CIDR_RE = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;
```

Replace:

```tsx
const HINT: Record<Mode, string> = {
  new: 'Create an environment on an SSH target. Sirdar generates its secrets; the first deploy builds it.',
```

with:

```tsx
const HINT: Record<Mode, string> = {
  new: 'Create an environment on an SSH target, or on a VM Sirdar builds on Proxmox. Sirdar generates its secrets; '
    + 'the first deploy builds it.',
```

In `CODE_FIELD`, replace:

```tsx
  snapshot_not_found: 'data', snapshot_not_ready: 'data',
};
```

with:

```tsx
  snapshot_not_found: 'data', snapshot_not_ready: 'data',
  integration_not_configured: 'target', adopt_not_allowed: 'target', vm_not_allowed: 'target',
  vm_cores_invalid: 'machine', vm_memory_invalid: 'machine', vm_disk_invalid: 'machine',
  vm_ip_mode_invalid: 'machine', vm_ip_invalid: 'machine', vm_gateway_invalid: 'machine', ip_in_use: 'machine',
};
```

After `const [publish, setPublish] = useState<PublishChoice>('on');`, add:

```tsx
  const [cores, setCores] = useState('4');
  const [memoryGb, setMemoryGb] = useState('8');
  const [diskGb, setDiskGb] = useState('64');
  const [ipMode, setIpMode] = useState<IpMode>('static');
  const [ipCidr, setIpCidr] = useState('');
  const [gateway, setGateway] = useState('');
```

In the loading effect, replace:

```tsx
      const ssh = sshTargets(t.targets);
      setTargets(ssh);
      setDefaults(d);
      setTarget((cur) => cur || ssh[0]?.id || '');
```

with:

```tsx
      const usable = envTargets(t.targets);
      setTargets(usable);
      setDefaults(d);
      setTarget((cur) => cur || usable[0]?.id || '');
      setCores(String(d.vm.cores));
      setMemoryGb(String(d.vm.memory_mb / 1024));
      setDiskGb(String(d.vm.disk_gb));
```

After `const targetName = …;`, add:

```tsx
  const onVm = mode === 'new' && target === 'proxmox';
  // Adopt reads a hand-built environment over SSH: Proxmox environments are only ones Sirdar builds.
  const offered = (targets ?? []).filter((t) => mode === 'new' || t.id !== 'proxmox');
  useEffect(() => {
    if (mode === 'adopt' && target === 'proxmox') setTarget(sshTargets(targets ?? [])[0]?.id ?? '');
  }, [mode, target, targets]);
  const limits = defaults?.vm.limits;
  const machine = { cores: Number(cores), memory_mb: Number(memoryGb) * 1024, disk_gb: Number(diskGb),
                    ip_mode: ipMode, ip_cidr: ipCidr.trim() || null, gateway: gateway.trim() || null };
```

In `basicsErrors`, replace:

```tsx
    target: target ? '' : 'Choose an SSH target.',
```

with:

```tsx
    target: target ? '' : 'Choose a target.',
```

After `servicesErrors`, add:

```tsx
  const machineErrors = (): Errors => {
    const within = (raw: string, [low, high]: [number, number], scale = 1) =>
      /^\d+$/.test(raw.trim()) && Number(raw) * scale >= low && Number(raw) * scale <= high;
    if (!limits) return {};
    if (!within(cores, limits.cores)) return { machine: 'Use 1 to 64 vCPUs.' };
    if (!within(memoryGb, limits.memory_mb, 1024)) return { machine: 'Use 2 to 256 GB of memory.' };
    if (!within(diskGb, limits.disk_gb)) return { machine: 'Use a disk of 20 to 4096 GB.' };
    if (ipMode === 'dhcp') return {};
    const m = CIDR_RE.exec(ipCidr.trim());
    if (!m || ipv4Problem(m[1], 'address') || Number(m[2]) < 8 || Number(m[2]) > 30) {
      return { machine: 'Enter the address with its prefix, like 10.10.48.70/24.' };
    }
    const gw = ipv4Problem(gateway, 'gateway');
    return gw ? { machine: gw } : {};
  };
```

Replace `next` and `back`:

```tsx
  const next = () => {
    const e = step === 'basics' ? basicsErrors() : step === 'services' ? servicesErrors() : dataErrors();
    setErrors(e);
    if (Object.keys(e).length) return;
    setStep(step === 'basics' ? 'services' : step === 'services' ? 'data' : 'review');
  };
  const back = () => {
    setErrors({});
    setStep(step === 'review' ? 'data' : step === 'data' ? 'services' : 'basics');
  };
```

with:

```tsx
  const next = () => {
    const e = step === 'basics' ? basicsErrors() : step === 'machine' ? machineErrors()
      : step === 'services' ? servicesErrors() : dataErrors();
    setErrors(e);
    if (Object.keys(e).length) return;
    setStep(step === 'basics' ? (onVm ? 'machine' : 'services') : step === 'machine' ? 'services'
      : step === 'services' ? 'data' : 'review');
  };
  const back = () => {
    setErrors({});
    setStep(step === 'review' ? 'data' : step === 'data' ? 'services'
      : step === 'services' ? (onVm ? 'machine' : 'basics') : 'basics');
  };
```

In `fail`, replace:

```tsx
    if (field === 'services' || field === 'data') setStep(field);
```

with:

```tsx
    if (field === 'services' || field === 'data' || field === 'machine') setStep(field);
```

In `submit`, replace:

```tsx
      ...(chosen ? { snapshot_id: chosen.id } : {}),
      publish: publish === 'on',
    } });
```

with:

```tsx
      ...(chosen ? { snapshot_id: chosen.id } : {}),
      publish: publish === 'on',
      ...(onVm ? { vm: {
        cores: machine.cores, memory_mb: machine.memory_mb, disk_gb: machine.disk_gb, ip_mode: ipMode,
        ...(ipMode === 'static' ? { ip_cidr: ipCidr.trim(), gateway: gateway.trim() } : {}),
      } } : {}),
    } });
```

Replace:

```tsx
  const stepList = STEPS[mode];
```

with:

```tsx
  const stepList = onVm ? PROXMOX_STEPS : STEPS[mode];
```

In the Basics step, replace the Target field:

```tsx
                  <ComboBox inputId="env-new-target" ariaLabel="Target" portal value={target}
                            placeholder="Choose an SSH target…"
                            options={(targets ?? []).map((t) => ({ value: t.id, label: t.label }))}
                            onChange={setTarget} />
                  {targets && targets.length === 0 && (
                    <p className="page-hint">No SSH target is ready. Add one under Target on the Deploy page first.</p>
                  )}
```

with:

```tsx
                  <ComboBox inputId="env-new-target" ariaLabel="Target" portal value={target}
                            placeholder="Choose a target…"
                            options={offered.map((t) => ({ value: t.id, label: t.label }))}
                            onChange={setTarget} />
                  {targets && offered.length === 0 && (
                    <p className="page-hint">
                      No target is ready. Add an SSH target under Target on the Deploy page, or set up Proxmox in
                      Settings › Integrations.
                    </p>
                  )}
                  {onVm && <p className="page-hint">Sirdar builds a VM for it on Proxmox on the first deploy.</p>}
```

Before the `{defaults && step === 'services' && (` block, add the Machine step:

```tsx
            {defaults && step === 'machine' && (
              <div className="sirdar-env-grid">
                <p className="page-hint sirdar-span2">
                  Sirdar clones the Ubuntu template into a VM named ss-{trimmed} on Proxmox, then deploys to it. Sizes
                  can grow later in Settings; the network can't change.
                </p>
                <div>
                  <label className="field-label" htmlFor="env-vm-cores">vCPUs</label>
                  <input id="env-vm-cores" type="text" inputMode="numeric" value={cores}
                         onChange={(e) => setCores(e.target.value)} />
                </div>
                <div>
                  <label className="field-label" htmlFor="env-vm-memory">Memory (GB)</label>
                  <input id="env-vm-memory" type="text" inputMode="numeric" value={memoryGb}
                         onChange={(e) => setMemoryGb(e.target.value)} />
                </div>
                <div>
                  <label className="field-label" htmlFor="env-vm-disk">Disk (GB)</label>
                  <input id="env-vm-disk" type="text" inputMode="numeric" value={diskGb}
                         onChange={(e) => setDiskGb(e.target.value)} />
                </div>
                <div className="sirdar-span2">
                  <span className="field-label" id="env-vm-net-label">Network</span>
                  <div className="segmented" role="radiogroup" aria-labelledby="env-vm-net-label">
                    {radios(IP_MODES, ipMode, setIpMode)}
                  </div>
                  <p className="page-hint">
                    {ipMode === 'static'
                      ? 'A fixed LAN address: the proxy hosts forward to it, so it should never move.'
                      : "The router's DHCP gives it an address; reserve it there so the proxy hosts keep working."}
                  </p>
                </div>
                {ipMode === 'static' && (
                  <>
                    <div>
                      <label className="field-label" htmlFor="env-vm-ip">Address</label>
                      <input id="env-vm-ip" type="text" value={ipCidr} placeholder="10.10.48.70/24" autoComplete="off"
                             spellCheck={false} onChange={(e) => setIpCidr(e.target.value)} />
                    </div>
                    <div>
                      <label className="field-label" htmlFor="env-vm-gateway">Gateway</label>
                      <input id="env-vm-gateway" type="text" value={gateway} placeholder="10.10.48.1"
                             autoComplete="off" spellCheck={false} onChange={(e) => setGateway(e.target.value)} />
                    </div>
                  </>
                )}
                {errors.machine && <p className="form-error sirdar-span2" role="alert">{errors.machine}</p>}
              </div>
            )}
```

In the Services table, replace:

```tsx
                      <span className="cell-sub">Target's address</span>,
```

with:

```tsx
                      <span className="cell-sub">{onVm ? "The VM's address" : "Target's address"}</span>,
```

In Review, replace:

```tsx
                  <dt>Target</dt><dd>{targetName(target)}</dd>
```

with:

```tsx
                  <dt>Target</dt><dd>{targetName(target)}</dd>
                  {onVm && (
                    <>
                      <dt>Machine</dt>
                      <dd>{`${vmSize(machine)} · ${vmNetwork(machine)}`}</dd>
                    </>
                  )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- --run src/pages/environments/NewEnvironmentModal.test.tsx`
Expected: PASS (the existing SSH tests too).

- [ ] **Step 5: Type-check, build and commit**

Run: `npm --prefix sirdar/web run build`
Expected: success.

```bash
git add sirdar/web/src/pages/environments/NewEnvironmentModal.tsx sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx
git commit -m "feat(sirdar-web): New environment on Proxmox with a Machine step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: The VM on the environment page — Overview, Settings and Delete

**Files:**
- Modify: `sirdar/web/src/pages/environments/EnvOverview.tsx`; create `EnvOverview.test.tsx`
- Modify: `sirdar/web/src/pages/environments/EnvSettings.tsx`, `EnvSettings.test.tsx`
- Modify: `sirdar/web/src/pages/environments/DeleteEnvironmentModal.tsx`, `DeleteEnvironmentModal.test.tsx`

**Interfaces:**
- Consumes: `onProxmox`, `vmSize`, `vmNetwork` (Task 1); `EnvironmentPatch.vm`.
- Produces: Overview's "Machine" section (heading "Machine") for a Proxmox environment; Settings shows the target read-only ("Proxmox · ss-uat3"), service addresses as text, and a "Machine" group (vCPUs, Memory (GB), Disk (GB), VM snapshots to keep) saved as `vm: {…}` with only what changed; Delete says the VM goes.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/pages/environments/EnvOverview.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import EnvOverview from './EnvOverview';
import { ENV, PX_ENV, PX_NEW_ENV } from './testData';

afterEach(cleanup);

it('a Proxmox environment shows its machine', () => {
  render(<EnvOverview env={PX_ENV} />);
  const machine = screen.getByRole('heading', { name: 'Machine' }).closest('section') as HTMLElement;
  expect(within(machine).getByText('ss-uat3 (VM 120)')).toBeTruthy();
  expect(within(machine).getByText('4 vCPU · 8 GB · 64 GB disk')).toBeTruthy();
  expect(within(machine).getByText('10.10.48.70/24 via 10.10.48.1')).toBeTruthy();
  expect(within(machine).getByText('10.10.48.70')).toBeTruthy();
});

it('before its first deploy the VM is only planned; SSH environments have no Machine section', () => {
  render(<EnvOverview env={PX_NEW_ENV} />);
  expect(screen.getByText('ss-uat3 · built by the first deploy')).toBeTruthy();
  expect(screen.getByText('Not known yet')).toBeTruthy();
  cleanup();
  render(<EnvOverview env={ENV} />);
  expect(screen.queryByRole('heading', { name: 'Machine' })).toBeNull();
});
```

In `sirdar/web/src/pages/environments/EnvSettings.test.tsx`, replace:

```tsx
import { DEFAULTS, ENV, TARGETS } from './testData';
```

with:

```tsx
import { DEFAULTS, ENV, PX_ENV, PX_TARGETS, TARGETS } from './testData';
```

and append:

```tsx
it('Proxmox: the target and the addresses are the VM\'s; Machine saves only what changed', async () => {
  const onSaved = vi.fn();
  render(<EnvSettings env={PX_ENV} targets={PX_TARGETS.targets} onSaved={onSaved} onDeleteStarted={vi.fn()} />);
  expect((screen.getByLabelText('Target') as HTMLInputElement).value).toBe('Proxmox · ss-uat3');
  expect((screen.getByLabelText('Target') as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByLabelText('api address')).toBeNull();
  expect(within(screen.getByRole('table', { name: 'Service addresses' })).getAllByText('10.10.48.70')).toHaveLength(7);
  expect((screen.getByLabelText('vCPUs') as HTMLInputElement).value).toBe('4');
  const disk = screen.getByLabelText('Disk (GB)');
  await userEvent.clear(disk);
  await userEvent.type(disk, '32');
  await save();
  expect(screen.getByText('A disk can grow but never shrink.')).toBeTruthy();
  await userEvent.clear(disk);
  await userEvent.type(disk, '64');
  await userEvent.clear(screen.getByLabelText('vCPUs'));
  await userEvent.type(screen.getByLabelText('vCPUs'), '8');
  await userEvent.clear(screen.getByLabelText('Memory (GB)'));
  await userEvent.type(screen.getByLabelText('Memory (GB)'), '16');
  await save();
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.updateEnvironment).toHaveBeenCalledWith('uat3', { vm: { cores: 8, memory_mb: 16384 } });
  expect(screen.getByText(/Destroys its VM on Proxmox/)).toBeTruthy();
});
```

In `sirdar/web/src/pages/environments/DeleteEnvironmentModal.test.tsx`, replace:

```tsx
import { ENV, PUBLISHED_ENV, TEARDOWN } from './testData';
```

with:

```tsx
import { ENV, PUBLISHED_ENV, PX_ENV, TEARDOWN } from './testData';
```

and append:

```tsx
it('a Proxmox environment: the VM goes, with everything on it', async () => {
  const onStarted = vi.fn();
  render(<DeleteEnvironmentModal env={PX_ENV} onStarted={onStarted} onClose={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'Delete uat3' });
  expect(within(dialog).getByText(
    /Destroys the VM ss-uat3 \(VM 120\) on Proxmox with everything on it: the database, files, backups and VM snapshots/,
  )).toBeTruthy();
  await userEvent.type(within(dialog).getByLabelText('Type uat3 to confirm'), 'uat3');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(TEARDOWN));
  expect(api.startDeployment).toHaveBeenCalledWith('uat3', { mode: 'teardown', confirm_name: 'uat3' });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- --run src/pages/environments/EnvOverview.test.tsx src/pages/environments/EnvSettings.test.tsx src/pages/environments/DeleteEnvironmentModal.test.tsx`
Expected: FAIL — no "Machine" heading, no read-only target, the old Delete copy.

- [ ] **Step 3: Overview**

In `sirdar/web/src/pages/environments/EnvOverview.tsx`, replace:

```tsx
import { DEPLOYMENT_STATUS, MODE_LABEL, StatusChip, when } from './labels';
```

with:

```tsx
import { DEPLOYMENT_STATUS, MODE_LABEL, StatusChip, onProxmox, vmNetwork, vmSize, when } from './labels';
```

and replace:

```tsx
      </section>
      <section className="sirdar-section">
        <h2>Services</h2>
```

with:

```tsx
      </section>
      {onProxmox(env) && env.vm && (
        <section className="sirdar-section">
          <h2>Machine</h2>
          <dl className="sirdar-kv">
            <dt>VM</dt>
            <dd className="mono">
              {env.vm.vmid !== null ? `${env.vm.name} (VM ${env.vm.vmid})` : `${env.vm.name} · built by the first deploy`}
            </dd>
            <dt>Node</dt><dd className="mono">{env.vm.node}</dd>
            <dt>Size</dt><dd>{vmSize(env.vm)}</dd>
            <dt>Network</dt><dd className="mono">{vmNetwork(env.vm)}</dd>
            <dt>Address</dt><dd className="mono">{env.vm.ip ?? 'Not known yet'}</dd>
            <dt>VM snapshots kept</dt><dd>{env.vm.keep_snapshots}</dd>
          </dl>
        </section>
      )}
      <section className="sirdar-section">
        <h2>Services</h2>
```

- [ ] **Step 4: Settings**

In `sirdar/web/src/pages/environments/EnvSettings.tsx`:

Replace:

```tsx
import { deploymentRunning, sshTargets, targetLabel } from './labels';
```

with:

```tsx
import { deploymentRunning, onProxmox, sshTargets, targetLabel } from './labels';
```

In `CODE_FIELD`, replace:

```tsx
  service_unknown: 'services',
};
```

with:

```tsx
  service_unknown: 'services', host_ip_managed: 'services', target_kind_locked: 'target',
  vm_cores_invalid: 'machine', vm_memory_invalid: 'machine', vm_disk_invalid: 'machine', vm_disk_shrink: 'machine',
  vm_keep_snapshots_invalid: 'machine',
};
```

Replace `fromEnv`:

```tsx
function fromEnv(env: Environment) {
  return {
    ref: env.git_ref, target: env.target, domain: env.base_domain, proxy: env.proxy_ip, bind: env.bind_ip,
    keep: String(env.keep_dumps), bucket: env.spaces_bucket, level: env.log_level,
    services: Object.fromEntries(env.services.map((s) => [s.service, { host_ip: s.host_ip, port: String(s.port) }])) as Record<string, Svc>,
  };
}
```

with:

```tsx
function fromEnv(env: Environment) {
  return {
    ref: env.git_ref, target: env.target, domain: env.base_domain, proxy: env.proxy_ip, bind: env.bind_ip,
    keep: String(env.keep_dumps), bucket: env.spaces_bucket, level: env.log_level,
    services: Object.fromEntries(env.services.map((s) => [s.service, { host_ip: s.host_ip, port: String(s.port) }])) as Record<string, Svc>,
    cores: String(env.vm?.cores ?? ''), memory: env.vm ? String(env.vm.memory_mb / 1024) : '',
    disk: String(env.vm?.disk_gb ?? ''), keepVm: String(env.vm?.keep_snapshots ?? ''),
  };
}
```

After `const off = locked || deploying;`, add:

```tsx
  const onVm = onProxmox(env);
```

In `validate`, replace:

```tsx
    for (const s of env.services) {
      const v = form.services[s.service];
      const problem = ipv4Problem(v.host_ip, `${s.service} address`) || (portProblem(v.port) && `${s.service}: ${portProblem(v.port)}`);
      if (problem) { e.services = problem; break; }
    }
```

with:

```tsx
    for (const s of env.services) {
      const v = form.services[s.service];
      // A Proxmox environment's addresses are the VM's: only the ports are edited.
      const problem = (!onVm && ipv4Problem(v.host_ip, `${s.service} address`))
        || (portProblem(v.port) && `${s.service}: ${portProblem(v.port)}`);
      if (problem) { e.services = problem; break; }
    }
    if (onVm && env.vm) {
      const whole = (raw: string, low: number, high: number) =>
        /^\d+$/.test(raw.trim()) && Number(raw) >= low && Number(raw) <= high;
      if (!whole(form.cores, 1, 64)) e.machine = 'Use 1 to 64 vCPUs.';
      else if (!whole(form.memory, 2, 256)) e.machine = 'Use 2 to 256 GB of memory.';
      else if (!whole(form.disk, 20, 4096)) e.machine = 'Use a disk of 20 to 4096 GB.';
      else if (Number(form.disk) < env.vm.disk_gb) e.machine = 'A disk can grow but never shrink.';
      else if (!whole(form.keepVm, 1, 10)) e.machine = 'Keep 1 to 10 VM snapshots.';
    }
```

In `patchOf`, replace:

```tsx
      if (t(v.host_ip) !== s.host_ip) change.host_ip = t(v.host_ip);
```

with:

```tsx
      if (!onVm && t(v.host_ip) !== s.host_ip) change.host_ip = t(v.host_ip);
```

and replace:

```tsx
    if (Object.keys(secrets).length) patch.secrets = secrets;
    return patch;
```

with:

```tsx
    if (Object.keys(secrets).length) patch.secrets = secrets;
    if (onVm && env.vm) {
      const vm: NonNullable<EnvironmentPatch['vm']> = {};
      if (Number(form.cores) !== env.vm.cores) vm.cores = Number(form.cores);
      if (Number(form.memory) * 1024 !== env.vm.memory_mb) vm.memory_mb = Number(form.memory) * 1024;
      if (Number(form.disk) !== env.vm.disk_gb) vm.disk_gb = Number(form.disk);
      if (Number(form.keepVm) !== env.vm.keep_snapshots) vm.keep_snapshots = Number(form.keepVm);
      if (Object.keys(vm).length) patch.vm = vm;
    }
    return patch;
```

Replace the Target field:

```tsx
        <div>
          <label className="field-label" htmlFor="env-set-target">Target</label>
          <ComboBox inputId="env-set-target" ariaLabel="Target" portal value={form.target} options={targetOptions}
                    disabled={off} onChange={(v) => set('target', v)} />
          {errors.target && <p className="form-error" role="alert">{errors.target}</p>}
        </div>
```

with:

```tsx
        {onVm ? (
          <TextField id="env-set-target" label="Target" value={`Proxmox · ${env.vm?.name ?? ''}`} disabled
                     hint="A Proxmox environment stays on the VM Sirdar built for it." onChange={() => {}} />
        ) : (
          <div>
            <label className="field-label" htmlFor="env-set-target">Target</label>
            <ComboBox inputId="env-set-target" ariaLabel="Target" portal value={form.target} options={targetOptions}
                      disabled={off} onChange={(v) => set('target', v)} />
            {errors.target && <p className="form-error" role="alert">{errors.target}</p>}
          </div>
        )}
```

Replace:

```tsx
      <h3 className="sirdar-sub">Services</h3>
```

with:

```tsx
      {onVm && (
        <>
          <h3 className="sirdar-sub">Machine</h3>
          <p className="page-hint">
            The next deploy's step 0 resizes the VM (Proxmox restarts it when it must). A disk can grow but never
            shrink.
          </p>
          <div className="pf-form sirdar-env-grid">
            <TextField id="env-set-cores" label="vCPUs" value={form.cores} disabled={off}
                       onChange={(v) => set('cores', v)} />
            <TextField id="env-set-memory" label="Memory (GB)" value={form.memory} disabled={off}
                       onChange={(v) => set('memory', v)} />
            <TextField id="env-set-disk" label="Disk (GB)" value={form.disk} disabled={off}
                       onChange={(v) => set('disk', v)} />
            <TextField id="env-set-keepvm" label="VM snapshots to keep" value={form.keepVm} disabled={off}
                       hint="The newest stay; older ones Sirdar took are deleted." onChange={(v) => set('keepVm', v)} />
          </div>
          {errors.machine && <p className="form-error" role="alert">{errors.machine}</p>}
        </>
      )}

      <h3 className="sirdar-sub">Services</h3>
```

In the Services table cells, replace:

```tsx
            <input type="text" aria-label={`${s.service} address`} value={form.services[s.service]?.host_ip ?? ''}
                   disabled={off} onChange={(e) => setSvc(s.service, 'host_ip', e.target.value)} />,
```

with:

```tsx
            onVm
              ? <span className="mono">{s.host_ip}</span>
              : <input type="text" aria-label={`${s.service} address`} value={form.services[s.service]?.host_ip ?? ''}
                       disabled={off} onChange={(e) => setSvc(s.service, 'host_ip', e.target.value)} />,
```

In the danger zone, replace:

```tsx
          <p className="page-hint">
            Stops it, deletes its data, backups and folder on the host, removes the DNS records and proxy hosts Sirdar
            made, and removes it from Sirdar.
          </p>
```

with:

```tsx
          <p className="page-hint">
            {onVm
              ? 'Destroys its VM on Proxmox with everything on it, removes the DNS records and proxy hosts Sirdar '
                + 'made, and removes it from Sirdar.'
              : 'Stops it, deletes its data, backups and folder on the host, removes the DNS records and proxy hosts '
                + 'Sirdar made, and removes it from Sirdar.'}
          </p>
```

- [ ] **Step 5: Delete**

In `sirdar/web/src/pages/environments/DeleteEnvironmentModal.tsx`, replace:

```tsx
              <p className="page-hint">
                Stops every container of {env.name}, deletes its database and files, and removes the whole
                {' '}{env.env_dir} folder from the host, backups included. Snapshots taken from {env.name} are kept,
                and so are Docker images. Then Sirdar forgets the environment.
              </p>
```

with:

```tsx
              {env.target_kind === 'proxmox' && env.vm ? (
                <p className="page-hint">
                  Destroys the VM {env.vm.name}{env.vm.vmid !== null ? ` (VM ${env.vm.vmid})` : ''} on Proxmox with
                  everything on it: the database, files, backups and VM snapshots. Snapshots taken from {env.name}
                  {' '}are kept in Sirdar. Then Sirdar forgets the environment.
                </p>
              ) : (
                <p className="page-hint">
                  Stops every container of {env.name}, deletes its database and files, and removes the whole
                  {' '}{env.env_dir} folder from the host, backups included. Snapshots taken from {env.name} are kept,
                  and so are Docker images. Then Sirdar forgets the environment.
                </p>
              )}
```

- [ ] **Step 6: Run the tests, type-check and build**

Run: `npm --prefix sirdar/web test -- --run src/pages/environments`
Expected: PASS.

Run: `npm --prefix sirdar/web run build`
Expected: success.

- [ ] **Step 7: Commit**

```bash
git add sirdar/web/src/pages/environments/EnvOverview.tsx sirdar/web/src/pages/environments/EnvOverview.test.tsx \
  sirdar/web/src/pages/environments/EnvSettings.tsx sirdar/web/src/pages/environments/EnvSettings.test.tsx \
  sirdar/web/src/pages/environments/DeleteEnvironmentModal.tsx \
  sirdar/web/src/pages/environments/DeleteEnvironmentModal.test.tsx
git commit -m "feat(sirdar-web): the VM on Overview and Settings; Delete says the VM goes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The VM snapshot choice when deploying, and Restore VM snapshot after a failure

**Files:**
- Modify: `sirdar/web/src/pages/environments/DeployModal.tsx`, `DeployModal.test.tsx`
- Modify: `sirdar/web/src/pages/environments/DeploymentView.tsx`, `DeploymentView.test.tsx`

**Interfaces:**
- Consumes: `DeploymentBody.take_vm_snapshot`, `DeploymentSummary.vm_snapshot`, `startDeployment` (Task 1).
- Produces: the Deploy modal of a deployed Proxmox environment has a "VM snapshot first" segmented On (default) / Off and sends `take_vm_snapshot`; a failed latest deployment that took a VM snapshot shows a "Restore VM snapshot" panel (typed name) that starts `{mode: 'vm_restore', vm_snapshot, confirm_name}`.

- [ ] **Step 1: Write the failing tests**

In `sirdar/web/src/pages/environments/DeployModal.test.tsx`, replace:

```tsx
import { ENV, RUNNING, SNAP, SNAP_TAKING } from './testData';
```

with:

```tsx
import { ENV, PX_ENV, PX_NEW_ENV, RUNNING, SNAP, SNAP_TAKING } from './testData';
```

and append:

```tsx
it('Proxmox: a VM snapshot is taken first unless turned off', async () => {
  const { onStarted } = open(PX_ENV);
  expect(screen.getByText(/Prepares the VM ss-uat3 on Proxmox/)).toBeTruthy();
  expect(screen.getByRole('radio', { name: 'On' }).getAttribute('aria-checked')).toBe('true');
  await userEvent.click(deployBtn());
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
  expect(api.startDeployment).toHaveBeenLastCalledWith('uat3', { mode: 'update', git_ref: 'main', take_vm_snapshot: true });
  cleanup();
  open(PX_ENV);
  await userEvent.click(screen.getByRole('radio', { name: 'Off' }));
  await userEvent.click(deployBtn());
  await waitFor(() => expect(api.startDeployment).toHaveBeenCalledTimes(2));
  expect(api.startDeployment).toHaveBeenLastCalledWith('uat3', { mode: 'update', git_ref: 'main', take_vm_snapshot: false });
});

it('Proxmox before its first deploy: nothing to snapshot, and SSH environments never send the choice', async () => {
  open(PX_NEW_ENV);
  expect(screen.queryByRole('radio', { name: 'On' })).toBeNull();
  expect(screen.getByText(/The first deploy builds the VM/)).toBeTruthy();
  await userEvent.click(deployBtn());
  await waitFor(() => expect(api.startDeployment).toHaveBeenCalledWith('uat3', { mode: 'update', git_ref: 'main' }));
});
```

In `sirdar/web/src/pages/environments/DeploymentView.test.tsx`, replace:

```tsx
const api = vi.hoisted(() => ({
  getDeployment: vi.fn(), cancelDeployment: vi.fn(), retryDeployment: vi.fn(), trustKnownHost: vi.fn(),
  rollbackDeployment: vi.fn(),
}));
```

with:

```tsx
const api = vi.hoisted(() => ({
  getDeployment: vi.fn(), cancelDeployment: vi.fn(), retryDeployment: vi.fn(), trustKnownHost: vi.fn(),
  rollbackDeployment: vi.fn(), startDeployment: vi.fn(),
}));
```

replace:

```tsx
import {
  ENV, FAILED, RESET_FAILED, RESTORE_FAILED, ROLLBACKABLE, RUNNING, RUNNING_MORE, SNAP, SUCCEEDED,
} from './testData';
```

with:

```tsx
import {
  ENV, FAILED, PX_ENV, RESET_FAILED, RESTORE_FAILED, ROLLBACKABLE, RUNNING, RUNNING_MORE, SNAP, SUCCEEDED,
  VM_ROLLBACKABLE,
} from './testData';
```

and append:

```tsx
it('a failed Proxmox deploy offers its VM snapshot as well as the dump', async () => {
  api.getDeployment.mockResolvedValue(VM_ROLLBACKABLE);
  api.startDeployment.mockResolvedValue(RUNNING);
  const handlers = { onFinished: vi.fn(), onRetried: vi.fn(), onClose: vi.fn() };
  render(<DeploymentView id="d11" env={PX_ENV} isLatest {...handlers} />);
  expect(await screen.findByText('Prepare VM')).toBeTruthy();                         // step 0 is listed
  expect(screen.getAllByText('sirdar-20261004T120000Z').length).toBeGreaterThan(0);
  const panel = screen.getByRole('heading', { name: 'Restore VM snapshot' }).closest('div') as HTMLElement;
  expect(panel.textContent).toMatch(/Puts the whole VM back to sirdar-20261004T120000Z/);
  const go = screen.getByRole('button', { name: 'Restore VM snapshot' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await user.type(screen.getByLabelText('Type uat3 to restore the VM snapshot'), 'uat3');
  await user.click(go);
  await waitFor(() => expect(handlers.onRetried).toHaveBeenCalledWith(RUNNING));
  expect(api.startDeployment).toHaveBeenCalledWith('uat3', {
    mode: 'vm_restore', vm_snapshot: 'sirdar-20261004T120000Z', confirm_name: 'uat3' });
});

it('no VM snapshot panel without the change permission or a snapshot', async () => {
  api.getDeployment.mockResolvedValue(ROLLBACKABLE);
  show();
  await screen.findByRole('heading', { name: 'Roll back' });
  expect(screen.queryByRole('heading', { name: 'Restore VM snapshot' })).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- --run src/pages/environments/DeployModal.test.tsx src/pages/environments/DeploymentView.test.tsx`
Expected: FAIL — no "On" radio; no "Restore VM snapshot" heading.

- [ ] **Step 3: The Deploy modal**

In `sirdar/web/src/pages/environments/DeployModal.tsx`:

Replace:

```tsx
import { snapshotLabel } from './labels';

type Mode = 'update' | 'reset';
type Field = 'ref' | 'confirm' | 'snapshot' | 'form';
type Attempt = { mode: Mode; ref: string; confirm: string; snapshotId: string };
```

with:

```tsx
import { onProxmox, snapshotLabel } from './labels';

type Mode = 'update' | 'reset';
type Field = 'ref' | 'confirm' | 'snapshot' | 'form';
/** vmSnapshot: null for an environment that doesn't choose (SSH, or a VM never deployed). */
type Attempt = { mode: Mode; ref: string; confirm: string; snapshotId: string; vmSnapshot: boolean | null };
const VM_SNAPSHOT: ['on' | 'off', string][] = [['on', 'On'], ['off', 'Off']];
```

After `const [snapshotId, setSnapshotId] = useState('');`, add:

```tsx
  // A deployed Proxmox environment snapshots its VM in step 0 unless turned off.
  const choosesVmSnapshot = onProxmox(env) && env.current_sha !== null;
  const [vmSnapshot, setVmSnapshot] = useState<'on' | 'off'>('on');
```

In `run`, replace:

```tsx
      onStarted(await startDeployment(env.name, attempt.mode === 'reset'
        ? { mode: attempt.mode, git_ref: attempt.ref, confirm_name: attempt.confirm,
            ...(attempt.snapshotId ? { snapshot_id: attempt.snapshotId } : {}) }
        : { mode: attempt.mode, git_ref: attempt.ref }));
```

with:

```tsx
      const vm = attempt.vmSnapshot === null ? {} : { take_vm_snapshot: attempt.vmSnapshot };
      onStarted(await startDeployment(env.name, attempt.mode === 'reset'
        ? { mode: attempt.mode, git_ref: attempt.ref, confirm_name: attempt.confirm,
            ...(attempt.snapshotId ? { snapshot_id: attempt.snapshotId } : {}), ...vm }
        : { mode: attempt.mode, git_ref: attempt.ref, ...vm }));
```

In `submit`, replace:

```tsx
    void run({ mode, ref: ref.trim(), confirm, snapshotId: restoring ? snapshotId : '' });
```

with:

```tsx
    void run({ mode, ref: ref.trim(), confirm, snapshotId: restoring ? snapshotId : '',
               vmSnapshot: choosesVmSnapshot ? vmSnapshot === 'on' : null });
```

Replace the header hint:

```tsx
              <p className="page-hint">
                Runs in {env.env_dir} on the target. You can follow each step's log while it runs.
              </p>
```

with:

```tsx
              <p className="page-hint">
                {onProxmox(env) && env.vm
                  ? `Prepares the VM ${env.vm.name} on Proxmox, then runs in ${env.env_dir} on it. `
                  : `Runs in ${env.env_dir} on the target. `}
                You can follow each step's log while it runs.
              </p>
```

After the Mode block's closing `</div>` (the one that ends with the `seeded` hint), add:

```tsx
            {onProxmox(env) && (
              <div>
                {choosesVmSnapshot ? (
                  <>
                    <span className="field-label" id="deploy-vmsnap-label">VM snapshot first</span>
                    <div className="segmented" role="radiogroup" aria-labelledby="deploy-vmsnap-label">
                      {VM_SNAPSHOT.map(([v, label]) => (
                        <button key={v} type="button" role="radio" aria-checked={vmSnapshot === v}
                                className={vmSnapshot === v ? 'on' : ''} tabIndex={vmSnapshot === v ? 0 : -1}
                                onKeyDown={arrowNav} onClick={() => setVmSnapshot(v)}>{label}</button>
                      ))}
                    </div>
                    <p className="page-hint">
                      Step 0 snapshots the whole VM before anything changes. Restore it from the Backups tab.
                    </p>
                  </>
                ) : (
                  <p className="page-hint">The first deploy builds the VM; there's nothing to snapshot yet.</p>
                )}
              </div>
            )}
```

- [ ] **Step 4: The deployment view**

In `sirdar/web/src/pages/environments/DeploymentView.tsx`:

Replace:

```tsx
import {
  cancelDeployment, deployErrorText, errorText, getDeployment, retryDeployment, rollbackDeployment,
  type Deployment, type Environment,
} from '../../lib/sirdarApi';
```

with:

```tsx
import {
  cancelDeployment, deployErrorText, errorText, getDeployment, retryDeployment, rollbackDeployment, startDeployment,
  type Deployment, type Environment,
} from '../../lib/sirdarApi';
```

Replace:

```tsx
type Attempt = { kind: 'retry'; fromStep: number; confirm: string; gated: boolean }
  | { kind: 'rollback'; confirm: string };
```

with:

```tsx
type Attempt = { kind: 'retry'; fromStep: number; confirm: string; gated: boolean }
  | { kind: 'rollback'; confirm: string }
  | { kind: 'vm_restore'; confirm: string; snapshot: string };
```

After `const [rollbackConfirm, setRollbackConfirm] = useState('');`, add:

```tsx
  const [vmConfirm, setVmConfirm] = useState('');
```

After `const mayRollBack = …;`, add:

```tsx
  // A failed deployment whose step 0 took a VM snapshot: put the whole VM back.
  const mayRestoreVm = !!dep && !!dep.vm_snapshot && dep.mode !== 'vm_restore' && RETRYABLE.includes(dep.status)
    && can('deploy', 'add') && can('deploy', 'change');
```

In `run`, replace:

```tsx
      if (attempt.kind === 'rollback') onRetried(await rollbackDeployment(id, attempt.confirm));
      else {
```

with:

```tsx
      if (attempt.kind === 'rollback') onRetried(await rollbackDeployment(id, attempt.confirm));
      else if (attempt.kind === 'vm_restore') {
        onRetried(await startDeployment(env.name, {
          mode: 'vm_restore', vm_snapshot: attempt.snapshot, confirm_name: attempt.confirm }));
      } else {
```

and replace:

```tsx
        setActionError(deployErrorText(e, attempt.kind === 'rollback'
          ? "Couldn't roll back the deployment." : "Couldn't retry the deployment."));
```

with:

```tsx
        setActionError(deployErrorText(e, attempt.kind === 'rollback' ? "Couldn't roll back the deployment."
          : attempt.kind === 'vm_restore' ? "Couldn't restore the VM snapshot." : "Couldn't retry the deployment."));
```

In the details list, replace:

```tsx
        {dep.restore_dump && <><dt>Restores backup</dt><dd className="mono">{dep.restore_dump}</dd></>}
```

with:

```tsx
        {dep.restore_dump && <><dt>Restores backup</dt><dd className="mono">{dep.restore_dump}</dd></>}
        {dep.vm_snapshot && (
          <><dt>{dep.mode === 'vm_restore' ? 'Restores VM snapshot' : 'VM snapshot'}</dt>
            <dd className="mono">{dep.vm_snapshot}</dd></>
        )}
```

Before `{actionError && <p className="form-error" role="alert">{actionError}</p>}`, add:

```tsx
      {mayRestoreVm && isLatest === true && (
        <div className="sirdar-rollback">
          <h3 className="sirdar-sub">Restore VM snapshot</h3>
          <p className="page-hint">
            Puts the whole VM back to {dep.vm_snapshot}, taken before this deployment changed anything: database,
            files and backups. The running commit goes back to{' '}
            <span className="mono">{shortSha(dep.previous_sha)}</span>.
          </p>
          <div className="sirdar-retry pf-form">
            <div>
              <label className="field-label" htmlFor="vmrestore-confirm">Type {env.name} to restore the VM snapshot</label>
              <input id="vmrestore-confirm" type="text" value={vmConfirm} maxLength={64} autoComplete="off"
                     spellCheck={false} onChange={(e) => setVmConfirm(e.target.value)} />
            </div>
            <button type="button" className="btn-ghost" disabled={retrying || vmConfirm !== env.name}
                    onClick={() => void run({ kind: 'vm_restore', confirm: vmConfirm, snapshot: dep.vm_snapshot! })}>
              {retrying ? 'Starting…' : 'Restore VM snapshot'}
            </button>
          </div>
        </div>
      )}
```

- [ ] **Step 5: Run the tests, type-check and build**

Run: `npm --prefix sirdar/web test -- --run src/pages/environments/DeployModal.test.tsx src/pages/environments/DeploymentView.test.tsx`
Expected: PASS.

Run: `npm --prefix sirdar/web run build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add sirdar/web/src/pages/environments/DeployModal.tsx sirdar/web/src/pages/environments/DeployModal.test.tsx \
  sirdar/web/src/pages/environments/DeploymentView.tsx sirdar/web/src/pages/environments/DeploymentView.test.tsx
git commit -m "feat(sirdar-web): VM snapshot choice in Deploy; Restore VM snapshot after a failed deploy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: VM snapshots on the Backups tab

**Files:**
- Create: `sirdar/web/src/pages/environments/VmSnapshots.tsx`, `RestoreVmSnapshotModal.tsx`, `VmSnapshots.test.tsx`
- Modify: `sirdar/web/src/pages/environments/BackupsTab.tsx`

**Interfaces:**
- Consumes: `listVmSnapshots`, `startDeployment`, `VmSnapshot` (Task 1); `deploymentRunning`, `onProxmox`, `shortSha`, `when`.
- Produces: `VmSnapshots({ env, onStarted })` — a section headed "VM snapshots" with a table named "VM snapshots" (Snapshot, Taken, Commit, action); `RestoreVmSnapshotModal({ env, snapshot, onStarted, onClose })` — dialog named "Restore VM snapshot", typed name, starts `vm_restore`. `BackupsTab` renders `VmSnapshots` first for a Proxmox environment.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/pages/environments/VmSnapshots.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a !== 'change' || perms.change) }),
}));
const api = vi.hoisted(() => ({ listVmSnapshots: vi.fn(), listBackups: vi.fn(), startDeployment: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import BackupsTab from './BackupsTab';
import { ENV, KEYS_CHANGED_REASON, PX_ENV, RUNNING, VM_SNAPSHOTS } from './testData';

beforeEach(() => {
  perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.listVmSnapshots.mockResolvedValue({ snapshots: VM_SNAPSHOTS });
  api.listBackups.mockResolvedValue({ backups: [] });
  api.startDeployment.mockResolvedValue(RUNNING);
});
afterEach(cleanup);

it('a Proxmox environment lists its VM snapshots above the backups', async () => {
  render(<BackupsTab env={PX_ENV} onStarted={vi.fn()} />);
  const table = await screen.findByRole('table', { name: 'VM snapshots' });
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(
    ['sirdar-20261004T120000Z', 'sirdar-20261002T080000Z']);
  expect(within(rows[0]).getByText('e73b99ca')).toBeTruthy();
  expect(within(rows[1]).getByText(KEYS_CHANGED_REASON)).toBeTruthy();
  expect(screen.getByText(/the newest 3 stay on Proxmox/)).toBeTruthy();
  expect(api.listVmSnapshots).toHaveBeenCalledWith('uat3');
  expect(screen.getByRole('heading', { name: 'Backups' })).toBeTruthy();
});

it('restoring one needs the typed name and starts a Restore VM snapshot deployment', async () => {
  const onStarted = vi.fn();
  render(<BackupsTab env={PX_ENV} onStarted={onStarted} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Restore sirdar-20261004T120000Z' }));
  const dialog = screen.getByRole('dialog', { name: 'Restore VM snapshot' });
  expect(within(dialog).getByText('Backups', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByText(/whole VM/)).toBeTruthy();
  const go = within(dialog).getByRole('button', { name: 'Restore VM snapshot' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type uat3 to confirm'), 'uat3');
  await userEvent.click(go);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
  expect(api.startDeployment).toHaveBeenCalledWith('uat3', {
    mode: 'vm_restore', vm_snapshot: 'sirdar-20261004T120000Z', confirm_name: 'uat3' });
});

it('view-only readers see no Restore; a Proxmox error shows its reason; SSH environments have no list', async () => {
  perms.change = false;
  render(<BackupsTab env={PX_ENV} onStarted={vi.fn()} />);
  await screen.findByRole('table', { name: 'VM snapshots' });
  expect(screen.queryByRole('button', { name: /^Restore sirdar/ })).toBeNull();
  cleanup();
  api.listVmSnapshots.mockRejectedValue(new ApiError(502, 'connect_failed',
    { code: 'connect_failed', reason: 'Proxmox rejected the API token.' }));
  render(<BackupsTab env={PX_ENV} onStarted={vi.fn()} />);
  expect(await screen.findByText('Proxmox rejected the API token.')).toBeTruthy();
  cleanup();
  render(<BackupsTab env={ENV} onStarted={vi.fn()} />);
  await waitFor(() => expect(api.listBackups).toHaveBeenCalledWith('uat'));
  expect(screen.queryByRole('heading', { name: 'VM snapshots' })).toBeNull();
  expect(api.listVmSnapshots).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- --run src/pages/environments/VmSnapshots.test.tsx`
Expected: FAIL — no table named "VM snapshots".

- [ ] **Step 3: The restore modal**

Create `sirdar/web/src/pages/environments/RestoreVmSnapshotModal.tsx`:

```tsx
/** Restore one of a Proxmox environment's VM snapshots: a "Restore VM
 *  snapshot" deployment rolls the whole VM back (database, files, backups)
 *  and the running commit with it. Typed-name gate. */
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import {
  deployErrorText, startDeployment, type Deployment, type Environment, type VmSnapshot,
} from '../../lib/sirdarApi';

import { shortSha, when } from './labels';

export default function RestoreVmSnapshotModal({ env, snapshot, onStarted, onClose }: {
  env: Environment; snapshot: VmSnapshot; onStarted: (dep: Deployment) => void; onClose: () => void;
}) {
  const { can } = useAuth();
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const confirmInput = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    confirmInput.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const run = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      onStarted(await startDeployment(env.name, {
        mode: 'vm_restore', vm_snapshot: snapshot.name, confirm_name: confirm }));
    } catch (e) {
      setError(deployErrorText(e, "Couldn't start the restore."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const ready = confirm === env.name && !busy && can('deploy', 'add') && can('deploy', 'change');

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-deploy-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-vmrestore-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Backups</div>
            <h3 id="sirdar-vmrestore-title">Restore VM snapshot</h3>
            <p className="page-hint">
              Rolls {env.vm?.name ?? env.name}'s whole VM back to {snapshot.name} and starts it again. The running
              commit goes back to the one the snapshot holds.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form sirdar-deploy-form">
          <dl className="sirdar-kv">
            <dt>Snapshot</dt><dd className="mono">{snapshot.name}</dd>
            <dt>Taken</dt><dd className="mono">{when(snapshot.taken_at)}</dd>
            <dt>Commit</dt><dd className="mono">{shortSha(snapshot.sha)}</dd>
          </dl>
          <p className="page-hint">
            Everything on the VM since then is lost: database writes, uploaded files and newer backups. This can't be
            undone.
          </p>
          <div>
            <label className="field-label" htmlFor="vmsnap-confirm">Type {env.name} to confirm</label>
            <input id="vmsnap-confirm" ref={confirmInput} type="text" value={confirm} maxLength={64}
                   autoComplete="off" spellCheck={false} disabled={busy}
                   onChange={(e) => setConfirm(e.target.value)} />
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn-solid" disabled={!ready} onClick={() => void run()}>
            {busy ? 'Starting…' : 'Restore VM snapshot'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: The list**

Create `sirdar/web/src/pages/environments/VmSnapshots.tsx`:

```tsx
/** A Proxmox environment's VM snapshots (read live from Proxmox): the ones
 *  Sirdar took in step 0 of a deploy, each restorable with the typed-name
 *  gate unless a snapshot restore changed the sign-in keys since. */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';

import {
  deployErrorText, listVmSnapshots, type Deployment, type Environment, type VmSnapshot,
} from '../../lib/sirdarApi';

import { deploymentRunning, shortSha, when } from './labels';
import RestoreVmSnapshotModal from './RestoreVmSnapshotModal';

export default function VmSnapshots({ env, onStarted }: {
  env: Environment; onStarted: (dep: Deployment) => void;
}) {
  const { can } = useAuth();
  const [rows, setRows] = useState<VmSnapshot[] | null>(null);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState<VmSnapshot | null>(null);
  const seq = useRef(0);

  // Only the newest request's answer lands.
  const load = useCallback(() => {
    const n = ++seq.current;
    return listVmSnapshots(env.name)
      .then((r) => { if (n === seq.current) { setRows(r.snapshots); setError(''); } })
      .catch((e) => {
        if (n === seq.current) { setRows([]); setError(deployErrorText(e, "Couldn't list the VM snapshots.")); }
      });
  }, [env.name]);
  // A deploy that ends may add one (and prune the oldest).
  useEffect(() => { void load(); }, [load, env.status]);
  useEffect(() => () => { seq.current += 1; }, []);

  const running = deploymentRunning(env);
  const mayRestore = can('deploy', 'add') && can('deploy', 'change');
  return (
    <section className="sirdar-section">
      <div className="sirdar-section-head">
        <h2>VM snapshots</h2>
        <button type="button" className="mini-btn" onClick={() => void load()}>Refresh</button>
      </div>
      <p className="page-hint">
        Step 0 of each Update, Reset, Restore backup and Roll back snapshots the whole VM before anything changes;
        the newest {env.vm?.keep_snapshots ?? 3} stay on Proxmox. Restoring one puts the VM back: database, files and
        backups.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!(error && (rows ?? []).length === 0) && <DataTable
        ariaLabel="VM snapshots"
        columns={[
          { key: 'name', label: 'Snapshot', mono: true }, { key: 'when', label: 'Taken', mono: true },
          { key: 'sha', label: 'Commit', mono: true }, { key: 'act', label: '', align: 'right' },
        ]}
        rows={(rows ?? []).map((s) => ({
          key: s.name,
          cells: [
            s.name, when(s.taken_at), shortSha(s.sha),
            !s.restorable
              ? <span className="sirdar-backup-blocked">{s.reason ?? "Can't be restored."}</span>
              : mayRestore
              ? <button type="button" className="mini-btn" aria-label={`Restore ${s.name}`} disabled={running}
                        title={running ? 'A deployment is running.' : undefined}
                        onClick={() => setRestoring(s)}>Restore</button>
              : '',
          ],
        }))}
        emptyText={rows === null ? 'Loading…' : 'No VM snapshots yet. The next Update of a deployed VM takes one.'}
      />}
      {restoring && (
        <RestoreVmSnapshotModal env={env} snapshot={restoring} onClose={() => setRestoring(null)}
                                onStarted={(dep) => { setRestoring(null); onStarted(dep); }} />
      )}
    </section>
  );
}
```

In `sirdar/web/src/pages/environments/BackupsTab.tsx`, replace:

```tsx
import { deploymentRunning, formatBytes, when } from './labels';
import RestoreBackupModal from './RestoreBackupModal';
```

with:

```tsx
import { deploymentRunning, formatBytes, onProxmox, when } from './labels';
import RestoreBackupModal from './RestoreBackupModal';
import VmSnapshots from './VmSnapshots';
```

and replace:

```tsx
  return (
    <section className="sirdar-section">
      <div className="sirdar-section-head">
        <h2>Backups</h2>
```

with:

```tsx
  return (
    <>
    {onProxmox(env) && <VmSnapshots env={env} onStarted={onStarted} />}
    <section className="sirdar-section">
      <div className="sirdar-section-head">
        <h2>Backups</h2>
```

and the component's last lines:

```tsx
      )}
    </section>
  );
}
```

with:

```tsx
      )}
    </section>
    </>
  );
}
```

- [ ] **Step 5: Run the tests, type-check and build**

Run: `npm --prefix sirdar/web test`
Expected: PASS (the whole web suite).

Run: `npm --prefix sirdar/web run build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add sirdar/web/src/pages/environments/VmSnapshots.tsx sirdar/web/src/pages/environments/VmSnapshots.test.tsx \
  sirdar/web/src/pages/environments/RestoreVmSnapshotModal.tsx sirdar/web/src/pages/environments/BackupsTab.tsx
git commit -m "feat(sirdar-web): VM snapshots with Restore on the Backups tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Live verify on the live Sirdar and Jimmy's Proxmox host with a throwaway uat3 (controller, not a subagent)

The controller runs this task itself, through Claude in Chrome, with Jimmy signed in to the live Sirdar at `https://sirdar.dev.serversherpa.com` (Tower, `10.10.48.14`). The Proxmox host is the Supermicro that runs the uat VM (`10.10.48.63`). The environment under test is a new **uat3** on a new VM.

**Hard rules for this task**

- **Never touch the existing uat VM** (`10.10.48.63`, environment `uat`): no deploy, snapshot, restore or delete on it, no Proxmox action on its VM. uat3 gets an address that is free and not 10.10.48.63 (Sirdar refuses it anyway).
- **Jimmy enters the Proxmox URL and token himself**, and runs every command on the Proxmox host himself (template, pool, role, token). Claude never types, reads back, prints or asks for the token.
- **Every outward action needs Jimmy's yes, per click**: Save or Remove of the integration, trusting the certificate, Create environment, every Deploy, Restore VM snapshot, Delete environment. Before each, say in chat exactly what it will create, change or destroy (VM name and id included) and wait. Test buttons and page reads are read-only; still say "testing Proxmox now" first.
- Publish stays **Off** for uat3 (no Cloudflare or NPM changes in this run).
- `ssh … 'bash -s' <<EOF` eats stdin under `docker compose`; keep every SSH command a single command line.
- Load the browser tools once: ToolSearch `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__form_input,mcp__claude-in-chrome__read_network_requests,mcp__claude-in-chrome__tabs_create_mcp`.
- `window.confirm` (Remove integration) blocks automation: Jimmy clicks OK himself.

**Known risks to watch (fix TDD-style on the owning 5a/5b task, redeploy, retry):**
- Terraform refuses the pinned certificate (`x509: certificate signed by unknown authority` or a name mismatch in step 0's log): Go must accept the leaf as its own root and the URL's host must be in the certificate's names. First check the URL uses a name or IP listed under Names in the trust prompt. If Go still refuses a leaf root, stop and report: the fallback (pinning `pve-root-ca.pem`) is a follow-up, not something to improvise.
- Privilege names differ by Proxmox version (`VM.GuestAgent.*` exist on 9; on 8 use `VM.Monitor`); a 403 in Test or step 0 names what the token isn't allowed to do.
- `GET /pools/{pool}` deprecated on the host's Proxmox version (Test's Pool check fails while the others pass): switch the client to `GET /pools?poolid=` on Task 3.
- The guest agent never answers (template without `qemu-guest-agent`): step 0 says so after 5 minutes.
- `terraform init` going online (it must not: the mirror is in the image).

- [ ] **Step 1: Preconditions — the code is live on Tower**

1. Plans 5a and 5b are merged to `main` and pushed (Jimmy decides): `git -C /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar log -1 --format=%H origin/main` shows the merge.
2. Jimmy updates Tower with the installer at that commit (it also creates `sirdar/terraform`):

   ```bash
   SHA=$(git -C /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar rev-parse origin/main)
   echo "curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/$SHA/sirdar/install.sh | SIRDAR_DIR=/mnt/user/serversherpa/sirdar bash"
   ```

   Then on Tower: `docker exec sirdar-sirdar-1 sh -c 'cd /app/api && alembic current'` → `0007 (head)`; `docker exec sirdar-sirdar-1 terraform version` → `Terraform v1.16.5`; `docker exec sirdar-sirdar-1 ls -ld /app/terraform` → owned by `sirdar`, `drwx------`.
3. Chrome → `https://sirdar.dev.serversherpa.com/settings`: Integrations shows a **Proxmox** card, "Not set up". `/deploy` lists no Proxmox target yet.
4. Baselines (read-only):

   ```bash
   ssh jrh1812@10.10.48.63 "uptime; docker ps --format '{{.Names}}' | grep -c '^ss-uat-'"
   curl -s -o /dev/null -w 'uat api %{http_code}\n' https://api.uat.serversherpa.com/healthz
   ping -c1 -W1 10.10.48.70 >/dev/null && echo "10.10.48.70 IN USE" || echo "10.10.48.70 free"
   ```

   Expected: uat up with its containers; `uat api 200`. Ask Jimmy which free LAN address uat3 should use (default `10.10.48.70/24`, gateway `10.10.48.1`; it must answer "free" above). Ask Jimmy to note uat's own VM id in Proxmox (it is outside the `sirdar` pool, so Sirdar can't see it).

- [ ] **Step 2: Jimmy prepares Proxmox (his terminal, on the Proxmox host)**

Jimmy follows `sirdar/README.md` › Proxmox targets: the template (id 9000 or his choice) with `qemu-guest-agent`, the `sirdar` pool holding it, the `SirdarProvision` role, the `sirdar@pve` user and its token (shown once; he keeps it). If `pvesh set /pools/sirdar --vms 9000` is refused on his version, he adds the template to the pool in the GUI (Datacenter › Permissions › Pools › sirdar › Members › Add › Virtual Machine). He tells Claude "ready" and the template id; nothing else.

- [ ] **Step 3: Set up and test the integration**

1. Ask Jimmy to click **Set up Proxmox** and fill it himself: URL (e.g. `https://<proxmox-ip>:8006`), Node, Pool `sirdar`, Storage, Bridge, VLAN tag (empty unless his LAN is tagged), Template VM id, API token. He clicks **Test**.
2. The **Server certificate** box appears with the SHA-256 fingerprint, subject, issuer, expiry and names. Ask Jimmy to compare the fingerprint with Proxmox's node › System › Certificates (pve-ssl.pem) and, if it matches, click **Trust this certificate** (his click). The Test runs again: Proxmox `Version 9.x` (or 8.x), Node pass, Pool pass (N VMs: note it as `POOL_VMS`), Template pass, Storage pass with free GB, Bridge pass or "can't check it" (warn).
3. Ask, then **Save** (his click or yours after his yes). The card: Configured, URL, "Node and pool", "Builds from ubuntu template 9000 · <storage> · <bridge>", Certificate `XX:XX:…`, "API token: Set (sirdar@pve!sirdar)".
4. With Jimmy's go-ahead, click the card's **Test**: the same checks. `read_network_requests` on `/deploy/integrations` shows `token_set: true`, a `token_id`, and no token or UUID. `/deploy` now shows a **Proxmox** target card ("PVE") whose hint points to Settings and New environment.

- [ ] **Step 4: Create uat3**

Ask Jimmy, naming it: environment `uat3` (type Custom), target Proxmox, VM `ss-uat3` with 2 vCPU, 4 GB, 40 GB disk, Static `10.10.48.70/24` via `10.10.48.1` (his address), proxy IP `10.10.48.6`, Publish **Off**, Data Start empty. On his yes: `/deploy` › **New environment** → Basics (Target: Proxmox) → **Machine** → Services (every address "The VM's address") → Data → Review ("Machine: 2 vCPU · 4 GB · 40 GB disk · 10.10.48.70/24 via 10.10.48.1") → **Create environment**. The Overview shows "Machine": `ss-uat3 · built by the first deploy`, Address "Not known yet". Nothing exists in Proxmox yet.

- [ ] **Step 5: The first deploy builds the VM**

1. Ask Jimmy, naming it: Deploy uat3 (Update, ref `main`) creates VM `ss-uat3` in pool `sirdar` (a full clone of the template), then installs Docker and the stacks on it. The Deploy modal says "The first deploy builds the VM; there's nothing to snapshot yet." On his yes, **Deploy**. The response's commit is blank until step 0 resolves it.
2. Follow step 0 "Prepare VM": "Reserved VM id N for ss-uat3." (note `VMID`), Terraform's init (offline, from the mirror) and apply output, "The VM answers at 10.10.48.70.", "Pinned 10.10.48.70's SSH host key SHA256:…, read through the guest agent.", "main is <sha>." Then steps 1–10 as for any target (Bootstrap installs Docker; Build takes a while). If step 0 fails, read the log against the known risks, fix, and **Retry from step 0**.
3. Checks:

   ```bash
   curl -s -o /dev/null -w 'uat3 api %{http_code}\n' http://10.10.48.70:8000/healthz
   curl -s -o /dev/null -w 'uat3 portal %{http_code}\n' http://10.10.48.70:8091/
   ```

   Expected: `200` and `200` (or a 30x for the portal). Overview: Machine `ss-uat3 (VM <VMID>)`, Address `10.10.48.70`, running commit = the resolved SHA. The Deploy page's trusted hosts list `10.10.48.70:22`. Jimmy confirms in Proxmox: VM `<VMID>` `ss-uat3` in pool `sirdar`, tags `sirdar` and `ss-uat3`, description "Managed by Sirdar (environment uat3)…".
4. Jimmy runs on Tower: `ls -la /mnt/user/serversherpa/sirdar/sirdar/terraform/` → one folder (uat3's id), mode `drwx------`, owned by uid 10001; and `grep -c PROXMOX_VE_API_TOKEN /mnt/user/serversherpa/sirdar/sirdar/terraform/*/main.tf.json` → `0`.

- [ ] **Step 6: A second deploy takes a VM snapshot; restore it**

1. Ask Jimmy, naming it: Deploy uat3 again (Update, `main`), which first takes VM snapshot `sirdar-<UTC time>` of `ss-uat3`. The Deploy modal shows **VM snapshot first: On**. On his yes, **Deploy**. Step 0 logs "Updating ss-uat3 …", "SSH host key … is pinned.", "Took VM snapshot sirdar-…" (note `VMSNAP`). All steps succeed.
2. Backups tab → **VM snapshots** lists `VMSNAP` with its commit; Backups lists the pre-deploy dump.
3. Make a visible change after the snapshot: on uat3's portal (`http://10.10.48.70:8091`) Jimmy creates the first admin (or any record), or Claude runs `curl -s http://10.10.48.70:8000/healthz` only — the minimum proof is the restore's log and the app answering afterwards. Note what changed.
4. Ask Jimmy, naming it: **Restore VM snapshot** `VMSNAP` rolls `ss-uat3` back to before the second deploy (anything written since is lost). On his yes: Backups › VM snapshots › **Restore** → type `uat3` → **Restore VM snapshot**. Step 0 "Restore VM snapshot" logs "Rolling ss-uat3 back to VMSNAP.", "Started the VM.", "The VM answers at 10.10.48.70.", "SSH host key … is pinned.", "ss-uat3 is back at VMSNAP; Docker starts its containers."
5. Checks: `curl … http://10.10.48.70:8000/healthz` → `200` (allow a minute for the containers); the change from 3. is gone; Overview's running commit is the snapshot's commit; the Deployments list shows "Restore VM snapshot" succeeded.

- [ ] **Step 7: Resize (optional, ask Jimmy; default skip)**

If Jimmy wants it: Settings › Machine vCPUs 2 → 4 → Save, then Deploy (VM snapshot Off): step 0 logs "Updating ss-uat3 (4 vCPU …)" and Terraform's in-place change; Proxmox shows 4 cores.

- [ ] **Step 8: Secrets stay out (Jimmy runs this)**

In his own terminal on Tower (Claude never sees the value):

```bash
read -rs PXT
docker logs sirdar-sirdar-1 2>&1 | grep -cF "${PXT#*=}"
docker exec sirdar-sirdar-db-1 psql -U sirdar -d sirdar -tAc "SELECT count(*) FROM deployment_steps WHERE strpos(log, '${PXT#*=}') > 0"
grep -rlF "${PXT#*=}" /mnt/user/serversherpa/sirdar/sirdar/terraform/ | wc -l ; unset PXT
```

Expected: `0`, `0`, `0`. (Adjust container names to Tower's if they differ.)

- [ ] **Step 9: UI checks (light and dark)**

In My preferences switch Theme to Dark, then revisit: Settings › Integrations (the Proxmox card; open **Edit** and Cancel — the modal fits its content, three columns of fields), New environment with Proxmox chosen (Machine step; Cancel), uat3's Overview (Machine), Settings (read-only target, Machine group), Backups (VM snapshots table), the Restore VM snapshot and Delete environment modals (open and Cancel), and a deployment's step 0 log. Readable contrast, no white blocks. Back to Light and spot-check.

- [ ] **Step 10: Delete uat3 and confirm the VM is destroyed**

1. Ask Jimmy, naming it: **Delete environment** uat3 destroys VM `<VMID>` `ss-uat3` on Proxmox with its disks and VM snapshots, then removes uat3 from Sirdar (no DNS or proxy hosts exist for it). On his yes: uat3 › Settings › **Delete environment…** → the modal says "Destroys the VM ss-uat3 (VM <VMID>) on Proxmox with everything on it…" → type `uat3` → **Delete environment**. Steps: 15 Destroy VM ("Destroying ss-uat3 (VM <VMID>) and its VM snapshots with Terraform.", Terraform's destroy output, "Destroyed ss-uat3.", "Forgot 10.10.48.70's SSH host key."), 16, 17 (nothing to remove). Then "uat3 was deleted."
2. Checks: Jimmy confirms in Proxmox that VM `<VMID>` is gone and the pool holds only the template (Settings › Integrations › Test → Pool `sirdar · POOL_VMS VMs` again). `ping -c1 -W1 10.10.48.70` → no answer. On Tower: `ls /mnt/user/serversherpa/sirdar/sirdar/terraform/` → empty (only `.gitkeep`). The Deploy page's trusted hosts no longer list `10.10.48.70:22`. Settings › Audit shows `deploy.environment_create`, the deployments, `deploy.host_trust` (target `proxmox:uat3`), `deploy.host_forget` and `deploy.environment_delete` for uat3.

- [ ] **Step 11: uat is untouched**

```bash
ssh jrh1812@10.10.48.63 "uptime; docker ps --format '{{.Names}}' | grep -c '^ss-uat-'"
curl -s -o /dev/null -w 'uat api %{http_code}\n' https://api.uat.serversherpa.com/healthz
```

Expected: the same uptime trend and container count as Step 1, and `200`. Jimmy confirms uat's VM in Proxmox has no new snapshot. In Sirdar, uat's Deployments list gained nothing.

- [ ] **Step 12: Report**

Each step's result (passed, or what failed and the fix commit), the VM id, the snapshot name, the step 0 timings (clone, agent, SSH), whether any known risk showed up (certificate pinning in Go, privileges, pools endpoint, agent), the leak-check zeros, that uat3's VM was destroyed and the Terraform folder removed, and that uat was untouched. Note any open question from the context file that the run answered.

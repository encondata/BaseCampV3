# Sirdar deploy phase 6b (VMware ESXi targets: UI and live verify) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the ESXi backend from 6a its web side, then prove it on Jimmy's real ESXi 7 host with a throwaway `uat3`:

- an ESXi card and modal in Settings › Integrations, sharing one certificate trust prompt with Proxmox;
- Proxmox moved into a collapsed "Other hosts" area;
- ESXi as a target in New environment, with the same Machine step;
- environment pages that name the right host;
- the ESXi disk-grow warning.

**Architecture:**
- The certificate prompt moves out of `ProxmoxModal` into `components/CertificatePrompt.tsx`, used by `ProxmoxModal` and the new `EsxiModal`.
- `labels.tsx` gains host-neutral helpers (`onVmHost`, `hostLabel`, `isVmTarget`, `vmRef`, and a `vmStage` that reads the API's `stage`). Every environment page uses them instead of `onProxmox`.
- `IntegrationsSection` renders cards through one function, so the same card can appear in the main grid or in "Other hosts".

**Tech Stack:** React 18 + TypeScript, Vite, Vitest + Testing Library (jsdom), the portal's `DataTable` / `ComboBox` / `lib/api` through the `@portal` alias.

**Spec and context:**
- Spec: `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md` Section 6.
- Decisions: `docs/superpowers/plans/2026-10-05-sirdar-phase6-context.md`.
- API: `docs/superpowers/plans/2026-10-05-sirdar-phase6a-backend.md` ("API produced for 6b"), restated below.

## Interfaces from 6a

All under `/api/deploy`. The web client's paths start with `/deploy`, and `VITE_API_URL=/api`.

**Integrations**

- `Integrations.esxi` is `{configured, url, user, datastore, network, resource_pool: string|null, source_vm, dns_servers: string[], tls_fingerprint: string|null, password_set, updated_at, updated_by_name}`.
- `PUT /integrations/esxi` (change) takes `{url, user, datastore, network, resource_pool: string|null, source_vm, dns_servers: string[], tls_fingerprint: string|null, password?}` and returns `Integrations`.
- `POST /integrations/esxi/test` (change), with the PUT body as an optional body, returns `{ok, target: "esxi", checks, facts: {url, version, build, fingerprint, user}}`. The check labels are ESXi, License, Datastore, Network, Resource pool and Seed VM.
- PUT and test answer these errors:
  - 409 `tls_untrusted {fingerprint, subject, issuer, not_after, names}` (an ESXi certificate usually names only `localhost.localdomain`);
  - 409 `tls_mismatch {expected, actual}`;
  - 502 `connect_failed {reason}`;
  - 422 `esxi_url_invalid | esxi_user_invalid | datastore_invalid | network_invalid | resource_pool_invalid | source_vm_invalid | dns_servers_invalid | password_invalid | tls_fingerprint_invalid | secret_required {reason?}`.
- The password is reused only for the same URL and user.
- `DELETE /integrations/esxi` (change) returns 204, or 409 `integration_in_use {environments}`.

**Targets and environments**

- `GET /targets` lists `{id: "esxi", label: "VMware ESXi", kind: "esxi", available: true, configured: true}` after Proxmox, once ESXi is saved.
- `POST /environments` with `target: "esxi"` takes the same `vm` body as Proxmox. Errors: 409 `integration_not_configured {kinds: ["esxi"]}`, 409 `ip_in_use`, and the `vm_*` 422s. Adopt on `esxi` returns 422 `adopt_not_allowed`.
- `Environment.target_kind` is `"ssh" | "proxmox" | "esxi"`. `Environment.vm` is:

  ```
  {kind: "proxmox"|"esxi", stage: "none"|"partial"|"built", name, host,
   node: string|null, vmid: number|null, moref: string|null,
   cores, memory_mb, disk_gb, ip_mode, ip_cidr, gateway, ip, keep_snapshots, created}
  ```

  - `host` is the Proxmox node or the ESXi host's address.
  - `node` and `vmid` are set only for Proxmox; `moref` only for ESXi.
- `PATCH` with `vm` works for both. `target_kind_locked` also blocks Proxmox ⇄ ESXi.

**Deployments and VM snapshots**

- Deploys, retries, Roll back, `take_vm_snapshot`, `vm_restore` and the VM snapshot list behave the same for both hosts.
- `GET …/vm-snapshots` and `vm_restore` on an SSH environment answer 409 `not_vm_environment`. That replaces `not_proxmox`, which the API no longer sends.
- Steps: 0 `provision` "Prepare VM", 0 `vm_restore` "Restore VM snapshot", 15 `destroy` "Destroy VM".

## Global Constraints

**Modals and controls**

- Every new modal gets the report-generate header (eyebrow, title, description) and sizes to its content: a content-matched card width, with dropdowns rendered through `portal`.
- Reuse the existing portal and Sirdar idioms: `DataTable`, `ComboBox`, segmented radio groups with `arrowNav`, chips, and `.pf-form` with `.field-label` for captions that aren't labels.
- No raw native `<select>`.
- Sections inside a `.pf-form` grid in a modal body get `grid-column: 1 / -1` (the `sirdar-span2` class).
- The ESXi password is write-only in the UI: never prefilled, never shown. The card shows only "Set" or "Not set".
- Don't add reader-facing widgets that weren't asked for. The "Other hosts" disclosure was asked for; no power buttons.

**Copy**

- American English in all copy.
- Display "Canceled" for the `cancelled` status.

**Tests and builds**

- Component tests:
  - start with `// @vitest-environment jsdom`;
  - mock `../../lib/sirdarApi` (spreading the real module) and `@portal/auth/AuthContext` the way the existing environment tests do;
  - set `Element.prototype.scrollIntoView = () => {}` when a ComboBox is used.
- No new `@portal` import. Only `auth/AuthContext`, `components/DataTable`, `components/ComboBox` and `lib/api` are allowlisted.
- `tsc` type-checks tests too (`noUnusedLocals`, `noUnusedParameters`).
- Web tests: `npm --prefix sirdar/web test`. Type-check and build: `npm --prefix sirdar/web run build`.
- Never run `npm install` in this worktree.

**Git in a shared worktree**

- Work in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`).
- Other agents may commit here at the same time (web layout fixes):
  - `git add` only your task's files;
  - never `git stash`;
  - retry when `.git/index.lock` is busy.
- If a file this plan edits has changed since it was written, apply the same edit to the new text and keep their change.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Change |
|---|---|
| `sirdar/web/src/lib/sirdarApi.ts` (+ `sirdarApi.test.ts`) | ESXi integration types and bodies, `VmHostKind`, the new `EnvVm` fields, messages for every new code, host-neutral copy, `not_vm_environment` |
| `sirdar/web/src/pages/environments/labels.tsx` (+ `labels.test.ts`) | `isVmTarget`, `onVmHost`, `hostLabel`, `vmRef`, `envTargets` with ESXi, `vmStage` from `stage` |
| `sirdar/web/src/pages/environments/testData.ts` | ESXi fixtures; Proxmox VM fixtures with the new fields |
| `sirdar/web/src/components/CertificatePrompt.tsx` (+ test) | Shared trust prompt and `pendingCertificate()` |
| `sirdar/web/src/pages/settings/ProxmoxModal.tsx` | Uses `CertificatePrompt` |
| `sirdar/web/src/pages/settings/EsxiModal.tsx` (+ test) | New |
| `sirdar/web/src/pages/settings/IntegrationsSection.tsx` (+ test) | ESXi card; Proxmox in "Other hosts" |
| `sirdar/web/src/pages/Deploy.tsx` (+ test) | ESXi target card |
| `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx` (+ test) | ESXi target and Machine copy |
| `EnvOverview.tsx` (+ test), `EnvSettings.tsx` (+ test), `DeleteEnvironmentModal.tsx` (+ test), `DeployModal.tsx` (+ test), `BackupsTab.tsx`, `VmSnapshots.tsx` (+ test), `RestoreVmSnapshotModal.tsx` | Host-neutral |
| `sirdar/web/src/styles/sirdar.css` | `.sirdar-esxi-card` / `.sirdar-esxi-form`, `.sirdar-other-hosts` |

---

### Task 1: API client, labels and fixtures

**Files:**
- Modify: `sirdar/web/src/lib/sirdarApi.ts`, `sirdar/web/src/lib/sirdarApi.test.ts`
- Modify: `sirdar/web/src/pages/environments/labels.tsx`, `sirdar/web/src/pages/environments/labels.test.ts`
- Modify: `sirdar/web/src/pages/environments/testData.ts`

**Interfaces:**
- Produces (`sirdarApi`):
  - `type VmHostKind = 'proxmox' | 'esxi'`;
  - `IntegrationKind = PublishKind | VmHostKind`;
  - `INTEGRATION_LABEL.esxi = 'VMware ESXi'`;
  - `interface EsxiIntegration`, `interface EsxiBody`, and `Integrations.esxi`;
  - `DeployTarget.kind` includes `'esxi'`;
  - `Environment.target_kind: 'ssh' | VmHostKind`;
  - `EnvVm` gains `kind: VmHostKind`, `stage: 'none' | 'partial' | 'built'`, `host: string`, `moref: string | null`, and `node: string | null`.
- Produces (`labels`):
  - `VM_HOST_LABEL: Record<VmHostKind, string>` (`Proxmox`, `ESXi`);
  - `isVmTarget(id: string): boolean`;
  - `onVmHost(env: Environment): boolean`;
  - `hostLabel(env: Environment): string`;
  - `vmRef(vm): string | null` ("VM 120", "VM 12");
  - `vmStage(vm)`, which prefers `vm.stage`;
  - `envTargets` lists ESXi after Proxmox;
  - `onProxmox` stays, for code that is truly Proxmox-only.
- Produces (fixtures in `testData`):
  - `INTEGRATIONS.esxi` (configured) and `NO_INTEGRATIONS.esxi`;
  - `ESXI_FINGERPRINT`, `ESXI_CERT`, `ESXI_PASSWORD`, `ESXI_CHECK`, `ESXI_TARGETS`;
  - `ESXI_VM`, `ESXI_ENV`, `ESXI_NEW_ENV`;
  - `PX_VM` gains `kind: 'proxmox', stage: 'built', host: 'pve', moref: null`.

- [ ] **Step 1: Write the failing tests**

Append to `sirdar/web/src/pages/environments/labels.test.ts`. Import the new names from `./labels` and the fixtures from `./testData`:

```ts
describe('VM hosts', () => {
  it('knows both hosts', () => {
    expect(isVmTarget('esxi')).toBe(true);
    expect(isVmTarget('proxmox')).toBe(true);
    expect(isVmTarget('ssh:uat')).toBe(false);
    expect(onVmHost(ESXI_ENV)).toBe(true);
    expect(onVmHost(PX_ENV)).toBe(true);
    expect(onVmHost(ENV)).toBe(false);
    expect(hostLabel(ESXI_ENV)).toBe('ESXi');
    expect(hostLabel(PX_ENV)).toBe('Proxmox');
  });

  it('names a VM by its id on either host', () => {
    expect(vmRef(PX_VM)).toBe('VM 120');
    expect(vmRef(ESXI_VM)).toBe('VM 12');
    expect(vmRef({ ...ESXI_VM, moref: null })).toBeNull();
  });

  it("reads the stage from the API, with Proxmox's old rule as the fallback", () => {
    expect(vmStage(ESXI_NEW_ENV.vm!)).toBe('none');
    expect(vmStage({ ...ESXI_VM, stage: 'partial' })).toBe('partial');
    expect(vmStage({ created: false, vmid: 120 })).toBe('partial');
  });

  it('offers ESXi as a target once it is set up', () => {
    expect(envTargets(ESXI_TARGETS.targets).map((t) => t.id)).toContain('esxi');
  });
});
```

Append to `sirdar/web/src/lib/sirdarApi.test.ts`, using the file's existing `ApiError` construction helper (copy how its other message tests build an error):

```ts
it('names ESXi in integration_not_configured and explains the new codes', () => {
  expect(deployErrorText(apiError(409, { code: 'integration_not_configured', kinds: ['esxi'] }), 'x'))
    .toBe('Set up VMware ESXi in Settings › Integrations first.');
  for (const code of ['esxi_url_invalid', 'esxi_user_invalid', 'datastore_invalid', 'network_invalid',
    'resource_pool_invalid', 'source_vm_invalid', 'dns_servers_invalid', 'not_vm_environment']) {
    expect(deployErrorText(apiError(422, { code }), 'fallback')).not.toBe('fallback');
  }
});
```

If the file's helper isn't called `apiError`, use its real name. If the existing "every API code has a message" scan test lists codes by reading the API source, it now finds the eight new codes automatically, and must pass once Step 3 adds them.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments/labels.test.ts src/lib/sirdarApi.test.ts`
Expected: FAIL. The new imports are missing.

- [ ] **Step 3: Types and messages in `sirdarApi.ts`**

1. `DeployTarget`: change the doc comment to "… | 'proxmox' | 'esxi' (once set up)." and the type to `kind?: 'aws' | 'gcp' | 'digitalocean' | 'ssh' | 'proxmox' | 'esxi';`.
2. Replace the integration kind block:

```ts
/** The integrations Sirdar publishes with. */
export type PublishKind = 'cloudflare' | 'npm';
/** The hosts Sirdar builds environments' VMs on. */
export type VmHostKind = 'proxmox' | 'esxi';
export type IntegrationKind = PublishKind | VmHostKind;
export const INTEGRATION_LABEL: Record<IntegrationKind, string> = {
  cloudflare: 'Cloudflare', npm: 'Nginx Proxy Manager', proxmox: 'Proxmox', esxi: 'VMware ESXi',
};
```

3. After `ProxmoxIntegration`, add:

```ts
export interface EsxiIntegration {
  configured: boolean; url: string | null; user: string | null; datastore: string | null; network: string | null;
  /** null: the host's root resource pool. */
  resource_pool: string | null;
  /** The powered-off VM whose disk every new VM copies. */
  source_vm: string | null;
  /** Empty: each VM uses its gateway. */
  dns_servers: string[];
  tls_fingerprint: string | null; password_set: boolean; updated_at: string | null; updated_by_name: string | null;
}
```

   Then add `esxi: EsxiIntegration;` to `Integrations`.
4. After `ProxmoxBody`, add:

```ts
/** tls_fingerprint: the certificate the user trusted (null: show it first). An omitted password keeps the stored one. */
export interface EsxiBody {
  url: string; user: string; datastore: string; network: string; resource_pool: string | null; source_vm: string;
  dns_servers: string[]; tls_fingerprint: string | null; password?: string;
}
```

   Then widen both `saveIntegration` and `testIntegration` to `body: CloudflareBody | NpmBody | ProxmoxBody | EsxiBody`. Change the `TlsCertificate` comment to "A VM host's certificate, as tls_untrusted describes it."
5. In `Environment`, use the comment `/** 'proxmox' | 'esxi': its host is a VM Sirdar builds (`vm`); 'ssh': a saved SSH target. */` and the type `target_kind: 'ssh' | VmHostKind;`.
6. Replace `EnvVm`:

```ts
/** A VM environment's VM. `stage`: none before step 0 starts one, partial while it isn't finished, then built.
 *  `vmid`/`node` are Proxmox's, `moref` ESXi's; `ip` is null until the VM reports it. */
export interface EnvVm {
  kind: VmHostKind; stage: 'none' | 'partial' | 'built'; name: string;
  /** The Proxmox node, or the ESXi host's address. */
  host: string; node: string | null; vmid: number | null; moref: string | null;
  cores: number; memory_mb: number; disk_gb: number;
  ip_mode: 'static' | 'dhcp'; ip_cidr: string | null; gateway: string | null; ip: string | null;
  keep_snapshots: number; created: boolean;
}
```

7. `NewEnvironmentBody.vm` comment: "a VM target ('proxmox' or 'esxi') only". `DeploymentBody.take_vm_snapshot` comment: "VM environments' update / reset / restore_dump: …". `DeploymentSummary.vm` comment: "(a VM environment)".
8. Messages. Replace the `// Proxmox targets` block's host-specific lines, and add the ESXi ones:

```ts
  // VM hosts (Proxmox and ESXi)
  proxmox_url_invalid: 'Use the Proxmox address with https, like https://10.10.48.5:8006 (no path).',
  node_invalid: "That node name isn't valid.",
  pool_invalid: "That pool name isn't valid.",
  storage_invalid: "That storage name isn't valid, like local-lvm.",
  bridge_invalid: "That bridge name isn't valid, like vmbr0.",
  vlan_tag_invalid: 'Use a VLAN tag from 1 to 4094, or leave it empty.',
  template_vmid_invalid: "Use the template's VM id, a number from 100 up.",
  proxmox_token_invalid: "That doesn't look like a Proxmox API token (user@realm!tokenid=secret).",
  esxi_url_invalid: 'Use the ESXi host with https, like https://10.10.48.10 (no path).',
  esxi_user_invalid: "That user name isn't valid, like sirdar or root.",
  datastore_invalid: "That datastore name isn't valid, like datastore1.",
  network_invalid: "That port group name isn't valid, like VM Network.",
  resource_pool_invalid: "That resource pool name isn't valid. Leave it empty for the host's root pool.",
  source_vm_invalid: "That seed VM name isn't valid, like sirdar-ubuntu-2404-seed.",
  dns_servers_invalid: 'Use up to 3 IPv4 addresses, separated by commas, or leave it empty.',
  tls_untrusted: "Sirdar doesn't trust this server's certificate yet.",
  tls_mismatch: "The server's certificate doesn't match the one Sirdar trusted.",
```

   and change these existing entries to host-neutral copy:

```ts
  vm_not_allowed: 'Only an environment on a VM host has a VM.',
  ip_in_use: 'That address is already used: by the proxy, an SSH target, a VM host or another environment.',
  adopt_not_allowed: 'Only environments on SSH targets can be adopted. Environments on Proxmox or ESXi are ones Sirdar builds.',
  host_ip_managed: "A VM environment's services always run on its VM.",
  target_kind_locked: "An environment can't move between an SSH target and a VM host, or between VM hosts.",
  vm_snapshot_not_allowed: 'Only an environment on a VM host takes VM snapshots.',
  not_vm_environment: "This environment isn't on a VM host.",
```

   Delete the `not_proxmox` entry, since the API no longer sends it. Update `sirdarApi.test.ts` wherever it asserted the old texts of the changed entries.

- [ ] **Step 4: Labels**

In `sirdar/web/src/pages/environments/labels.tsx`:
- import `type VmHostKind` along with the existing `sirdarApi` type imports;
- replace `envTargets`, `onProxmox`, `vmBuilt` and `vmStage` with:

```ts
export const VM_HOST_LABEL: Record<VmHostKind, string> = { proxmox: 'Proxmox', esxi: 'ESXi' };

/** A target whose host is a VM Sirdar builds. */
export const isVmTarget = (id: string) => id === 'proxmox' || id === 'esxi';

/** Targets a new environment can use: configured SSH targets, then the VM hosts once set up. */
export const envTargets = (targets: DeployTarget[]) =>
  [...sshTargets(targets), ...targets.filter((t) => isVmTarget(t.id) && t.configured)];

/** Its host is a VM Sirdar builds, on Proxmox or ESXi. */
export const onVmHost = (env: Environment) => env.target_kind === 'proxmox' || env.target_kind === 'esxi';
/** Its host is a VM Sirdar builds on Proxmox. */
export const onProxmox = (env: Environment) => env.target_kind === 'proxmox';
/** "Proxmox" or "ESXi" for a VM environment. */
export const hostLabel = (env: Environment) => (env.target_kind === 'esxi' ? 'ESXi' : 'Proxmox');

type StageOf = Pick<EnvVm, 'created' | 'vmid'> & Partial<Pick<EnvVm, 'stage'>>;
// none: no VM yet. partial: one exists (or an id is reserved) but the first build didn't finish. built.
export const vmStage = (vm: StageOf): 'none' | 'partial' | 'built' =>
  vm.stage ?? (vm.vmid === null ? 'none' : vm.created ? 'built' : 'partial');
/** Sirdar built the VM (an id reserved, or a VM half built, is not a VM yet). */
export const vmBuilt = (vm: StageOf) => vmStage(vm) === 'built';
/** "VM 120" (Proxmox) or "VM 12" (ESXi's managed object id); null before one exists. */
export const vmRef = (vm: Pick<EnvVm, 'vmid' | 'moref'>) =>
  vm.vmid !== null ? `VM ${vm.vmid}` : vm.moref ? `VM ${vm.moref}` : null;
```

- [ ] **Step 5: Fixtures**

In `sirdar/web/src/pages/environments/testData.ts`:

1. Add to `INTEGRATIONS`:

```ts
  esxi: { configured: true, url: 'https://10.10.48.10', user: 'sirdar', datastore: 'datastore1', network: 'VM Network',
          resource_pool: null, source_vm: 'sirdar-ubuntu-2404-seed', dns_servers: [],
          tls_fingerprint: fingerprint(11), password_set: true,
          updated_at: '2026-10-05T15:00:00Z', updated_by_name: 'Jimmy Henderson' },
```

   `fingerprint` is defined below `INTEGRATIONS` in this file. If TypeScript complains that it is used before its definition, move the `fingerprint` function above `INTEGRATIONS` (it's a function declaration, so this only matters for `const`).

2. Add to `NO_INTEGRATIONS`:

```ts
  esxi: { configured: false, url: null, user: null, datastore: null, network: null, resource_pool: null,
          source_vm: null, dns_servers: [], tls_fingerprint: null, password_set: false, updated_at: null,
          updated_by_name: null },
```

3. Change `PX_VM` to include `kind: 'proxmox', stage: 'built', host: 'pve', moref: null`. In `PX_NEW_ENV`, its `vm` override becomes `{ ...PX_VM, vmid: null, ip: null, created: false, stage: 'none' }`.
4. Append:

```ts
export const ESXI_FINGERPRINT = INTEGRATIONS.esxi.tls_fingerprint!;
/** What tls_untrusted describes for an ESXi host: its default certificate names only its host name. */
export const ESXI_CERT: TlsCertificate = {
  fingerprint: fingerprint(19), subject: 'localhost.localdomain', issuer: 'localhost.localdomain',
  not_after: '2030-01-01T00:00:00+00:00', names: ['localhost.localdomain'],
};
export const ESXI_PASSWORD = 'esxi-PASSWORD-s3cr3t!';
export const ESXI_CHECK: IntegrationCheck = {
  ok: true, target: 'esxi',
  checks: [
    { label: 'ESXi', status: 'pass', value: 'VMware ESXi 7.0.3 build-21930508' },
    { label: 'License', status: 'pass', value: 'esx.enterprisePlus.cpuPackage' },
    { label: 'Datastore', status: 'pass', value: 'datastore1 · 800 GB free' },
    { label: 'Network', status: 'pass', value: 'VM Network' },
    { label: 'Resource pool', status: 'pass', value: "The host's root pool" },
    { label: 'Seed VM', status: 'pass',
      value: 'sirdar-ubuntu-2404-seed · [datastore1] sirdar-ubuntu-2404-seed/sirdar-ubuntu-2404-seed.vmdk · 3 GB' },
  ],
  facts: { url: 'https://10.10.48.10', version: '7.0.3', build: '21930508', user: 'sirdar' },
};
export const ESXI_TARGETS = {
  ...TARGETS,
  targets: [...TARGETS.targets,
            { id: 'esxi', label: 'VMware ESXi', kind: 'esxi', available: true, configured: true } as DeployTarget],
};
export const ESXI_VM: EnvVm = {
  kind: 'esxi', stage: 'built', name: 'ss-uat3', host: '10.10.48.10', node: null, vmid: null, moref: '12',
  cores: 4, memory_mb: 8192, disk_gb: 64, ip_mode: 'static', ip_cidr: '10.10.48.71/24', gateway: '10.10.48.1',
  ip: '10.10.48.71', keep_snapshots: 3, created: true,
};
/** uat3 on ESXi, deployed. */
export const ESXI_ENV: Environment = {
  ...PX_ENV, target: 'esxi', target_kind: 'esxi', vm: ESXI_VM,
  services: PX_ENV.services.map((s) => ({ ...s, host_ip: '10.10.48.71' })),
};
/** uat3 on ESXi just created: no VM yet, never deployed. */
export const ESXI_NEW_ENV: Environment = {
  ...ESXI_ENV, status: 'new', current_sha: null, image_tag: null, last_deployment: null,
  vm: { ...ESXI_VM, stage: 'none', moref: null, ip: null, created: false },
};
```

- [ ] **Step 6: Run the tests and the type-check**

Run:

```bash
npm --prefix sirdar/web test
npm --prefix sirdar/web run build
```

Expected: all tests pass and the build type-checks. A component test that mocks a `vm` object literal without the new fields fails `tsc`; add the fields there. Do not loosen the type.

- [ ] **Step 7: Commit**

```bash
git add sirdar/web/src/lib/sirdarApi.ts sirdar/web/src/lib/sirdarApi.test.ts sirdar/web/src/pages/environments/labels.tsx sirdar/web/src/pages/environments/labels.test.ts sirdar/web/src/pages/environments/testData.ts
git commit -m "feat(sirdar-web): ESXi integration and VM types, host-neutral labels and messages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Also `git add` any other test file you had to touch for the new `EnvVm` fields.

---

### Task 2: The shared certificate prompt, the ESXi modal, Settings › Integrations and the Deploy page

**Files:**
- Create: `sirdar/web/src/components/CertificatePrompt.tsx`, `sirdar/web/src/components/CertificatePrompt.test.tsx`
- Create: `sirdar/web/src/pages/settings/EsxiModal.tsx`, `sirdar/web/src/pages/settings/EsxiModal.test.tsx`
- Modify: `sirdar/web/src/pages/settings/ProxmoxModal.tsx`
- Modify: `sirdar/web/src/pages/settings/IntegrationsSection.tsx`, `IntegrationsSection.test.tsx`
- Modify: `sirdar/web/src/pages/Deploy.tsx`, `Deploy.test.tsx`
- Modify: `sirdar/web/src/styles/sirdar.css`

**Interfaces:**
- Consumes (Task 1): `EsxiBody`, `EsxiIntegration`, `INTEGRATION_LABEL`, `VmHostKind`, and the fixtures.
- Produces:
  - `type PendingCertificate<W> = { kind: 'untrusted'; what: W; cert: TlsCertificate } | { kind: 'changed'; what: W; expected: string; actual: string }`;
  - `pendingCertificate<W>(err: unknown, what: W): PendingCertificate<W> | null`;
  - `<CertificatePrompt pending question busy onTrust />`;
  - `<EsxiModal current onSaved onClose />`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/components/CertificatePrompt.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/sirdarApi';
import { ESXI_CERT } from '../pages/environments/testData';

import CertificatePrompt, { pendingCertificate } from './CertificatePrompt';

const err = (status: number, detail: Record<string, unknown>) =>
  new ApiError(status, String(detail.code), detail);

describe('pendingCertificate', () => {
  it('reads a new certificate and a changed one', () => {
    expect(pendingCertificate(err(409, { code: 'tls_untrusted', ...ESXI_CERT }), 'save'))
      .toEqual({ kind: 'untrusted', what: 'save', cert: ESXI_CERT });
    expect(pendingCertificate(err(409, { code: 'tls_mismatch', expected: 'AA', actual: 'BB' }), 'test'))
      .toEqual({ kind: 'changed', what: 'test', expected: 'AA', actual: 'BB' });
  });

  it('is null for anything else, including a bare tls_untrusted', () => {
    expect(pendingCertificate(err(409, { code: 'tls_untrusted' }), 'save')).toBeNull();
    expect(pendingCertificate(err(422, { code: 'esxi_url_invalid' }), 'save')).toBeNull();
    expect(pendingCertificate(new Error('x'), 'save')).toBeNull();
  });
});

describe('CertificatePrompt', () => {
  it('shows the certificate and trusts its fingerprint', () => {
    const onTrust = vi.fn();
    render(<CertificatePrompt pending={{ kind: 'untrusted', what: 'save', cert: ESXI_CERT }}
                              question="Is this the ESXi host's certificate?" busy={false} onTrust={onTrust} />);
    expect(screen.getByText("Is this the ESXi host's certificate?")).toBeTruthy();
    expect(screen.getByText(ESXI_CERT.fingerprint)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Trust this certificate' }));
    expect(onTrust).toHaveBeenCalledWith(ESXI_CERT.fingerprint, 'save');
  });

  it('warns about a changed certificate', () => {
    const onTrust = vi.fn();
    render(<CertificatePrompt pending={{ kind: 'changed', what: 'test', expected: 'AA', actual: 'BB' }}
                              question="?" busy={false} onTrust={onTrust} />);
    fireEvent.click(screen.getByRole('button', { name: 'Trust the new certificate' }));
    expect(onTrust).toHaveBeenCalledWith('BB', 'test');
  });
});
```

Check how `ApiError` is constructed in the existing tests (`grep -n "new ApiError" sirdar/web/src -r | head -3`) and match its constructor arguments.

Create `sirdar/web/src/pages/settings/EsxiModal.test.tsx`. Model it on `ProxmoxModal.test.tsx`: read that file first, and copy its mocks, render helper and `ApiError` usage. Write these tests:

- Prefill: setting up from `NO_INTEGRATIONS` prefills user `sirdar`, network `VM Network`, datastore `datastore1` and seed `sirdar-ubuntu-2404-seed`. The password field is empty, and the action is "set".
- Save trust flow:
  1. Save with an untrusted certificate calls `saveIntegration('esxi', body)` with `tls_fingerprint: null`.
  2. The API answers `tls_untrusted` with `ESXI_CERT`, and the prompt shows the question naming the Host Client and `rui.crt`.
  3. Clicking "Trust this certificate" resends the same body with `tls_fingerprint: ESXI_CERT.fingerprint`.
  4. The second answer calls `onSaved`.
- Test: Test with stored settings calls `testIntegration('esxi', body)` and shows the six `ESXI_CHECK` labels.
- Validation. These block Save without an API call:
  - URL `http://x` → "Start with https://, then the host and port only.";
  - empty seed VM;
  - DNS servers `10.10.48.1, nope` → "Use up to 3 IPv4 addresses, separated by commas.";
  - user `a b`.
- Body shape: DNS servers typed as `10.10.48.1, 1.1.1.1` go in the body as `['10.10.48.1', '1.1.1.1']`; an empty resource pool goes as `null`.
- Password reuse: with a stored password and a changed URL, "keep" fails validation with "Enter the password again for a different host or user." The same happens with a changed user.
- Leaks: the password typed never appears in the DOM text after save (`document.body.textContent` doesn't contain `ESXI_PASSWORD`).
- Header: the modal has the eyebrow "Integrations", the title "VMware ESXi", and a description.

Update `sirdar/web/src/pages/settings/IntegrationsSection.test.tsx`:
- ESXi card: with `INTEGRATIONS`, an "VMware ESXi" card shows URL, User, "Builds from" (`sirdar-ubuntu-2404-seed · datastore1 · VM Network`), "DNS" ("Each VM's gateway"), Certificate (truncated) and "Password: Set".
- Other hosts, configured: the Proxmox card is **not** in the document until "Other hosts" is clicked (the button has `aria-expanded="false"`). After the click, the Proxmox card (with its Edit/Test/Remove) is shown.
- Other hosts, not set up: with `NO_INTEGRATIONS`, expanding "Other hosts" shows "Proxmox · Not set up" and a "Set up Proxmox" button that opens `ProxmoxModal`.
- Edit ESXi opens `EsxiModal`. Remove ESXi confirms with "Remove the VMware ESXi credentials? Nothing changes on ESXi itself."
- Existing Proxmox tests click "Other hosts" first, then go on unchanged.

Update `sirdar/web/src/pages/Deploy.test.tsx` with a test like the existing Proxmox-card test. With `ESXI_TARGETS`:
- an `ESXi` target card is listed;
- selecting it shows "Test VMware ESXi in Settings › Integrations. Environments on it are made with New environment, which builds their VM on the first deploy.";
- the Test button stays disabled (`canRun` false), as for Proxmox.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/components/CertificatePrompt.test.tsx src/pages/settings src/pages/Deploy.test.tsx`
Expected: FAIL. The modules are missing and there is no ESXi card.

- [ ] **Step 3: `CertificatePrompt`**

Create `sirdar/web/src/components/CertificatePrompt.tsx`:

```tsx
/** The trust-on-first-use prompt for a VM host's TLS certificate (Proxmox,
 *  ESXi): a new certificate to compare with the host's own, or a changed one
 *  to trust only if it was renewed on purpose. The modal keeps the request
 *  that asked (`what`) and resends it with the trusted fingerprint. */
import { errorDetail, type TlsCertificate } from '../lib/sirdarApi';
import { when } from '../pages/environments/labels';

export type PendingCertificate<W> = { kind: 'untrusted'; what: W; cert: TlsCertificate }
  | { kind: 'changed'; what: W; expected: string; actual: string };

/** tls_untrusted / tls_mismatch from a save or test, as a pending prompt; null for anything else. */
export function pendingCertificate<W>(err: unknown, what: W): PendingCertificate<W> | null {
  const code = (err as { code?: string }).code ?? '';
  const d = errorDetail<Record<string, unknown>>(err);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (code === 'tls_untrusted' && d && typeof d.fingerprint === 'string') {
    const names = Array.isArray(d.names) ? d.names.map(String) : [];
    return { kind: 'untrusted', what, cert: {
      fingerprint: d.fingerprint, subject: str(d.subject), issuer: str(d.issuer), not_after: str(d.not_after), names,
    } };
  }
  if (code === 'tls_mismatch' && d && typeof d.expected === 'string' && typeof d.actual === 'string') {
    return { kind: 'changed', what, expected: d.expected, actual: d.actual };
  }
  return null;
}

export default function CertificatePrompt<W>({ pending, question, busy, onTrust }: {
  pending: PendingCertificate<W>; question: string; busy: boolean; onTrust: (fingerprint: string, what: W) => void;
}) {
  return (
    <div className="sirdar-span2 sirdar-cert-prompt" role="group" aria-label="Server certificate">
      {pending.kind === 'untrusted' ? (
        <>
          <p>{question}</p>
          <dl className="sirdar-kv">
            <dt>SHA-256 fingerprint</dt><dd className="mono sirdar-fingerprint">{pending.cert.fingerprint}</dd>
            <dt>Subject</dt><dd>{pending.cert.subject}</dd>
            <dt>Issued by</dt><dd>{pending.cert.issuer}</dd>
            <dt>Expires</dt><dd className="mono">{pending.cert.not_after ? when(pending.cert.not_after) : '—'}</dd>
            <dt>Names</dt><dd className="mono">{pending.cert.names.join(', ') || '—'}</dd>
          </dl>
          <button type="button" className="btn-solid" disabled={busy}
                  onClick={() => onTrust(pending.cert.fingerprint, pending.what)}>Trust this certificate</button>
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
          <button type="button" className="btn-ghost" disabled={busy}
                  onClick={() => onTrust(pending.actual, pending.what)}>Trust the new certificate</button>
        </>
      )}
    </div>
  );
}
```

`components/` importing from `pages/environments/labels` for `when` is fine: `HostKeyModal` already crosses that line. If it doesn't, check `grep -rn "from '../pages" sirdar/web/src/components`. If nothing does, inline a local `toLocaleString` instead.

In `sirdar/web/src/pages/settings/ProxmoxModal.tsx`:
1. Import `CertificatePrompt, { pendingCertificate, type PendingCertificate } from '../../components/CertificatePrompt'`.
2. Delete the local `Pending` type and use `PendingCertificate<What>`.
3. In `run`'s `catch`, replace the `tls_untrusted` / `tls_mismatch` branches with:

```tsx
      const asked = pendingCertificate(err, what);
      if (asked) setPending(asked);
      else setErrors({ [CODE_FIELD[(err as { code?: string }).code ?? ''] ?? 'form']: deployErrorText(err,
        what === 'test' ? "Couldn't test these settings." : "Couldn't save these settings.") });
```

4. Replace the `{pending && (<div className="sirdar-span2 sirdar-cert-prompt" …>…</div>)}` block with:

```tsx
          {pending && (
            <CertificatePrompt pending={pending} busy={!!busy} onTrust={trust}
                               question="Is this the certificate Proxmox shows under the node's System › Certificates?" />
          )}
```

5. Drop the imports that are now unused (`errorDetail`, `TlsCertificate`, `when` if unused).

`ProxmoxModal.test.tsx` must pass unchanged.

- [ ] **Step 4: `EsxiModal`**

Create `sirdar/web/src/pages/settings/EsxiModal.tsx`:

```tsx
/** Set up or change the VMware ESXi integration: the standalone ESXi host
 *  Sirdar builds ESXi environments' VMs on (URL, user, datastore, port group,
 *  resource pool, seed VM, DNS servers) and the user's password, write-only.
 *  The host's TLS certificate is pinned trust-on-first-use, as for Proxmox:
 *  Test or Save first answers with the certificate, the user compares its
 *  fingerprint with the host's own and trusts it, and the same request goes
 *  again with that fingerprint. */
import { type RefObject, useEffect, useRef, useState } from 'react';

import CertificatePrompt, { pendingCertificate, type PendingCertificate } from '../../components/CertificatePrompt';
import CheckList from '../../components/CheckList';
import SecretField, { type SecretAction } from '../../components/SecretField';
import {
  deployErrorText, saveIntegration, testIntegration,
  type EsxiBody, type IntegrationCheck, type Integrations,
} from '../../lib/sirdarApi';

type Field = 'url' | 'user' | 'datastore' | 'network' | 'pool' | 'seed' | 'dns' | 'secret' | 'form';
type Errors = Partial<Record<Field, string>>;
type What = 'test' | 'save';
const CODE_FIELD: Record<string, Field> = {
  esxi_url_invalid: 'url', esxi_user_invalid: 'user', datastore_invalid: 'datastore', network_invalid: 'network',
  resource_pool_invalid: 'pool', source_vm_invalid: 'seed', dns_servers_invalid: 'dns', password_invalid: 'secret',
  secret_required: 'secret',
};
const URL_RE = /^https:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?\/?$/;
const USER_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
// The API's rule: no brackets, slashes or colons; no leading/trailing space.
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._()-]{0,78}[A-Za-z0-9._()-])?$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const QUESTION = 'Is this the certificate the ESXi host shows? Compare it with Host Client › Manage › Security & users › '
  + 'Certificates, or with `openssl x509 -in /etc/vmware/ssl/rui.crt -noout -fingerprint -sha256` in the ESXi Shell.';

const dnsList = (text: string) => text.split(',').map((s) => s.trim()).filter(Boolean);

function TextField({ id, label, value, error, hint, inputRef, onChange }: {
  id: string; label: string; value: string; error?: string; hint?: string;
  inputRef?: RefObject<HTMLInputElement>; onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} ref={inputRef} type="text" value={value} autoComplete="off" spellCheck={false}
             aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="page-hint">{hint}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

export default function EsxiModal({ current, onSaved, onClose }: {
  current: Integrations; onSaved: (saved: Integrations) => void; onClose: () => void;
}) {
  const ex = current.esxi;
  const storedUrl = ex.url ?? '';
  const storedUser = ex.user ?? '';
  const [url, setUrl] = useState(storedUrl);
  const [user, setUser] = useState(ex.user ?? 'sirdar');
  const [datastore, setDatastore] = useState(ex.datastore ?? 'datastore1');
  const [network, setNetwork] = useState(ex.network ?? 'VM Network');
  const [pool, setPool] = useState(ex.resource_pool ?? '');
  const [seed, setSeed] = useState(ex.source_vm ?? 'sirdar-ubuntu-2404-seed');
  const [dns, setDns] = useState(ex.dns_servers.join(', '));
  /** The certificate the next request trusts; null: let the server show it first. */
  const [fingerprint, setFingerprint] = useState<string | null>(ex.tls_fingerprint);
  const [pending, setPending] = useState<PendingCertificate<What> | null>(null);
  const [action, setAction] = useState<SecretAction>(ex.password_set ? 'keep' : 'set');
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
    // The stored pin belongs to the stored host only.
    setFingerprint(v.trim().replace(/\/$/, '') === storedUrl ? ex.tls_fingerprint : null);
    edited();
  };
  const otherLogin = url.trim().replace(/\/$/, '') !== storedUrl || user.trim() !== storedUser;

  const body = (trusted: string | null): EsxiBody => ({
    url: url.trim(), user: user.trim(), datastore: datastore.trim(), network: network.trim(),
    resource_pool: pool.trim() || null, source_vm: seed.trim(), dns_servers: dnsList(dns),
    tls_fingerprint: trusted, ...(action === 'set' ? { password: secret } : {}),
  });

  const validate = (): Errors => {
    const e: Errors = {};
    if (!URL_RE.test(url.trim())) e.url = 'Start with https://, then the host and port only.';
    if (!USER_RE.test(user.trim())) e.user = 'Enter the ESXi user, like sirdar.';
    if (!NAME_RE.test(datastore.trim())) e.datastore = 'Enter the datastore for VM disks, like datastore1.';
    if (!NAME_RE.test(network.trim())) e.network = 'Enter the port group, like VM Network.';
    if (pool.trim() && !NAME_RE.test(pool.trim())) e.pool = "Enter a resource pool's name, or leave it empty.";
    if (!NAME_RE.test(seed.trim())) e.seed = 'Enter the seed VM, like sirdar-ubuntu-2404-seed.';
    const servers = dnsList(dns);
    if (servers.length > 3 || servers.some((s) => !IPV4_RE.test(s))) {
      e.dns = 'Use up to 3 IPv4 addresses, separated by commas.';
    }
    if (action === 'set' && !secret) e.secret = 'Enter the ESXi password.';
    if (action === 'keep' && otherLogin && ex.password_set) {
      e.secret = 'Enter the password again for a different host or user.';
    }
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
        const checked = await testIntegration('esxi', body(trusted));
        if (asked === version.current) setResult(checked);
      } else {
        onSaved(await saveIntegration('esxi', body(trusted)));
      }
    } catch (err) {
      if (asked !== version.current) return;
      const prompt = pendingCertificate(err, what);
      if (prompt) setPending(prompt);
      else setErrors({ [CODE_FIELD[(err as { code?: string }).code ?? ''] ?? 'form']: deployErrorText(err,
        what === 'test' ? "Couldn't test these settings." : "Couldn't save these settings.") });
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
      <div className="modal-card reports-modal-card rgm-card sirdar-esxi-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-esxi-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Integrations</div>
            <h3 id="sirdar-esxi-title">VMware ESXi</h3>
            <p className="page-hint">
              Sirdar builds each ESXi environment's VM on this standalone host: it copies the seed VM's disk to the
              datastore below and connects the VM to the port group. The host needs a paid license; the user needs
              the Administrator role (see the README).
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={!!busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form sirdar-esxi-form">
          <div className="sirdar-span2">
            <TextField id="esxi-url" label="URL" value={url} error={errors.url} inputRef={firstRef}
                       hint="Where Sirdar reaches the host's API, like https://10.10.48.10." onChange={editUrl} />
          </div>
          <TextField id="esxi-user" label="User" value={user} error={errors.user}
                     onChange={(v) => { setUser(v); edited(); }} />
          <TextField id="esxi-datastore" label="Datastore" value={datastore} error={errors.datastore}
                     onChange={edit(setDatastore)} />
          <TextField id="esxi-network" label="Port group" value={network} error={errors.network}
                     onChange={edit(setNetwork)} />
          <TextField id="esxi-pool" label="Resource pool" value={pool} error={errors.pool}
                     hint="Empty: the host's root pool." onChange={edit(setPool)} />
          <TextField id="esxi-seed" label="Seed VM" value={seed} error={errors.seed}
                     hint="Ubuntu 24.04 cloud image, powered off, never started." onChange={edit(setSeed)} />
          <TextField id="esxi-dns" label="DNS servers" value={dns} error={errors.dns}
                     hint="Up to 3, comma-separated. Empty: each VM's gateway." onChange={edit(setDns)} />
          <div className="sirdar-span2">
            <span className="field-label">Certificate</span>
            {fingerprint ? (
              <div className="sirdar-secret-row">
                <span className="mono sirdar-fingerprint">{fingerprint}</span>
                <button type="button" className="mini-btn" disabled={!!busy}
                        onClick={() => { setFingerprint(null); edited(); }}>Check again</button>
              </div>
            ) : (
              <p className="page-hint">Not trusted yet. Test or Save shows the host's certificate first.</p>
            )}
          </div>
          {pending && <CertificatePrompt pending={pending} question={QUESTION} busy={!!busy} onTrust={trust} />}
          <div className="sirdar-span2">
            <SecretField id="esxi-password" label="Password" isSet={ex.password_set} adding={!ex.password_set}
                         action={action} value={secret} error={errors.secret} clearable={false}
                         onAction={(a) => { setAction(a); setSecret(''); edited(); }}
                         onValue={(v) => { setSecret(v); edited(); }} />
          </div>
          {result && (
            <div className="sirdar-span2">
              <CheckList label="VMware ESXi test" checks={result.checks} />
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

The `QUESTION` text contains backticks for the shell command. They render as literal backticks; that is acceptable copy. If the reviewer prefers it, wrap the command in a `<code>` element inside a custom `question` node. In that case `CertificatePrompt`'s `question` prop type becomes `ReactNode`, and the test then matches by partial text.

In `sirdar/web/src/styles/sirdar.css`, next to the `.sirdar-proxmox-*` rules, add:

```css
.modal-card.reports-modal-card.rgm-card.sirdar-esxi-card { width: min(760px, 96vw); max-width: 96vw; }
.sirdar-esxi-form { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.sirdar-esxi-form .sirdar-span2 { grid-column: 1 / -1; }
@media (max-width: 760px) { .sirdar-esxi-form { grid-template-columns: 1fr; } }
.sirdar-other-hosts { margin-top: 16px; }
.sirdar-other-hosts > .sirdar-cards { margin-top: 12px; }
.sirdar-other-hosts-row { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
```

If `sirdar/web/src/styles/cardLayout.test.ts` guards card classes, add the new card class wherever it lists `sirdar-proxmox-card`.

- [ ] **Step 5: Settings › Integrations**

In `sirdar/web/src/pages/settings/IntegrationsSection.tsx`:

1. Update the docstring: "…builds VMs with (VMware ESXi; Proxmox under Other hosts)".
2. `import EsxiModal from './EsxiModal';`
3. Constants:

```tsx
const KINDS: IntegrationKind[] = ['cloudflare', 'npm', 'esxi'];
const PURPOSE: Record<IntegrationKind, string> = {
  esxi: 'The VMware ESXi host Sirdar builds a VM on for each ESXi environment.',
  proxmox: 'The Proxmox host Sirdar builds a VM on for each Proxmox environment.',
  cloudflare: 'DNS records for every public service of an environment that publishes.',
  npm: 'Proxy hosts and certificates for every public service of an environment that publishes.',
};
```

4. In `settingsOf`, before the Proxmox branch, add:

```tsx
  if (kind === 'esxi') {
    const e = data.esxi;
    const from = e.source_vm
      ? `${e.source_vm} · ${e.datastore} · ${e.network}${e.resource_pool ? ` · pool ${e.resource_pool}` : ''}` : '—';
    return [['URL', e.url ?? '—'], ['User', e.user ?? '—'], ['Builds from', from],
            ['DNS', e.dns_servers.length ? e.dns_servers.join(', ') : "Each VM's gateway"],
            ['Certificate', e.tls_fingerprint ? `${e.tls_fingerprint.slice(0, 23)}…` : '—'],
            ['Password', set(e.password_set)]];
  }
```

5. Add `const [othersOpen, setOthersOpen] = useState(false);`.
6. `remove`'s confirm text: replace the ternary with:

```tsx
    const vmHost = kind === 'proxmox' || kind === 'esxi';
    if (!window.confirm(vmHost
      ? `Remove the ${label} credentials? Nothing changes on ${kind === 'esxi' ? 'ESXi' : 'Proxmox'} itself.`
      : `Remove the ${label} credentials? Publishing stops until they are set again; `
        + `nothing changes in ${label} itself.`)) return;
```

7. Move the card JSX (`<div key={kind} className="sirdar-card" …>…</div>`) into an inner function `const card = (kind: IntegrationKind) => { … return (<div …>…</div>); };`, unchanged, and render `{KINDS.map(card)}` in the grid.
8. After the main grid, still inside `{data && (…)}`, add the Other hosts area:

```tsx
      {data && (
        <div className="sirdar-other-hosts">
          <button type="button" className="mini-btn" aria-expanded={othersOpen} aria-controls="sirdar-other-hosts"
                  onClick={() => setOthersOpen((o) => !o)}>
            {othersOpen ? 'Hide other hosts' : 'Other hosts'}
          </button>
          {othersOpen && (
            <div id="sirdar-other-hosts">
              {data.proxmox.configured ? (
                <div className="sirdar-cards sirdar-integration-cards">{card('proxmox')}</div>
              ) : (
                <div className="sirdar-other-hosts-row">
                  <span>Proxmox · Not set up</span>
                  {mayChange && (
                    <button type="button" className="mini-btn" aria-label="Set up Proxmox"
                            disabled={!data.secrets_key_configured} onClick={() => setEditing('proxmox')}>
                      Set up
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
```

9. Page hint: "Environments with Publish on use Cloudflare and Nginx Proxy Manager for their DNS records and proxy hosts; ESXi environments are built on VMware ESXi. Tokens and passwords are stored encrypted and never shown again."
10. Modal routing:

```tsx
      {editing && data && editing !== 'proxmox' && editing !== 'esxi' && (
        <IntegrationModal kind={editing} current={data} onClose={() => setEditing(null)}
                          onSaved={(saved) => { setData(saved); forget(editing); setEditing(null); }} />
      )}
      {editing === 'esxi' && data && (
        <EsxiModal current={data} onClose={() => setEditing(null)}
                   onSaved={(saved) => { setData(saved); forget('esxi'); setEditing(null); }} />
      )}
```

    The Proxmox modal block stays. `IntegrationModal`'s `kind` prop is `PublishKind`. If TypeScript doesn't narrow `editing` there, cast with `editing as PublishKind` after the two checks.

- [ ] **Step 6: The Deploy page's ESXi card**

In `sirdar/web/src/pages/Deploy.tsx`:
- `INITIALS` gains `esxi: 'ESXi'`;
- replace the `proxmoxSelected` lines with:

```tsx
  // VM hosts are tested in Settings › Integrations; their environments are made with New environment.
  const vmHostSelected = !!selected && (kindOf(selected) === 'proxmox' || kindOf(selected) === 'esxi');
  const canRun = !!selected && selected.available && selected.configured && !!type && nameOk && canAdd && !running
    && !vmHostSelected;
```

- the hint becomes:

```tsx
        {vmHostSelected && selected && (
          <p className="page-hint sirdar-envnote">
            Test {selected.label} in Settings › Integrations. Environments on it are made with New environment, which
            builds their VM on the first deploy.
          </p>
        )}
```

The Proxmox test's expected copy becomes "Test Proxmox in Settings › Integrations. …"; the label is `Proxmox`, so the text doesn't change.

- [ ] **Step 7: Run the tests and the build**

Run:

```bash
npm --prefix sirdar/web test
npm --prefix sirdar/web run build
```

Expected: all pass, and the build type-checks.

- [ ] **Step 8: Commit**

```bash
git add sirdar/web/src/components/CertificatePrompt.tsx sirdar/web/src/components/CertificatePrompt.test.tsx sirdar/web/src/pages/settings/EsxiModal.tsx sirdar/web/src/pages/settings/EsxiModal.test.tsx sirdar/web/src/pages/settings/ProxmoxModal.tsx sirdar/web/src/pages/settings/IntegrationsSection.tsx sirdar/web/src/pages/settings/IntegrationsSection.test.tsx sirdar/web/src/pages/Deploy.tsx sirdar/web/src/pages/Deploy.test.tsx sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): VMware ESXi in Settings with a shared certificate prompt; Proxmox under Other hosts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: New environment on ESXi — the target and the Machine step

**Files:**
- Modify: `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, `NewEnvironmentModal.test.tsx`

**Interfaces:**
- Consumes (Task 1): `isVmTarget`, `VM_HOST_LABEL`, `envTargets`, `ESXI_TARGETS`, and `ESXI_NEW_ENV`.

- [ ] **Step 1: Write the failing tests**

Add to `NewEnvironmentModal.test.tsx`. Mirror the existing Proxmox tests in that file, swapping in `ESXI_TARGETS`:

- **Target and steps.** Choosing the target "VMware ESXi" shows the hint "Sirdar builds a VM for it on ESXi on the first deploy." and the steps Basics › Machine › Services › Data › Review.
- **Machine copy.** The Machine step reads: "Sirdar copies the Ubuntu seed VM's disk into a VM named ss-uat3 on ESXi, then deploys to it. Sizes can grow later in Settings; the network can't change."
- **Create body.** Creating sends `createEnvironment` with `target: 'esxi'` and the same `vm` body shape the Proxmox test asserts.
- **Adopt.** In adopt mode, ESXi isn't offered, and a chosen ESXi target falls back to the first SSH target.
- **Errors.** `integration_not_configured {kinds: ['esxi']}` shows "Set up VMware ESXi in Settings › Integrations first." on the Basics step.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments/NewEnvironmentModal.test.tsx`
Expected: FAIL. ESXi isn't treated as a VM target.

- [ ] **Step 3: Make the modal VM-host-aware**

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`:

1. Docstring: "on Proxmox a Machine step sizes the VM" → "on a VM host (Proxmox or ESXi) a Machine step sizes the VM".
2. Import `isVmTarget` and `VM_HOST_LABEL` from `./labels`.
3. Rename `PROXMOX_STEPS` to `VM_STEPS` (both uses).
4. `HINT.new` becomes: "Create an environment on an SSH target, or on a VM Sirdar builds on ESXi or Proxmox. Sirdar generates its secrets; the first deploy builds it."
5. Replace:

```tsx
  const onVm = mode === 'new' && target === 'proxmox';
  // Adopt reads a hand-built environment over SSH: Proxmox environments are only ones Sirdar builds.
  const offered = (targets ?? []).filter((t) => mode === 'new' || t.id !== 'proxmox');
  useEffect(() => {
    if (mode === 'adopt' && target === 'proxmox') setTarget(sshTargets(targets ?? [])[0]?.id ?? '');
  }, [mode, target, targets]);
```

with:

```tsx
  const onVm = mode === 'new' && isVmTarget(target);
  const hostName = isVmTarget(target) ? VM_HOST_LABEL[target as 'proxmox' | 'esxi'] : '';
  // Adopt reads a hand-built environment over SSH: VM environments are only ones Sirdar builds.
  const offered = (targets ?? []).filter((t) => mode === 'new' || !isVmTarget(t.id));
  useEffect(() => {
    if (mode === 'adopt' && isVmTarget(target)) setTarget(sshTargets(targets ?? [])[0]?.id ?? '');
  }, [mode, target, targets]);
```

6. The "No target is ready" hint: "… Add an SSH target under Target on the Deploy page, or set up VMware ESXi in Settings › Integrations."
7. `{onVm && <p className="page-hint">Sirdar builds a VM for it on {hostName} on the first deploy.</p>}`
8. The Machine step paragraph:

```tsx
                <p className="page-hint sirdar-span2">
                  {target === 'esxi'
                    ? `Sirdar copies the Ubuntu seed VM's disk into a VM named ss-${trimmed} on ESXi, then deploys to it. `
                    : `Sirdar clones the Ubuntu template into a VM named ss-${trimmed} on Proxmox, then deploys to it. `}
                  Sizes can grow later in Settings; the network can't change.
                </p>
```

`stepList` uses `VM_STEPS` when `onVm`. Nothing else in the file compares against `'proxmox'`. Check: `grep -n "'proxmox'" sirdar/web/src/pages/environments/NewEnvironmentModal.tsx` must print nothing.

- [ ] **Step 4: Run the tests and the build**

Run: `npm --prefix sirdar/web test -- src/pages/environments/NewEnvironmentModal.test.tsx && npm --prefix sirdar/web run build`
Expected: all pass. The existing Proxmox tests still pass, with the copy "Sirdar clones the Ubuntu template … on Proxmox" unchanged.

- [ ] **Step 5: Commit**

```bash
git add sirdar/web/src/pages/environments/NewEnvironmentModal.tsx sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx
git commit -m "feat(sirdar-web): New environment on VMware ESXi

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The environment pages name the right host — Overview, Settings, Delete, Deploy, VM snapshots

**Files:**
- Modify: `sirdar/web/src/pages/environments/EnvOverview.tsx` (+ `EnvOverview.test.tsx`)
- Modify: `sirdar/web/src/pages/environments/EnvSettings.tsx` (+ `EnvSettings.test.tsx`)
- Modify: `sirdar/web/src/pages/environments/DeleteEnvironmentModal.tsx` (+ test)
- Modify: `sirdar/web/src/pages/environments/DeployModal.tsx` (+ test)
- Modify: `sirdar/web/src/pages/environments/BackupsTab.tsx`, `VmSnapshots.tsx` (+ `VmSnapshots.test.tsx`), `RestoreVmSnapshotModal.tsx`

**Interfaces:**
- Consumes (Task 1): `onVmHost`, `hostLabel`, `vmRef`, `vmStage`, `ESXI_ENV`, `ESXI_NEW_ENV`, and `PX_ENV`.

- [ ] **Step 1: Write the failing tests**

Add these tests. Each mirrors the file's existing Proxmox test, with `ESXI_ENV` / `ESXI_NEW_ENV`:

- **`EnvOverview.test.tsx`.** For `ESXI_ENV`, the Machine section shows:
  - VM `ss-uat3 (VM 12)`;
  - Host `10.10.48.10` (the row is labeled "Host" for ESXi, and "Node" stays for Proxmox);
  - Size `4 vCPU · 8 GB · 64 GB disk`;
  - Address `10.10.48.71`.

  For `ESXI_NEW_ENV`, VM reads `ss-uat3 · built by the first deploy`.
- **`EnvSettings.test.tsx`.**
  - For `ESXI_ENV`, the target field shows `ESXi · ss-uat3`.
  - The Machine hint is "The next deploy's step 0 resizes the VM: ESXi shuts it down and starts it again to change its vCPUs, memory or disk. A disk can grow but never shrink."
  - Typing a disk of `80` shows "ESXi can't grow a disk that has snapshots: the next deploy deletes this environment's VM snapshots first, then takes a new one." The text isn't there at 64.
  - The Delete zone says "Destroys its VM on ESXi with everything on it, VM snapshots included, …".
  - For Proxmox (`PX_ENV`), the existing texts don't change, and there is no grow warning at 80.
- **`DeleteEnvironmentModal.test.tsx`.**
  - `ESXI_ENV`: "Destroys the VM ss-uat3 (VM 12) on ESXi with everything on it: …".
  - `ESXI_NEW_ENV`: "No VM was created yet; nothing on ESXi is removed. …".
  - A partial ESXi VM (`{ ...ESXI_VM, stage: 'partial', created: false }`): "Removes the partly built VM ss-uat3 (VM 12) if ESXi has it. …".
- **`DeployModal.test.tsx`.** For `ESXI_ENV`, the header says "Prepares the VM ss-uat3 on ESXi, then runs in /opt/serversherpa/uat3 on it." and the "VM snapshot first" choice is offered (deployed).
- **`VmSnapshots.test.tsx`.** For `ESXI_ENV`, the hint says "… the newest 3 stay on ESXi. …".

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments`
Expected: FAIL. The ESXi copy is missing; the pages say Proxmox or treat ESXi as SSH.

- [ ] **Step 3: Use the host-neutral helpers**

**`EnvOverview.tsx`:**
- import `onVmHost`, `vmRef` (and keep `vmSize`, `vmNetwork`, `when`), replacing `onProxmox`;
- replace the Machine section with:

```tsx
      {onVmHost(env) && env.vm && (
        <section className="sirdar-section">
          <h2>Machine</h2>
          <dl className="sirdar-kv">
            <dt>VM</dt>
            <dd className="mono">
              {vmRef(env.vm) ? `${env.vm.name} (${vmRef(env.vm)})` : `${env.vm.name} · built by the first deploy`}
            </dd>
            <dt>{env.vm.kind === 'esxi' ? 'Host' : 'Node'}</dt><dd className="mono">{env.vm.host}</dd>
            <dt>Size</dt><dd>{vmSize(env.vm)}</dd>
            <dt>Network</dt><dd className="mono">{vmNetwork(env.vm)}</dd>
            <dt>Address</dt><dd className="mono">{env.vm.ip ?? 'Not known yet'}</dd>
            <dt>VM snapshots kept</dt><dd>{env.vm.keep_snapshots}</dd>
          </dl>
        </section>
      )}
```

**`EnvSettings.tsx`:**
- import `hostLabel`, `onVmHost`, `vmRef` in place of `onProxmox`;
- `const onVm = onVmHost(env);`
- `const esxi = env.target_kind === 'esxi';`
- the target field: `value={`${hostLabel(env)} · ${env.vm?.name ?? ''}`}` with `hint="It stays on the VM Sirdar built for it."`;
- the Machine hint and the grow warning:

```tsx
          <p className="page-hint">
            {esxi
              ? "The next deploy's step 0 resizes the VM: ESXi shuts it down and starts it again to change its vCPUs, "
                + 'memory or disk. A disk can grow but never shrink.'
              : "The next deploy's step 0 resizes the VM (Proxmox restarts it when it must). A disk can grow but never "
                + 'shrink.'}
          </p>
```

  and, right after the Machine grid, before `errors.machine`:

```tsx
          {esxi && env.vm && /^\d+$/.test(form.disk.trim()) && Number(form.disk.trim()) > env.vm.disk_gb && (
            <p className="page-hint">
              ESXi can't grow a disk that has snapshots: the next deploy deletes this environment's VM snapshots
              first, then takes a new one.
            </p>
          )}
```

  This is the change the context's question 2 confirms. It's a hint inside an existing form section, not a new widget.
- the Delete zone copy:

```tsx
            {onVm && env.vm && vmStage(env.vm) === 'none'
              ? `No VM was created yet; nothing on ${hostLabel(env)} is removed. Deleting it removes the DNS records `
                + 'and proxy hosts Sirdar made, and removes it from Sirdar.'
              : onVm && env.vm && vmStage(env.vm) === 'partial'
              ? `Removes the partly built VM ${env.vm.name}${vmRef(env.vm) ? ` (${vmRef(env.vm)})` : ''} if `
                + `${hostLabel(env)} has it. Deleting it removes the DNS records and proxy hosts Sirdar made, and `
                + 'removes it from Sirdar.'
              : onVm
              ? `Destroys its VM on ${hostLabel(env)} with everything on it, VM snapshots included, removes the DNS `
                + 'records and proxy hosts Sirdar made, and removes it from Sirdar.'
              : 'Stops it, deletes its data, backups and folder on the host, removes the DNS records and proxy hosts '
                + 'Sirdar made, and removes it from Sirdar.'}
```

  The Proxmox partial text changes from `(id 120)` to `(VM 120)`. Update the existing Proxmox test's expected string the same way, in `EnvSettings.test.tsx` and `DeleteEnvironmentModal.test.tsx`.

**`DeleteEnvironmentModal.tsx`:**
- import `hostLabel`, `onVmHost`, `vmRef`;
- the three VM branches test `onVmHost(env) && env.vm && …`;
- their copy uses `hostLabel(env)` where it said Proxmox;
- the built-VM sentence: `Destroys the VM {env.vm.name}{vmRef(env.vm) ? ` (${vmRef(env.vm)})` : ''} on {hostLabel(env)} with everything on it: the database, files, backups and VM snapshots. …`;
- the partial sentence: `Removes the partly built VM {env.vm.name}{vmRef(env.vm) ? ` (${vmRef(env.vm)})` : ''} if {hostLabel(env)} has it. …`.

**`DeployModal.tsx`:**
- import `hostLabel` and `onVmHost` in place of `onProxmox`;
- `const choosesVmSnapshot = onVmHost(env) && env.current_sha !== null;`
- header: `{onVmHost(env) && env.vm ? `Prepares the VM ${env.vm.name} on ${hostLabel(env)}, then runs in ${env.env_dir} on it. ` : …}`;
- the VM snapshot block: `{onVmHost(env) && (`;
- the comment: "A deployed VM environment snapshots its VM in step 0 unless turned off."

**`BackupsTab.tsx`:** `{onVmHost(env) && <VmSnapshots env={env} onStarted={onStarted} />}` (import `onVmHost` instead of `onProxmox`).

**`VmSnapshots.tsx`:**
- docstring: "A VM environment's VM snapshots (read live from Proxmox or ESXi) …";
- import `hostLabel` from `./labels`;
- hint: "… the newest {env.vm?.keep_snapshots ?? 3} stay on {hostLabel(env)}. …".

**`RestoreVmSnapshotModal.tsx`:** docstring "Restore one of a VM environment's VM snapshots …". Check `grep -n "Proxmox" sirdar/web/src/pages/environments/RestoreVmSnapshotModal.tsx`: any user-facing "Proxmox" uses `hostLabel(env)` instead.

**Final check:** `grep -rn "onProxmox\|'proxmox'" sirdar/web/src/pages/environments/*.tsx | grep -v test` prints only `labels.tsx` (the definitions) and nothing else.

- [ ] **Step 4: Run the tests and the build**

Run:

```bash
npm --prefix sirdar/web test
npm --prefix sirdar/web run build
```

Expected: all pass, and the build type-checks.

- [ ] **Step 5: Commit**

```bash
git add sirdar/web/src/pages/environments/EnvOverview.tsx sirdar/web/src/pages/environments/EnvOverview.test.tsx sirdar/web/src/pages/environments/EnvSettings.tsx sirdar/web/src/pages/environments/EnvSettings.test.tsx sirdar/web/src/pages/environments/DeleteEnvironmentModal.tsx sirdar/web/src/pages/environments/DeleteEnvironmentModal.test.tsx sirdar/web/src/pages/environments/DeployModal.tsx sirdar/web/src/pages/environments/DeployModal.test.tsx sirdar/web/src/pages/environments/BackupsTab.tsx sirdar/web/src/pages/environments/VmSnapshots.tsx sirdar/web/src/pages/environments/VmSnapshots.test.tsx sirdar/web/src/pages/environments/RestoreVmSnapshotModal.tsx
git commit -m "feat(sirdar-web): environment pages name the VM host (ESXi or Proxmox); ESXi disk-grow warning

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Live verify on Jimmy's ESXi host with a throwaway uat3 (controller, not a subagent)

Run by the controller, with Jimmy, after both 6a and 6b are reviewed and merged on branch `sirdar`. Nothing here runs against real infrastructure without Jimmy present.

**Safety rules (repeat them to Jimmy before starting):**
- Never touch any VM Sirdar didn't create. That includes `uat` (10.10.48.63) and the seed VM, apart from Sirdar reading it.
- Jimmy types the ESXi password himself into Sirdar's Settings. The controller never sees it, types it or stores it.
- The only environment created, deployed, snapshotted, restored and deleted is `uat3`. Publish stays off for `uat3`.

- [ ] **Step 1: Find where uat runs**

Ask Jimmy which host runs the uat VM (10.10.48.63). The phase 5 notes say Proxmox, but he doesn't use Proxmox.
- If uat is on this ESXi host, note its VM name.
- With Jimmy, open the VM in the Host Client (VM › Edit settings › VM Options › Advanced › Configuration Parameters) and confirm it has **no** `sirdar.environment` key.
- Record the answer in the ledger (`.superpowers/sdd/progress.md`).

Sirdar's address checks refuse 10.10.48.63 anyway, because it is a saved SSH target on Tower.

- [ ] **Step 2: Prepare ESXi (Jimmy, in the Host Client, following the README's "VMware ESXi targets")**

1. Confirm the license is paid (Host › Manage › Licensing).
2. Create the local user `sirdar` with the Administrator role.
3. Import `noble-server-cloudimg-amd64.ova` as `sirdar-ubuntu-2404-seed`, thin, powered off. Leave the properties empty.
4. Note the datastore and port group names.
5. Pick a free static address for uat3 in the LAN, with Jimmy, for example `10.10.48.71/24` via `10.10.48.1`. Confirm nothing answers on it: `ping` and `nc -z <ip> 22` from the Mac both fail.

- [ ] **Step 3: Update Tower's Sirdar to the branch head**

1. Push `sirdar` to GitHub, with Jimmy's go-ahead.
2. Update Tower's Sirdar with the installer pinned to that SHA, as in earlier phases. Memory notes `SIRDAR_DIR=/mnt/user/serversherpa/sirdar`.
3. Confirm:
   - `docker exec` into the Sirdar container and run `python -c "import pyVmomi; print(pyVmomi.__version__)"`, which prints `8.0.3.0.1`;
   - `alembic current` shows `0008`.

- [ ] **Step 4: ESXi integration (Jimmy types the password)**

1. In Sirdar › Settings › Integrations, open VMware ESXi › Set up. Fill in the URL, user `sirdar`, datastore, port group and seed VM; leave DNS empty (each VM uses its gateway) unless Jimmy prefers otherwise.
2. Jimmy types the password.
3. Click Test. The certificate prompt appears.
4. Jimmy compares the fingerprint with `openssl x509 -in /etc/vmware/ssl/rui.crt -noout -fingerprint -sha256` in the ESXi Shell (or with the browser's view of the Host Client certificate), then clicks Trust.
5. Expected: the checks ESXi, License, Datastore, Network, Resource pool and Seed VM all pass.
6. Save.
7. Check:
   - the card shows "Password: Set";
   - Proxmox is under "Other hosts";
   - the audit row for `deploy.integration_update` lists `password` but no value.

If the License check fails, stop: the host's API is read-only.

- [ ] **Step 5: Create and deploy uat3**

1. New environment › name `uat3`, type Dev, target VMware ESXi, Publish off. Use ports +200 from uat's defaults if the address is shared; it isn't, since uat3 has its own VM.
2. Machine: 4 vCPU, 8 GB, 64 GB, Static, the chosen address.
3. Create. Then Deploy › Update `main`.
4. Watch step 0's log. It should show, in order:
   - Creating;
   - Created (VM N);
   - Copying the seed disk;
   - Grew the disk to 64 GB;
   - Started;
   - "The VM answers at …";
   - "Pinned …'s SSH host key SHA256:…, the key Sirdar generated for the VM";
   - "Removed the cloud-init user-data …";
   - the commit.
5. Steps 1–10 then run green.
6. In the Host Client, check that `ss-uat3` has:
   - the `sirdar.environment` key with uat3's id;
   - no `guestinfo.userdata` key;
   - the annotation `sirdar:<id> …`.
7. On Sirdar, check that the Overview Machine card shows `VM <moref>`, Host, and the address.

If `CopyVirtualDisk_Task` is refused, stop and record it. The context file names the fallback (`CopyDatastoreFile_Task`) as a follow-up.

- [ ] **Step 6: Take and restore a VM snapshot**

1. Deploy › Update again with "VM snapshot first" on. Step 0 logs "Took VM snapshot sirdar-…" (or the crash-consistent note).
2. Check that the Backups tab › VM snapshots lists it, with the commit it holds.
3. Make a visible change, so the restore can be proven: deploy a different commit (a newer `main` commit, or an older tag) with "VM snapshot first" off, and note the commit the Overview shows. Sirdar has no shell UI, and Sirdar's VM key stays inside Sirdar.
4. Restore VM snapshot › type `uat3` › Restore.
5. Step 0 "Restore VM snapshot" logs "Reverting …", "Started the VM.", "SSH host key … is pinned." (the generated key never changes) and "… is back at sirdar-…".
6. The environment's commit is the snapshot's commit again.

- [ ] **Step 7: Delete uat3 and confirm the VM is gone**

1. Settings › Delete environment › type `uat3`. The plan is 15 Destroy VM, then 16 and 17, which have nothing to remove with Publish off.
2. Step 15 logs "Powered the VM off.", "Destroying ss-uat3 and its VM snapshots." and "Destroyed ss-uat3.", then "Forgot …'s SSH host key."
3. With Jimmy, in the Host Client: **ss-uat3 is no longer listed**. uat (if it's on this host) and the seed are untouched, and the datastore folder `ss-uat3` is gone or empty.
4. Settings › Integrations › VMware ESXi › Remove now works, since no environment uses it. Only do this if Jimmy wants it.

- [ ] **Step 8: Record and clean up**

1. Write a ledger entry: what passed, the moref, timings, any copy fixes. Fix copy or layout issues found live in small commits named `fix(sirdar-web): …` or `fix(sirdar): …`.
2. Update the memory note `sirdar.md` with the phase 6 status.
3. Ask Jimmy whether to merge `sirdar` to main and push.

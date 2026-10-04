# Sirdar deploy phase 4b (DNS + proxy: web UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give phase 4a's publishing API its UI — Settings › Integrations (Cloudflare and Nginx Proxy Manager credentials, write-only, with Test), a Publish tab per environment (the switch, what publishing would do per service, Claim existing, Publish now), Delete environment with the typed-name gate, and the Publish choice in New environment — then live-verify it against `uat2` on the real uat VM.

**Architecture:** Web code in `sirdar/web/src` over the `/api/deploy` routes of plan 4a. New folder `pages/settings/` holds the Integrations section and its modal; `components/CheckList.tsx` renders connection-test checks; environment pages gain `PublishTab` and `DeleteEnvironmentModal`; `EnvironmentDetail`, `EnvSettings`, `NewEnvironmentModal` and `EnvOverview` grow the publish and delete pieces. Shared pieces stay where they are (`useHostKeyTrust`, `labels.tsx`, `testData.ts`).

**Tech Stack:** React 18 + TypeScript 5.6 + react-router-dom 6 + Vitest 3 / Testing Library (jsdom); portal components through `@portal` (`DataTable`, `ComboBox`, `AuthContext`, `lib/api`); Claude in Chrome for the live verify.

**Spec:** `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md` Section 4 (Settings credentials with Test, Delete environment, New environment Review listing DNS records and NPM hosts), with `docs/superpowers/plans/2026-10-04-sirdar-phase4-context.md`. Plan 4a (`docs/superpowers/plans/2026-10-04-sirdar-phase4a-backend.md`) must be done first.

## Interfaces from 4a

All under `/api/deploy` (the web client's paths start `/deploy`; `VITE_API_URL=/api`). Times are ISO 8601 strings.

- `Integrations` = `{secrets_key_configured, cloudflare: {configured, zone, public_ip, token_set, updated_at, updated_by_name}, npm: {configured, url, identity, letsencrypt_email, password_set, updated_at, updated_by_name}}` (unset values null). `GET /integrations` (view).
- `PUT /integrations/cloudflare` (change) `{zone, public_ip, token?}`; `PUT /integrations/npm` (change) `{url, identity, letsencrypt_email?, password?}` — an omitted secret keeps the stored one → `Integrations`. Errors: 422 `zone_invalid`, `public_ip_invalid`, `token_invalid`, `secret_required`, `npm_url_invalid`, `identity_invalid`, `letsencrypt_email_invalid`, `password_invalid`; 400 `secrets_key_missing`.
- `DELETE /integrations/{kind}` (change) → 204; 404 `integration_not_found`.
- `POST /integrations/{kind}/test` (change), optional body = the PUT body → `{ok, target, checks: [{label, status, value}], facts}`. Errors: 409 `integration_not_configured`; 409 `integration_unreadable`; 502 `connect_failed {reason}`; the PUT codes.
- `GET /environments/{name}/publish` (view) → `PublishPlan` = `{publish, proxy_ip, cloudflare: {configured, zone, public_ip, error}, npm: {configured, url, error}, services: [{service, hostname, forward, dns: {state, detail, origin, record_id}, proxy: {state, detail, origin, host_id}, certificate: {state, detail, expires_on}}], stale: [{service, kind, name, origin}]}`; `state` ∈ `ok | update | create | claimable | conflict | unknown` (certificate: `ok | update | create | unknown`).
- `POST /environments/{name}/publish/claim` (change) → `PublishPlan & {claimed: string[]}`. Errors: 409 `deploy_in_progress`, `nothing_to_claim`, `claim_conflict`.
- `POST /environments` takes `publish?: boolean` (new; default true). `PATCH /environments/{name}` takes `publish`.
- `POST /environments/{name}/deployments` `mode` may be `publish` (add; nothing else in the body) or `teardown` (change + `confirm_name`). Errors add 409 `publish_off`, 409 `not_deployed`, 409 `integration_not_configured {kinds}`, 422 `git_ref_not_allowed`.
- `Environment` adds `publish: boolean`, `managed_records: [{service, kind: 'dns_record'|'proxy_host'|'certificate', name, origin: 'created'|'claimed'}]`; `status` may be `deleting`. `DeploymentSummary` adds `publish: boolean`; `mode` may be `publish` or `teardown`. After a teardown succeeds, the environment and its deployments answer 404.
- Steps: 12 `dns` "DNS records", 13 `proxy` "Proxy hosts", 14 `smoke` "Smoke test" (a publishing deploy, or a publish job alone); 15 `teardown` "Remove environment", 16 `unproxy` "Remove proxy hosts", 17 `undns` "Remove DNS records" (Delete environment).

## Global Constraints

- Every new modal gets the report-generate header (eyebrow, title, description) and sizes to its content (a content-matched card width; dropdowns render through `portal`).
- Reuse the existing portal and Sirdar idioms (`DataTable`, `ComboBox`, segmented radio groups with `arrowNav`, chips, `.pf-form` with `.field-label`). No raw native `<select>`. Sections inside a `.pf-form` grid in a modal body get `grid-column: 1 / -1` (the `sirdar-span2` class).
- Typed-name gate (the environment's name typed exactly) for Delete environment and its retry, as the API requires.
- Secrets are write-only in the UI: never prefilled, never shown; an integration's secret can be replaced but not cleared (Remove deletes the whole integration).
- Don't add reader-facing widgets that weren't asked for.
- American English in all copy; display "Canceled" for the `cancelled` status.
- Component tests start with `// @vitest-environment jsdom`, mock `../../lib/sirdarApi` (spreading the real module) and `@portal/auth/AuthContext` the way the existing environment tests do, set `Element.prototype.scrollIntoView = () => {}` when a ComboBox is used, and use fake timers for polling.
- No new `@portal` import: only `auth/AuthContext`, `components/DataTable`, `components/ComboBox` and `lib/api`, all allowlisted.
- `tsc` type-checks tests too (`noUnusedLocals`, `noUnusedParameters`).
- Web tests: `npm --prefix sirdar/web test`. Type-check and build: `npm --prefix sirdar/web run build`. Never run `npm install` in this worktree.
- Work in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

- Modify `sirdar/web/src/lib/sirdarApi.ts` (+ `sirdarApi.test.ts`) — types, seven endpoint functions, `INTEGRATION_LABEL`, messages for every new code, `kinds` in `deployErrorText`.
- Modify `sirdar/web/src/pages/environments/labels.tsx` (+ `labels.test.ts`) — `deleting`, the two modes, `PUBLISH_STATE`, `CERT_STATE`, `GATED_MODES`, `RETRY_MODES`.
- Modify `sirdar/web/src/pages/environments/testData.ts` — `publish`, `managed_records`, `INTEGRATIONS`, `NO_INTEGRATIONS`, `CF_CHECK`, `PUBLISH_PLAN`, `PUBLISHED_ENV`, `PUBLISHING`, `TEARDOWN`.
- Create `sirdar/web/src/components/CheckList.tsx` (+ test); modify `components/SecretField.tsx` (+ test) — `clearable`.
- Create `sirdar/web/src/pages/settings/IntegrationModal.tsx`, `IntegrationsSection.tsx` (+ tests); modify `pages/Settings.tsx` (+ new `Settings.test.tsx`).
- Create `sirdar/web/src/pages/environments/PublishTab.tsx` (+ test); modify `EnvironmentDetail.tsx` (+ test).
- Create `sirdar/web/src/pages/environments/DeleteEnvironmentModal.tsx` (+ test); modify `EnvSettings.tsx` (+ test), `EnvironmentDetail.tsx` (+ test).
- Modify `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx` (+ test), `EnvOverview.tsx`.
- Modify `sirdar/web/src/styles/sirdar.css`.

---

### Task 1: API client, labels and fixtures

**Files:**
- Modify: `sirdar/web/src/lib/sirdarApi.ts`
- Modify: `sirdar/web/src/pages/environments/labels.tsx`
- Modify: `sirdar/web/src/pages/environments/testData.ts`
- Test: `sirdar/web/src/lib/sirdarApi.test.ts`, `sirdar/web/src/pages/environments/labels.test.ts`

**Interfaces:**
- Produces (`lib/sirdarApi.ts`): `EnvStatus` adds `'deleting'`; `DeploymentMode` adds `'publish' | 'teardown'`; `DeploymentBody.mode: DeployMode | 'publish' | 'teardown'`; `DeploymentSummary.publish: boolean`; `interface ManagedRecordRef { service; kind: 'dns_record' | 'proxy_host' | 'certificate'; name; origin: 'created' | 'claimed' }`; `Environment.publish: boolean`, `Environment.managed_records: ManagedRecordRef[]`; `NewEnvironmentBody.publish?: boolean`; `EnvironmentPatch.publish?: boolean`; `type IntegrationKind = 'cloudflare' | 'npm'`; `INTEGRATION_LABEL: Record<IntegrationKind, string>`; `interface Integrations` (with `CloudflareIntegration`, `NpmIntegration`); `interface CloudflareBody { zone; public_ip; token? }`; `interface NpmBody { url; identity; letsencrypt_email?; password? }`; `interface IntegrationCheck { ok; target: IntegrationKind; checks: DeployCheck[]; facts }`; `type PublishEntryState = 'ok' | 'update' | 'create' | 'claimable' | 'conflict' | 'unknown'`; `interface PublishEntry { state; detail; origin }`; `interface PublishService`; `interface PublishPlan`; functions `getIntegrations()`, `saveIntegration(kind, body)`, `removeIntegration(kind): Promise<void>`, `testIntegration(kind, body?)`, `getPublishPlan(name)`, `claimPublish(name)`.
- Produces (`labels.tsx`): `ENV_STATUS.deleting` ("Deleting"), `MODE_LABEL.publish` ("Publish"), `MODE_LABEL.teardown` ("Delete environment"), `PUBLISH_STATE` and `CERT_STATE` chip maps, `GATED_MODES` + `'teardown'`, `RETRY_MODES` + `'publish', 'teardown'`.
- Produces (`testData.ts`): `ENV.publish = false`, `ENV.managed_records = []`, every deployment fixture `publish: false`; `INTEGRATIONS`, `NO_INTEGRATIONS`, `CF_CHECK`, `PUBLISH_PLAN` (uat: api claimable DNS + proxy, portal managed and up to date, kiosk blocked by a CNAME), `PUBLISHED_ENV` (publish on, four managed records), `PUBLISHING` (`d8`, a running publish job, steps 12–14), `TEARDOWN` (`d7`, a running teardown, steps 15–17).

- [ ] **Step 1: Write the failing tests**

In `sirdar/web/src/lib/sirdarApi.test.ts`, replace:

```ts
  { name: 'startDeployment (restore a backup)',
    call: () => sirdar.startDeployment('uat', { mode: 'restore_dump', backup: 'x.dump', confirm_name: 'uat' }),
    path: '/deploy/environments/uat/deployments', method: 'POST',
    body: { mode: 'restore_dump', backup: 'x.dump', confirm_name: 'uat' } },
];
```

with:

```ts
  { name: 'startDeployment (restore a backup)',
    call: () => sirdar.startDeployment('uat', { mode: 'restore_dump', backup: 'x.dump', confirm_name: 'uat' }),
    path: '/deploy/environments/uat/deployments', method: 'POST',
    body: { mode: 'restore_dump', backup: 'x.dump', confirm_name: 'uat' } },
  { name: 'getIntegrations', call: () => sirdar.getIntegrations(), path: '/deploy/integrations' },
  { name: 'saveIntegration', call: () => sirdar.saveIntegration('cloudflare',
      { zone: 'serversherpa.com', public_ip: '203.0.113.7', token: 't' }),
    path: '/deploy/integrations/cloudflare', method: 'PUT',
    body: { zone: 'serversherpa.com', public_ip: '203.0.113.7', token: 't' } },
  { name: 'removeIntegration', call: () => sirdar.removeIntegration('npm'), path: '/deploy/integrations/npm',
    method: 'DELETE' },
  { name: 'testIntegration (saved)', call: () => sirdar.testIntegration('npm'),
    path: '/deploy/integrations/npm/test', method: 'POST' },
  { name: 'testIntegration (unsaved)', call: () => sirdar.testIntegration('npm',
      { url: 'http://10.10.48.6:81', identity: 'a@b.co' }),
    path: '/deploy/integrations/npm/test', method: 'POST', body: { url: 'http://10.10.48.6:81', identity: 'a@b.co' } },
  { name: 'getPublishPlan', call: () => sirdar.getPublishPlan('uat'), path: '/deploy/environments/uat/publish' },
  { name: 'claimPublish', call: () => sirdar.claimPublish('uat'), path: '/deploy/environments/uat/publish/claim',
    method: 'POST' },
  { name: 'startDeployment (publish)', call: () => sirdar.startDeployment('uat', { mode: 'publish' }),
    path: '/deploy/environments/uat/deployments', method: 'POST', body: { mode: 'publish' } },
  { name: 'startDeployment (delete)', call: () => sirdar.startDeployment('uat', { mode: 'teardown', confirm_name: 'uat' }),
    path: '/deploy/environments/uat/deployments', method: 'POST', body: { mode: 'teardown', confirm_name: 'uat' } },
];
```

In the same file, replace:

```ts
  for (const file of ['api/routes/deploy.py', 'deploy/environments.py', 'deploy/gitref.py',
                       'deploy/ssh_targets.py', 'deploy/snapshots.py']) {
    const src = readFileSync(join(root, file), 'utf8');
    for (const re of [/"code": "([a-z_]+)"/g, /(?:EnvError|RefError|TargetError|SnapshotError)\("([a-z_]+)"/g,
```

with:

```ts
  for (const file of ['api/routes/deploy.py', 'api/routes/integrations.py', 'deploy/environments.py',
                       'deploy/gitref.py', 'deploy/ssh_targets.py', 'deploy/snapshots.py', 'deploy/integrations.py']) {
    const src = readFileSync(join(root, file), 'utf8');
    for (const re of [/"code": "([a-z_]+)"/g,
                      /(?:EnvError|RefError|TargetError|SnapshotError|IntegrationError)\("([a-z_]+)"/g,
```

and replace:

```ts
  expect(codes).toContain('rollback_not_latest');
```

with:

```ts
  expect(codes).toContain('rollback_not_latest');
  for (const code of ['integration_not_configured', 'publish_off', 'nothing_to_claim', 'claim_conflict',
                      'token_invalid', 'npm_url_invalid', 'secret_required', 'publish_not_allowed']) {
    expect(codes).toContain(code);
  }
```

Append to the end of `sirdar/web/src/lib/sirdarApi.test.ts`:

```ts
it('deployErrorText names the integrations a publish still needs', () => {
  const err = new ApiError(409, 'integration_not_configured',
    { code: 'integration_not_configured', kinds: ['cloudflare', 'npm'] });
  expect(sirdar.deployErrorText(err, 'x'))
    .toBe('Set up publishing in Settings › Integrations first (Cloudflare, Nginx Proxy Manager).');
});
```

In `sirdar/web/src/pages/environments/labels.test.ts`, replace:

```ts
import {
  DEPLOYMENT_STATUS, MODE_LABEL, STEP_STATUS, dumpTakenAt, duration, formatBytes, snapshotLabel, sshTargets, stoppedStep,
} from './labels';
```

with:

```ts
import {
  CERT_STATE, DEPLOYMENT_STATUS, ENV_STATUS, GATED_MODES, MODE_LABEL, PUBLISH_STATE, RETRY_MODES, STEP_STATUS,
  dumpTakenAt, duration, formatBytes, snapshotLabel, sshTargets, stoppedStep,
} from './labels';
```

and append:

```ts
it('labels the publish and delete modes, the deleting status and the publish states', () => {
  expect([MODE_LABEL.publish, MODE_LABEL.teardown]).toEqual(['Publish', 'Delete environment']);
  expect(ENV_STATUS.deleting).toEqual(['c-amber', 'Deleting']);
  expect(GATED_MODES).toEqual(['reset', 'restore_dump', 'rollback', 'teardown']);
  expect(RETRY_MODES).toEqual(['update', 'reset', 'restore_dump', 'rollback', 'publish', 'teardown']);
  expect(Object.keys(PUBLISH_STATE)).toEqual(['ok', 'update', 'create', 'claimable', 'conflict', 'unknown']);
  expect(PUBLISH_STATE.claimable).toEqual(['c-amber', "Not Sirdar's"]);
  expect(PUBLISH_STATE.conflict).toEqual(['c-red', 'Blocked']);
  expect(CERT_STATE.create).toEqual(['tag', 'Will request']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix sirdar/web test -- src/lib/sirdarApi.test.ts src/pages/environments/labels.test.ts`
Expected: FAIL — `sirdar.getIntegrations is not a function`, missing messages for the new codes, missing labels.

- [ ] **Step 3: Extend the API client**

In `sirdar/web/src/lib/sirdarApi.ts`, replace:

```ts
export type EnvStatus = 'new' | 'ready' | 'deploying' | 'failed';
/** Modes POST /environments/{name}/deployments starts. */
export type DeployMode = 'update' | 'reset' | 'restore_dump';
/** Every mode a deployment record can have. */
export type DeploymentMode = DeployMode | 'adopt' | 'snapshot' | 'rollback';
```

with:

```ts
export type EnvStatus = 'new' | 'ready' | 'deploying' | 'failed' | 'deleting';
/** Modes the Deploy modal starts. */
export type DeployMode = 'update' | 'reset' | 'restore_dump';
/** Every mode a deployment record can have (publish: steps 12–14 alone;
 *  teardown: Delete environment). */
export type DeploymentMode = DeployMode | 'adopt' | 'snapshot' | 'rollback' | 'publish' | 'teardown';
```

Replace:

```ts
  /** A stopped Update with a pre-deploy dump and a commit to go back to. */
  rollback_available: boolean;
  previous_sha: string | null; error: string | null; actor_name: string | null;
```

with:

```ts
  /** A stopped Update with a pre-deploy dump and a commit to go back to. */
  rollback_available: boolean;
  /** Its plan ends with steps 12–14 (DNS records, proxy hosts, smoke test). */
  publish: boolean;
  previous_sha: string | null; error: string | null; actor_name: string | null;
```

Replace:

```ts
  /** The snapshot the first deploy restores (kept afterwards). */
  seed_snapshot: SnapshotRef | null;
  last_deployment: DeploymentSummary | null; created_at: string; updated_at: string;
}
```

with:

```ts
  /** The snapshot the first deploy restores (kept afterwards). */
  seed_snapshot: SnapshotRef | null;
  /** Deploys publish DNS records and proxy hosts (steps 12–14). */
  publish: boolean;
  /** What Sirdar manages for it in Cloudflare and Nginx Proxy Manager. */
  managed_records: ManagedRecordRef[];
  last_deployment: DeploymentSummary | null; created_at: string; updated_at: string;
}
export interface ManagedRecordRef {
  service: string; kind: 'dns_record' | 'proxy_host' | 'certificate'; name: string; origin: 'created' | 'claimed';
}
```

Replace:

```ts
  /** The first deploy restores this snapshot. */
  snapshot_id?: string;
}
export interface AdoptEnvironmentBody { name: string; type: EnvType; target: string; git_ref: string }
```

with:

```ts
  /** The first deploy restores this snapshot. */
  snapshot_id?: string;
  /** Deploys publish DNS records and proxy hosts (the API's default: true). */
  publish?: boolean;
}
export interface AdoptEnvironmentBody { name: string; type: EnvType; target: string; git_ref: string }
```

Replace:

```ts
  services?: Record<string, { port?: number; host_ip?: string; proxied?: boolean }>;
  secrets?: Record<string, string>;
}
export interface DeploymentBody {
  mode: DeployMode; git_ref?: string; confirm_name?: string;
```

with:

```ts
  services?: Record<string, { port?: number; host_ip?: string; proxied?: boolean }>;
  secrets?: Record<string, string>;
  publish?: boolean;
}
export interface DeploymentBody {
  mode: DeployMode | 'publish' | 'teardown'; git_ref?: string; confirm_name?: string;
```

Replace:

```ts
export async function deleteSnapshot(id: string): Promise<void> {
  const resp = await apiFetch(`/deploy/snapshots/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorOf(resp);
}
```

with:

```ts
export async function deleteSnapshot(id: string): Promise<void> {
  const resp = await apiFetch(`/deploy/snapshots/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorOf(resp);
}

/* ---- Publishing: integrations (Settings) and the Publish tab ---- */
export type IntegrationKind = 'cloudflare' | 'npm';
export const INTEGRATION_LABEL: Record<IntegrationKind, string> = {
  cloudflare: 'Cloudflare', npm: 'Nginx Proxy Manager',
};
export interface CloudflareIntegration {
  configured: boolean; zone: string | null; public_ip: string | null; token_set: boolean;
  updated_at: string | null; updated_by_name: string | null;
}
export interface NpmIntegration {
  configured: boolean; url: string | null; identity: string | null; letsencrypt_email: string | null;
  password_set: boolean; updated_at: string | null; updated_by_name: string | null;
}
export interface Integrations { secrets_key_configured: boolean; cloudflare: CloudflareIntegration; npm: NpmIntegration }
/** An omitted secret keeps the stored one. */
export interface CloudflareBody { zone: string; public_ip: string; token?: string }
export interface NpmBody { url: string; identity: string; letsencrypt_email?: string; password?: string }
export interface IntegrationCheck {
  ok: boolean; target: IntegrationKind; checks: DeployCheck[]; facts: Record<string, unknown>;
}
export type PublishEntryState = 'ok' | 'update' | 'create' | 'claimable' | 'conflict' | 'unknown';
export interface PublishEntry { state: PublishEntryState; detail: string; origin: 'created' | 'claimed' | null }
export interface PublishService {
  service: string; hostname: string; forward: string;
  dns: PublishEntry & { record_id: string | null };
  proxy: PublishEntry & { host_id: number | null };
  certificate: { state: 'ok' | 'update' | 'create' | 'unknown'; detail: string; expires_on: string | null };
}
export interface PublishPlan {
  publish: boolean; proxy_ip: string;
  cloudflare: { configured: boolean; zone: string | null; public_ip: string | null; error: string | null };
  npm: { configured: boolean; url: string | null; error: string | null };
  services: PublishService[];
  /** Managed entries under a name the environment no longer uses. */
  stale: ManagedRecordRef[];
}
const integrationPath = (kind: IntegrationKind) => `/deploy/integrations/${kind}`;
export const getIntegrations = () => getJson<Integrations>('/deploy/integrations');
export const saveIntegration = (kind: IntegrationKind, body: CloudflareBody | NpmBody) =>
  sendJson<Integrations>('PUT', integrationPath(kind), body);
export async function removeIntegration(kind: IntegrationKind): Promise<void> {
  const resp = await apiFetch(integrationPath(kind), { method: 'DELETE' });
  if (!resp.ok) throw await errorOf(resp);
}
/** No body: the saved settings. A body: those values unsaved (no secret = the stored one). */
export const testIntegration = (kind: IntegrationKind, body?: CloudflareBody | NpmBody) =>
  sendJson<IntegrationCheck>('POST', `${integrationPath(kind)}/test`, body);
export const getPublishPlan = (name: string) => getJson<PublishPlan>(`${envPath(name)}/publish`);
export const claimPublish = (name: string) =>
  sendJson<PublishPlan & { claimed: string[] }>('POST', `${envPath(name)}/publish/claim`);
```

In `MESSAGES`, replace:

```ts
  upload_aborted: 'The upload was interrupted. Try again.',
};
```

with:

```ts
  upload_aborted: 'The upload was interrupted. Try again.',
  // integrations and publishing
  zone_invalid: "That zone isn't a valid domain, like serversherpa.com.",
  public_ip_invalid: 'The public IP must be an IPv4 address.',
  token_invalid: "That doesn't look like a Cloudflare API token (20–200 letters, digits, - or _).",
  secret_required: 'Enter the token or password: none is stored yet.',
  npm_url_invalid: 'Use the address of Nginx Proxy Manager, like http://10.10.48.6:81 (no path).',
  identity_invalid: 'Enter the email you sign in to Nginx Proxy Manager with.',
  letsencrypt_email_invalid: "That isn't a valid email address.",
  password_invalid: "That password can't be used: it's empty, too long, or has a line break.",
  integration_not_found: "Those credentials aren't stored any more.",
  integration_not_configured: 'Set up publishing in Settings › Integrations first.',
  integration_unreadable: "The stored credentials don't open with this Sirdar's SIRDAR_SECRETS_KEY. Enter them again.",
  nothing_to_claim: 'There is nothing to claim: no hand-made record or proxy host uses these names.',
  claim_conflict: 'Another environment claimed one of these first. Refresh and try again.',
  publish_off: 'Publishing is off for this environment. Turn it on first.',
  publish_not_allowed: 'An adopted environment starts with Publish off. Claim its records, then turn it on.',
};
```

Replace the body of `deployErrorText`:

```ts
  const d = errorDetail<{ reason?: unknown; missing?: unknown; key?: unknown; service?: unknown }>(err);
  if (d && typeof d.reason === 'string' && d.reason) return d.reason;
  const base = errorText(err, fallback);
  let extra = '';
  if (d && Array.isArray(d.missing) && d.missing.length) extra = d.missing.join(', ');
```

with:

```ts
  const d = errorDetail<{ reason?: unknown; missing?: unknown; key?: unknown; service?: unknown; kinds?: unknown }>(err);
  if (d && typeof d.reason === 'string' && d.reason) return d.reason;
  const base = errorText(err, fallback);
  let extra = '';
  if (d && Array.isArray(d.missing) && d.missing.length) extra = d.missing.join(', ');
  else if (d && Array.isArray(d.kinds) && d.kinds.length)
    extra = d.kinds.map((k) => INTEGRATION_LABEL[k as IntegrationKind] ?? String(k)).join(', ');
```

`INTEGRATION_LABEL` is a `const` declared further down the module; it is only read when `deployErrorText` runs, after the module has loaded, so the order is fine.

- [ ] **Step 4: Extend the labels**

In `sirdar/web/src/pages/environments/labels.tsx`, replace:

```ts
export const ENV_STATUS: ChipMap = {
  new: ['tag', 'New'], ready: ['c-green', 'Ready'], deploying: ['c-blue', 'Deploying'], failed: ['c-red', 'Failed'],
};
```

with:

```ts
export const ENV_STATUS: ChipMap = {
  new: ['tag', 'New'], ready: ['c-green', 'Ready'], deploying: ['c-blue', 'Deploying'], failed: ['c-red', 'Failed'],
  deleting: ['c-amber', 'Deleting'],
};
```

Replace:

```ts
  restore_dump: 'Restore backup', rollback: 'Roll back',
};
```

with:

```ts
  restore_dump: 'Restore backup', rollback: 'Roll back', publish: 'Publish', teardown: 'Delete environment',
};
/** A Publish tab entry's state (the API's PublishPlan). */
export const PUBLISH_STATE: ChipMap = {
  ok: ['c-green', 'Up to date'], update: ['c-blue', 'Will update'], create: ['tag', 'Will create'],
  claimable: ['c-amber', "Not Sirdar's"], conflict: ['c-red', 'Blocked'], unknown: ['tag', 'Unknown'],
};
export const CERT_STATE: ChipMap = {
  ok: ['c-green', 'Valid'], update: ['c-blue', 'Will update'], create: ['tag', 'Will request'], unknown: ['tag', 'Unknown'],
};
```

Replace:

```ts
export const GATED_MODES = ['reset', 'restore_dump', 'rollback'];
export const RETRY_MODES = ['update', 'reset', 'restore_dump', 'rollback'];
```

with:

```ts
export const GATED_MODES = ['reset', 'restore_dump', 'rollback', 'teardown'];
export const RETRY_MODES = ['update', 'reset', 'restore_dump', 'rollback', 'publish', 'teardown'];
```

- [ ] **Step 5: Extend the fixtures**

In `sirdar/web/src/pages/environments/testData.ts`, replace:

```ts
import type {
  Backup, Deployment, DeploymentStatus, DeploymentStep, DeploymentSummary, DeployTarget, Environment,
  EnvironmentDefaults, EnvService, Snapshot, StepStatus,
} from '../../lib/sirdarApi';
```

with:

```ts
import type {
  Backup, Deployment, DeploymentStatus, DeploymentStep, DeploymentSummary, DeployTarget, Environment,
  EnvironmentDefaults, EnvService, IntegrationCheck, Integrations, PublishPlan, Snapshot, StepStatus,
} from '../../lib/sirdarApi';
```

In `ADOPTED`, replace:

```ts
  failed_step: null, dump_path: null, snapshot: null, restore_dump: null, rollback_available: false,
  previous_sha: null, error: null, actor_name: 'Jimmy Henderson',
  started_at: '2026-10-03T12:00:00Z', finished_at: '2026-10-03T12:00:00Z', created_at: '2026-10-03T12:00:00Z',
};
```

with:

```ts
  failed_step: null, dump_path: null, snapshot: null, restore_dump: null, rollback_available: false, publish: false,
  previous_sha: null, error: null, actor_name: 'Jimmy Henderson',
  started_at: '2026-10-03T12:00:00Z', finished_at: '2026-10-03T12:00:00Z', created_at: '2026-10-03T12:00:00Z',
};
```

In `ENV`, replace:

```ts
  seed_snapshot: null, last_deployment: ADOPTED, created_at: '2026-10-03T12:00:00Z', updated_at: '2026-10-03T12:00:00Z',
};
```

with:

```ts
  seed_snapshot: null, publish: false, managed_records: [],
  last_deployment: ADOPTED, created_at: '2026-10-03T12:00:00Z', updated_at: '2026-10-03T12:00:00Z',
};
```

In `deployment()`, replace:

```ts
    dump_path: null, snapshot: null, restore_dump: null, rollback_available: false,
    previous_sha: SHA, error: null, actor_name: 'Jimmy Henderson',
```

with:

```ts
    dump_path: null, snapshot: null, restore_dump: null, rollback_available: false, publish: false,
    previous_sha: SHA, error: null, actor_name: 'Jimmy Henderson',
```

In `summary()`, replace:

```ts
    restore_dump: d.restore_dump, rollback_available: d.rollback_available, previous_sha: d.previous_sha,
```

with:

```ts
    restore_dump: d.restore_dump, rollback_available: d.rollback_available, publish: d.publish,
    previous_sha: d.previous_sha,
```

Append to the end of `testData.ts`:

```ts
export const INTEGRATIONS: Integrations = {
  secrets_key_configured: true,
  cloudflare: { configured: true, zone: 'serversherpa.com', public_ip: '203.0.113.7', token_set: true,
                updated_at: '2026-10-04T15:00:00Z', updated_by_name: 'Jimmy Henderson' },
  npm: { configured: true, url: 'http://10.10.48.6:81', identity: 'admin@example.com',
         letsencrypt_email: 'admin@example.com', password_set: true,
         updated_at: '2026-10-04T15:05:00Z', updated_by_name: 'Jimmy Henderson' },
};
export const NO_INTEGRATIONS: Integrations = {
  secrets_key_configured: true,
  cloudflare: { configured: false, zone: null, public_ip: null, token_set: false, updated_at: null, updated_by_name: null },
  npm: { configured: false, url: null, identity: null, letsencrypt_email: null, password_set: false,
         updated_at: null, updated_by_name: null },
};
export const CF_CHECK: IntegrationCheck = {
  ok: true, target: 'cloudflare',
  checks: [
    { label: 'Zone', status: 'pass', value: 'serversherpa.com (zone-1)' },
    { label: 'DNS records', status: 'pass', value: '40 records, 31 A' },
    { label: 'Public IP', status: 'pass', value: '203.0.113.7 · 12 A records point at it' },
  ],
  facts: { zone: 'serversherpa.com', zone_id: 'zone-1' },
};
/** uat as the Publish tab sees it: api made by hand, portal Sirdar's, kiosk blocked. */
export const PUBLISH_PLAN: PublishPlan = {
  publish: false, proxy_ip: '10.10.48.6',
  cloudflare: { configured: true, zone: 'serversherpa.com', public_ip: '203.0.113.7', error: null },
  npm: { configured: true, url: 'http://10.10.48.6:81', error: null },
  services: [
    { service: 'api', hostname: 'api.uat.serversherpa.com', forward: '10.10.48.63:8000',
      dns: { state: 'claimable', detail: 'A 203.0.113.7, made outside Sirdar.', origin: null, record_id: 'rec-1' },
      proxy: { state: 'claimable', detail: 'To 10.10.48.63:8000, made outside Sirdar.', origin: null, host_id: 4 },
      certificate: { state: 'ok', detail: 'Valid until 2026-12-03.', expires_on: '2026-12-03T10:00:00Z' } },
    { service: 'portal', hostname: 'portal.uat.serversherpa.com', forward: '10.10.48.63:8091',
      dns: { state: 'ok', detail: 'A 203.0.113.7', origin: 'created', record_id: 'rec-2' },
      proxy: { state: 'ok', detail: 'To 10.10.48.63:8091', origin: 'created', host_id: 5 },
      certificate: { state: 'ok', detail: 'Valid until 2026-12-20.', expires_on: '2026-12-20T10:00:00Z' } },
    { service: 'kiosk', hostname: 'kiosk.uat.serversherpa.com', forward: '10.10.48.63:8090',
      dns: { state: 'conflict', detail: 'A CNAME record already uses this name.', origin: null, record_id: null },
      proxy: { state: 'create', detail: 'Sirdar will create a proxy host to 10.10.48.63:8090.', origin: null, host_id: null },
      certificate: { state: 'create', detail: "Sirdar will request a Let's Encrypt certificate.", expires_on: null } },
  ],
  stale: [],
};
export const PUBLISHED_ENV: Environment = {
  ...ENV, publish: true,
  managed_records: [
    { service: 'api', kind: 'dns_record', name: 'api.uat.serversherpa.com', origin: 'claimed' },
    { service: 'portal', kind: 'certificate', name: 'portal.uat.serversherpa.com', origin: 'created' },
    { service: 'portal', kind: 'dns_record', name: 'portal.uat.serversherpa.com', origin: 'created' },
    { service: 'portal', kind: 'proxy_host', name: 'portal.uat.serversherpa.com', origin: 'created' },
  ],
};
const PUBLISH_STEPS: [number, string, string][] = [
  [12, 'dns', 'DNS records'], [13, 'proxy', 'Proxy hosts'], [14, 'smoke', 'Smoke test'],
];
const TEARDOWN_STEPS: [number, string, string][] = [
  [15, 'teardown', 'Remove environment'], [16, 'unproxy', 'Remove proxy hosts'], [17, 'undns', 'Remove DNS records'],
];
const STARTING: StepStatus[] = ['running', 'pending', 'pending'];
export const PUBLISHING = deployment('running', STARTING, {}, {
  id: 'd8', mode: 'publish', sha: SHA, start_step: 12, steps: steps(PUBLISH_STEPS, STARTING, {}),
});
export const TEARDOWN = deployment('running', STARTING, {}, {
  id: 'd7', mode: 'teardown', sha: '', start_step: 15, steps: steps(TEARDOWN_STEPS, STARTING, {}),
});
```

- [ ] **Step 6: Run the tests to verify they pass, then the whole web suite**

Run: `npm --prefix sirdar/web test -- src/lib/sirdarApi.test.ts src/pages/environments/labels.test.ts`
Expected: PASS.
Run: `npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: PASS (the new fixture fields keep every existing test and `tsc` happy).

- [ ] **Step 7: Commit**

```bash
git add sirdar/web/src/lib/sirdarApi.ts sirdar/web/src/lib/sirdarApi.test.ts \
  sirdar/web/src/pages/environments/labels.tsx sirdar/web/src/pages/environments/labels.test.ts \
  sirdar/web/src/pages/environments/testData.ts
git commit -m "feat(sirdar-web): publishing and integrations in the API client, labels and fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: Check list, a non-clearable secret, and the integration modal

**Files:**
- Create: `sirdar/web/src/components/CheckList.tsx`
- Modify: `sirdar/web/src/components/SecretField.tsx`
- Create: `sirdar/web/src/pages/settings/IntegrationModal.tsx`
- Modify: `sirdar/web/src/styles/sirdar.css`
- Test: `sirdar/web/src/components/CheckList.test.tsx`, `sirdar/web/src/components/SecretField.test.tsx`, `sirdar/web/src/pages/settings/IntegrationModal.test.tsx`

**Interfaces:**
- Consumes: `saveIntegration`, `testIntegration`, `deployErrorText`, `INTEGRATION_LABEL`, types from Task 1; `ipv4Problem` from `lib/envRules`.
- Produces: `CheckList({ checks: DeployCheck[]; label: string })` (a `ul` named `label`, one chip + label + value per check); `SecretField` prop `clearable?: boolean` (default true; false hides Clear); `IntegrationModal({ kind: IntegrationKind; current: Integrations; onSaved: (i: Integrations) => void; onClose: () => void })` — dialog named after `INTEGRATION_LABEL[kind]`, fields Zone / Public IP / API token (Cloudflare) or URL / Login email / Let's Encrypt email / Password (NPM), buttons Cancel, Test, Save.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/components/CheckList.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import CheckList from './CheckList';

afterEach(cleanup);

it('shows each check with its chip, label and value', () => {
  render(<CheckList label="Cloudflare test" checks={[
    { label: 'Zone', status: 'pass', value: 'serversherpa.com' },
    { label: 'Public IP', status: 'warn', value: '0 A records point at it' },
  ]} />);
  const list = screen.getByRole('list', { name: 'Cloudflare test' });
  const items = within(list).getAllByRole('listitem');
  expect(items.map((i) => i.textContent)).toEqual([
    'PassZoneserversherpa.com', 'WarningPublic IP0 A records point at it']);
});
```

In `sirdar/web/src/components/SecretField.test.tsx`, append:

```tsx
it('a secret that must stay set offers Replace but not Clear', () => {
  render(<SecretField {...base} isSet adding={false} action="keep" clearable={false} onAction={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
});
```

Create `sirdar/web/src/pages/settings/IntegrationModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ saveIntegration: vi.fn(), testIntegration: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import type { IntegrationKind, Integrations } from '../../lib/sirdarApi';
import { CF_CHECK, INTEGRATIONS, NO_INTEGRATIONS } from '../environments/testData';

import IntegrationModal from './IntegrationModal';

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.saveIntegration.mockResolvedValue(INTEGRATIONS);
  api.testIntegration.mockResolvedValue(CF_CHECK);
});
afterEach(cleanup);

function show(kind: IntegrationKind, current: Integrations = NO_INTEGRATIONS) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<IntegrationModal kind={kind} current={current} onSaved={onSaved} onClose={onClose} />);
  return { onSaved, onClose, dialog: screen.getByRole('dialog', { name: kind === 'cloudflare' ? 'Cloudflare' : 'Nginx Proxy Manager' }) };
}

it('sets up Cloudflare: header, the token is required, then it saves', async () => {
  const { onSaved, dialog } = show('cloudflare');
  expect(within(dialog).getByText('Integrations', { selector: '.eyebrow' })).toBeTruthy();
  expect((within(dialog).getByLabelText('Zone') as HTMLInputElement).value).toBe('serversherpa.com');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(within(dialog).getByText('Enter the public IP.')).toBeTruthy();
  expect(within(dialog).getByText('Enter the API token.')).toBeTruthy();
  expect(api.saveIntegration).not.toHaveBeenCalled();
  await userEvent.type(within(dialog).getByLabelText('Public IP'), '203.0.113.7');
  await userEvent.type(within(dialog).getByLabelText('API token'), 'cf-token-123456789012345');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(INTEGRATIONS));
  expect(api.saveIntegration).toHaveBeenCalledWith('cloudflare', {
    zone: 'serversherpa.com', public_ip: '203.0.113.7', token: 'cf-token-123456789012345' });
});

it('Test tries the values in the form without saving them and lists the checks', async () => {
  const { dialog } = show('cloudflare');
  await userEvent.type(within(dialog).getByLabelText('Public IP'), '203.0.113.7');
  await userEvent.type(within(dialog).getByLabelText('API token'), 'cf-token-123456789012345');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  const list = await within(dialog).findByRole('list', { name: 'Cloudflare test' });
  expect(within(list).getByText('40 records, 31 A')).toBeTruthy();
  expect(api.testIntegration).toHaveBeenCalledWith('cloudflare', {
    zone: 'serversherpa.com', public_ip: '203.0.113.7', token: 'cf-token-123456789012345' });
  expect(api.saveIntegration).not.toHaveBeenCalled();
});

it('editing NPM keeps the stored password unless it is replaced, and never offers Clear', async () => {
  const { onSaved, dialog } = show('npm', INTEGRATIONS);
  expect(within(dialog).getByText('Password: set')).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: 'Clear' })).toBeNull();
  expect((within(dialog).getByLabelText("Let's Encrypt email") as HTMLInputElement).value).toBe('');
  const login = within(dialog).getByLabelText('Login email');
  await userEvent.clear(login);
  await userEvent.type(login, 'ops@example.com');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.saveIntegration).toHaveBeenCalledWith('npm', {
    url: 'http://10.10.48.6:81', identity: 'ops@example.com', letsencrypt_email: '' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
  await userEvent.type(within(dialog).getByLabelText('Password'), 'new-pass');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.saveIntegration).toHaveBeenCalledTimes(2));
  expect(api.saveIntegration.mock.calls[1][1]).toEqual({
    url: 'http://10.10.48.6:81', identity: 'ops@example.com', letsencrypt_email: '', password: 'new-pass' });
});

it('API errors land on their field; a failed test shows the reason', async () => {
  api.saveIntegration.mockRejectedValue(new ApiError(422, 'npm_url_invalid', { code: 'npm_url_invalid' }));
  api.testIntegration.mockRejectedValue(new ApiError(502, 'connect_failed',
    { code: 'connect_failed', reason: 'Nginx Proxy Manager rejected the login.' }));
  const { dialog } = show('npm', INTEGRATIONS);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText(/Use the address of Nginx Proxy Manager/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  expect(await within(dialog).findByText('Nginx Proxy Manager rejected the login.')).toBeTruthy();
});

it('checks the URL and emails before asking the API', async () => {
  const { dialog } = show('npm');
  await userEvent.type(within(dialog).getByLabelText('URL'), '10.10.48.6:81');
  await userEvent.type(within(dialog).getByLabelText('Login email'), 'admin');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  expect(within(dialog).getByText('Start with http:// or https://, then the host and port only.')).toBeTruthy();
  expect(within(dialog).getByText('Enter an email address.')).toBeTruthy();
  expect(within(dialog).getByText('Enter the password.')).toBeTruthy();
  expect(api.testIntegration).not.toHaveBeenCalled();
});

it('Escape and Cancel close it', async () => {
  const { onClose, dialog } = show('cloudflare');
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix sirdar/web test -- src/components/CheckList.test.tsx src/components/SecretField.test.tsx src/pages/settings/IntegrationModal.test.tsx`
Expected: FAIL — the two new modules don't exist; SecretField still shows Clear.

- [ ] **Step 3: Write `CheckList`**

Create `sirdar/web/src/components/CheckList.tsx`:

```tsx
/** The result of a connection test: one chip, label and value per check. */
import type { DeployCheck } from '../lib/sirdarApi';

const CHIP: Record<DeployCheck['status'], [string, string]> = {
  pass: ['c-green', 'Pass'], warn: ['c-amber', 'Warning'], fail: ['c-red', 'Fail'],
};

export default function CheckList({ checks, label }: { checks: DeployCheck[]; label: string }) {
  return (
    <ul className="sirdar-checks" aria-label={label}>
      {checks.map((c) => (
        <li key={c.label}>
          <span className={`chip ${CHIP[c.status][0]}`}>{CHIP[c.status][1]}</span>
          <b>{c.label}</b>
          <span className="cell-sub">{c.value}</span>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Let `SecretField` hide Clear**

In `sirdar/web/src/components/SecretField.tsx`, replace:

```tsx
export default function SecretField({ id, label, isSet, adding, action, value, error, disabled = false, onAction, onValue }: {
  id: string; label: string; isSet: boolean; adding: boolean; action: SecretAction; value: string;
  error?: string; disabled?: boolean; onAction: (a: SecretAction) => void; onValue: (v: string) => void;
}) {
```

with:

```tsx
export default function SecretField({ id, label, isSet, adding, action, value, error, disabled = false, clearable = true,
  onAction, onValue }: {
  id: string; label: string; isSet: boolean; adding: boolean; action: SecretAction; value: string;
  error?: string; disabled?: boolean;
  /** false: a secret that must stay set (Replace only, no Clear). */
  clearable?: boolean;
  onAction: (a: SecretAction) => void; onValue: (v: string) => void;
}) {
```

and replace:

```tsx
                    <button type="button" className="mini-btn" onClick={() => onAction('set')}>Replace</button>
                    <button type="button" className="mini-btn" onClick={() => onAction('clear')}>Clear</button>
```

with:

```tsx
                    <button type="button" className="mini-btn" onClick={() => onAction('set')}>Replace</button>
                    {clearable && <button type="button" className="mini-btn" onClick={() => onAction('clear')}>Clear</button>}
```

- [ ] **Step 5: Write the modal**

Create `sirdar/web/src/pages/settings/IntegrationModal.tsx`:

```tsx
/** Set up or change one integration Sirdar publishes with: Cloudflare (zone,
 *  public IP, API token) or Nginx Proxy Manager (URL, login, Let's Encrypt
 *  email, password). The secret is write-only: kept unless replaced, never
 *  shown. Test tries the values in the form without saving them. */
import { type RefObject, useEffect, useRef, useState } from 'react';

import CheckList from '../../components/CheckList';
import SecretField, { type SecretAction } from '../../components/SecretField';
import { ipv4Problem } from '../../lib/envRules';
import {
  INTEGRATION_LABEL, deployErrorText, saveIntegration, testIntegration,
  type CloudflareBody, type IntegrationCheck, type IntegrationKind, type Integrations, type NpmBody,
} from '../../lib/sirdarApi';

type Field = 'zone' | 'ip' | 'url' | 'identity' | 'email' | 'secret' | 'form';
type Errors = Partial<Record<Field, string>>;
/** API error code → the field it belongs to. */
const CODE_FIELD: Record<string, Field> = {
  zone_invalid: 'zone', public_ip_invalid: 'ip', token_invalid: 'secret', secret_required: 'secret',
  npm_url_invalid: 'url', identity_invalid: 'identity', letsencrypt_email_invalid: 'email', password_invalid: 'secret',
};
const URL_RE = /^https?:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?\/?$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
const DESCRIPTION: Record<IntegrationKind, string> = {
  cloudflare: 'Sirdar keeps an A record for each public service in this zone, pointing at the public IP. '
    + 'The API token needs DNS edit on the zone.',
  npm: "Sirdar keeps a proxy host and a Let's Encrypt certificate for each public service through the "
    + 'Nginx Proxy Manager API.',
};
const SECRET_LABEL: Record<IntegrationKind, string> = { cloudflare: 'API token', npm: 'Password' };
const SECRET_MISSING: Record<IntegrationKind, string> = { cloudflare: 'Enter the API token.', npm: 'Enter the password.' };

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

export default function IntegrationModal({ kind, current, onSaved, onClose }: {
  kind: IntegrationKind; current: Integrations; onSaved: (saved: Integrations) => void; onClose: () => void;
}) {
  const cf = current.cloudflare;
  const npm = current.npm;
  const secretSet = kind === 'cloudflare' ? cf.token_set : npm.password_set;
  const [zone, setZone] = useState(cf.zone ?? 'serversherpa.com');
  const [ip, setIp] = useState(cf.public_ip ?? '');
  const [url, setUrl] = useState(npm.url ?? '');
  const [identity, setIdentity] = useState(npm.identity ?? '');
  // Blank means "the login email"; show it only when it differs.
  const [email, setEmail] = useState(
    npm.letsencrypt_email && npm.letsencrypt_email !== npm.identity ? npm.letsencrypt_email : '');
  const [action, setAction] = useState<SecretAction>(secretSet ? 'keep' : 'set');
  const [secret, setSecret] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('');
  const [result, setResult] = useState<IntegrationCheck | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
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

  const body = (): CloudflareBody | NpmBody => (kind === 'cloudflare'
    ? { zone: zone.trim(), public_ip: ip.trim(), ...(action === 'set' ? { token: secret } : {}) }
    : { url: url.trim(), identity: identity.trim(), letsencrypt_email: email.trim(),
        ...(action === 'set' ? { password: secret } : {}) });

  const validate = (): Errors => {
    const e: Errors = {};
    if (kind === 'cloudflare') {
      if (!zone.trim()) e.zone = 'Enter the zone, like serversherpa.com.';
      const problem = ipv4Problem(ip, 'public IP');
      if (problem) e.ip = problem;
    } else {
      if (!URL_RE.test(url.trim())) e.url = 'Start with http:// or https://, then the host and port only.';
      if (!EMAIL_RE.test(identity.trim())) e.identity = 'Enter an email address.';
      if (email.trim() && !EMAIL_RE.test(email.trim())) e.email = 'Enter an email address, or leave it blank.';
    }
    if (action === 'set' && !secret) e.secret = SECRET_MISSING[kind];
    return e;
  };

  const run = async (what: 'test' | 'save') => {
    if (busyRef.current) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    busyRef.current = what;
    setBusy(what);
    setResult(null);
    try {
      if (what === 'test') setResult(await testIntegration(kind, body()));
      else onSaved(await saveIntegration(kind, body()));
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      setErrors({ [CODE_FIELD[code] ?? 'form']: deployErrorText(err,
        what === 'test' ? "Couldn't test these settings." : "Couldn't save these settings.") });
    } finally {
      busyRef.current = '';
      setBusy('');
    }
  };

  const label = INTEGRATION_LABEL[kind];
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-integration-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-integration-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Integrations</div>
            <h3 id="sirdar-integration-title">{label}</h3>
            <p className="page-hint">{DESCRIPTION[kind]}</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={!!busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form sirdar-integration-form">
          {kind === 'cloudflare' ? (
            <>
              <TextField id="int-zone" label="Zone" value={zone} error={errors.zone} inputRef={firstRef}
                         onChange={setZone} />
              <TextField id="int-ip" label="Public IP" value={ip} error={errors.ip}
                         hint="The WAN address every A record points at." onChange={setIp} />
            </>
          ) : (
            <>
              <TextField id="int-url" label="URL" value={url} error={errors.url} inputRef={firstRef}
                         hint="Where Sirdar reaches Nginx Proxy Manager, like http://10.10.48.6:81." onChange={setUrl} />
              <TextField id="int-identity" label="Login email" value={identity} error={errors.identity}
                         onChange={setIdentity} />
              <TextField id="int-email" label="Let's Encrypt email" value={email} error={errors.email}
                         hint="Blank uses the login email." onChange={setEmail} />
            </>
          )}
          <div className="sirdar-span2">
            <SecretField id="int-secret" label={SECRET_LABEL[kind]} isSet={secretSet} adding={!secretSet}
                         action={action} value={secret} error={errors.secret} clearable={false}
                         onAction={(a) => { setAction(a); setSecret(''); }} onValue={setSecret} />
          </div>
          {result && (
            <div className="sirdar-span2">
              <CheckList label={`${label} test`} checks={result.checks} />
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

- [ ] **Step 6: Size the modal**

Append to `sirdar/web/src/styles/sirdar.css`:

```css
/* Settings › Integrations. 4 classes, to out-rank the portal's
   `.modal-card.reports-modal-card.rgm-card` width (980px). */
.modal-card.reports-modal-card.rgm-card.sirdar-integration-card { width: min(620px, 96vw); max-width: 96vw; }
.sirdar-integration-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.sirdar-integration-form .sirdar-span2 { grid-column: 1 / -1; }
@media (max-width: 640px) { .sirdar-integration-form { grid-template-columns: 1fr; } }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- src/components src/pages/settings`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add sirdar/web/src/components/CheckList.tsx sirdar/web/src/components/CheckList.test.tsx \
  sirdar/web/src/components/SecretField.tsx sirdar/web/src/components/SecretField.test.tsx \
  sirdar/web/src/pages/settings/IntegrationModal.tsx sirdar/web/src/pages/settings/IntegrationModal.test.tsx \
  sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): integration modal with write-only secret and Test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Settings › Integrations

**Files:**
- Create: `sirdar/web/src/pages/settings/IntegrationsSection.tsx`
- Modify: `sirdar/web/src/pages/Settings.tsx`
- Test: `sirdar/web/src/pages/settings/IntegrationsSection.test.tsx`, `sirdar/web/src/pages/Settings.test.tsx`

**Interfaces:**
- Consumes: `getIntegrations`, `testIntegration`, `removeIntegration` (Task 1); `IntegrationModal`, `CheckList` (Task 2); `when` from `pages/environments/labels`.
- Produces: `IntegrationsSection()` — a section named "Integrations" with one card (`role="group"`, named after the integration) per kind: state chip, settings, "Updated …", and (with `deploy:change`) buttons named "Set up <label>" / "Edit <label>", "Test <label>", "Remove <label>". The Settings page shows it to `deploy:view` readers.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/pages/settings/IntegrationsSection.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a === 'view' || perms.change) }),
}));
const api = vi.hoisted(() => ({
  getIntegrations: vi.fn(), testIntegration: vi.fn(), removeIntegration: vi.fn(), saveIntegration: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { CF_CHECK, INTEGRATIONS, NO_INTEGRATIONS } from '../environments/testData';

import IntegrationsSection from './IntegrationsSection';

beforeEach(() => {
  perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getIntegrations.mockResolvedValue(INTEGRATIONS);
  api.testIntegration.mockResolvedValue(CF_CHECK);
  api.removeIntegration.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows each integration, what is set, and never a secret', async () => {
  render(<IntegrationsSection />);
  const cf = await screen.findByRole('group', { name: 'Cloudflare' });
  expect(within(cf).getByText('Configured')).toBeTruthy();
  expect(within(cf).getByText('203.0.113.7')).toBeTruthy();
  expect(within(cf).getByText('Set', { selector: 'dd' })).toBeTruthy();
  expect(within(cf).getByText(/by Jimmy Henderson/)).toBeTruthy();
  const npm = screen.getByRole('group', { name: 'Nginx Proxy Manager' });
  expect(within(npm).getByText('http://10.10.48.6:81')).toBeTruthy();
  expect(within(npm).getAllByText('admin@example.com', { selector: 'dd' })).toHaveLength(2);   // login and Let's Encrypt
});

it('Set up opens the modal; saving shows the new state', async () => {
  api.getIntegrations.mockResolvedValue(NO_INTEGRATIONS);
  api.saveIntegration.mockResolvedValue(INTEGRATIONS);
  render(<IntegrationsSection />);
  const cf = await screen.findByRole('group', { name: 'Cloudflare' });
  expect(within(cf).getByText('Not set up')).toBeTruthy();
  expect(within(cf).queryByRole('button', { name: 'Test Cloudflare' })).toBeNull();
  await userEvent.click(within(cf).getByRole('button', { name: 'Set up Cloudflare' }));
  const dialog = screen.getByRole('dialog', { name: 'Cloudflare' });
  await userEvent.type(within(dialog).getByLabelText('Public IP'), '203.0.113.7');
  await userEvent.type(within(dialog).getByLabelText('API token'), 'cf-token-123456789012345');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(within(screen.getByRole('group', { name: 'Cloudflare' })).getByText('Configured')).toBeTruthy();
});

it('Test checks the saved settings and lists the result in the card', async () => {
  render(<IntegrationsSection />);
  const cf = await screen.findByRole('group', { name: 'Cloudflare' });
  await userEvent.click(within(cf).getByRole('button', { name: 'Test Cloudflare' }));
  const list = await within(cf).findByRole('list', { name: 'Cloudflare test' });
  expect(within(list).getByText('serversherpa.com (zone-1)')).toBeTruthy();
  expect(api.testIntegration).toHaveBeenCalledWith('cloudflare');
  api.testIntegration.mockRejectedValue(new ApiError(502, 'connect_failed',
    { code: 'connect_failed', reason: 'Nginx Proxy Manager rejected the login.' }));
  const npm = screen.getByRole('group', { name: 'Nginx Proxy Manager' });
  await userEvent.click(within(npm).getByRole('button', { name: 'Test Nginx Proxy Manager' }));
  expect(await within(npm).findByText('Nginx Proxy Manager rejected the login.')).toBeTruthy();
});

it('Remove asks first, then removes and reloads', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<IntegrationsSection />);
  const npm = await screen.findByRole('group', { name: 'Nginx Proxy Manager' });
  await userEvent.click(within(npm).getByRole('button', { name: 'Remove Nginx Proxy Manager' }));
  expect(api.removeIntegration).not.toHaveBeenCalled();
  api.getIntegrations.mockResolvedValue(NO_INTEGRATIONS);
  await userEvent.click(within(npm).getByRole('button', { name: 'Remove Nginx Proxy Manager' }));
  await waitFor(() => expect(api.removeIntegration).toHaveBeenCalledWith('npm'));
  expect(confirm.mock.calls[0][0]).toMatch(/Publishing stops until they are set again/);
  await waitFor(() => expect(within(screen.getByRole('group', { name: 'Nginx Proxy Manager' }))
    .getByText('Not set up')).toBeTruthy());
});

it('a view-only reader sees the settings and no buttons', async () => {
  perms.change = false;
  render(<IntegrationsSection />);
  const cf = await screen.findByRole('group', { name: 'Cloudflare' });
  expect(within(cf).queryByRole('button')).toBeNull();
  expect(screen.getByText('You can view these settings but not change them.')).toBeTruthy();
});

it('without SIRDAR_SECRETS_KEY nothing can be stored', async () => {
  api.getIntegrations.mockResolvedValue({ ...NO_INTEGRATIONS, secrets_key_configured: false });
  render(<IntegrationsSection />);
  expect(await screen.findByText(/SIRDAR_SECRETS_KEY isn't set on the Sirdar host/)).toBeTruthy();
  const setUp = screen.getByRole('button', { name: 'Set up Cloudflare' }) as HTMLButtonElement;
  expect(setUp.disabled).toBe(true);
});
```

Create `sirdar/web/src/pages/Settings.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ deploy: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string) => r === 'settings' || (r === 'deploy' && perms.deploy) }),
}));
const api = vi.hoisted(() => ({ getSettings: vi.fn(), getIntegrations: vi.fn() }));
vi.mock('../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../lib/sirdarApi')>()), ...api }));

import Settings from './Settings';
import { INTEGRATIONS } from './environments/testData';

beforeEach(() => {
  perms.deploy = true;
  api.getSettings.mockResolvedValue({ env: 'production', source_configured: true, session_ttl_seconds: 86400,
    access_token_ttl_seconds: 900, max_failed_logins: 10, lockout_seconds: 900 });
  api.getIntegrations.mockResolvedValue(INTEGRATIONS);
});
afterEach(cleanup);

it('shows Integrations to deploy readers', async () => {
  render(<Settings />);
  expect(await screen.findByRole('heading', { name: 'Integrations' })).toBeTruthy();
});

it('hides Integrations from people without deploy access', async () => {
  perms.deploy = false;
  render(<Settings />);
  expect(await screen.findByText('production')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Integrations' })).toBeNull();
  expect(api.getIntegrations).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/settings/IntegrationsSection.test.tsx src/pages/Settings.test.tsx`
Expected: FAIL — `IntegrationsSection` doesn't exist; Settings has no Integrations heading.

- [ ] **Step 3: Write the section**

Create `sirdar/web/src/pages/settings/IntegrationsSection.tsx`:

```tsx
/** Settings › Integrations: the credentials Sirdar publishes environments
 *  with (Cloudflare DNS, Nginx Proxy Manager). Secrets are write-only: a card
 *  shows only whether one is set. Test checks the saved settings; Remove
 *  forgets them (nothing changes in Cloudflare or NPM). */
import { Fragment, useCallback, useEffect, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import CheckList from '../../components/CheckList';
import {
  INTEGRATION_LABEL, deployErrorText, getIntegrations, removeIntegration, testIntegration,
  type IntegrationCheck, type IntegrationKind, type Integrations,
} from '../../lib/sirdarApi';
import { when } from '../environments/labels';

import IntegrationModal from './IntegrationModal';

const KINDS: IntegrationKind[] = ['cloudflare', 'npm'];
const PURPOSE: Record<IntegrationKind, string> = {
  cloudflare: 'DNS records for every public service of an environment that publishes.',
  npm: 'Proxy hosts and certificates for every public service of an environment that publishes.',
};

function settingsOf(data: Integrations, kind: IntegrationKind): [string, string][] {
  const set = (on: boolean) => (on ? 'Set' : 'Not set');
  if (kind === 'cloudflare') {
    const c = data.cloudflare;
    return [['Zone', c.zone ?? '—'], ['Public IP', c.public_ip ?? '—'], ['API token', set(c.token_set)]];
  }
  const n = data.npm;
  return [['URL', n.url ?? '—'], ['Login email', n.identity ?? '—'],
          ["Let's Encrypt email", n.letsencrypt_email ?? '—'], ['Password', set(n.password_set)]];
}

export default function IntegrationsSection() {
  const { can } = useAuth();
  const mayChange = can('deploy', 'change');
  const [data, setData] = useState<Integrations | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<IntegrationKind | null>(null);
  const [results, setResults] = useState<Partial<Record<IntegrationKind, IntegrationCheck>>>({});
  const [problems, setProblems] = useState<Partial<Record<IntegrationKind, string>>>({});
  const [busy, setBusy] = useState<IntegrationKind | null>(null);

  const load = useCallback(() => getIntegrations()
    .then((d) => { setData(d); setError(''); })
    .catch((e) => setError(deployErrorText(e, "Couldn't load the integrations."))), []);
  useEffect(() => { void load(); }, [load]);

  const forget = (kind: IntegrationKind) => {
    setResults((r) => ({ ...r, [kind]: undefined }));
    setProblems((p) => ({ ...p, [kind]: '' }));
  };

  const test = async (kind: IntegrationKind) => {
    forget(kind);
    setBusy(kind);
    try {
      const result = await testIntegration(kind);
      setResults((r) => ({ ...r, [kind]: result }));
    } catch (e) {
      setProblems((p) => ({ ...p, [kind]: deployErrorText(e, "Couldn't test the connection.") }));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (kind: IntegrationKind) => {
    const label = INTEGRATION_LABEL[kind];
    if (!window.confirm(`Remove the ${label} credentials? Publishing stops until they are set again; `
      + `nothing changes in ${label} itself.`)) return;
    forget(kind);
    setBusy(kind);
    try {
      await removeIntegration(kind);
      await load();
    } catch (e) {
      setProblems((p) => ({ ...p, [kind]: deployErrorText(e, "Couldn't remove the credentials.") }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="sirdar-section">
      <h2>Integrations</h2>
      <p className="page-hint">
        Environments with Publish on use these for their DNS records and proxy hosts. Tokens and passwords are stored
        encrypted and never shown again.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {data && !data.secrets_key_configured && (
        <p className="page-hint">
          SIRDAR_SECRETS_KEY isn't set on the Sirdar host, so credentials can't be stored. Add it to sirdar/.env and
          restart Sirdar.
        </p>
      )}
      {data && (
        <div className="sirdar-cards">
          {KINDS.map((kind) => {
            const label = INTEGRATION_LABEL[kind];
            const item = data[kind];
            return (
              <div key={kind} className="sirdar-card" role="group" aria-label={label}>
                <div className="sirdar-section-head">
                  <h3>{label}</h3>
                  <span className={`chip ${item.configured ? 'c-green' : 'tag'}`}>
                    {item.configured ? 'Configured' : 'Not set up'}
                  </span>
                </div>
                <p className="page-hint">{PURPOSE[kind]}</p>
                <dl className="sirdar-kv">
                  {settingsOf(data, kind).map(([k, v]) => (
                    <Fragment key={k}><dt>{k}</dt><dd className="mono">{v}</dd></Fragment>
                  ))}
                </dl>
                {item.updated_at && (
                  <p className="page-hint">
                    Updated {when(item.updated_at)}{item.updated_by_name ? ` by ${item.updated_by_name}` : ''}
                  </p>
                )}
                {mayChange && (
                  <div className="sirdar-actions">
                    {item.configured && (
                      <button type="button" className="mini-btn danger" aria-label={`Remove ${label}`}
                              disabled={busy === kind} onClick={() => void remove(kind)}>Remove</button>
                    )}
                    {item.configured && (
                      <button type="button" className="mini-btn" aria-label={`Test ${label}`}
                              disabled={busy === kind} onClick={() => void test(kind)}>
                        {busy === kind ? 'Testing…' : 'Test'}
                      </button>
                    )}
                    <button type="button" className="mini-btn"
                            aria-label={`${item.configured ? 'Edit' : 'Set up'} ${label}`}
                            disabled={!data.secrets_key_configured || busy === kind} onClick={() => setEditing(kind)}>
                      {item.configured ? 'Edit' : 'Set up'}
                    </button>
                  </div>
                )}
                {problems[kind] && <p className="form-error" role="alert">{problems[kind]}</p>}
                {results[kind] && <CheckList label={`${label} test`} checks={results[kind]!.checks} />}
              </div>
            );
          })}
        </div>
      )}
      {data && !mayChange && <p className="page-hint">You can view these settings but not change them.</p>}
      {editing && data && (
        <IntegrationModal kind={editing} current={data} onClose={() => setEditing(null)}
                          onSaved={(saved) => { setData(saved); forget(editing); setEditing(null); }} />
      )}
    </section>
  );
}
```

- [ ] **Step 4: Show it on the Settings page**

Replace the whole of `sirdar/web/src/pages/Settings.tsx` with:

```tsx
import { useEffect, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import { errorText, getSettings, type SirdarSettings } from '../lib/sirdarApi';

import IntegrationsSection from './settings/IntegrationsSection';

const minutes = (s: number) => `${Math.round(s / 60)} min`;

export default function Settings() {
  const { can } = useAuth();
  const [s, setS] = useState<SirdarSettings | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { getSettings().then(setS).catch((e) => setError(errorText(e, "Couldn't load settings."))); }, []);
  return (
    <div className="portal-page">
      <div className="eyebrow">System</div>
      <div className="dir-head">
        <h1>Settings</h1>
        <p>How this Sirdar is configured. The values below come from the server's environment.</p>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {s && (
        <div className="sirdar-kv">
          <span>Environment</span><span>{s.env}</span>
          <span>Portal database</span><span>{s.source_configured ? 'Configured' : 'Not configured'}</span>
          <span>Session lifetime</span><span>{Math.round(s.session_ttl_seconds / 3600)} h</span>
          <span>Access token lifetime</span><span>{minutes(s.access_token_ttl_seconds)}</span>
          <span>Lockout</span><span>{s.max_failed_logins} failures → {minutes(s.lockout_seconds)}</span>
        </div>
      )}
      {can('deploy', 'view') && <IntegrationsSection />}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- src/pages/settings src/pages/Settings.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sirdar/web/src/pages/settings/IntegrationsSection.tsx sirdar/web/src/pages/settings/IntegrationsSection.test.tsx \
  sirdar/web/src/pages/Settings.tsx sirdar/web/src/pages/Settings.test.tsx
git commit -m "feat(sirdar-web): Settings › Integrations with Test and Remove

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: The Publish tab

**Files:**
- Create: `sirdar/web/src/pages/environments/PublishTab.tsx`
- Modify: `sirdar/web/src/pages/environments/EnvironmentDetail.tsx`
- Modify: `sirdar/web/src/styles/sirdar.css`
- Test: `sirdar/web/src/pages/environments/PublishTab.test.tsx`, `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`

**Interfaces:**
- Consumes: `getPublishPlan`, `claimPublish`, `updateEnvironment`, `startDeployment` (Task 1); `PUBLISH_STATE`, `CERT_STATE`, `StatusChip`; `arrowNav`.
- Produces: `PublishTab({ env: Environment; onStarted: (dep: Deployment) => void; onChanged: (env: Environment) => void })` — the "Publish DNS and proxy" On/Off radiogroup (PATCH, `deploy:change`), a table named "Public names" (Service, Public name, Forwards to, DNS record, Proxy host, Certificate), buttons "Claim existing" (`deploy:change`) and "Publish now" (`deploy:add`); `EnvironmentDetail` gains the tab "Publish" between Deployments and Backups.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/pages/environments/PublishTab.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
  }),
}));
const api = vi.hoisted(() => ({
  getPublishPlan: vi.fn(), claimPublish: vi.fn(), updateEnvironment: vi.fn(), startDeployment: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import type { Environment } from '../../lib/sirdarApi';

import PublishTab from './PublishTab';
import { ENV, PUBLISHED_ENV, PUBLISHING, PUBLISH_PLAN } from './testData';

beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getPublishPlan.mockResolvedValue(PUBLISH_PLAN);
  api.startDeployment.mockResolvedValue(PUBLISHING);
});
afterEach(cleanup);

function show(env: Environment = ENV) {
  const onStarted = vi.fn();
  const onChanged = vi.fn();
  render(<MemoryRouter><PublishTab env={env} onStarted={onStarted} onChanged={onChanged} /></MemoryRouter>);
  return { onStarted, onChanged };
}

const cells = (row: HTMLElement) => within(row).getAllByRole('cell');

it('shows what publishing would do for each public name', async () => {
  show();
  const table = await screen.findByRole('table', { name: 'Public names' });
  const [api_, portal, kiosk] = within(table).getAllByRole('row').slice(1);
  expect(cells(api_)[1].textContent).toBe('api.uat.serversherpa.com');
  expect(cells(api_)[2].textContent).toBe('10.10.48.63:8000');
  expect(within(cells(api_)[3]).getByText("Not Sirdar's")).toBeTruthy();
  expect(within(cells(api_)[3]).getByText('A 203.0.113.7, made outside Sirdar.')).toBeTruthy();
  expect(within(cells(api_)[5]).getByText('Valid')).toBeTruthy();
  expect(within(cells(portal)[3]).getByText('Up to date')).toBeTruthy();
  expect(within(cells(kiosk)[3]).getByText('Blocked')).toBeTruthy();
  expect(within(cells(kiosk)[5]).getByText('Will request')).toBeTruthy();
  expect(api.getPublishPlan).toHaveBeenCalledWith('uat');
  expect(screen.getByText(/Claim them to let Sirdar keep them up to date/)).toBeTruthy();
});

it('Claim existing claims the hand-made entries and says what it claimed', async () => {
  api.claimPublish.mockResolvedValue({
    ...PUBLISH_PLAN, claimed: ['dns:api.uat.serversherpa.com', 'proxy:api.uat.serversherpa.com'],
    services: PUBLISH_PLAN.services.map((s) => (s.service === 'api'
      ? { ...s, dns: { ...s.dns, state: 'ok', origin: 'claimed' }, proxy: { ...s.proxy, state: 'ok', origin: 'claimed' } }
      : s)),
  });
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Claim existing' }));
  expect(await screen.findByRole('status')).toHaveProperty('textContent',
    'Claimed 2: dns:api.uat.serversherpa.com, proxy:api.uat.serversherpa.com. Sirdar keeps them up to date and '
    + 'never deletes them.');
  expect(api.claimPublish).toHaveBeenCalledWith('uat');
  const row = within(screen.getByRole('table', { name: 'Public names' })).getAllByRole('row')[1];
  expect(within(cells(row)[3]).getByText('claimed')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Claim existing' }) as HTMLButtonElement).disabled).toBe(true);
});

it('the switch turns Publish on through the environment PATCH', async () => {
  api.updateEnvironment.mockResolvedValue(PUBLISHED_ENV);
  const { onChanged } = show();
  const group = await screen.findByRole('radiogroup', { name: 'Publish DNS and proxy' });
  expect(within(group).getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText('Deploys leave DNS and the proxy as they are.')).toBeTruthy();
  await userEvent.click(within(group).getByRole('radio', { name: 'On' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(PUBLISHED_ENV));
  expect(api.updateEnvironment).toHaveBeenCalledWith('uat', { publish: true });
});

it('Publish now starts a publish job once publishing is on, set up and deployed', async () => {
  const { onStarted } = show(PUBLISHED_ENV);
  const button = (await screen.findByRole('button', { name: 'Publish now' })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  await userEvent.click(button);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(PUBLISHING));
  expect(api.startDeployment).toHaveBeenCalledWith('uat', { mode: 'publish' });
});

it('Publish now waits for the switch, both integrations and a deployed commit', async () => {
  show();
  const off = (await screen.findByRole('button', { name: 'Publish now' })) as HTMLButtonElement;
  expect(off.disabled).toBe(true);
  cleanup();
  api.getPublishPlan.mockResolvedValue({ ...PUBLISH_PLAN, npm: { configured: false, url: null, error: null } });
  show(PUBLISHED_ENV);
  const link = await screen.findByRole('link', { name: 'Settings › Integrations' });
  expect(link.getAttribute('href')).toBe('/settings');
  expect((screen.getByRole('button', { name: 'Publish now' }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  api.getPublishPlan.mockResolvedValue(PUBLISH_PLAN);
  show({ ...PUBLISHED_ENV, current_sha: null });
  await screen.findByRole('table', { name: 'Public names' });
  expect((screen.getByRole('button', { name: 'Publish now' }) as HTMLButtonElement).disabled).toBe(true);
});

it('says why a section is unknown', async () => {
  api.getPublishPlan.mockResolvedValue({
    ...PUBLISH_PLAN, cloudflare: { ...PUBLISH_PLAN.cloudflare, error: "Couldn't reach the Cloudflare API." },
    services: PUBLISH_PLAN.services.map((s) => ({ ...s, dns: { ...s.dns, state: 'unknown', detail: '' } })),
  });
  show();
  expect(await screen.findByText("Cloudflare: Couldn't reach the Cloudflare API.")).toBeTruthy();
  const row = within(screen.getByRole('table', { name: 'Public names' })).getAllByRole('row')[1];
  expect(within(cells(row)[3]).getByText('Unknown')).toBeTruthy();
});

it('a view-only reader gets no Claim or Publish now and a locked switch', async () => {
  perms.add = false; perms.change = false;
  show();
  await screen.findByRole('table', { name: 'Public names' });
  expect(screen.queryByRole('button', { name: 'Claim existing' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Publish now' })).toBeNull();
  const on = screen.getByRole('radio', { name: 'On' });
  expect(on.getAttribute('aria-disabled')).toBe('true');
  await userEvent.click(on);
  expect(api.updateEnvironment).not.toHaveBeenCalled();
});
```

In `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`, replace:

```tsx
  listSnapshots: vi.fn(), listBackups: vi.fn(),
}));
```

with:

```tsx
  listSnapshots: vi.fn(), listBackups: vi.fn(), getPublishPlan: vi.fn(), claimPublish: vi.fn(),
}));
```

replace:

```tsx
import { ADOPTED, BACKUPS, DEFAULTS, ENV, RUNNING, TARGETS, summary } from './testData';
```

with:

```tsx
import { ADOPTED, BACKUPS, DEFAULTS, ENV, PUBLISH_PLAN, RUNNING, TARGETS, summary } from './testData';
```

replace:

```tsx
  api.listBackups.mockResolvedValue({ backups: BACKUPS });
});
afterEach(cleanup);
```

with:

```tsx
  api.listBackups.mockResolvedValue({ backups: BACKUPS });
  api.getPublishPlan.mockResolvedValue(PUBLISH_PLAN);
});
afterEach(cleanup);
```

and append:

```tsx
it('the Publish tab sits between Deployments and Backups and shows the plan', async () => {
  show();
  await screen.findByRole('heading', { level: 1, name: 'uat' });
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(
    ['Overview', 'Deployments', 'Publish', 'Backups', 'Settings']);
  await userEvent.click(screen.getByRole('tab', { name: 'Publish' }));
  expect(await screen.findByRole('table', { name: 'Public names' })).toBeTruthy();
  expect(api.getPublishPlan).toHaveBeenCalledWith('uat');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments/PublishTab.test.tsx src/pages/environments/EnvironmentDetail.test.tsx`
Expected: FAIL — `PublishTab` doesn't exist; there is no Publish tab.

- [ ] **Step 3: Write the tab**

Create `sirdar/web/src/pages/environments/PublishTab.tsx`:

```tsx
/** Publish tab: whether deploys publish this environment (a DNS record and a
 *  proxy host per public name, then a smoke test), what publishing would do
 *  now for each name (read live from Cloudflare and Nginx Proxy Manager),
 *  Claim for hand-made records and hosts, and Publish now (steps 12–14 alone). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';

import { arrowNav } from '../../lib/arrowNav';
import {
  claimPublish, deployErrorText, getPublishPlan, startDeployment, updateEnvironment,
  type Deployment, type Environment, type PublishEntry, type PublishPlan,
} from '../../lib/sirdarApi';

import { CERT_STATE, PUBLISH_STATE, StatusChip } from './labels';

const SWITCH: [boolean, string][] = [[true, 'On'], [false, 'Off']];

function Entry({ entry }: { entry: PublishEntry }) {
  return (
    <div>
      <StatusChip map={PUBLISH_STATE} status={entry.state} />
      {entry.origin === 'claimed' && <span className="cell-sub"> claimed</span>}
      {entry.detail && <div className="cell-sub">{entry.detail}</div>}
    </div>
  );
}

export default function PublishTab({ env, onStarted, onChanged }: {
  env: Environment; onStarted: (dep: Deployment) => void; onChanged: (env: Environment) => void;
}) {
  const { can } = useAuth();
  const [plan, setPlan] = useState<PublishPlan | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<'' | 'switch' | 'claim' | 'publish'>('');
  const seq = useRef(0);

  // Only the newest request's answer lands.
  const load = useCallback(() => {
    const n = ++seq.current;
    return getPublishPlan(env.name)
      .then((p) => { if (n === seq.current) { setPlan(p); setError(''); } })
      .catch((e) => { if (n === seq.current) setError(deployErrorText(e, "Couldn't read what publishing would do.")); });
  }, [env.name]);
  // A deployment that ends may have published: read again.
  useEffect(() => { void load(); }, [load, env.status]);
  useEffect(() => () => { seq.current += 1; }, []);

  const running = env.status === 'deploying' || env.status === 'deleting';
  const mayChange = can('deploy', 'change');
  const mayDeploy = can('deploy', 'add');
  const configured = !!plan && plan.cloudflare.configured && plan.npm.configured;
  const claimable = !!plan && plan.services.some((s) => s.dns.state === 'claimable' || s.proxy.state === 'claimable');
  const switchLocked = !mayChange || running || busy !== '';

  const act = async (what: 'switch' | 'claim' | 'publish', work: () => Promise<void>, fallback: string) => {
    setBusy(what);
    setNotice('');
    setError('');
    try {
      await work();
    } catch (e) {
      setError(deployErrorText(e, fallback));
    } finally {
      setBusy('');
    }
  };
  const setPublish = (on: boolean) => {
    if (switchLocked || on === env.publish) return;
    void act('switch', async () => { onChanged(await updateEnvironment(env.name, { publish: on })); },
      "Couldn't change the Publish setting.");
  };
  const claim = () => act('claim', async () => {
    const result = await claimPublish(env.name);
    setPlan(result);
    setNotice(`Claimed ${result.claimed.length}: ${result.claimed.join(', ')}. Sirdar keeps them up to date and `
      + 'never deletes them.');
  }, "Couldn't claim them.");
  const publishNow = () => act('publish', async () => {
    onStarted(await startDeployment(env.name, { mode: 'publish' }));
  }, "Couldn't start publishing.");

  const why = !env.publish ? 'Turn Publish on first.' : !env.current_sha ? 'Deploy the environment first.'
    : !configured ? 'Set up both integrations first.' : running ? 'A deployment is running.' : undefined;

  return (
    <section className="sirdar-section">
      <div className="sirdar-section-head">
        <h2>Publish</h2>
        <button type="button" className="mini-btn" onClick={() => void load()}>Refresh</button>
      </div>
      <div className="sirdar-publish-switch">
        <span className="field-label" id="publish-switch-label">Publish DNS and proxy</span>
        <div className="segmented" role="radiogroup" aria-labelledby="publish-switch-label">
          {SWITCH.map(([value, label]) => (
            <button key={label} type="button" role="radio" aria-checked={env.publish === value}
                    aria-disabled={switchLocked} className={env.publish === value ? 'on' : ''}
                    tabIndex={env.publish === value ? 0 : -1} onKeyDown={arrowNav}
                    onClick={() => setPublish(value)}>{label}</button>
          ))}
        </div>
        <p className="page-hint">
          {env.publish
            ? 'Each deploy ends by bringing the DNS records and proxy hosts below up to date, then checks every public URL.'
            : 'Deploys leave DNS and the proxy as they are.'}
        </p>
      </div>
      {plan && !configured && (
        <p className="page-hint">
          Set up Cloudflare and Nginx Proxy Manager in <Link to="/settings">Settings › Integrations</Link> to publish.
        </p>
      )}
      {plan?.cloudflare.error && <p className="form-error" role="alert">Cloudflare: {plan.cloudflare.error}</p>}
      {plan?.npm.error && <p className="form-error" role="alert">Nginx Proxy Manager: {plan.npm.error}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <DataTable
        ariaLabel="Public names"
        columns={[
          { key: 'service', label: 'Service' }, { key: 'host', label: 'Public name', mono: true },
          { key: 'fwd', label: 'Forwards to', mono: true }, { key: 'dns', label: 'DNS record' },
          { key: 'proxy', label: 'Proxy host' }, { key: 'cert', label: 'Certificate' },
        ]}
        rows={(plan?.services ?? []).map((s) => ({
          key: s.service,
          cells: [
            <b className="cell-top">{s.service}</b>, s.hostname, s.forward,
            <Entry entry={s.dns} />, <Entry entry={s.proxy} />,
            <div>
              <StatusChip map={CERT_STATE} status={s.certificate.state} />
              {s.certificate.detail && <div className="cell-sub">{s.certificate.detail}</div>}
            </div>,
          ],
        }))}
        emptyText={plan === null ? 'Loading…' : 'This environment has no public services.'}
      />
      {plan && plan.stale.length > 0 && (
        <p className="page-hint">
          The next publish also removes what Sirdar made under names this environment no longer uses, and lets go of
          what was claimed there: {plan.stale.map((r) => r.name).join(', ')}.
        </p>
      )}
      {claimable && (
        <p className="page-hint">
          "Not Sirdar's" entries were made by hand. Claim them to let Sirdar keep them up to date; it never deletes what
          it claimed, even when the environment is deleted.
        </p>
      )}
      {notice && <p className="page-hint" role="status">{notice}</p>}
      {(mayChange || mayDeploy) && (
        <div className="sirdar-actions">
          {mayChange && (
            <button type="button" className="btn-ghost" disabled={!claimable || running || busy !== ''}
                    onClick={() => void claim()}>
              {busy === 'claim' ? 'Claiming…' : 'Claim existing'}
            </button>
          )}
          {mayDeploy && (
            <button type="button" className="btn-solid" disabled={!!why || busy !== ''} title={why}
                    onClick={() => void publishNow()}>
              {busy === 'publish' ? 'Starting…' : 'Publish now'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Add the tab**

In `sirdar/web/src/pages/environments/EnvironmentDetail.tsx`, replace:

```tsx
import EnvSettings from './EnvSettings';
```

with:

```tsx
import EnvSettings from './EnvSettings';
import PublishTab from './PublishTab';
```

replace:

```tsx
type Tab = 'overview' | 'deployments' | 'backups' | 'settings';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'], ['deployments', 'Deployments'], ['backups', 'Backups'], ['settings', 'Settings'],
];
```

with:

```tsx
type Tab = 'overview' | 'deployments' | 'publish' | 'backups' | 'settings';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'], ['deployments', 'Deployments'], ['publish', 'Publish'], ['backups', 'Backups'],
  ['settings', 'Settings'],
];
```

and replace:

```tsx
      {tab === 'backups' && <BackupsTab env={env} onStarted={started} />}
```

with:

```tsx
      {tab === 'publish' && <PublishTab env={env} onStarted={started} onChanged={setEnv} />}
      {tab === 'backups' && <BackupsTab env={env} onStarted={started} />}
```

- [ ] **Step 5: Style the switch**

Append to `sirdar/web/src/styles/sirdar.css`:

```css
/* Publish tab */
.sirdar-publish-switch { margin: 8px 0 16px; }
.sirdar-publish-switch .segmented { margin-top: 4px; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- src/pages/environments`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sirdar/web/src/pages/environments/PublishTab.tsx sirdar/web/src/pages/environments/PublishTab.test.tsx \
  sirdar/web/src/pages/environments/EnvironmentDetail.tsx sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx \
  sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): Publish tab with the switch, per-name plan, Claim and Publish now

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Delete environment

**Files:**
- Create: `sirdar/web/src/pages/environments/DeleteEnvironmentModal.tsx`
- Modify: `sirdar/web/src/pages/environments/EnvSettings.tsx`
- Modify: `sirdar/web/src/pages/environments/EnvironmentDetail.tsx`
- Modify: `sirdar/web/src/styles/sirdar.css`
- Test: `sirdar/web/src/pages/environments/DeleteEnvironmentModal.test.tsx`, `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`

**Interfaces:**
- Consumes: `startDeployment` with `{mode: 'teardown', confirm_name}`; `useHostKeyTrust`; `TEARDOWN` fixture.
- Produces: `DeleteEnvironmentModal({ env, onStarted, onClose })` (dialog "Delete <name>", lists what Sirdar removes and what it leaves, typed-name gate, button "Delete environment"); `EnvSettings` prop `onDeleteStarted?: (dep: Deployment) => void` (when given and the reader has `deploy:change`, a "Delete environment…" button at the end); `EnvironmentDetail` polls while `deleting`, disables Deploy then, and shows "<name> was deleted." with a "Back to Deploy" link once the environment answers 404 after having loaded.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/pages/environments/DeleteEnvironmentModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const api = vi.hoisted(() => ({ startDeployment: vi.fn(), trustKnownHost: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import DeleteEnvironmentModal from './DeleteEnvironmentModal';
import { ENV, PUBLISHED_ENV, TEARDOWN } from './testData';

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.startDeployment.mockResolvedValue(TEARDOWN);
});
afterEach(cleanup);

function show(env = PUBLISHED_ENV) {
  const onStarted = vi.fn();
  const onClose = vi.fn();
  render(<DeleteEnvironmentModal env={env} onStarted={onStarted} onClose={onClose} />);
  return { onStarted, onClose, dialog: screen.getByRole('dialog', { name: 'Delete uat' }) };
}

it('says what goes and what stays, and needs the typed name', async () => {
  const { onStarted, dialog } = show();
  expect(within(dialog).getByText('Settings', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByText(/removes \/opt\/serversherpa\/uat from the host, backups included/)).toBeTruthy();
  const removes = within(dialog).getByRole('list', { name: 'Sirdar removes' });
  expect(within(removes).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    'Certificate portal.uat.serversherpa.com', 'DNS record portal.uat.serversherpa.com',
    'Proxy host portal.uat.serversherpa.com']);
  const stays = within(dialog).getByRole('list', { name: 'Left in place' });
  expect(within(stays).getByText('DNS record api.uat.serversherpa.com')).toBeTruthy();
  const go = within(dialog).getByRole('button', { name: 'Delete environment' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(go);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(TEARDOWN));
  expect(api.startDeployment).toHaveBeenCalledWith('uat', { mode: 'teardown', confirm_name: 'uat' });
});

it('an environment with nothing published says so', () => {
  const { dialog } = show(ENV);
  expect(within(dialog).getByText('Sirdar manages no DNS records or proxy hosts for it.')).toBeTruthy();
});

it('an API refusal is shown in the modal', async () => {
  api.startDeployment.mockRejectedValue(new ApiError(409, 'integration_not_configured',
    { code: 'integration_not_configured', kinds: ['cloudflare'] }));
  const { dialog } = show();
  await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
  expect(await within(dialog).findByText('Set up publishing in Settings › Integrations first (Cloudflare).'))
    .toBeTruthy();
});
```

In `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`, replace:

```tsx
import { ADOPTED, BACKUPS, DEFAULTS, ENV, PUBLISH_PLAN, RUNNING, TARGETS, summary } from './testData';
```

with:

```tsx
import { ADOPTED, BACKUPS, DEFAULTS, ENV, PUBLISH_PLAN, RUNNING, TARGETS, TEARDOWN, summary } from './testData';
```

Append, after the `it('the Publish tab …')` test:

```tsx
it('Delete environment from the Settings tab: typed name, then the page follows the teardown', async () => {
  api.startDeployment.mockResolvedValue(TEARDOWN);
  api.getEnvironment.mockResolvedValueOnce(ENV).mockResolvedValue({ ...ENV, status: 'deleting' });
  show();
  await userEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
  await userEvent.click(screen.getByRole('button', { name: 'Delete environment…' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete uat' });
  await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
  expect(await screen.findByText('deployment view d7')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Deployments' }).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByText('Deleting')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement).disabled).toBe(true);
});

it('a view-only reader has no Delete environment button', async () => {
  perms.change = false;
  show();
  await userEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
  expect(screen.queryByRole('button', { name: 'Delete environment…' })).toBeNull();
});
```

Inside `describe('while the environment is deploying', …)`, append:

```tsx
  it('once a deleting environment is gone, the page says so', async () => {
    api.getEnvironment.mockResolvedValueOnce({ ...ENV, status: 'deleting' })
      .mockRejectedValue(new ApiError(404, 'environment_not_found', { code: 'environment_not_found' }));
    show();
    expect(await screen.findByText('Deleting')).toBeTruthy();
    await tick(ENV_POLL_MS);
    expect(await screen.findByText('uat was deleted.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Deploy' }).getAttribute('href')).toBe('/deploy');
    await tick(ENV_POLL_MS * 3);                 // gone: polling stops
    expect(api.getEnvironment).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments/DeleteEnvironmentModal.test.tsx src/pages/environments/EnvironmentDetail.test.tsx`
Expected: FAIL — no modal, no button, no deleted state.

- [ ] **Step 3: Write the modal**

Create `sirdar/web/src/pages/environments/DeleteEnvironmentModal.tsx`:

```tsx
/** Delete environment: a "teardown" deployment that stops the stacks and
 *  deletes the data and folder on the host (step 15), removes the proxy
 *  hosts, certificates and DNS records Sirdar created (16, 17), leaves the
 *  claimed ones in place, then removes the environment from Sirdar. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import {
  deployErrorText, startDeployment, type Deployment, type Environment, type ManagedRecordRef,
} from '../../lib/sirdarApi';

type Attempt = { confirm: string };
const NOUN: Record<ManagedRecordRef['kind'], string> = {
  dns_record: 'DNS record', proxy_host: 'Proxy host', certificate: 'Certificate',
};
const line = (r: ManagedRecordRef) => `${NOUN[r.kind]} ${r.name}`;

export default function DeleteEnvironmentModal({ env, onStarted, onClose }: {
  env: Environment; onStarted: (dep: Deployment) => void; onClose: () => void;
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

  const hostKey = useHostKeyTrust<Attempt>({
    canTrust: can('deploy', 'change'), trustLabel: 'Trust and delete',
    onTrusted: (attempt) => { void run(attempt); }, onProblem: setError,
  });
  const hostKeyOpen = useRef(false);
  hostKeyOpen.current = hostKey.open;
  const scrimRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { scrimRef.current?.toggleAttribute('inert', hostKey.open); }, [hostKey.open]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    confirmInput.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current && !hostKeyOpen.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  // Replays exactly the attempt that hit the host-key prompt.
  const run = async (attempt: Attempt) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      onStarted(await startDeployment(env.name, { mode: 'teardown', confirm_name: attempt.confirm }));
    } catch (e) {
      if (!hostKey.handle(e, env.target, attempt)) setError(deployErrorText(e, "Couldn't start deleting it."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const made = env.managed_records.filter((r) => r.origin === 'created');
  const claimed = env.managed_records.filter((r) => r.origin === 'claimed');
  const ready = confirm === env.name && !busy && can('deploy', 'change');

  return (
    <>
      <div className="modal-scrim" ref={scrimRef} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="modal-card reports-modal-card rgm-card sirdar-deploy-card" role="dialog" aria-modal="true"
             aria-labelledby="sirdar-delete-title">
          <div className="modal-head">
            <div className="rgm-head-text">
              <div className="eyebrow">Settings</div>
              <h3 id="sirdar-delete-title">Delete {env.name}</h3>
              <p className="page-hint">
                Stops every container of {env.name}, deletes its database and files, and removes {env.env_dir} from
                the host, backups included. Docker images stay. Then Sirdar forgets the environment.
              </p>
            </div>
            <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </div>
          <div className="modal-body pf-form sirdar-deploy-form">
            {made.length > 0 && (
              <div>
                <span className="field-label" id="delete-removes-label">Sirdar removes</span>
                <ul className="sirdar-plain-list" aria-labelledby="delete-removes-label">
                  {made.map((r) => <li key={`${r.kind}:${r.name}`}>{line(r)}</li>)}
                </ul>
              </div>
            )}
            {claimed.length > 0 && (
              <div>
                <span className="field-label" id="delete-stays-label">Left in place</span>
                <ul className="sirdar-plain-list" aria-labelledby="delete-stays-label">
                  {claimed.map((r) => <li key={`${r.kind}:${r.name}`}>{line(r)}</li>)}
                </ul>
                <p className="page-hint">Claimed: they were made by hand, so Sirdar never deletes them.</p>
              </div>
            )}
            {made.length === 0 && claimed.length === 0 && (
              <p className="page-hint">Sirdar manages no DNS records or proxy hosts for it.</p>
            )}
            <p className="page-hint">This can't be undone.</p>
            <div>
              <label className="field-label" htmlFor="delete-confirm">Type {env.name} to confirm</label>
              <input id="delete-confirm" ref={confirmInput} type="text" value={confirm} maxLength={64}
                     autoComplete="off" spellCheck={false} disabled={busy}
                     onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="btn-danger" disabled={!ready}
                    onClick={() => void run({ confirm })}>
              {busy ? 'Starting…' : 'Delete environment'}
            </button>
          </div>
        </div>
      </div>
      {hostKey.modal}
    </>
  );
}
```

Append to `sirdar/web/src/styles/sirdar.css`:

```css
.sirdar-plain-list { margin: 4px 0 0; padding-left: 18px; }
.sirdar-plain-list li { margin: 2px 0; }
.sirdar-danger-zone { margin-top: 28px; }
.sirdar-danger-zone .sirdar-actions { justify-content: flex-start; }
```

- [ ] **Step 4: The button in Settings**

In `sirdar/web/src/pages/environments/EnvSettings.tsx`, replace:

```tsx
import {
  deployErrorText, errorDetail, getEnvironmentDefaults, updateEnvironment,
  type DeployTarget, type Environment, type EnvironmentPatch,
} from '../../lib/sirdarApi';

import { sshTargets, targetLabel } from './labels';
```

with:

```tsx
import {
  deployErrorText, errorDetail, getEnvironmentDefaults, updateEnvironment,
  type DeployTarget, type Deployment, type Environment, type EnvironmentPatch,
} from '../../lib/sirdarApi';

import DeleteEnvironmentModal from './DeleteEnvironmentModal';
import { sshTargets, targetLabel } from './labels';
```

replace:

```tsx
export default function EnvSettings({ env, targets, onSaved }: {
  env: Environment; targets: DeployTarget[]; onSaved: (env: Environment) => void;
}) {
  const { can } = useAuth();
  const locked = !can('deploy', 'change');
  const deploying = env.status === 'deploying';
```

with:

```tsx
export default function EnvSettings({ env, targets, onSaved, onDeleteStarted }: {
  env: Environment; targets: DeployTarget[]; onSaved: (env: Environment) => void;
  /** Given: offer Delete environment, and hand its teardown deployment back. */
  onDeleteStarted?: (dep: Deployment) => void;
}) {
  const { can } = useAuth();
  const locked = !can('deploy', 'change');
  const deploying = env.status === 'deploying' || env.status === 'deleting';
  const [deleting, setDeleting] = useState(false);
```

and replace the end of the component:

```tsx
      {!locked && (
        <div className="sirdar-actions">
          <button type="button" className="btn-solid" disabled={saving || deploying} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      )}
    </section>
  );
}
```

with:

```tsx
      {!locked && (
        <div className="sirdar-actions">
          <button type="button" className="btn-solid" disabled={saving || deploying} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      )}
      {!locked && onDeleteStarted && (
        <div className="sirdar-danger-zone">
          <h3 className="sirdar-sub">Delete environment</h3>
          <p className="page-hint">
            Stops it, deletes its data and folder on the host, removes the DNS records and proxy hosts Sirdar made, and
            removes it from Sirdar.
          </p>
          <div className="sirdar-actions">
            <button type="button" className="btn-danger" disabled={deploying}
                    title={deploying ? 'A deployment is running.' : undefined} onClick={() => setDeleting(true)}>
              Delete environment…
            </button>
          </div>
        </div>
      )}
      {deleting && onDeleteStarted && (
        <DeleteEnvironmentModal env={env} onClose={() => setDeleting(false)}
                                onStarted={(dep) => { setDeleting(false); onDeleteStarted(dep); }} />
      )}
    </section>
  );
}
```

- [ ] **Step 5: The page follows the teardown and notices the end**

In `sirdar/web/src/pages/environments/EnvironmentDetail.tsx`, replace:

```tsx
import { useAuth } from '@portal/auth/AuthContext';
```

with:

```tsx
import { useAuth } from '@portal/auth/AuthContext';
import { ApiError } from '@portal/lib/api';
```

replace:

```tsx
  const [deploying, setDeploying] = useState(false);
  const seq = useRef(0);
```

with:

```tsx
  const [deploying, setDeploying] = useState(false);
  // A teardown ends by deleting the environment: a 404 after it loaded means gone.
  const [gone, setGone] = useState(false);
  const loaded = useRef(false);
  const seq = useRef(0);
```

replace:

```tsx
    return getEnvironment(name)
      .then((e) => { if (n === seq.current) { setEnv(e); setError(''); } })
      .catch((e) => { if (n === seq.current) setError(errorText(e, "Couldn't load this environment.")); });
  }, [name]);
```

with:

```tsx
    return getEnvironment(name)
      .then((e) => { if (n === seq.current) { loaded.current = true; setEnv(e); setError(''); } })
      .catch((e) => {
        if (n !== seq.current) return;
        if (loaded.current && e instanceof ApiError && e.code === 'environment_not_found') setGone(true);
        else setError(errorText(e, "Couldn't load this environment."));
      });
  }, [name]);
```

replace:

```tsx
  const status = env?.status;
  useEffect(() => {
    if (status !== 'deploying') return undefined;
```

with:

```tsx
  const status = env?.status;
  useEffect(() => {
    if ((status !== 'deploying' && status !== 'deleting') || gone) return undefined;
```

and add `gone` to that effect's dependency list: replace

```tsx
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [status, load]);
```

with:

```tsx
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [status, load, gone]);
```

replace:

```tsx
  const crumb = <div className="eyebrow"><Link to="/deploy">Deploy</Link></div>;
  if (!env) {
```

with:

```tsx
  const crumb = <div className="eyebrow"><Link to="/deploy">Deploy</Link></div>;
  if (gone) {
    return (
      <div className="portal-page">
        {crumb}
        <p className="page-hint" role="status">{name} was deleted.</p>
        <Link to="/deploy">Back to Deploy</Link>
      </div>
    );
  }
  if (!env) {
```

replace:

```tsx
  const running = env.status === 'deploying';
```

with:

```tsx
  const running = env.status === 'deploying' || env.status === 'deleting';
```

and replace:

```tsx
      {tab === 'settings' && <EnvSettings env={env} targets={targets} onSaved={setEnv} />}
```

with:

```tsx
      {tab === 'settings' && <EnvSettings env={env} targets={targets} onSaved={setEnv} onDeleteStarted={started} />}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test -- src/pages/environments`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sirdar/web/src/pages/environments/DeleteEnvironmentModal.tsx \
  sirdar/web/src/pages/environments/DeleteEnvironmentModal.test.tsx \
  sirdar/web/src/pages/environments/EnvSettings.tsx sirdar/web/src/pages/environments/EnvironmentDetail.tsx \
  sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): Delete environment with the typed-name gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: New environment's Publish choice, and the Overview hint

**Files:**
- Modify: `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`
- Modify: `sirdar/web/src/pages/environments/EnvOverview.tsx`
- Test: `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx`, `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`

**Interfaces:**
- Consumes: `NewEnvironmentBody.publish` (Task 1).
- Produces: the Services step's "Publish DNS and proxy" On (default) / Off radiogroup; Review shows "Publishing" and a "DNS record and proxy host" column; the create body always carries `publish`.

- [ ] **Step 1: Write the failing tests**

In `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx`, replace:

```tsx
    name: 'qa', type: 'custom', target: 'ssh:lab', git_ref: 'main', proxy_ip: '10.10.48.6', bind_ip: '0.0.0.0',
    ports: { api: 8100, portal: 8091, kiosk: 8090, wiki: 8096, spaces: 9000, status: 8095, mailpit: 8025 },
  });
});
```

with:

```tsx
    name: 'qa', type: 'custom', target: 'ssh:lab', git_ref: 'main', proxy_ip: '10.10.48.6', bind_ip: '0.0.0.0',
    ports: { api: 8100, portal: 8091, kiosk: 8090, wiki: 8096, spaces: 9000, status: 8095, mailpit: 8025 },
    publish: true,
  });
});

it('Services offers Publish (on by default); Off is shown in Review and sent', async () => {
  await open();
  await fillBasics();
  await next();
  const group = await screen.findByRole('radiogroup', { name: 'Publish DNS and proxy' });
  expect(within(group).getByRole('radio', { name: 'On' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText(/Each deploy creates or updates a DNS record and a proxy host/)).toBeTruthy();
  await userEvent.click(within(group).getByRole('radio', { name: 'Off' }));
  expect(screen.getByText(/DNS records and proxy hosts stay as they are/)).toBeTruthy();
  await next();
  await next();
  expect(screen.getByText('Off: DNS and the proxy are set up by hand')).toBeTruthy();
  const table = screen.getByRole('table', { name: 'Services to create' });
  expect(within(table).queryByText('On the first deploy')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  await waitFor(() => expect(api.createEnvironment).toHaveBeenCalled());
  expect(api.createEnvironment.mock.calls[0][0].publish).toBe(false);
});

it('with Publish on, Review lists the names it publishes', async () => {
  await open();
  await fillBasics();
  await next();
  await next();
  await next();
  expect(screen.getByText('On: Sirdar publishes the public names')).toBeTruthy();
  const table = screen.getByRole('table', { name: 'Services to create' });
  expect(within(table).getAllByText('On the first deploy')).toHaveLength(6);
});
```

In `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`, append:

```tsx
it('the Overview says who keeps the public names', async () => {
  api.getEnvironment.mockResolvedValue({ ...ENV, publish: true });
  show();
  expect(await screen.findByText(/Sirdar keeps their DNS records and proxy hosts up to date/)).toBeTruthy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments/NewEnvironmentModal.test.tsx src/pages/environments/EnvironmentDetail.test.tsx`
Expected: FAIL — no Publish choice; the body has no `publish`; the Overview hint is the old one.

- [ ] **Step 3: The modal**

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, replace:

```tsx
const DATA_MODES: [DataMode, string][] = [['empty', 'Start empty'], ['snapshot', 'From a snapshot']];
```

with:

```tsx
const DATA_MODES: [DataMode, string][] = [['empty', 'Start empty'], ['snapshot', 'From a snapshot']];
type PublishChoice = 'on' | 'off';
const PUBLISH_CHOICES: [PublishChoice, string][] = [['on', 'On'], ['off', 'Off']];
```

replace:

```tsx
  const [snapshotId, setSnapshotId] = useState('');
```

with:

```tsx
  const [snapshotId, setSnapshotId] = useState('');
  const [publish, setPublish] = useState<PublishChoice>('on');
```

replace:

```tsx
      ...(chosen ? { snapshot_id: chosen.id } : {}),
    } });
```

with:

```tsx
      ...(chosen ? { snapshot_id: chosen.id } : {}),
      publish: publish === 'on',
    } });
```

replace:

```tsx
                <p className="page-hint">
                  Every service runs on the chosen target. Public names point at the proxy; mailpit stays on the LAN.
                </p>
```

with:

```tsx
                <p className="page-hint">
                  Every service runs on the chosen target. Public names point at the proxy; mailpit stays on the LAN.
                </p>
                <div>
                  <span className="field-label" id="env-publish-label">Publish DNS and proxy</span>
                  <div className="segmented" role="radiogroup" aria-labelledby="env-publish-label">
                    {radios(PUBLISH_CHOICES, publish, setPublish)}
                  </div>
                  <p className="page-hint">
                    {publish === 'on'
                      ? 'Each deploy creates or updates a DNS record and a proxy host for every public name (Settings › '
                        + 'Integrations has the credentials).'
                      : 'DNS records and proxy hosts stay as they are: set them up by hand, or turn Publish on later.'}
                  </p>
                </div>
```

replace:

```tsx
                  <dd>{chosen ? `Snapshot ${chosen.name} (migration ${chosen.alembic_revision ?? '—'}), restored by the first deploy` : 'Empty'}</dd>
                </dl>
```

with:

```tsx
                  <dd>{chosen ? `Snapshot ${chosen.name} (migration ${chosen.alembic_revision ?? '—'}), restored by the first deploy` : 'Empty'}</dd>
                  <dt>Publishing</dt>
                  <dd>{publish === 'on' ? 'On: Sirdar publishes the public names' : 'Off: DNS and the proxy are set up by hand'}</dd>
                </dl>
```

replace:

```tsx
                  columns={[{ key: 'service', label: 'Service' }, { key: 'host', label: 'Public name', mono: true },
                            { key: 'port', label: 'Port', mono: true }]}
                  rows={services.map((s) => ({
                    key: s.service,
                    cells: [<b className="cell-top">{s.service}</b>, s.public ? `${s.service}.${effectiveDomain}` : '—',
                            ports[s.service]],
                  }))}
                />
                <p className="page-hint">Nothing is installed until the first deploy. DNS records and proxy hosts are still set up by hand.</p>
```

with:

```tsx
                  columns={[{ key: 'service', label: 'Service' }, { key: 'host', label: 'Public name', mono: true },
                            { key: 'port', label: 'Port', mono: true },
                            { key: 'pub', label: 'DNS record and proxy host' }]}
                  rows={services.map((s) => ({
                    key: s.service,
                    cells: [<b className="cell-top">{s.service}</b>, s.public ? `${s.service}.${effectiveDomain}` : '—',
                            ports[s.service], s.public && publish === 'on' ? 'On the first deploy' : '—'],
                  }))}
                />
                <p className="page-hint">
                  {publish === 'on'
                    ? 'Nothing is installed until the first deploy, which also publishes the public names.'
                    : 'Nothing is installed until the first deploy. DNS records and proxy hosts are set up by hand.'}
                </p>
```

- [ ] **Step 4: The Overview hint**

In `sirdar/web/src/pages/environments/EnvOverview.tsx`, replace:

```tsx
        <p className="page-hint">
          Public URLs answer once their DNS records and proxy hosts exist. Mailpit catches this environment's email on the LAN.
        </p>
```

with:

```tsx
        <p className="page-hint">
          {env.publish
            ? 'Sirdar keeps their DNS records and proxy hosts up to date on every deploy (Publish tab). '
            : 'Public URLs answer once their DNS records and proxy hosts exist: set up by hand, or turn Publish on. '}
          Mailpit catches this environment's email on the LAN.
        </p>
```

- [ ] **Step 5: Run the web suite and the build**

Run: `npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: PASS, and `tsc` + Vite build without errors.

- [ ] **Step 6: Commit**

```bash
git add sirdar/web/src/pages/environments/NewEnvironmentModal.tsx \
  sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx sirdar/web/src/pages/environments/EnvOverview.tsx \
  sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx
git commit -m "feat(sirdar-web): Publish choice in New environment; Overview says who keeps the names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: Live verify on the live Sirdar, Cloudflare, NPM and uat2 (controller, not a subagent)

The controller runs this task itself, through Claude in Chrome, with Jimmy signed in to the live Sirdar at `https://sirdar.dev.serversherpa.com` (Tower, `10.10.48.14`). The environment under test is **uat2** (made in the phase 3 live verify: the uat VM `10.10.48.63`, ports +100, proxy IP `10.10.48.6`). SSH checks use `jrh1812@10.10.48.63` with key auth from this Mac.

**Hard rules for this task**

- **Only uat2 is published, updated or deleted.** uat is only inspected and claimed (Claim writes Sirdar's database alone). uat's Publish switch stays Off. Never press Publish now, Deploy or Delete environment on uat.
- **Jimmy enters every credential himself** (Cloudflare API token, NPM password) in Settings › Integrations. Claude never types, reads back or prints a token or password, and never asks for one in chat.
- **Every outward change needs Jimmy's yes, per click**: Save or Remove of an integration, Claim, the Publish switch, Publish now, Deploy, Delete environment, trusting a host key. Before each, say in chat exactly what it will create, change or delete (names included) and wait. Test buttons and page reads are read-only; still say "testing Cloudflare now" before clicking Test.
- `ssh … 'bash -s' <<EOF` eats stdin under `docker compose`; keep every SSH command a single command line.
- Load the browser tools once: ToolSearch `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__form_input,mcp__claude-in-chrome__read_network_requests,mcp__claude-in-chrome__tabs_create_mcp`.
- `window.confirm` (Remove integration) blocks automation: Jimmy clicks OK himself.

**Known risks to watch (fix TDD-style on the owning 4a task, redeploy, retry):** NPM's schema may refuse a key in the proxy-host body (look for "additional properties" — `host_body` copies only `HOST_FIELDS`, and `meta` passes through as NPM sent it); NPM 2.12+ may ignore or refuse `letsencrypt_email` in the certificate `meta`; Cloudflare may refuse `comment` on the zone's plan (error 1004-ish: drop the comment); Let's Encrypt can't validate until Cloudflare's new A record is visible (the step's retries cover a minute or two; otherwise Retry from step 13).

- [ ] **Step 1: Preconditions — the code is live on Tower**

1. Plans 4a and 4b are merged to `main` and pushed (Jimmy decides): `git -C /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar log -1 --format=%H origin/main` shows the merge.
2. Jimmy updates Tower with the installer at that commit:

   ```bash
   SHA=$(git -C /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar rev-parse origin/main)
   echo "curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/$SHA/sirdar/install.sh | SIRDAR_DIR=/mnt/user/serversherpa/sirdar bash"
   ```

   Then on Tower: `docker exec sirdar-sirdar-1 sh -c 'cd /app/api && alembic current'` → `0006 (head)`.
3. Chrome → `https://sirdar.dev.serversherpa.com/settings`: an **Integrations** section with Cloudflare and Nginx Proxy Manager cards, both "Not set up". `/deploy/environments/uat2` → tabs Overview, Deployments, **Publish**, Backups, Settings; uat2 is Ready; its Publish switch is **Off** (migration 0006 left existing environments unpublished). Same for uat.
4. Baselines (read-only):

   ```bash
   for s in api portal kiosk wiki spaces status; do printf '%s ' $s.uat2; dig +short $s.uat2.serversherpa.com @1.1.1.1 | tr '\n' ' '; echo; done
   for s in api portal kiosk wiki spaces status mail; do printf '%s ' $s.uat; dig +short $s.uat.serversherpa.com @1.1.1.1 | tr '\n' ' '; echo; done
   curl -s -o /dev/null -w 'uat api %{http_code}\n' https://api.uat.serversherpa.com/healthz
   ssh jrh1812@10.10.48.63 "docker ps --format '{{.Names}}' | grep -c '^ss-uat2-'; ls /opt/serversherpa"
   ```

   Expected: no address for any `*.uat2` name; the uat names answer with the WAN IP (note it: `WAN_IP`); `uat api 200`; uat2's containers running (12 or more); `uat uat2` in `/opt/serversherpa`.

- [ ] **Step 2: Jimmy enters the credentials; Test both**

1. Ask Jimmy to click **Set up Cloudflare** and fill it himself: Zone `serversherpa.com`, Public IP = `WAN_IP`, API token (DNS edit on serversherpa.com). Before he clicks **Save**, he may click **Test** in the modal: the checks show Zone `serversherpa.com (<zone id>)`, the record count, and "Public IP · N A records point at it" with N ≥ 6 (uat's). Then **Save** (his click). The card reads Configured, "API token: Set", "Updated … by Jimmy Henderson".
2. Same for **Set up Nginx Proxy Manager**: URL `http://10.10.48.6:81`, Login email, Let's Encrypt email (blank = the login), Password → **Test** → Login pass, Version `2.x.y`, Proxy hosts N (note it: `NPM_HOSTS`), Certificates M (`NPM_CERTS`) → **Save**.
3. With Jimmy's go-ahead, click each card's **Test** yourself: the same checks appear in the card. Note the Cloudflare record count (`CF_RECORDS`).
4. Secrets never come back: `read_network_requests` on `/deploy/integrations` shows `token_set: true` / `password_set: true` and no token or password field. Settings › Audit (or `/admin/audit`) shows `deploy.integration_update` rows with `changed` names only.

- [ ] **Step 3: Claim uat's hand-made records (read-only toward Cloudflare and NPM)**

1. `/deploy/environments/uat` → **Publish** tab. The table "Public names" lists api, portal, kiosk, wiki, spaces, status: DNS record "Not Sirdar's — A `WAN_IP`, made outside Sirdar."; Proxy host "Not Sirdar's — To 10.10.48.63:<port>, made outside Sirdar."; Certificate Valid (or Will update if one is near expiry). `mail.uat` is not listed (Sirdar never manages it). If any row is Blocked, stop and report its detail.
2. Ask Jimmy, then click **Claim existing**. The notice lists `dns:` and `proxy:` for the six names; every row now shows "Up to date … claimed" (or Will update where a hand-made host differs from Sirdar's settings — note which, and don't publish uat).
3. Prove nothing changed outside Sirdar: Settings › Integrations → **Test** both → Cloudflare's record count = `CF_RECORDS`, NPM's proxy hosts = `NPM_HOSTS`, certificates = `NPM_CERTS`. uat's Settings tab shows the managed records only via the API: `read_network_requests` on `GET /deploy/environments/uat` → `managed_records` has 12 entries, all `origin: "claimed"`. uat's switch is still **Off**.

- [ ] **Step 4: Publish uat2**

1. `/deploy/environments/uat2` → **Publish** tab: all six rows "Will create" (DNS, proxy, certificate). Publish now is disabled ("Turn Publish on first.").
2. Ask Jimmy, then switch **Publish DNS and proxy** to **On** (a PATCH; nothing outside Sirdar changes).
3. Ask Jimmy, naming what it creates: six Cloudflare A records `api|portal|kiosk|wiki|spaces|status.uat2.serversherpa.com → WAN_IP` (DNS only), six NPM proxy hosts to `10.10.48.63:8100/8191/8190/8196/9100/8195`, and six Let's Encrypt certificates. Then click **Publish now**. The page moves to Deployments with steps 12 DNS records, 13 Proxy hosts, 14 Smoke test.
4. Follow the logs: step 12 prints "created A WAN_IP" per name; step 13 "created a proxy host…", "requesting a Let's Encrypt certificate", maybe "Certbot is busy …; trying again in 30 s", then "HTTPS with certificate #N, Force SSL on"; step 14 one "https://<name>/…: HTTP 200" (or 30x) per name. If step 13 or 14 fails, read the log, fix, and **Retry** from that step (no SSH needed).
5. Checks:

   ```bash
   for s in api portal kiosk wiki spaces status; do printf '%s ' $s; dig +short $s.uat2.serversherpa.com @1.1.1.1; done
   for p in api/healthz portal/ kiosk/ wiki/healthz spaces/healthz status/healthz; do
     n=${p%%/*}; curl -s -o /dev/null -w "$n %{http_code} %{ssl_verify_result}\n" \
       --resolve $n.uat2.serversherpa.com:443:10.10.48.6 https://$n.uat2.serversherpa.com/${p#*/}; done
   curl -s -o /dev/null -w 'http→https %{http_code} %{redirect_url}\n' --resolve api.uat2.serversherpa.com:80:10.10.48.6 http://api.uat2.serversherpa.com/healthz
   ```

   Expected: each name → `WAN_IP`; each URL `200` (portal/kiosk may be `200` or `30x`) with `ssl_verify_result` 0; the http request redirects to https (Force SSL). If the router does hairpin NAT, the same URLs also answer from a browser on the LAN.
6. In Chrome: the Publish tab shows every row "Up to date" with origin created; uat2's Overview hint reads "Sirdar keeps their DNS records and proxy hosts up to date…"; Settings › Integrations › Test → Cloudflare records = `CF_RECORDS + 6`, NPM hosts = `NPM_HOSTS + 6`, certificates = `NPM_CERTS + 6`. In NPM's own UI (Jimmy, or read-only in Chrome) the six hosts show WebSockets on, Force SSL on, Block common exploits on, and `spaces.uat2` has `client_max_body_size 0;` in Advanced.
7. Idempotence: ask Jimmy, then **Publish now** again → steps 12 and 13 log "unchanged" for every name and request no certificate; step 14 passes. The Test counts don't change.

- [ ] **Step 5: A publishing Update of uat2**

Ask Jimmy, then **Deploy** uat2 (Update, ref `main`). The step list ends 1–6, 10, 12, 13, 14; all succeed; 12–13 report "unchanged". The Deployments row's details carry the publish steps. Then a Retry check isn't needed unless something failed.

- [ ] **Step 6: Secrets stay out of logs (Jimmy runs this)**

In his own terminal on Tower (Claude never sees the values), Jimmy runs:

```bash
read -rs CF; read -rs NPMPW
docker logs sirdar-sirdar-1 2>&1 | grep -cF -e "$CF" -e "$NPMPW"
docker exec sirdar-sirdar-db-1 psql -U sirdar -d sirdar -tAc "SELECT count(*) FROM deployment_steps WHERE strpos(log, '$CF') > 0 OR strpos(log, '$NPMPW') > 0" ; unset CF NPMPW
```

Expected: `0` and `0`. (Adjust the container names to Tower's if they differ: `docker ps --format '{{.Names}}' | grep sirdar`.)

- [ ] **Step 7: UI checks (light and dark)**

In My preferences switch Theme to Dark, then revisit: Settings › Integrations (cards, the modal — open **Edit** and Cancel), uat2's Publish tab (chips, details, the switch), the Delete environment modal (open from uat2's Settings tab and Cancel — never on uat), and a publish deployment's steps. Readable contrast, no white blocks, the modals sized to their content. Switch back to Light and spot-check. Optional: a view-only (`admin` role) account sees the Integrations cards without buttons, the Publish tab without Claim or Publish now, and no Delete environment.

- [ ] **Step 8: Delete uat2 (ask Jimmy; default yes)**

1. Ask Jimmy whether to delete uat2 now (it removes its six A records, six proxy hosts and six certificates, its containers, volumes and `/opt/serversherpa/uat2`, then the Sirdar record). Default: yes — it is the spec's teardown check.
2. On his yes: uat2 → Settings tab → **Delete environment…**. The modal lists "Sirdar removes": 6 certificates, 6 DNS records, 6 proxy hosts; nothing "Left in place". Type `uat2` → **Delete environment** (his click, or yours after his yes). The page follows steps 15 Remove environment, 16 Remove proxy hosts, 17 Remove DNS records, then shows "uat2 was deleted." with Back to Deploy. If the host key prompt appears, ask before trusting.
3. Checks:

   ```bash
   for s in api portal kiosk wiki spaces status; do printf '%s ' $s; dig +short $s.uat2.serversherpa.com @1.1.1.1; echo; done
   ssh jrh1812@10.10.48.63 "docker ps -a --format '{{.Names}}' | grep -c '^ss-uat2-'; docker volume ls -q | grep -c '^ss-uat2-'; ls /opt/serversherpa"
   ```

   Expected: no addresses (allow a few minutes for resolver caches; Cloudflare's own count is the authority); `0`, `0`, and only `uat` in `/opt/serversherpa`. Settings › Integrations › Test → Cloudflare records = `CF_RECORDS`, NPM hosts = `NPM_HOSTS`, certificates = `NPM_CERTS`. `/deploy` no longer lists uat2; Settings › Audit shows `deploy.deployment_start` (teardown) and `deploy.environment_delete` for uat2.

- [ ] **Step 9: uat is untouched**

```bash
for s in api portal kiosk wiki spaces status mail; do printf '%s ' $s.uat; dig +short $s.uat.serversherpa.com @1.1.1.1 | tr '\n' ' '; echo; done
curl -s -o /dev/null -w 'uat api %{http_code}\n' https://api.uat.serversherpa.com/healthz
```

Expected: the same answers as Step 1's baseline and `200`. In Sirdar: uat's Publish switch is Off, its Publish tab shows the six names claimed and up to date, its Deployments list gained nothing.

- [ ] **Step 10: Report**

Each step's result (passed, or what failed and the fix commit), the before/after counts (`CF_RECORDS`, `NPM_HOSTS`, `NPM_CERTS` at Steps 2, 4 and 8), the smoke-test lines, whether certbot retries happened, the leak-check zeros, whether uat2 was deleted, and that uat was only claimed (Step 9). Note any open question from the context file that the run answered.

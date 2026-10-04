# Sirdar deploy phase 3b (snapshots: web UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give phase 3a's snapshot API its UI: a Snapshots section on `/deploy` (list, Upload, Take snapshot, Delete), the New environment modal's Data step, Reset data that restores a snapshot, a Backups tab with Restore backup, Roll back on a failed Update — then live-verify it all on the real uat VM through a second environment, `uat2`.

**Architecture:** Web code in `sirdar/web/src` over the `/api/deploy` routes of plan 3a. New folder `pages/snapshots/` holds the section and its two modals; environment pages gain `BackupsTab` and `RestoreBackupModal`; `NewEnvironmentModal`, `DeployModal`, `DeploymentView`, `EnvironmentDetail` and `EnvOverview` grow the snapshot choices. Shared pieces stay where they are (`useHostKeyTrust`, `labels.tsx`, `testData.ts`); the upload sends the file as the raw request body through the portal's `apiFetch`.

**Tech Stack:** React 18 + TypeScript 5.6 + react-router-dom 6 + Vitest 3 / Testing Library (jsdom); portal components through `@portal` (`DataTable`, `ComboBox`, `AuthContext`, `lib/api`); Claude in Chrome for the live verify.

**Spec:** `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md` Section 4 (Snapshots tab, Backups tab, New environment Data step, Deploy modal, Roll back), with `docs/superpowers/plans/2026-10-04-sirdar-phase3-context.md`. Plan 3a (`docs/superpowers/plans/2026-10-04-sirdar-phase3a-backend.md`) must be done first.

## Interfaces from 3a

All under `/api/deploy` (the web client's paths start `/deploy`; `VITE_API_URL=/api`). Times are ISO 8601 strings.

- `SnapshotOut` = `{id, name, origin: "upload"|"environment", source, status: "pending"|"ready"|"failed", alembic_revision: string|null, size_bytes: number|null, checksum: string|null, object_count: number|null, object_bytes: number|null, notes: string, source_created_at: string|null, created_at: string, created_by_name: string|null, deployment_id: string|null}` (`deployment_id`: the snapshot job, taken snapshots only).
- `GET /snapshots` (view) → `{snapshots: SnapshotOut[]}`, newest first.
- `POST /snapshots?name=<name>&notes=<notes>` (add), body = the raw bundle, `Content-Type: application/gzip` → 201 `SnapshotOut`. Errors: 422 `snapshot_name_invalid`; 422 `notes_too_long`; 409 `snapshot_exists`; 413 `snapshot_too_large` `{max_bytes}`; 422 `bundle_invalid` `{reason}`; 422 `snapshot_keys_unreadable`; 400 `secrets_key_missing`; 500 `snapshots_dir_unwritable`. A reverse proxy that refuses the size answers a non-JSON 413 (client code `http_413`).
- `POST /environments/{name}/snapshots` (add) body `{name, notes}` → 201 `{snapshot: SnapshotOut (pending), deployment: Deployment (mode "snapshot")}`. Errors: 404 `environment_not_found`; 409 `deploy_in_progress`; 409 `not_deployed`; 422 `snapshot_name_invalid`; 409 `snapshot_exists`; host-key shapes (409 `host_key_unknown` `{host, port, key_type, fingerprint}`, 409 `host_key_mismatch`, 502 `connect_failed` `{reason}`).
- `DELETE /snapshots/{id}` (change) → 204. Errors: 404 `snapshot_not_found`; 409 `snapshot_in_use`.
- `GET /environments/{name}/backups` (view) → `{backups: [{name, size_bytes, modified_at}]}`, newest first. Errors: 400 `target_not_configured`; host-key shapes; 502 `connect_failed`.
- `POST /environments` (add) takes `snapshot_id` with mode `new`. Errors: 404 `snapshot_not_found`; 409 `snapshot_not_ready`; 422 `snapshot_not_allowed`.
- `POST /environments/{name}/deployments` (add) body `{mode: "update"|"reset"|"restore_dump", git_ref?, confirm_name?, snapshot_id? (reset only), backup? (restore_dump only)}`. Reset and restore_dump need change + `confirm_name`. An Update of a never-deployed environment with a seed restores the seed. Errors add 422 `snapshot_not_allowed`, 404 `snapshot_not_found`, 409 `snapshot_not_ready`, 422 `backup_invalid`, 409 `not_deployed`.
- `POST /deployments/{id}/rollback` (change) body `{confirm_name}` → 201 `Deployment` (mode `rollback`). Errors: 409 `rollback_unavailable`; 422 `confirm_name_mismatch`; 409 `rollback_not_latest`; 409 `deploy_in_progress`; host-key shapes.
- `POST /deployments/{id}/retry` also retries `restore_dump` and `rollback` (change + `confirm_name`); a `snapshot` job answers 409 `not_retryable`.
- `DeploymentSummary` adds `snapshot: {id, name}|null`, `restore_dump: string|null`, `rollback_available: boolean`; `mode` may be `update|reset|adopt|snapshot|restore_dump|rollback`. `Environment` adds `seed_snapshot: {id, name}|null`.
- Steps (number · key · name): 1 preflight, 2 bootstrap, 3 fetch, 4 render, 5 build, 6 dump, 7 reset, 8 `data` "Start data services", 9 `restore` "Restore snapshot" or `restore_dump` "Restore backup", 10 `up` "Start services", 11 `export` "Take snapshot". Plans: update 1-6,10; seeded first deploy 1-5,8,9,10; reset 1-5,7,10; reset with snapshot 1-5,7,8,9,10; restore_dump 1,8,9,10; rollback 1,3,4,5,8,9,10; snapshot 1,11.

## Global Constraints

- Every new modal gets the report-generate header (eyebrow, title, description) and sizes to its content (a content-matched card width; dropdowns render through `portal` so they aren't clipped).
- Reuse the existing portal and Sirdar idioms (`DataTable`, `ComboBox`, segmented radio groups with `arrowNav`, chips, `.pf-form` with `.field-label`). No raw native `<select>`; the file input is hidden behind a styled button.
- Typed-name gate (the environment's name typed exactly) for Reset, Restore backup and Roll back, as the API requires.
- Don't add reader-facing widgets that weren't asked for.
- American English in all copy; display "Canceled" for the `cancelled` status.
- Component tests start with `// @vitest-environment jsdom`, mock `../../lib/sirdarApi` (spreading the real module) and `@portal/auth/AuthContext` the way the existing environment tests do, set `Element.prototype.scrollIntoView = () => {}` when a ComboBox is used, and use fake timers for polling.
- No new `@portal` import: only `auth/AuthContext`, `components/DataTable`, `components/ComboBox` and `lib/api`, all allowlisted.
- `tsc` type-checks tests too (`noUnusedLocals`, `noUnusedParameters`).
- Web tests: `npm --prefix sirdar/web test`. Type-check and build: `npm --prefix sirdar/web run build`. Never run `npm install` in this worktree (`sirdar/web/node_modules` is a real folder; `portal/node_modules` is a symlink to the main checkout's).
- Work in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`). Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

- Modify `sirdar/web/src/lib/sirdarApi.ts` (+ `sirdarApi.test.ts`) — types (`DeploymentMode`, `SnapshotRef`, `Snapshot`, `Backup`, new fields), seven endpoint functions, messages for every new error code.
- Modify `sirdar/web/src/pages/environments/labels.tsx` (+ `labels.test.ts`) — mode labels, `SNAPSHOT_STATUS`, `GATED_MODES`, `RETRY_MODES`, `formatBytes`, `snapshotLabel`.
- Modify `sirdar/web/src/pages/environments/testData.ts` — step 10, new fields, `SNAP`, `SNAP_TAKING`, `BACKUPS`, `ROLLBACKABLE`, `RESTORE_FAILED`.
- Create `sirdar/web/src/pages/snapshots/UploadSnapshotModal.tsx`, `TakeSnapshotModal.tsx`, `SnapshotsSection.tsx` (+ tests).
- Modify `sirdar/web/src/pages/Deploy.tsx` (+ `Deploy.test.tsx`) — the Snapshots section under Environments.
- Modify `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx` (+ test) — Data step.
- Modify `sirdar/web/src/pages/environments/DeployModal.tsx` (+ test), `EnvOverview.tsx` — Reset with a snapshot; seeded first deploy.
- Create `sirdar/web/src/pages/environments/BackupsTab.tsx`, `RestoreBackupModal.tsx` (+ `BackupsTab.test.tsx`); modify `EnvironmentDetail.tsx` (+ test) — Backups tab.
- Modify `sirdar/web/src/pages/environments/DeploymentView.tsx` (+ test) — Roll back, the new modes' retry and details.
- Modify `sirdar/web/src/styles/sirdar.css`.

---

### Task 1: API client, labels and fixtures

**Files:**
- Modify: `sirdar/web/src/lib/sirdarApi.ts`
- Modify: `sirdar/web/src/pages/environments/labels.tsx`
- Modify: `sirdar/web/src/pages/environments/testData.ts`
- Test: `sirdar/web/src/lib/sirdarApi.test.ts`, `sirdar/web/src/pages/environments/labels.test.ts`

**Interfaces:**
- Produces (`lib/sirdarApi.ts`): `type DeployMode = 'update' | 'reset' | 'restore_dump'`; `type DeploymentMode = DeployMode | 'adopt' | 'snapshot' | 'rollback'`; `interface SnapshotRef { id; name }`; `DeploymentSummary` + `snapshot`, `restore_dump`, `rollback_available`; `Environment` + `seed_snapshot`; `NewEnvironmentBody.snapshot_id?`; `DeploymentBody` + `snapshot_id?`, `backup?`; `type SnapshotStatus`; `interface Snapshot` (= `SnapshotOut`); `interface Backup { name; size_bytes; modified_at }`; functions `rollbackDeployment(id, confirmName)`, `listBackups(name)`, `listSnapshots()`, `uploadSnapshot(file: Blob, name, notes): Promise<Snapshot>`, `takeSnapshot(env, name, notes): Promise<{ snapshot; deployment }>`, `deleteSnapshot(id): Promise<void>`.
- Produces (`labels.tsx`): `MODE_LABEL` for every mode (`snapshot` "Take snapshot", `restore_dump` "Restore backup", `rollback` "Roll back"), `SNAPSHOT_STATUS` chip map (pending "Taking", ready "Ready", failed "Failed"), `GATED_MODES`, `RETRY_MODES`, `formatBytes(n)`, `snapshotLabel(s)`.
- Produces (`testData.ts`): Start services at step 10; `SNAP` (ready upload `s1` "dev-2026-10-04", 552,000,000 bytes, 17,603 files, migration 0089), `SNAP_TAKING` (pending `s2` "uat-2026-10-04", job `d9`), `BACKUPS` (two dumps, newest first), `ROLLBACKABLE` (`d4`, failed at 10 with a dump), `RESTORE_FAILED` (`d5`, restore_dump failed at 9).

- [ ] **Step 1: Write the failing tests**

In `sirdar/web/src/lib/sirdarApi.test.ts`, replace:

```ts
  { name: 'retryDeployment', call: () => sirdar.retryDeployment('d1', { from_step: 3 }),
    path: '/deploy/deployments/d1/retry', method: 'POST', body: { from_step: 3 } },
];
```

with:

```ts
  { name: 'retryDeployment', call: () => sirdar.retryDeployment('d1', { from_step: 3 }),
    path: '/deploy/deployments/d1/retry', method: 'POST', body: { from_step: 3 } },
  { name: 'rollbackDeployment', call: () => sirdar.rollbackDeployment('d1', 'uat'),
    path: '/deploy/deployments/d1/rollback', method: 'POST', body: { confirm_name: 'uat' } },
  { name: 'listBackups', call: () => sirdar.listBackups('uat'), path: '/deploy/environments/uat/backups' },
  { name: 'listSnapshots', call: () => sirdar.listSnapshots(), path: '/deploy/snapshots' },
  { name: 'takeSnapshot', call: () => sirdar.takeSnapshot('uat', 'uat-2026-10-04', 'before uat2'),
    path: '/deploy/environments/uat/snapshots', method: 'POST',
    body: { name: 'uat-2026-10-04', notes: 'before uat2' } },
  { name: 'deleteSnapshot', call: () => sirdar.deleteSnapshot('s 1'), path: '/deploy/snapshots/s%201',
    method: 'DELETE' },
  { name: 'startDeployment (restore a backup)',
    call: () => sirdar.startDeployment('uat', { mode: 'restore_dump', backup: 'x.dump', confirm_name: 'uat' }),
    path: '/deploy/environments/uat/deployments', method: 'POST',
    body: { mode: 'restore_dump', backup: 'x.dump', confirm_name: 'uat' } },
];
```

In `sirdar/web/src/lib/sirdarApi.test.ts`, replace:

```ts
  for (const file of ['api/routes/deploy.py', 'deploy/environments.py', 'deploy/gitref.py',
                       'deploy/ssh_targets.py']) {
    const src = readFileSync(join(root, file), 'utf8');
    for (const re of [/"code": "([a-z_]+)"/g, /(?:EnvError|RefError|TargetError)\("([a-z_]+)"/g,
```

with:

```ts
  for (const file of ['api/routes/deploy.py', 'deploy/environments.py', 'deploy/gitref.py',
                       'deploy/ssh_targets.py', 'deploy/snapshots.py']) {
    const src = readFileSync(join(root, file), 'utf8');
    for (const re of [/"code": "([a-z_]+)"/g, /(?:EnvError|RefError|TargetError|SnapshotError)\("([a-z_]+)"/g,
```

In `sirdar/web/src/lib/sirdarApi.test.ts`, replace:

```ts
  expect(codes).toContain('ref_lookup_failed');
```

with:

```ts
  expect(codes).toContain('ref_lookup_failed');
  expect(codes).toContain('snapshot_in_use');
  expect(codes).toContain('rollback_not_latest');
```

Append to the end of `sirdar/web/src/lib/sirdarApi.test.ts`:

```ts
it('uploadSnapshot streams the file as the body, with the name and notes in the query', async () => {
  const file = new Blob(['bundle-bytes'], { type: 'application/gzip' });
  await sirdar.uploadSnapshot(file, 'dev 2026-10-04', 'from the Mac & co');
  const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(path).toBe('/deploy/snapshots?name=dev+2026-10-04&notes=from+the+Mac+%26+co');
  expect(init.method).toBe('POST');
  expect(init.body).toBe(file);
  expect(init.headers).toEqual({ 'Content-Type': 'application/gzip' });
  fetchMock.mockResolvedValueOnce({ ok: false, status: 413, json: async () => { throw new Error('html'); } });
  await expect(sirdar.uploadSnapshot(file, 'x', '')).rejects.toMatchObject({ status: 413, code: 'http_413' });
  expect(sirdar.errorText(new ApiError(413, 'http_413'), 'x')).toBe('That file is larger than the proxy in front of Sirdar accepts.');
});

it('a bundle problem shows its reason', () => {
  expect(sirdar.deployErrorText(new ApiError(422, 'bundle_invalid', {
    code: 'bundle_invalid', reason: "db.dump doesn't match its checksum in the manifest." }), 'x'))
    .toBe("db.dump doesn't match its checksum in the manifest.");
});
```

In `sirdar/web/src/pages/environments/labels.test.ts`, replace:

```ts
import { DEPLOYMENT_STATUS, STEP_STATUS, duration, sshTargets, stoppedStep } from './labels';
import { FAILED, RUNNING, SUCCEEDED, TARGETS } from './testData';
```

with:

```ts
import {
  DEPLOYMENT_STATUS, MODE_LABEL, STEP_STATUS, duration, formatBytes, snapshotLabel, sshTargets, stoppedStep,
} from './labels';
import { FAILED, RUNNING, SNAP, SUCCEEDED, TARGETS } from './testData';
```

Append to the end of `sirdar/web/src/pages/environments/labels.test.ts`:

```ts
it('formatBytes and snapshotLabel', () => {
  expect(formatBytes(null)).toBe('—');
  expect(formatBytes(512)).toBe('512 bytes');
  expect(formatBytes(1536)).toBe('1.5 KB');
  expect(formatBytes(552_000_000)).toBe('526.4 MB');
  expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  expect(snapshotLabel(SNAP)).toBe('dev-2026-10-04 · mac-dev · migration 0089 · 526.4 MB');
});

it('every deployment mode has a label', () => {
  expect(MODE_LABEL.snapshot).toBe('Take snapshot');
  expect(MODE_LABEL.restore_dump).toBe('Restore backup');
  expect(MODE_LABEL.rollback).toBe('Roll back');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix sirdar/web test -- src/lib/sirdarApi.test.ts src/pages/environments/labels.test.ts`
Expected: FAIL — `sirdar.rollbackDeployment is not a function`, missing messages for `snapshot_in_use` and friends, and `formatBytes`/`SNAP` not exported.

- [ ] **Step 3: Implement the client, labels and fixtures**

In `sirdar/web/src/lib/sirdarApi.ts`, replace:

```ts
  invalid_start_step: "That step isn't part of this deployment.",
};
```

with:

```ts
  invalid_start_step: "That step isn't part of this deployment.",
  // snapshots, backups and rollback
  snapshot_name_invalid: 'Use letters, numbers, dots, hyphens and underscores, starting with a letter or number (up to 64).',
  notes_too_long: 'Keep the notes under 2,000 characters.',
  snapshot_exists: 'A snapshot with that name already exists.',
  snapshot_too_large: 'That file is larger than Sirdar accepts.',
  http_413: 'That file is larger than the proxy in front of Sirdar accepts.',
  bundle_invalid: "That file isn't a snapshot bundle Sirdar can use.",
  snapshots_dir_unwritable: "Sirdar can't write its snapshots folder. It must be owned by uid 10001 with mode 700; see the README.",
  snapshot_keys_unreadable: "This snapshot's keys don't open with this Sirdar's SIRDAR_SECRETS_KEY.",
  snapshot_file_missing: "This snapshot's bundle is missing from Sirdar's snapshots folder.",
  snapshot_not_found: 'That snapshot no longer exists.',
  snapshot_not_ready: "That snapshot isn't ready yet.",
  snapshot_in_use: 'That snapshot is in use: a snapshot job or a deployment is running with it, or an environment that has not deployed yet starts from it.',
  snapshot_not_allowed: 'Only Reset data (or a new environment) can restore a snapshot.',
  not_deployed: "This environment hasn't been deployed yet.",
  backup_invalid: "That isn't one of this environment's backups.",
  rollback_unavailable: "This deployment can't be rolled back: it needs a pre-deploy dump and a commit to go back to.",
  rollback_not_latest: 'Only the most recent deployment can be rolled back.',
};
```

In `sirdar/web/src/lib/sirdarApi.ts`, replace:

```ts
export type DeployMode = 'update' | 'reset';
export type DeploymentStatus
```

with:

```ts
/** Modes POST /environments/{name}/deployments starts. */
export type DeployMode = 'update' | 'reset' | 'restore_dump';
/** Every mode a deployment record can have. */
export type DeploymentMode = DeployMode | 'adopt' | 'snapshot' | 'rollback';
export type DeploymentStatus
```

In `sirdar/web/src/lib/sirdarApi.ts`, replace:

```ts
export interface DeploymentSummary {
  id: string; mode: DeployMode | 'adopt'; git_ref: string; sha: string; status: DeploymentStatus;
  start_step: number; retry_of: string | null; failed_step: number | null; dump_path: string | null;
  previous_sha: string | null; error: string | null; actor_name: string | null;
  started_at: string; finished_at: string | null; created_at: string;
}
```

with:

```ts
export interface SnapshotRef { id: string; name: string }
export interface DeploymentSummary {
  id: string; mode: DeploymentMode; git_ref: string; sha: string; status: DeploymentStatus;
  start_step: number; retry_of: string | null; failed_step: number | null; dump_path: string | null;
  /** The snapshot a reset or first deploy restores, or the one a snapshot job takes. */
  snapshot: SnapshotRef | null;
  /** restore_dump and rollback: the backup's file name in <env-dir>/backups. */
  restore_dump: string | null;
  /** A stopped Update with a pre-deploy dump and a commit to go back to. */
  rollback_available: boolean;
  previous_sha: string | null; error: string | null; actor_name: string | null;
  started_at: string; finished_at: string | null; created_at: string;
}
```

In `sirdar/web/src/lib/sirdarApi.ts`, replace:

```ts
  /** Which optional (write-only) secrets are set. */
  secrets_set: Record<string, boolean>;
  last_deployment
```

with:

```ts
  /** Which optional (write-only) secrets are set. */
  secrets_set: Record<string, boolean>;
  /** The snapshot the first deploy restores (kept afterwards). */
  seed_snapshot: SnapshotRef | null;
  last_deployment
```

In `sirdar/web/src/lib/sirdarApi.ts`, replace:

```ts
export interface NewEnvironmentBody {
  name: string; type: EnvType; target: string; git_ref: string; base_domain?: string;
  proxy_ip: string; bind_ip: string; ports: Record<string, number>;
}
```

with:

```ts
export interface NewEnvironmentBody {
  name: string; type: EnvType; target: string; git_ref: string; base_domain?: string;
  proxy_ip: string; bind_ip: string; ports: Record<string, number>;
  /** The first deploy restores this snapshot. */
  snapshot_id?: string;
}
```

In `sirdar/web/src/lib/sirdarApi.ts`, replace:

```ts
export interface DeploymentBody { mode: DeployMode; git_ref?: string; confirm_name?: string }
export interface RetryBody { from_step?: number; confirm_name?: string }
```

with:

```ts
export interface DeploymentBody {
  mode: DeployMode; git_ref?: string; confirm_name?: string;
  /** Reset only. */
  snapshot_id?: string;
  /** Restore backup only: a file name from listBackups. */
  backup?: string;
}
export interface RetryBody { from_step?: number; confirm_name?: string }
export type SnapshotStatus = 'pending' | 'ready' | 'failed';
export interface Snapshot {
  id: string; name: string; origin: 'upload' | 'environment';
  /** The bundle's source (an environment's name, or what the Mac script was told). */
  source: string; status: SnapshotStatus; alembic_revision: string | null;
  size_bytes: number | null; checksum: string | null; object_count: number | null; object_bytes: number | null;
  notes: string; source_created_at: string | null; created_at: string; created_by_name: string | null;
  /** The snapshot job's deployment (taken snapshots only). */
  deployment_id: string | null;
}
export interface Backup { name: string; size_bytes: number; modified_at: string }
```

In `sirdar/web/src/lib/sirdarApi.ts`, replace:

```ts
export const retryDeployment = (id: string, body: RetryBody) =>
  sendJson<Deployment>('POST', `${depPath(id)}/retry`, body);
```

with:

```ts
export const retryDeployment = (id: string, body: RetryBody) =>
  sendJson<Deployment>('POST', `${depPath(id)}/retry`, body);
export const rollbackDeployment = (id: string, confirmName: string) =>
  sendJson<Deployment>('POST', `${depPath(id)}/rollback`, { confirm_name: confirmName });
export const listBackups = (name: string) => getJson<{ backups: Backup[] }>(`${envPath(name)}/backups`);

export const listSnapshots = () => getJson<{ snapshots: Snapshot[] }>('/deploy/snapshots');
/** The bundle goes up as the raw request body (streamed; no multipart). */
export async function uploadSnapshot(file: Blob, name: string, notes: string): Promise<Snapshot> {
  const params = new URLSearchParams({ name, notes });
  const resp = await apiFetch(`/deploy/snapshots?${params.toString()}`, {
    method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: file,
  });
  if (!resp.ok) throw await errorOf(resp);
  return resp.json();
}
export const takeSnapshot = (env: string, name: string, notes: string) =>
  sendJson<{ snapshot: Snapshot; deployment: Deployment }>('POST', `${envPath(env)}/snapshots`, { name, notes });
export async function deleteSnapshot(id: string): Promise<void> {
  const resp = await apiFetch(`/deploy/snapshots/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorOf(resp);
}
```

In `sirdar/web/src/pages/environments/labels.tsx`, replace:

```tsx
import type { DeployTarget, DeploymentStep } from '../../lib/sirdarApi';
```

with:

```tsx
import type { DeployTarget, DeploymentStep, Snapshot } from '../../lib/sirdarApi';
```

In `sirdar/web/src/pages/environments/labels.tsx`, replace:

```tsx
export const MODE_LABEL: Record<string, string> = { update: 'Update', reset: 'Reset data', adopt: 'Adopt' };
/** Deployment statuses the API retries (pipeline.RETRYABLE_STATUSES). */
export const RETRYABLE = ['failed', 'cancelled', 'interrupted'];
```

with:

```tsx
export const MODE_LABEL: Record<string, string> = {
  update: 'Update', reset: 'Reset data', adopt: 'Adopt', snapshot: 'Take snapshot',
  restore_dump: 'Restore backup', rollback: 'Roll back',
};
export const SNAPSHOT_STATUS: ChipMap = {
  pending: ['c-blue', 'Taking'], ready: ['c-green', 'Ready'], failed: ['c-red', 'Failed'],
};
/** Deployment statuses the API retries (pipeline.RETRYABLE_STATUSES). */
export const RETRYABLE = ['failed', 'cancelled', 'interrupted'];
/** Modes that replace data: they need deploy:change and the environment's name typed back
 *  (the API's GATED_MODES). A snapshot job is never retried. */
export const GATED_MODES = ['reset', 'restore_dump', 'rollback'];
export const RETRY_MODES = ['update', 'reset', 'restore_dump', 'rollback'];

/** 1,536 → "1.5 KB"; null → "—". Binary steps, as the file sizes people see. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const units = ['KB', 'MB', 'GB', 'TB'];
  if (n < 1024) return `${n} bytes`;
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** One line for a snapshot in a picker. */
export const snapshotLabel = (s: Snapshot) =>
  `${s.name} · ${s.source} · migration ${s.alembic_revision ?? '—'} · ${formatBytes(s.size_bytes)}`;
```

In `sirdar/web/src/pages/environments/testData.ts`, replace:

```ts
import type {
  Deployment, DeploymentStatus, DeploymentStep, DeploymentSummary, DeployTarget, Environment,
  EnvironmentDefaults, EnvService, StepStatus,
} from '../../lib/sirdarApi';
```

with:

```ts
import type {
  Backup, Deployment, DeploymentStatus, DeploymentStep, DeploymentSummary, DeployTarget, Environment,
  EnvironmentDefaults, EnvService, Snapshot, StepStatus,
} from '../../lib/sirdarApi';
```

In `sirdar/web/src/pages/environments/testData.ts`, replace:

```ts
  id: 'd0', mode: 'adopt', git_ref: 'main', sha: SHA, status: 'adopted', start_step: 1, retry_of: null,
  failed_step: null, dump_path: null, previous_sha: null, error: null, actor_name: 'Jimmy Henderson',
```

with:

```ts
  id: 'd0', mode: 'adopt', git_ref: 'main', sha: SHA, status: 'adopted', start_step: 1, retry_of: null,
  failed_step: null, dump_path: null, snapshot: null, restore_dump: null, rollback_available: false,
  previous_sha: null, error: null, actor_name: 'Jimmy Henderson',
```

In `sirdar/web/src/pages/environments/testData.ts`, replace:

```ts
  secrets_set: { SS_ANTHROPIC_API_KEY: true, SS_DB_TESTING_PASSWORD: false },
  last_deployment: ADOPTED,
```

with:

```ts
  secrets_set: { SS_ANTHROPIC_API_KEY: true, SS_DB_TESTING_PASSWORD: false },
  seed_snapshot: null, last_deployment: ADOPTED,
```

In `sirdar/web/src/pages/environments/testData.ts`, replace:

```ts
  [4, 'render', 'Render config'], [5, 'build', 'Build images'], [6, 'dump', 'Pre-deploy dump'],
  [8, 'up', 'Start services'],
];
```

with:

```ts
  [4, 'render', 'Render config'], [5, 'build', 'Build images'], [6, 'dump', 'Pre-deploy dump'],
  [10, 'up', 'Start services'],
];
```

In `sirdar/web/src/pages/environments/testData.ts`, replace:

```ts
  [4, 'render', 'Render config'], [5, 'build', 'Build images'], [7, 'reset', 'Reset data'],
  [8, 'up', 'Start services'],
];
```

with:

```ts
  [4, 'render', 'Render config'], [5, 'build', 'Build images'], [7, 'reset', 'Reset data'],
  [10, 'up', 'Start services'],
];
const RESTORE_DUMP_PLAN: [number, string, string][] = [
  [1, 'preflight', 'Preflight'], [8, 'data', 'Start data services'], [9, 'restore_dump', 'Restore backup'],
  [10, 'up', 'Start services'],
];
```

In `sirdar/web/src/pages/environments/testData.ts`, replace:

```ts
    id: 'd1', mode, git_ref: 'main', sha: NEW_SHA, status, start_step: 1, retry_of: null, failed_step: null,
    dump_path: null, previous_sha: SHA, error: null, actor_name: 'Jimmy Henderson',
    started_at: '2026-10-03T13:00:00Z', finished_at: status === 'running' ? null : '2026-10-03T13:10:00Z',
    created_at: '2026-10-03T13:00:00Z', environment: 'uat',
    steps: steps(mode === 'reset' ? RESET_PLAN : UPDATE_PLAN, statuses, logs), ...extra,
```

with:

```ts
    id: 'd1', mode, git_ref: 'main', sha: NEW_SHA, status, start_step: 1, retry_of: null, failed_step: null,
    dump_path: null, snapshot: null, restore_dump: null, rollback_available: false,
    previous_sha: SHA, error: null, actor_name: 'Jimmy Henderson',
    started_at: '2026-10-03T13:00:00Z', finished_at: status === 'running' ? null : '2026-10-03T13:10:00Z',
    created_at: '2026-10-03T13:00:00Z', environment: 'uat',
    steps: steps(mode === 'reset' ? RESET_PLAN : mode === 'restore_dump' ? RESTORE_DUMP_PLAN : UPDATE_PLAN,
                 statuses, logs), ...extra,
```

In `sirdar/web/src/pages/environments/testData.ts`, replace:

```ts
export const RESET_FAILED = deployment('failed', FAILED_AT_5, { 5: 'docker build exited 1\n' },
  { id: 'd3', mode: 'reset', failed_step: 5, error: BUILD_FAILED });
```

with:

```ts
export const RESET_FAILED = deployment('failed', FAILED_AT_5, { 5: 'docker build exited 1\n' },
  { id: 'd3', mode: 'reset', failed_step: 5, error: BUILD_FAILED });
const UP_FAILED: StepStatus[] = ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'failed'];
/** A failed Update that can be rolled back: its dump exists and it has a previous commit. */
export const ROLLBACKABLE = deployment('failed', UP_FAILED, { 10: 'migrate exited 1\n' }, {
  id: 'd4', failed_step: 10, error: 'Step 10 (Start services) failed. See its log.',
  dump_path: '/opt/serversherpa/uat/backups/20261003T130500Z.dump', rollback_available: true,
});
export const RESTORE_FAILED = deployment('failed', ['succeeded', 'succeeded', 'failed', 'not_run'],
  { 9: 'pg_restore failed\n' }, {
    id: 'd5', mode: 'restore_dump', sha: SHA, git_ref: SHA, failed_step: 9, restore_dump: '20261003T130500Z.dump',
    error: 'Step 9 (Restore backup) failed. See its log.',
  });

export const SNAP: Snapshot = {
  id: 's1', name: 'dev-2026-10-04', origin: 'upload', source: 'mac-dev', status: 'ready', alembic_revision: '0089',
  size_bytes: 552_000_000, checksum: 'ab'.repeat(32), object_count: 17_603, object_bytes: 526_000_000,
  notes: 'Seeded from the Mac dev stack', source_created_at: '2026-10-04T11:00:00Z',
  created_at: '2026-10-04T11:30:00Z', created_by_name: 'Jimmy Henderson', deployment_id: null,
};
export const SNAP_TAKING: Snapshot = {
  ...SNAP, id: 's2', name: 'uat-2026-10-04', origin: 'environment', source: 'uat', status: 'pending',
  alembic_revision: null, size_bytes: null, checksum: null, object_count: null, object_bytes: null, notes: '',
  source_created_at: null, created_at: '2026-10-04T12:00:00Z', deployment_id: 'd9',
};
export const BACKUPS: Backup[] = [
  { name: '20261004T010203Z.dump', size_bytes: 2_097_152, modified_at: '2026-10-04T01:02:03Z' },
  { name: '20261003T130500Z.dump', size_bytes: 1_048_576, modified_at: '2026-10-03T13:05:00Z' },
];
```

In `sirdar/web/src/pages/environments/testData.ts`, replace:

```ts
    retry_of: d.retry_of, failed_step: d.failed_step, dump_path: d.dump_path, previous_sha: d.previous_sha,
```

with:

```ts
    retry_of: d.retry_of, failed_step: d.failed_step, dump_path: d.dump_path, snapshot: d.snapshot,
    restore_dump: d.restore_dump, rollback_available: d.rollback_available, previous_sha: d.previous_sha,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: every test passes (the existing ones keep passing with the step-10 fixtures) and the build type-checks.

- [ ] **Step 5: Commit**

```bash
git add sirdar/web/src/lib/sirdarApi.ts sirdar/web/src/lib/sirdarApi.test.ts sirdar/web/src/pages/environments/labels.tsx sirdar/web/src/pages/environments/labels.test.ts sirdar/web/src/pages/environments/testData.ts
git commit -m "feat(sirdar-web): snapshot, backup and rollback API client; labels and fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Upload snapshot modal

**Files:**
- Create: `sirdar/web/src/pages/snapshots/UploadSnapshotModal.tsx`
- Modify: `sirdar/web/src/styles/sirdar.css`
- Test: `sirdar/web/src/pages/snapshots/UploadSnapshotModal.test.tsx`

**Interfaces:**
- Consumes: Task 1 `uploadSnapshot`, `deployErrorText`, `errorDetail`, `formatBytes`, `SNAP`.
- Produces: `default UploadSnapshotModal({ onUploaded(snapshot), onClose })`; exports `SNAPSHOT_NAME_HELP`, `snapshotNameProblem(raw) -> string`, `nameFromFile(fileName) -> string`. CSS: `.sirdar-snapmodal-card`, `.sirdar-snap-form`, `.sirdar-file-pick`.

- [ ] **Step 1: Write the failing test**

Create `sirdar/web/src/pages/snapshots/UploadSnapshotModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ uploadSnapshot: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { SNAP } from '../environments/testData';

import UploadSnapshotModal, { nameFromFile, snapshotNameProblem } from './UploadSnapshotModal';

beforeEach(() => { api.uploadSnapshot.mockReset(); api.uploadSnapshot.mockResolvedValue(SNAP); });
afterEach(cleanup);

function open() {
  const onUploaded = vi.fn();
  const onClose = vi.fn();
  render(<UploadSnapshotModal onUploaded={onUploaded} onClose={onClose} />);
  return { onUploaded, onClose };
}
const bundle = (name = 'seed-20261004T120000Z.tar.gz') =>
  new File([new Uint8Array(1536)], name, { type: 'application/gzip' });
const choose = (file: File) => fireEvent.change(screen.getByTestId('snap-file'), { target: { files: [file] } });
const uploadBtn = () => screen.getByRole('button', { name: /^(Upload|Uploading…)$/ }) as HTMLButtonElement;

it('has the modal header and uploads the chosen file with its name and notes', async () => {
  const { onUploaded } = open();
  expect(screen.getByRole('dialog', { name: 'Upload snapshot' })).toBeTruthy();
  expect(screen.getByText('Snapshots')).toBeTruthy();
  expect(screen.getByText(/scripts\/make-seed-snapshot\.sh/)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: /Choose file/ }));
  expect(uploadBtn().disabled).toBe(true);
  choose(bundle());
  expect(screen.getByText('seed-20261004T120000Z.tar.gz · 1.5 KB')).toBeTruthy();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('seed-20261004T120000Z');
  await userEvent.type(screen.getByLabelText('Notes'), 'From the Mac');
  await userEvent.click(uploadBtn());
  await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(SNAP));
  const [file, name, notes] = api.uploadSnapshot.mock.calls[0];
  expect([(file as File).name, name, notes]).toEqual(['seed-20261004T120000Z.tar.gz', 'seed-20261004T120000Z', 'From the Mac']);
});

it('checks the name before uploading', async () => {
  open();
  choose(bundle());
  await userEvent.clear(screen.getByLabelText('Name'));
  await userEvent.type(screen.getByLabelText('Name'), 'bad name');
  expect(screen.getByRole('alert').textContent).toMatch(/^Use letters, numbers/);
  expect(uploadBtn().disabled).toBe(true);
});

it('shows the server reason, the size cap, and a proxy refusal', async () => {
  open();
  choose(bundle());
  api.uploadSnapshot.mockRejectedValueOnce(new ApiError(422, 'bundle_invalid', {
    code: 'bundle_invalid', reason: "db.dump doesn't match its checksum in the manifest." }));
  await userEvent.click(uploadBtn());
  expect((await screen.findByRole('alert')).textContent).toBe("db.dump doesn't match its checksum in the manifest.");
  api.uploadSnapshot.mockRejectedValueOnce(new ApiError(413, 'snapshot_too_large', {
    code: 'snapshot_too_large', max_bytes: 5 * 1024 ** 3 }));
  await userEvent.click(uploadBtn());
  expect((await screen.findByRole('alert')).textContent)
    .toBe('That file is larger than Sirdar accepts (5.0 GB, SIRDAR_SNAPSHOT_MAX_BYTES).');
  api.uploadSnapshot.mockRejectedValueOnce(new ApiError(413, 'http_413'));
  await userEvent.click(uploadBtn());
  expect((await screen.findByRole('alert')).textContent).toBe('That file is larger than the proxy in front of Sirdar accepts.');
});

it('is locked while uploading: no close, no second upload', async () => {
  let finish: (s: typeof SNAP) => void = () => {};
  api.uploadSnapshot.mockReturnValue(new Promise((r) => { finish = r; }));
  const { onClose } = open();
  choose(bundle());
  await userEvent.click(uploadBtn());
  expect(uploadBtn().textContent).toBe('Uploading…');
  expect(screen.getByRole('status').textContent).toMatch(/Keep this page open/);
  await userEvent.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  finish(SNAP);
  await waitFor(() => expect(uploadBtn().textContent).toBe('Upload'));
  expect(api.uploadSnapshot).toHaveBeenCalledTimes(1);
});

it('helpers', () => {
  expect(nameFromFile('seed-20261004T120000Z.tar.gz')).toBe('seed-20261004T120000Z');
  expect(nameFromFile('my dev (copy).tgz')).toBe('my-dev--copy-');
  expect(snapshotNameProblem('')).toBe('');
  expect(snapshotNameProblem('dev-2026.10_04')).toBe('');
  expect(snapshotNameProblem('-x')).not.toBe('');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix sirdar/web test -- src/pages/snapshots/UploadSnapshotModal.test.tsx`
Expected: FAIL — `Failed to resolve import "./UploadSnapshotModal"`.

- [ ] **Step 3: Implement**

Create `sirdar/web/src/pages/snapshots/UploadSnapshotModal.tsx`:

```tsx
/** Upload a snapshot bundle made by scripts/make-seed-snapshot.sh. The file
 *  goes up as the request body; Sirdar checks every checksum, encrypts the
 *  keys and keeps it. */
import { useEffect, useRef, useState } from 'react';

import { deployErrorText, errorDetail, uploadSnapshot, type Snapshot } from '../../lib/sirdarApi';
import { formatBytes } from '../environments/labels';

export const SNAPSHOT_NAME_HELP = 'Letters, numbers, dots, hyphens and underscores; up to 64 characters.';

/** Mirrors snapshots.NAME_RE; '' when fine (an empty name is the caller's message). */
export function snapshotNameProblem(raw: string): string {
  const n = raw.trim();
  if (!n) return '';
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n)
    ? '' : 'Use letters, numbers, dots, hyphens and underscores, starting with a letter or number (up to 64).';
}

/** "seed-20261004T120000Z.tar.gz" → "seed-20261004T120000Z". */
export function nameFromFile(fileName: string): string {
  return fileName.replace(/\.tar\.gz$|\.tgz$/i, '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
}

export default function UploadSnapshotModal({ onUploaded, onClose }: {
  onUploaded: (snapshot: Snapshot) => void; onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    chooseRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const pick = (f: File | null) => {
    setFile(f);
    setError('');
    if (f && !name.trim()) setName(nameFromFile(f.name));
  };

  const nameError = snapshotNameProblem(name);
  const ready = !!file && !!name.trim() && !nameError && !busy;

  const submit = async () => {
    if (!file || busyRef.current) return;
    if (!name.trim()) { setError('Enter a name.'); return; }
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      onUploaded(await uploadSnapshot(file, name.trim(), notes.trim()));
    } catch (e) {
      const max = errorDetail<{ max_bytes?: number }>(e)?.max_bytes;
      setError(typeof max === 'number'
        ? `That file is larger than Sirdar accepts (${formatBytes(max)}, SIRDAR_SNAPSHOT_MAX_BYTES).`
        : deployErrorText(e, "Couldn't upload the snapshot."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-snapmodal-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-upload-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Snapshots</div>
            <h3 id="sirdar-upload-title">Upload snapshot</h3>
            <p className="page-hint">
              A bundle from scripts/make-seed-snapshot.sh. Sirdar checks it, encrypts its keys and keeps it for
              new environments and Reset data.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form sirdar-snap-form">
          <div>
            <span className="field-label" id="snap-file-label">Bundle</span>
            <div className="sirdar-file-pick">
              <button type="button" ref={chooseRef} className="btn-ghost" disabled={busy}
                      aria-describedby="snap-file-label snap-file-name" onClick={() => fileInput.current?.click()}>
                {file ? 'Choose another file' : 'Choose file…'}
              </button>
              <span id="snap-file-name" className="mono">
                {file ? `${file.name} · ${formatBytes(file.size)}` : 'No file chosen'}
              </span>
              <input ref={fileInput} type="file" accept=".gz,.tgz,application/gzip" hidden data-testid="snap-file"
                     onChange={(e) => pick(e.target.files?.[0] ?? null)} />
            </div>
          </div>
          <div>
            <label className="field-label" htmlFor="snap-name">Name</label>
            <input id="snap-name" type="text" value={name} maxLength={64} autoComplete="off" spellCheck={false}
                   aria-invalid={!!nameError} aria-describedby="snap-name-help" disabled={busy}
                   onChange={(e) => setName(e.target.value)} />
            <p id="snap-name-help" className="page-hint">{SNAPSHOT_NAME_HELP}</p>
            {nameError && <p className="form-error" role="alert">{nameError}</p>}
          </div>
          <div>
            <label className="field-label" htmlFor="snap-notes">Notes</label>
            <textarea id="snap-notes" rows={3} value={notes} maxLength={2000} disabled={busy}
                      onChange={(e) => setNotes(e.target.value)} />
          </div>
          {busy && <p className="page-hint" role="status">Uploading… Keep this page open until it finishes.</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn-solid" disabled={!ready} onClick={() => void submit()}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Append to the end of `sirdar/web/src/styles/sirdar.css`:

```css
/* Snapshots (deploy phase 3): the Upload and Take snapshot modals. */
.modal-card.reports-modal-card.rgm-card.sirdar-snapmodal-card { width: min(600px, 96vw); max-width: 96vw; }
.sirdar-snap-form { display: flex; flex-direction: column; gap: 14px; }
.sirdar-snap-form textarea { width: 100%; resize: vertical; }
.sirdar-file-pick { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix sirdar/web test -- src/pages/snapshots/UploadSnapshotModal.test.tsx && npm --prefix sirdar/web run build`
Expected: `5 passed`; the build type-checks.

- [ ] **Step 5: Commit**

```bash
git add sirdar/web/src/pages/snapshots/UploadSnapshotModal.tsx sirdar/web/src/pages/snapshots/UploadSnapshotModal.test.tsx sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): Upload snapshot modal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Take snapshot modal

**Files:**
- Create: `sirdar/web/src/pages/snapshots/TakeSnapshotModal.tsx`
- Test: `sirdar/web/src/pages/snapshots/TakeSnapshotModal.test.tsx`

**Interfaces:**
- Consumes: Task 1 `takeSnapshot`; Task 2 `SNAPSHOT_NAME_HELP`, `snapshotNameProblem`; `useHostKeyTrust`.
- Produces: `default TakeSnapshotModal({ envs: Environment[], initialEnv?, onStarted({ snapshot, deployment }), onClose })`; `defaultSnapshotName(env, now?) -> "<env>-YYYY-MM-DD"` (local date). An unknown host key shows the trust prompt ("Trust and take snapshot") and replays the same attempt.

- [ ] **Step 1: Write the failing test**

Create `sirdar/web/src/pages/snapshots/TakeSnapshotModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const api = vi.hoisted(() => ({ takeSnapshot: vi.fn(), trustKnownHost: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { ENV, RUNNING, SNAP_TAKING } from '../environments/testData';

import TakeSnapshotModal, { defaultSnapshotName } from './TakeSnapshotModal';

Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
const QA = { ...ENV, id: 'e2', name: 'qa', base_domain: 'qa.serversherpa.com', target: 'ssh:other' };
const TODAY = defaultSnapshotName('uat');
beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.takeSnapshot.mockResolvedValue({ snapshot: SNAP_TAKING, deployment: RUNNING });
});
afterEach(cleanup);

function open(initialEnv?: string) {
  const onStarted = vi.fn();
  const onClose = vi.fn();
  render(<TakeSnapshotModal envs={[ENV, QA]} initialEnv={initialEnv} onStarted={onStarted} onClose={onClose} />);
  return { onStarted, onClose };
}
const takeBtn = () => screen.getByRole('button', { name: /^(Take snapshot|Starting…)$/ }) as HTMLButtonElement;

it('takes a snapshot of the chosen environment with a dated default name', async () => {
  const { onStarted } = open();
  expect(screen.getByRole('dialog', { name: 'Take snapshot' })).toBeTruthy();
  expect(TODAY).toMatch(/^uat-\d{4}-\d{2}-\d{2}$/);
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(TODAY);
  await userEvent.type(screen.getByLabelText('Notes'), 'before uat2');
  await userEvent.click(takeBtn());
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith({ snapshot: SNAP_TAKING, deployment: RUNNING }));
  expect(api.takeSnapshot).toHaveBeenCalledWith('uat', TODAY, 'before uat2');
});

it('picking another environment renames until the name is edited', async () => {
  open();
  await userEvent.click(screen.getByRole('combobox', { name: 'Environment' }));
  await userEvent.click(await screen.findByRole('button', { name: 'qa · qa.serversherpa.com' }));
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(defaultSnapshotName('qa'));
  await userEvent.clear(screen.getByLabelText('Name'));
  await userEvent.type(screen.getByLabelText('Name'), 'mine');
  await userEvent.click(screen.getByRole('combobox', { name: 'Environment' }));
  await userEvent.click(await screen.findByRole('button', { name: 'uat · uat.serversherpa.com' }));
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('mine');
});

it('shows API errors; an unknown host key is trusted and the same attempt replayed', async () => {
  open('qa');
  api.takeSnapshot.mockRejectedValueOnce(new ApiError(409, 'snapshot_exists', { code: 'snapshot_exists' }));
  await userEvent.click(takeBtn());
  expect((await screen.findByRole('alert')).textContent).toBe('A snapshot with that name already exists.');
  api.takeSnapshot.mockRejectedValueOnce(new ApiError(409, 'host_key_unknown', {
    code: 'host_key_unknown', host: '10.10.48.63', port: 22, key_type: 'ssh-rsa', fingerprint: 'SHA256:abc' }));
  api.trustKnownHost.mockResolvedValue({});
  await userEvent.click(takeBtn());
  await userEvent.click(await screen.findByRole('button', { name: 'Trust and take snapshot' }));
  await waitFor(() => expect(api.takeSnapshot).toHaveBeenCalledTimes(3));
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.63', 22, 'SHA256:abc', 'ssh:other');
  expect(api.takeSnapshot.mock.calls[2]).toEqual(api.takeSnapshot.mock.calls[1]);
});

it('says so when nothing has been deployed', () => {
  render(<TakeSnapshotModal envs={[]} onStarted={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByText('No environment has been deployed yet.')).toBeTruthy();
  expect(takeBtn().disabled).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix sirdar/web test -- src/pages/snapshots/TakeSnapshotModal.test.tsx`
Expected: FAIL — `Failed to resolve import "./TakeSnapshotModal"`.

- [ ] **Step 3: Implement**

Create `sirdar/web/src/pages/snapshots/TakeSnapshotModal.tsx`:

```tsx
/** Take a snapshot of a deployed environment: a job on its target dumps the
 *  database and every object, packs them with the environment's keys and
 *  fetches the bundle to Sirdar. The environment keeps running. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import { deployErrorText, takeSnapshot, type Deployment, type Environment, type Snapshot } from '../../lib/sirdarApi';

import { SNAPSHOT_NAME_HELP, snapshotNameProblem } from './UploadSnapshotModal';

type Attempt = { env: string; target: string; name: string; notes: string };

/** "uat-2026-10-04" (the local date). */
export function defaultSnapshotName(env: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${env}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export default function TakeSnapshotModal({ envs, initialEnv, onStarted, onClose }: {
  /** Environments that can be snapshotted (deployed ones). */
  envs: Environment[]; initialEnv?: string;
  onStarted: (result: { snapshot: Snapshot; deployment: Deployment }) => void; onClose: () => void;
}) {
  const { can } = useAuth();
  const first = initialEnv ?? envs[0]?.name ?? '';
  const [env, setEnv] = useState(first);
  const [name, setName] = useState(first ? defaultSnapshotName(first) : '');
  const [nameTouched, setNameTouched] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const hostKey = useHostKeyTrust<Attempt>({
    canTrust: can('deploy', 'change'), trustLabel: 'Trust and take snapshot',
    onTrusted: (attempt) => { void run(attempt); }, onProblem: setError,
  });
  const hostKeyOpen = useRef(false);
  hostKeyOpen.current = hostKey.open;
  const scrimRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { scrimRef.current?.toggleAttribute('inert', hostKey.open); }, [hostKey.open]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current && !hostKeyOpen.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const pickEnv = (v: string) => {
    setEnv(v);
    setError('');
    if (!nameTouched) setName(v ? defaultSnapshotName(v) : '');
  };

  const nameError = snapshotNameProblem(name);
  const ready = !!env && !!name.trim() && !nameError && !busy;

  // Replays exactly the attempt that hit the host-key prompt.
  const run = async (attempt: Attempt) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      onStarted(await takeSnapshot(attempt.env, attempt.name, attempt.notes));
    } catch (e) {
      if (!hostKey.handle(e, attempt.target, attempt)) setError(deployErrorText(e, "Couldn't start the snapshot."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const submit = () => {
    const chosen = envs.find((e) => e.name === env);
    if (!chosen || !name.trim()) return;
    void run({ env: chosen.name, target: chosen.target, name: name.trim(), notes: notes.trim() });
  };

  return (
    <>
      <div className="modal-scrim" ref={scrimRef} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="modal-card reports-modal-card rgm-card sirdar-snapmodal-card" role="dialog" aria-modal="true"
             aria-labelledby="sirdar-take-title">
          <div className="modal-head">
            <div className="rgm-head-text">
              <div className="eyebrow">Snapshots</div>
              <h3 id="sirdar-take-title">Take snapshot</h3>
              <p className="page-hint">
                Copies an environment's database, files and sign-in keys into a snapshot on Sirdar. The environment
                keeps running; you can follow the job's log.
              </p>
            </div>
            <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </div>
          <div className="modal-body pf-form sirdar-snap-form">
            <div>
              <label className="field-label" htmlFor="take-env">Environment</label>
              <ComboBox inputId="take-env" ariaLabel="Environment" portal value={env}
                        placeholder="Choose an environment…"
                        options={envs.map((e) => ({ value: e.name, label: `${e.name} · ${e.base_domain}` }))}
                        onChange={pickEnv} />
              {envs.length === 0 && <p className="page-hint">No environment has been deployed yet.</p>}
            </div>
            <div>
              <label className="field-label" htmlFor="take-name">Name</label>
              <input id="take-name" type="text" value={name} maxLength={64} autoComplete="off" spellCheck={false}
                     aria-invalid={!!nameError} aria-describedby="take-name-help" disabled={busy}
                     onChange={(e) => { setName(e.target.value); setNameTouched(true); }} />
              <p id="take-name-help" className="page-hint">{SNAPSHOT_NAME_HELP}</p>
              {nameError && <p className="form-error" role="alert">{nameError}</p>}
            </div>
            <div>
              <label className="field-label" htmlFor="take-notes">Notes</label>
              <textarea id="take-notes" rows={3} value={notes} maxLength={2000} disabled={busy}
                        onChange={(e) => setNotes(e.target.value)} />
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="btn-solid" disabled={!ready} onClick={submit}>
              {busy ? 'Starting…' : 'Take snapshot'}
            </button>
          </div>
        </div>
      </div>
      {hostKey.modal}
    </>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix sirdar/web test -- src/pages/snapshots && npm --prefix sirdar/web run build`
Expected: `9 passed` (both modal files); the build type-checks.

- [ ] **Step 5: Commit**

```bash
git add sirdar/web/src/pages/snapshots/TakeSnapshotModal.tsx sirdar/web/src/pages/snapshots/TakeSnapshotModal.test.tsx
git commit -m "feat(sirdar-web): Take snapshot modal with host-key trust

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Snapshots section on /deploy

**Files:**
- Create: `sirdar/web/src/pages/snapshots/SnapshotsSection.tsx`
- Modify: `sirdar/web/src/pages/Deploy.tsx`
- Test: `sirdar/web/src/pages/snapshots/SnapshotsSection.test.tsx`, `sirdar/web/src/pages/Deploy.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–3 (`listSnapshots`, `deleteSnapshot`, `listEnvironments`, `SNAPSHOT_STATUS`, `formatBytes`, `when`, both modals).
- Produces: `default SnapshotsSection()` (no props) and `SNAPSHOTS_POLL_MS = 5000`: a DataTable "Snapshots" (Name + notes, Source — `Upload · <source>` for uploads, Created, Migration, Size, Files, Status, Delete); a pending snapshot links "View the job" to `/deploy/environments/<source>?deployment=<deployment_id>` and the list reloads every 5 s while one is pending; Upload and Take snapshot need `deploy:add`, Delete needs `deploy:change` and a `window.confirm`; Take snapshot offers deployed environments only (`current_sha !== null`) and opens the job's page when it starts.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/pages/snapshots/SnapshotsSection.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
  }),
}));
const api = vi.hoisted(() => ({ listSnapshots: vi.fn(), deleteSnapshot: vi.fn(), listEnvironments: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));
vi.mock('./UploadSnapshotModal', () => ({
  default: ({ onUploaded, onClose }: { onUploaded: (s: unknown) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="Upload snapshot">
      <button type="button" onClick={() => onUploaded({})}>fake upload</button>
      <button type="button" onClick={onClose}>fake close</button>
    </div>
  ),
}));
vi.mock('./TakeSnapshotModal', () => ({
  default: ({ envs, onStarted }: { envs: { name: string }[]; onStarted: (r: unknown) => void }) => (
    <div role="dialog" aria-label="Take snapshot">
      <span>{envs.map((e) => e.name).join(',')}</span>
      <button type="button" onClick={() => onStarted({ snapshot: {}, deployment: { id: 'd9', environment: 'uat' } })}>
        fake take</button>
    </div>
  ),
}));

import { ApiError } from '@portal/lib/api';

import { ENV, SNAP, SNAP_TAKING } from '../environments/testData';

import SnapshotsSection, { SNAPSHOTS_POLL_MS } from './SnapshotsSection';

beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.listSnapshots.mockResolvedValue({ snapshots: [SNAP] });
  api.deleteSnapshot.mockResolvedValue(undefined);
  api.listEnvironments.mockResolvedValue({ environments: [ENV, { ...ENV, id: 'e2', name: 'fresh', current_sha: null }] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function Where() {
  const loc = useLocation();
  return <p>at {loc.pathname}{loc.search}</p>;
}
function show() {
  return render(
    <MemoryRouter initialEntries={['/deploy']}>
      <Routes>
        <Route path="/deploy" element={<SnapshotsSection />} />
        <Route path="/deploy/environments/:name" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

it('lists snapshots with source, migration, size, files and status', async () => {
  show();
  const table = await screen.findByRole('table', { name: 'Snapshots' });
  expect(within(table).getByText('dev-2026-10-04')).toBeTruthy();
  expect(within(table).getByText('Seeded from the Mac dev stack')).toBeTruthy();
  expect(within(table).getByText('Upload · mac-dev')).toBeTruthy();
  expect(within(table).getByText('0089')).toBeTruthy();
  expect(within(table).getByText('526.4 MB')).toBeTruthy();
  expect(within(table).getByText('17,603')).toBeTruthy();
  expect(within(table).getByText('Ready')).toBeTruthy();
});

it('a snapshot being taken links to its job, and the list reloads until it is done', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.listSnapshots.mockResolvedValueOnce({ snapshots: [SNAP_TAKING, SNAP] })
    .mockResolvedValue({ snapshots: [{ ...SNAP_TAKING, status: 'ready', alembic_revision: '0089' }, SNAP] });
  show();
  const link = await screen.findByRole('link', { name: 'View the job' });
  expect(link.getAttribute('href')).toBe('/deploy/environments/uat?deployment=d9');
  expect(screen.getByText('Taking')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Delete uat-2026-10-04' })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOTS_POLL_MS); });
  await waitFor(() => expect(screen.queryByText('Taking')).toBeNull());
  await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOTS_POLL_MS * 3); });
  expect(api.listSnapshots).toHaveBeenCalledTimes(2);
});

it('deletes after a confirmation', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Delete dev-2026-10-04' }));
  expect(api.deleteSnapshot).not.toHaveBeenCalled();
  api.listSnapshots.mockResolvedValue({ snapshots: [] });
  await userEvent.click(screen.getByRole('button', { name: 'Delete dev-2026-10-04' }));
  expect(confirm.mock.calls[1][0]).toBe(
    "Delete the snapshot dev-2026-10-04? Its bundle is removed from Sirdar. This can't be undone.");
  expect(await screen.findByText('No snapshots yet.')).toBeTruthy();
  expect(api.deleteSnapshot).toHaveBeenCalledWith('s1');
});

it('a refused delete says why', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.deleteSnapshot.mockRejectedValue(new ApiError(409, 'snapshot_in_use', { code: 'snapshot_in_use' }));
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Delete dev-2026-10-04' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/^That snapshot is in use/);
});

it('Upload reloads the list; Take snapshot offers deployed environments and opens the job', async () => {
  show();
  await screen.findByText('dev-2026-10-04');
  await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
  await userEvent.click(within(screen.getByRole('dialog', { name: 'Upload snapshot' })).getByRole('button', { name: 'fake upload' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(api.listSnapshots).toHaveBeenCalledTimes(2));
  await userEvent.click(screen.getByRole('button', { name: 'Take snapshot' }));
  const take = await screen.findByRole('dialog', { name: 'Take snapshot' });
  expect(within(take).getByText('uat')).toBeTruthy();                 // "fresh" was never deployed
  await userEvent.click(within(take).getByRole('button', { name: 'fake take' }));
  expect(await screen.findByText('at /deploy/environments/uat?deployment=d9')).toBeTruthy();
});

it('view-only: no Upload, Take snapshot or Delete', async () => {
  perms.add = false; perms.change = false;
  show();
  await screen.findByText('dev-2026-10-04');
  expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Take snapshot' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
});
```

In `sirdar/web/src/pages/Deploy.test.tsx`, replace:

```tsx
  listEnvironments: vi.fn(),
}));
```

with:

```tsx
  listEnvironments: vi.fn(), listSnapshots: vi.fn(),
}));
```

In `sirdar/web/src/pages/Deploy.test.tsx`, replace:

```tsx
  api.listEnvironments.mockResolvedValue({ environments: [] });
});
```

with:

```tsx
  api.listEnvironments.mockResolvedValue({ environments: [] });
  api.listSnapshots.mockResolvedValue({ snapshots: [] });
});
```

Append to the end of `sirdar/web/src/pages/Deploy.test.tsx`:

```tsx
it('shows the Snapshots section under Environments', async () => {
  await ready();
  const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  expect(headings.slice(0, 2)).toEqual(['Environments', 'Snapshots']);
  expect(await screen.findByText('No snapshots yet.')).toBeTruthy();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/snapshots/SnapshotsSection.test.tsx src/pages/Deploy.test.tsx`
Expected: FAIL — `Failed to resolve import "./SnapshotsSection"`, and the Deploy page has no "Snapshots" heading.

- [ ] **Step 3: Implement**

Create `sirdar/web/src/pages/snapshots/SnapshotsSection.tsx`:

```tsx
/** The Snapshots section on /deploy: every snapshot, Upload, Take snapshot
 *  and Delete. A snapshot being taken links to its job and the list reloads
 *  until it ends. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';

import {
  deleteSnapshot, errorText, listEnvironments, listSnapshots, type Environment, type Snapshot,
} from '../../lib/sirdarApi';
import { SNAPSHOT_STATUS, StatusChip, formatBytes, when } from '../environments/labels';

import TakeSnapshotModal from './TakeSnapshotModal';
import UploadSnapshotModal from './UploadSnapshotModal';

/** While a snapshot is being taken the list reloads this often. */
export const SNAPSHOTS_POLL_MS = 5000;

export default function SnapshotsSection() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [taking, setTaking] = useState<Environment[] | null>(null);
  const seq = useRef(0);

  // Only the newest request's answer lands; nothing lands after unmount.
  const load = useCallback(() => {
    const n = ++seq.current;
    return listSnapshots()
      .then((r) => { if (n === seq.current) { setRows(r.snapshots); setError(''); } })
      .catch((e) => { if (n === seq.current) setError(errorText(e, "Couldn't load snapshots.")); });
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { seq.current += 1; }, []);
  const pending = !!rows?.some((s) => s.status === 'pending');
  useEffect(() => {
    if (!pending) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => { void load().finally(() => { if (live) schedule(); }); }, SNAPSHOTS_POLL_MS);
    };
    schedule();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [pending, load]);

  const openTake = async () => {
    try {
      const r = await listEnvironments();
      setTaking(r.environments.filter((e) => e.current_sha !== null));
    } catch (e) { setError(errorText(e, "Couldn't load environments.")); }
  };

  const remove = async (s: Snapshot) => {
    if (!window.confirm(`Delete the snapshot ${s.name}? Its bundle is removed from Sirdar. This can't be undone.`)) return;
    try {
      await deleteSnapshot(s.id);
      await load();
    } catch (e) { setError(errorText(e, "Couldn't delete that snapshot.")); }
  };

  const status = (s: Snapshot) => (s.status === 'pending' && s.deployment_id
    ? <><StatusChip map={SNAPSHOT_STATUS} status={s.status} />{' '}
        <Link to={`/deploy/environments/${encodeURIComponent(s.source)}?deployment=${encodeURIComponent(s.deployment_id)}`}>
          View the job</Link></>
    : <StatusChip map={SNAPSHOT_STATUS} status={s.status} />);

  return (
    <section className="sirdar-section">
      <div className="sirdar-section-head">
        <h2>Snapshots</h2>
        {can('deploy', 'add') && (
          <div className="sirdar-target-actions">
            <button type="button" className="btn-ghost" onClick={() => void openTake()}>Take snapshot</button>
            <button type="button" className="btn-solid" onClick={() => setUploading(true)}>Upload</button>
          </div>
        )}
      </div>
      <p className="page-hint">
        A snapshot holds an environment's database, its files and the keys its users sign in with. New
        environments and Reset data can start from one.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <DataTable
        ariaLabel="Snapshots"
        columns={[
          { key: 'name', label: 'Name' }, { key: 'source', label: 'Source' }, { key: 'created', label: 'Created', mono: true },
          { key: 'rev', label: 'Migration', mono: true }, { key: 'size', label: 'Size' }, { key: 'objects', label: 'Files' },
          { key: 'status', label: 'Status' }, { key: 'act', label: '', align: 'right' },
        ]}
        rows={(rows ?? []).map((s) => ({
          key: s.id,
          cells: [
            <><b className="cell-top">{s.name}</b>{s.notes && <div className="cell-sub">{s.notes}</div>}</>,
            s.origin === 'upload' ? `Upload · ${s.source}` : s.source,
            when(s.created_at),
            s.alembic_revision ?? '—',
            formatBytes(s.size_bytes),
            s.object_count === null ? '—' : s.object_count.toLocaleString(),
            status(s),
            can('deploy', 'change') && s.status !== 'pending'
              ? <button type="button" className="mini-btn" aria-label={`Delete ${s.name}`}
                        onClick={() => void remove(s)}>Delete</button>
              : '',
          ],
        }))}
        emptyText={rows === null ? 'Loading…' : 'No snapshots yet.'}
      />
      {uploading && (
        <UploadSnapshotModal onUploaded={() => { setUploading(false); void load(); }}
                             onClose={() => setUploading(false)} />
      )}
      {taking && (
        <TakeSnapshotModal envs={taking} onClose={() => setTaking(null)}
                           onStarted={({ deployment }) => {
                             setTaking(null);
                             navigate(`/deploy/environments/${encodeURIComponent(deployment.environment)}`
                                      + `?deployment=${encodeURIComponent(deployment.id)}`);
                           }} />
      )}
    </section>
  );
}
```

In `sirdar/web/src/pages/Deploy.tsx`, replace:

```tsx
import EnvironmentsSection from './environments/EnvironmentsSection';
```

with:

```tsx
import EnvironmentsSection from './environments/EnvironmentsSection';
import SnapshotsSection from './snapshots/SnapshotsSection';
```

In `sirdar/web/src/pages/Deploy.tsx`, replace:

```tsx
      <EnvironmentsSection targets={targets} />
```

with:

```tsx
      <EnvironmentsSection targets={targets} />
      <SnapshotsSection />
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: every test passes (`SnapshotsSection.test.tsx`: 6); the build type-checks.

- [ ] **Step 5: Commit**

```bash
git add sirdar/web/src/pages/snapshots/SnapshotsSection.tsx sirdar/web/src/pages/snapshots/SnapshotsSection.test.tsx sirdar/web/src/pages/Deploy.tsx sirdar/web/src/pages/Deploy.test.tsx
git commit -m "feat(sirdar-web): Snapshots section on /deploy (list, upload, take, delete)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: New environment — the Data step

**Files:**
- Modify: `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`
- Test: `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx`

**Interfaces:**
- Consumes: Task 1 `listSnapshots`, `snapshotLabel`, `NewEnvironmentBody.snapshot_id`.
- Produces: Create's steps are Basics › Services › Data › Review. Data is a segmented "Start empty" / "From a snapshot" (locked when no snapshot is ready) with a Snapshot ComboBox of ready snapshots; Review shows "Data: Empty" or "Snapshot <name> (migration <rev>), restored by the first deploy"; the create body carries `snapshot_id`. `snapshot_not_found` / `snapshot_not_ready` errors land on the Data step. Snapshots are loaded with the targets and defaults; a failure to load them just leaves "Start empty".

- [ ] **Step 1: Write the failing tests**

In `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx`, replace:

```tsx
  adoptEnvironment: vi.fn(), trustKnownHost: vi.fn(),
}));
```

with:

```tsx
  adoptEnvironment: vi.fn(), trustKnownHost: vi.fn(), listSnapshots: vi.fn(),
}));
```

In `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx`, replace:

```tsx
import { DEFAULTS, ENV, TARGETS } from './testData';
```

with:

```tsx
import { DEFAULTS, ENV, SNAP, SNAP_TAKING, TARGETS } from './testData';
```

In `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx`, replace:

```tsx
  api.createEnvironment.mockResolvedValue(ENV);
});
```

with:

```tsx
  api.createEnvironment.mockResolvedValue(ENV);
  api.listSnapshots.mockResolvedValue({ snapshots: [SNAP, SNAP_TAKING] });
});
```

In `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx`, replace:

```tsx
  expect(['Basics', 'Services', 'Review'].every((s) => screen.getByText(s))).toBe(true);
```

with:

```tsx
  expect(['Basics', 'Services', 'Data', 'Review'].every((s) => screen.getByText(s))).toBe(true);
```

In `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx`, replace:

```tsx
  await userEvent.type(apiPort, '8100');
  await next();
  expect(screen.getByText('/opt/serversherpa/qa')).toBeTruthy();
```

with:

```tsx
  await userEvent.type(apiPort, '8100');
  await next();
  expect(screen.getByRole('radio', { name: 'Start empty' }).getAttribute('aria-checked')).toBe('true');
  await next();
  expect(screen.getByText('/opt/serversherpa/qa')).toBeTruthy();
  expect(screen.getByText('Empty')).toBeTruthy();
```

In `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx`, replace (it appears 3 times; replace every one):

```tsx
  await next();
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
```

with:

```tsx
  await next();
  await next();
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
```

Append to the end of `sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx`:

```tsx
it('Data: a new environment can start from a ready snapshot', async () => {
  const { onCreated } = await open();
  await fillBasics();
  await next();
  await next();
  expect(screen.getByText(/starts an empty database/)).toBeTruthy();
  await userEvent.click(screen.getByRole('radio', { name: 'From a snapshot' }));
  expect(screen.getByText(/restores the snapshot's database and files/)).toBeTruthy();
  await next();
  expect(screen.getByText('Choose a snapshot.')).toBeTruthy();
  await userEvent.click(screen.getByRole('combobox', { name: 'Snapshot' }));
  expect(screen.queryByRole('button', { name: /uat-2026-10-04/ })).toBeNull();      // still being taken
  await userEvent.click(await screen.findByRole('button', { name: 'dev-2026-10-04 · mac-dev · migration 0089 · 526.4 MB' }));
  await next();
  expect(screen.getByText('Snapshot dev-2026-10-04 (migration 0089), restored by the first deploy')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(ENV));
  expect(api.createEnvironment.mock.calls[0][0].snapshot_id).toBe('s1');
});

it('Data: with no snapshot only Start empty is offered, and a gone snapshot sends you back to Data', async () => {
  api.listSnapshots.mockResolvedValue({ snapshots: [] });
  await open();
  await fillBasics();
  await next();
  await next();
  const fromSnap = screen.getByRole('radio', { name: 'From a snapshot' });
  expect(fromSnap.getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByText(/No snapshot yet/)).toBeTruthy();
  cleanup();
  api.listSnapshots.mockResolvedValue({ snapshots: [SNAP] });
  api.createEnvironment.mockRejectedValue(new ApiError(404, 'snapshot_not_found', { code: 'snapshot_not_found' }));
  await open();
  await fillBasics();
  await next();
  await next();
  await userEvent.click(screen.getByRole('radio', { name: 'From a snapshot' }));
  await userEvent.click(screen.getByRole('combobox', { name: 'Snapshot' }));
  await userEvent.click(await screen.findByRole('button', { name: /^dev-2026-10-04/ }));
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  expect(await screen.findByText('That snapshot no longer exists.')).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'Snapshot' })).toBeTruthy();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments/NewEnvironmentModal.test.tsx`
Expected: FAIL — no "Data" step, and the third `Next` lands nowhere ("Create environment" not found).

- [ ] **Step 3: Implement**

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, replace:

```tsx
/** New environment: Create (Basics › Services › Review) makes a new
 *  environment record with generated secrets; Adopt (Basics › Result) reads a
 *  hand-built environment's .env and checkout over SSH and changes nothing. */
```

with:

```tsx
/** New environment: Create (Basics › Services › Data › Review) makes a new
 *  environment record with generated secrets, empty or seeded from a snapshot
 *  its first deploy restores; Adopt (Basics › Result) reads a hand-built
 *  environment's .env and checkout over SSH and changes nothing. */
```

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, replace:

```tsx
import {
  adoptEnvironment, createEnvironment, deployErrorText, getDeployTargets, getEnvironmentDefaults,
  type AdoptEnvironmentBody, type AdoptedEnvironment, type DeployTarget, type EnvType, type Environment,
  type EnvironmentDefaults, type NewEnvironmentBody,
} from '../../lib/sirdarApi';

import { TYPE_LABEL, sshTargets } from './labels';

type Mode = 'new' | 'adopt';
type Step = 'basics' | 'services' | 'review' | 'result';
type Field = 'name' | 'target' | 'ref' | 'domain' | 'proxy' | 'bind' | 'services' | 'form';
```

with:

```tsx
import {
  adoptEnvironment, createEnvironment, deployErrorText, getDeployTargets, getEnvironmentDefaults, listSnapshots,
  type AdoptEnvironmentBody, type AdoptedEnvironment, type DeployTarget, type EnvType, type Environment,
  type EnvironmentDefaults, type NewEnvironmentBody, type Snapshot,
} from '../../lib/sirdarApi';

import { TYPE_LABEL, snapshotLabel, sshTargets } from './labels';

type Mode = 'new' | 'adopt';
type Step = 'basics' | 'services' | 'data' | 'review' | 'result';
type DataMode = 'empty' | 'snapshot';
type Field = 'name' | 'target' | 'ref' | 'domain' | 'proxy' | 'bind' | 'services' | 'data' | 'form';
```

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, replace:

```tsx
const STEPS: Record<Mode, [Step, string][]> = {
  new: [['basics', 'Basics'], ['services', 'Services'], ['review', 'Review']],
  adopt: [['basics', 'Basics'], ['result', 'Result']],
};
```

with:

```tsx
const STEPS: Record<Mode, [Step, string][]> = {
  new: [['basics', 'Basics'], ['services', 'Services'], ['data', 'Data'], ['review', 'Review']],
  adopt: [['basics', 'Basics'], ['result', 'Result']],
};
const DATA_MODES: [DataMode, string][] = [['empty', 'Start empty'], ['snapshot', 'From a snapshot']];
```

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, replace:

```tsx
  bind_ip_invalid: 'bind', port_invalid: 'services', ports_conflict: 'services', service_unknown: 'services',
};
```

with:

```tsx
  bind_ip_invalid: 'bind', port_invalid: 'services', ports_conflict: 'services', service_unknown: 'services',
  snapshot_not_found: 'data', snapshot_not_ready: 'data',
};
```

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, replace:

```tsx
  const [ports, setPorts] = useState<Record<string, string>>({});
```

with:

```tsx
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [dataMode, setDataMode] = useState<DataMode>('empty');
  const [snapshotId, setSnapshotId] = useState('');
```

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, replace:

```tsx
    Promise.all([getDeployTargets(), getEnvironmentDefaults()]).then(([t, d]) => {
      if (!live) return;
```

with:

```tsx
    // Snapshots are optional: without them the Data step offers "Start empty" only.
    const snaps = listSnapshots().then((r) => r.snapshots.filter((s) => s.status === 'ready'))
      .catch(() => [] as Snapshot[]);
    Promise.all([getDeployTargets(), getEnvironmentDefaults(), snaps]).then(([t, d, ready]) => {
      if (!live) return;
      setSnapshots(ready);
```

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, replace:

```tsx
  const next = () => {
    const e = step === 'basics' ? basicsErrors() : servicesErrors();
    setErrors(e);
    if (Object.keys(e).length) return;
    setStep(step === 'basics' ? 'services' : 'review');
  };
  const back = () => { setErrors({}); setStep(step === 'review' ? 'services' : 'basics'); };
```

with:

```tsx
  const dataErrors = (): Errors => (dataMode === 'snapshot' && !snapshotId ? { data: 'Choose a snapshot.' } : {});
  const chosen = snapshots.find((s) => s.id === snapshotId);

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

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, replace:

```tsx
    if (field === 'services') setStep('services');
    else if (field !== 'form') setStep('basics');
```

with:

```tsx
    if (field === 'services' || field === 'data') setStep(field);
    else if (field !== 'form') setStep('basics');
```

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, replace:

```tsx
      ports: Object.fromEntries(services.map((s) => [s.service, Number(ports[s.service])])),
    } });
```

with:

```tsx
      ports: Object.fromEntries(services.map((s) => [s.service, Number(ports[s.service])])),
      ...(dataMode === 'snapshot' && snapshotId ? { snapshot_id: snapshotId } : {}),
    } });
```

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, replace:

```tsx
            {defaults && step === 'review' && (
```

with:

```tsx
            {defaults && step === 'data' && (
              <div className="sirdar-env-grid">
                <div className="sirdar-span2">
                  <span className="field-label" id="env-data-label">Data</span>
                  <div className="segmented" role="radiogroup" aria-labelledby="env-data-label">
                    {DATA_MODES.map(([m, label]) => {
                      const locked = m === 'snapshot' && snapshots.length === 0;
                      return (
                        <button key={m} type="button" role="radio" aria-checked={dataMode === m} aria-disabled={locked}
                                className={dataMode === m ? 'on' : ''} tabIndex={dataMode === m ? 0 : -1}
                                onKeyDown={arrowNav}
                                onClick={() => { if (!locked) { setDataMode(m); setErrors({}); } }}>{label}</button>
                      );
                    })}
                  </div>
                  <p className="page-hint">
                    {dataMode === 'empty'
                      ? 'The first deploy starts an empty database; create its first admin afterwards.'
                      : "The first deploy restores the snapshot's database and files. Its users sign in with their own passwords and 2FA."}
                  </p>
                  {snapshots.length === 0 && (
                    <p className="page-hint">No snapshot yet. Upload one or take one in Snapshots on the Deploy page.</p>
                  )}
                </div>
                {dataMode === 'snapshot' && (
                  <div className="sirdar-span2">
                    <label className="field-label" htmlFor="env-new-snapshot">Snapshot</label>
                    <ComboBox inputId="env-new-snapshot" ariaLabel="Snapshot" portal value={snapshotId}
                              placeholder="Choose a snapshot…"
                              options={snapshots.map((s) => ({ value: s.id, label: snapshotLabel(s) }))}
                              onChange={(v) => { setSnapshotId(v); setErrors({}); }} />
                    {errors.data && <p className="form-error" role="alert">{errors.data}</p>}
                  </div>
                )}
              </div>
            )}

            {defaults && step === 'review' && (
```

In `sirdar/web/src/pages/environments/NewEnvironmentModal.tsx`, replace:

```tsx
                  <dt>Secrets</dt><dd>Generated by Sirdar and never shown</dd>
```

with:

```tsx
                  <dt>Secrets</dt><dd>Generated by Sirdar and never shown</dd>
                  <dt>Data</dt>
                  <dd>{chosen ? `Snapshot ${chosen.name} (migration ${chosen.alembic_revision ?? '—'}), restored by the first deploy` : 'Empty'}</dd>
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm --prefix sirdar/web test -- src/pages/environments/NewEnvironmentModal.test.tsx && npm --prefix sirdar/web run build`
Expected: `15 passed`; the build type-checks.

- [ ] **Step 5: Commit**

```bash
git add sirdar/web/src/pages/environments/NewEnvironmentModal.tsx sirdar/web/src/pages/environments/NewEnvironmentModal.test.tsx
git commit -m "feat(sirdar-web): New environment Data step (start empty or from a snapshot)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Deploy modal — Reset with a snapshot, seeded first deploy

**Files:**
- Modify: `sirdar/web/src/pages/environments/DeployModal.tsx`, `sirdar/web/src/pages/environments/EnvOverview.tsx`, `sirdar/web/src/styles/sirdar.css`
- Test: `sirdar/web/src/pages/environments/DeployModal.test.tsx`, `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`

**Interfaces:**
- Consumes: Task 1 `listSnapshots`, `snapshotLabel`, `Environment.seed_snapshot`, `DeploymentBody.snapshot_id`.
- Produces: under Reset data, "After the reset": "Start empty" / "From a snapshot" (+ Snapshot ComboBox; the button reads "Reset and restore"; locked with "No snapshot is ready, so it starts empty." when none is ready); a reset body carries `snapshot_id` only when one is chosen; an Update of a never-deployed seeded environment says "This first deploy restores the snapshot <name>…"; the Overview shows "Seed snapshot" (with "(the first deploy restores it)" before the first deploy). CSS `.sirdar-sub-label`.

- [ ] **Step 1: Write the failing tests**

In `sirdar/web/src/pages/environments/DeployModal.test.tsx`, replace:

```tsx
const api = vi.hoisted(() => ({ startDeployment: vi.fn(), trustKnownHost: vi.fn() }));
```

with:

```tsx
const api = vi.hoisted(() => ({ startDeployment: vi.fn(), trustKnownHost: vi.fn(), listSnapshots: vi.fn() }));
```

In `sirdar/web/src/pages/environments/DeployModal.test.tsx`, replace:

```tsx
import { ENV, RUNNING } from './testData';
```

with:

```tsx
import { ENV, RUNNING, SNAP, SNAP_TAKING } from './testData';
```

In `sirdar/web/src/pages/environments/DeployModal.test.tsx`, replace:

```tsx
  api.startDeployment.mockResolvedValue(RUNNING);
});
```

with:

```tsx
  api.startDeployment.mockResolvedValue(RUNNING);
  api.listSnapshots.mockResolvedValue({ snapshots: [SNAP, SNAP_TAKING] });
});
Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
```

In `sirdar/web/src/pages/environments/DeployModal.test.tsx`, replace:

```tsx
const deployBtn = () => screen.getByRole('button', { name: /^(Deploy|Reset and deploy|Starting…)$/ }) as HTMLButtonElement;
```

with:

```tsx
const deployBtn = () =>
  screen.getByRole('button', { name: /^(Deploy|Reset and deploy|Reset and restore|Starting…)$/ }) as HTMLButtonElement;
```

Append to the end of `sirdar/web/src/pages/environments/DeployModal.test.tsx`:

```tsx
it('Reset data can restore a ready snapshot after the reset', async () => {
  const { onStarted } = open();
  await userEvent.click(screen.getByRole('radio', { name: 'Reset data' }));
  expect(screen.getByRole('radio', { name: 'Start empty' }).getAttribute('aria-checked')).toBe('true');
  await userEvent.click(screen.getByRole('radio', { name: 'From a snapshot' }));
  expect(deployBtn().textContent).toBe('Reset and restore');
  await userEvent.type(screen.getByLabelText('Type uat to confirm'), 'uat');
  expect(deployBtn().disabled).toBe(true);                     // no snapshot chosen yet
  await userEvent.click(screen.getByRole('combobox', { name: 'Snapshot' }));
  expect(screen.queryByRole('button', { name: /uat-2026-10-04/ })).toBeNull();
  await userEvent.click(await screen.findByRole('button', { name: /^dev-2026-10-04/ }));
  expect(screen.getByText(/Everyone signed in here now is signed out/)).toBeTruthy();
  await userEvent.click(deployBtn());
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
  expect(api.startDeployment).toHaveBeenCalledWith('uat', {
    mode: 'reset', git_ref: 'main', confirm_name: 'uat', snapshot_id: 's1' });
});

it('without a ready snapshot Reset data starts empty only', async () => {
  api.listSnapshots.mockResolvedValue({ snapshots: [] });
  open();
  await userEvent.click(screen.getByRole('radio', { name: 'Reset data' }));
  expect(screen.getByRole('radio', { name: 'From a snapshot' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByText('No snapshot is ready, so it starts empty.')).toBeTruthy();
});

it("a seeded environment's first deploy says it restores the snapshot", async () => {
  open({ ...ENV, current_sha: null, status: 'new', seed_snapshot: { id: 's1', name: 'dev-2026-10-04' } });
  expect(await screen.findByText(/This first deploy restores the snapshot/)).toBeTruthy();
  expect(screen.getByText('dev-2026-10-04', { selector: 'b' })).toBeTruthy();
  cleanup();
  open({ ...ENV, seed_snapshot: { id: 's1', name: 'dev-2026-10-04' } });    // deployed already
  expect(screen.queryByText(/This first deploy restores/)).toBeNull();
});
```

In `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`, replace:

```tsx
  listDeployments: vi.fn(), updateEnvironment: vi.fn(), getEnvironmentDefaults: vi.fn(),
}));
```

with:

```tsx
  listDeployments: vi.fn(), updateEnvironment: vi.fn(), getEnvironmentDefaults: vi.fn(),
  listSnapshots: vi.fn(),
}));
```

In `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`, replace:

```tsx
  api.listDeployments.mockResolvedValue({ deployments: [summary(RUNNING), ADOPTED] });
});
```

with:

```tsx
  api.listDeployments.mockResolvedValue({ deployments: [summary(RUNNING), ADOPTED] });
  api.listSnapshots.mockResolvedValue({ snapshots: [] });
});
```

Append to the end of `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`:

```tsx
it('the Overview names the seed snapshot the first deploy restores', async () => {
  api.getEnvironment.mockResolvedValue({ ...ENV, current_sha: null, status: 'new', last_deployment: null,
                                         seed_snapshot: { id: 's1', name: 'dev-2026-10-04' } });
  show();
  expect(await screen.findByText('dev-2026-10-04 (the first deploy restores it)')).toBeTruthy();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments/DeployModal.test.tsx src/pages/environments/EnvironmentDetail.test.tsx`
Expected: FAIL — no "Start empty" / "From a snapshot" radios, no seed hint, no "Seed snapshot" row.

- [ ] **Step 3: Implement**

In `sirdar/web/src/pages/environments/DeployModal.tsx`, replace:

```tsx
/** Deploy an environment: a git ref and Update (default) or Reset data
 *  (needs deploy:change and the typed environment name). Opened from the
 *  environment page and from the Dashboard. */
```

with:

```tsx
/** Deploy an environment: a git ref and Update (default) or Reset data
 *  (needs deploy:change and the typed environment name; it can restore a
 *  snapshot after the reset). Opened from the environment page and from the
 *  Dashboard. */
```

In `sirdar/web/src/pages/environments/DeployModal.tsx`, replace:

```tsx
import { useAuth } from '@portal/auth/AuthContext';
```

with:

```tsx
import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';
```

In `sirdar/web/src/pages/environments/DeployModal.tsx`, replace:

```tsx
import {
  deployErrorText, startDeployment, type DeployMode, type Deployment, type Environment,
} from '../../lib/sirdarApi';

type Field = 'ref' | 'confirm' | 'form';
type Attempt = { mode: DeployMode; ref: string; confirm: string };
const MODES: [DeployMode, string, string][] = [
  ['update', 'Update', 'Keeps the data. Once the environment has been deployed, a database dump is taken first.'],
  ['reset', 'Reset data', "Deletes this environment's database and files, then starts it empty. This can't be undone."],
];
const CODE_FIELD: Record<string, Field> = { ref_invalid: 'ref', ref_not_found: 'ref', confirm_name_mismatch: 'confirm' };
```

with:

```tsx
import {
  deployErrorText, listSnapshots, startDeployment, type Deployment, type Environment, type Snapshot,
} from '../../lib/sirdarApi';

import { snapshotLabel } from './labels';

type Mode = 'update' | 'reset';
type Field = 'ref' | 'confirm' | 'snapshot' | 'form';
type Attempt = { mode: Mode; ref: string; confirm: string; snapshotId: string };
const MODES: [Mode, string, string][] = [
  ['update', 'Update', 'Keeps the data. Once the environment has been deployed, a database dump is taken first.'],
  ['reset', 'Reset data', "Deletes this environment's database and files, then starts it empty or from a snapshot. This can't be undone."],
];
const AFTER: ['empty' | 'snapshot', string][] = [['empty', 'Start empty'], ['snapshot', 'From a snapshot']];
const CODE_FIELD: Record<string, Field> = {
  ref_invalid: 'ref', ref_not_found: 'ref', confirm_name_mismatch: 'confirm',
  snapshot_not_found: 'snapshot', snapshot_not_ready: 'snapshot',
};
```

In `sirdar/web/src/pages/environments/DeployModal.tsx`, replace:

```tsx
  const [mode, setMode] = useState<DeployMode>('update');
  const [confirm, setConfirm] = useState('');
```

with:

```tsx
  const [mode, setMode] = useState<Mode>('update');
  const [confirm, setConfirm] = useState('');
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [after, setAfter] = useState<'empty' | 'snapshot'>('empty');
  const [snapshotId, setSnapshotId] = useState('');
```

In `sirdar/web/src/pages/environments/DeployModal.tsx`, replace:

```tsx
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    refInput.current?.focus();
```

with:

```tsx
  // Snapshots are optional: without them Reset data offers "Start empty" only.
  useEffect(() => {
    let live = true;
    listSnapshots().then((r) => { if (live) setSnapshots(r.snapshots.filter((x) => x.status === 'ready')); })
      .catch(() => { /* no snapshot choice */ });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    refInput.current?.focus();
```

In `sirdar/web/src/pages/environments/DeployModal.tsx`, replace:

```tsx
  const reset = mode === 'reset';
  const ready = canAdd && !busy && (!reset || (canChange && confirm === env.name));
```

with:

```tsx
  const reset = mode === 'reset';
  const restoring = reset && after === 'snapshot';
  const ready = canAdd && !busy && (!reset || (canChange && confirm === env.name)) && (!restoring || !!snapshotId);
  const seeded = mode === 'update' && env.current_sha === null ? env.seed_snapshot : null;
```

In `sirdar/web/src/pages/environments/DeployModal.tsx`, replace:

```tsx
      onStarted(await startDeployment(env.name, attempt.mode === 'reset'
        ? { mode: attempt.mode, git_ref: attempt.ref, confirm_name: attempt.confirm }
        : { mode: attempt.mode, git_ref: attempt.ref }));
```

with:

```tsx
      onStarted(await startDeployment(env.name, attempt.mode === 'reset'
        ? { mode: attempt.mode, git_ref: attempt.ref, confirm_name: attempt.confirm,
            ...(attempt.snapshotId ? { snapshot_id: attempt.snapshotId } : {}) }
        : { mode: attempt.mode, git_ref: attempt.ref }));
```

In `sirdar/web/src/pages/environments/DeployModal.tsx`, replace:

```tsx
    if (reset && confirm !== env.name) { setErrors({ confirm: `Type ${env.name} to confirm.` }); return; }
    void run({ mode, ref: ref.trim(), confirm });
```

with:

```tsx
    if (restoring && !snapshotId) { setErrors({ snapshot: 'Choose a snapshot.' }); return; }
    if (reset && confirm !== env.name) { setErrors({ confirm: `Type ${env.name} to confirm.` }); return; }
    void run({ mode, ref: ref.trim(), confirm, snapshotId: restoring ? snapshotId : '' });
```

In `sirdar/web/src/pages/environments/DeployModal.tsx`, replace:

```tsx
              <p className="page-hint">{MODES.find(([m]) => m === mode)?.[2]}</p>
              {!canChange && <p className="page-hint">Reset data needs permission to change deployments.</p>}
            </div>
```

with:

```tsx
              <p className="page-hint">{MODES.find(([m]) => m === mode)?.[2]}</p>
              {!canChange && <p className="page-hint">Reset data needs permission to change deployments.</p>}
              {seeded && (
                <p className="page-hint">
                  This first deploy restores the snapshot <b>{seeded.name}</b>: its database, files and sign-in keys.
                </p>
              )}
            </div>
            {reset && (
              <div>
                <span className="field-label" id="deploy-after-label">After the reset</span>
                <div className="segmented" role="radiogroup" aria-labelledby="deploy-after-label">
                  {AFTER.map(([a, label]) => {
                    const locked = a === 'snapshot' && snapshots.length === 0;
                    return (
                      <button key={a} type="button" role="radio" aria-checked={after === a} aria-disabled={locked}
                              className={after === a ? 'on' : ''} tabIndex={after === a ? 0 : -1} onKeyDown={arrowNav}
                              onClick={() => { if (!locked) { setAfter(a); setErrors({}); } }}>{label}</button>
                    );
                  })}
                </div>
                {after === 'snapshot' && (
                  <>
                    <label className="field-label sirdar-sub-label" htmlFor="deploy-snapshot">Snapshot</label>
                    <ComboBox inputId="deploy-snapshot" ariaLabel="Snapshot" portal value={snapshotId}
                              placeholder="Choose a snapshot…"
                              options={snapshots.map((x) => ({ value: x.id, label: snapshotLabel(x) }))}
                              onChange={(v) => { setSnapshotId(v); setErrors({}); }} />
                    <p className="page-hint">
                      Its users sign in with their own passwords and 2FA: the snapshot's keys replace this
                      environment's. Everyone signed in here now is signed out.
                    </p>
                  </>
                )}
                {snapshots.length === 0 && <p className="page-hint">No snapshot is ready, so it starts empty.</p>}
                {errors.snapshot && <p className="form-error" role="alert">{errors.snapshot}</p>}
              </div>
            )}
```

In `sirdar/web/src/pages/environments/DeployModal.tsx`, replace:

```tsx
              {busy ? 'Starting…' : reset ? 'Reset and deploy' : 'Deploy'}
```

with:

```tsx
              {busy ? 'Starting…' : restoring ? 'Reset and restore' : reset ? 'Reset and deploy' : 'Deploy'}
```

In `sirdar/web/src/pages/environments/EnvOverview.tsx`, replace:

```tsx
          <dt>Folder</dt><dd className="mono">{env.env_dir}</dd>
```

with:

```tsx
          <dt>Folder</dt><dd className="mono">{env.env_dir}</dd>
          {env.seed_snapshot && (
            <>
              <dt>Seed snapshot</dt>
              <dd>{env.seed_snapshot.name}{env.current_sha === null ? ' (the first deploy restores it)' : ''}</dd>
            </>
          )}
```

Append to the end of `sirdar/web/src/styles/sirdar.css`:

```css
.sirdar-sub-label { margin-top: 12px; }
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: every test passes (`DeployModal.test.tsx`: 12); the build type-checks.

- [ ] **Step 5: Commit**

```bash
git add sirdar/web/src/pages/environments/DeployModal.tsx sirdar/web/src/pages/environments/DeployModal.test.tsx sirdar/web/src/pages/environments/EnvOverview.tsx sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): Reset data can restore a snapshot; seeded first deploy and Overview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Backups tab and Restore backup

**Files:**
- Create: `sirdar/web/src/pages/environments/RestoreBackupModal.tsx`, `sirdar/web/src/pages/environments/BackupsTab.tsx`
- Modify: `sirdar/web/src/pages/environments/EnvironmentDetail.tsx`
- Test: `sirdar/web/src/pages/environments/BackupsTab.test.tsx`, `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`

**Interfaces:**
- Consumes: Task 1 `listBackups`, `startDeployment` with `{mode: 'restore_dump', backup, confirm_name}`, `formatBytes`, `when`, `BACKUPS`; `useHostKeyTrust`.
- Produces: `default BackupsTab({ env, onStarted(dep) })` — DataTable "Backups" (File, Taken, Size, Restore), Refresh, reloads when `env.status` changes, Restore needs `deploy:change` and is disabled while deploying; `default RestoreBackupModal({ env, backup, onStarted, onClose })` — header eyebrow "Backups", title "Restore backup", the "Uploaded files are not rolled back" warning, typed-name gate, "Trust and restore" on an unknown host key. `EnvironmentDetail` tabs: Overview, Deployments, Backups, Settings; a started restore opens on Deployments.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/web/src/pages/environments/BackupsTab.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a !== 'change' || perms.change) }),
}));
const api = vi.hoisted(() => ({ listBackups: vi.fn(), startDeployment: vi.fn(), trustKnownHost: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import BackupsTab from './BackupsTab';
import { BACKUPS, ENV, RUNNING } from './testData';

beforeEach(() => {
  perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.listBackups.mockResolvedValue({ backups: BACKUPS });
  api.startDeployment.mockResolvedValue(RUNNING);
});
afterEach(cleanup);

function show(env = ENV) {
  const onStarted = vi.fn();
  render(<BackupsTab env={env} onStarted={onStarted} />);
  return { onStarted };
}

it('lists the pre-deploy dumps, newest first, with time and size', async () => {
  show();
  const table = await screen.findByRole('table', { name: 'Backups' });
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(
    ['20261004T010203Z.dump', '20261003T130500Z.dump']);
  expect(within(table).getByText('2.0 MB')).toBeTruthy();
  expect(screen.getByText(/the newest 5 stay in \/opt\/serversherpa\/uat\/backups/)).toBeTruthy();
  expect(screen.getByText(/Uploaded files are not rolled back/)).toBeTruthy();
  expect(api.listBackups).toHaveBeenCalledWith('uat');
});

it('restoring needs the typed name and starts a Restore backup deployment', async () => {
  const { onStarted } = show();
  await userEvent.click(await screen.findByRole('button', { name: 'Restore 20261003T130500Z.dump' }));
  const dialog = screen.getByRole('dialog', { name: 'Restore backup' });
  expect(within(dialog).getByText('Backups', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByText(/files deleted since stay deleted/)).toBeTruthy();
  const go = within(dialog).getByRole('button', { name: 'Restore backup' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(go);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
  expect(api.startDeployment).toHaveBeenCalledWith('uat', {
    mode: 'restore_dump', backup: '20261003T130500Z.dump', confirm_name: 'uat' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('an unknown host key is trusted, then the same restore is replayed', async () => {
  api.startDeployment.mockRejectedValueOnce(new ApiError(409, 'host_key_unknown', {
    code: 'host_key_unknown', host: '10.10.48.63', port: 22, key_type: 'ssh-rsa', fingerprint: 'SHA256:abc' }));
  api.trustKnownHost.mockResolvedValue({});
  const { onStarted } = show();
  await userEvent.click(await screen.findByRole('button', { name: 'Restore 20261004T010203Z.dump' }));
  await userEvent.type(screen.getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Restore backup' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Trust and restore' }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.63', 22, 'SHA256:abc', 'ssh:lab');
  expect(api.startDeployment.mock.calls[1]).toEqual(api.startDeployment.mock.calls[0]);
});

it('a refused restore says why and keeps the modal open', async () => {
  api.startDeployment.mockRejectedValue(new ApiError(409, 'deploy_in_progress', { code: 'deploy_in_progress' }));
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Restore 20261004T010203Z.dump' }));
  await userEvent.type(screen.getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Restore backup' }));
  expect((await screen.findByRole('alert')).textContent).toBe('A deployment of this environment is already running.');
  expect(screen.getByRole('dialog', { name: 'Restore backup' })).toBeTruthy();
});

it('view-only, deploying, empty and unreachable states', async () => {
  perms.change = false;
  show();
  await screen.findByText('20261004T010203Z.dump');
  expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull();
  cleanup();
  perms.change = true;
  show({ ...ENV, status: 'deploying' });
  const btn = await screen.findByRole('button', { name: 'Restore 20261004T010203Z.dump' }) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  cleanup();
  api.listBackups.mockResolvedValue({ backups: [] });
  show();
  expect(await screen.findByText('No backups yet. Each Update takes one before it migrates.')).toBeTruthy();
  cleanup();
  api.listBackups.mockRejectedValue(new ApiError(502, 'connect_failed', { code: 'connect_failed', reason: 'Timed out.' }));
  show();
  expect((await screen.findByRole('alert')).textContent).toBe('Timed out.');
});
```

In `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`, replace:

```tsx
  listSnapshots: vi.fn(),
}));
```

with:

```tsx
  listSnapshots: vi.fn(), listBackups: vi.fn(),
}));
```

In `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`, replace:

```tsx
import { ADOPTED, DEFAULTS, ENV, RUNNING, TARGETS, summary } from './testData';
```

with:

```tsx
import { ADOPTED, BACKUPS, DEFAULTS, ENV, RUNNING, TARGETS, summary } from './testData';
```

In `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`, replace:

```tsx
  api.listSnapshots.mockResolvedValue({ snapshots: [] });
});
```

with:

```tsx
  api.listSnapshots.mockResolvedValue({ snapshots: [] });
  api.listBackups.mockResolvedValue({ backups: BACKUPS });
});
```

Append to the end of `sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx`:

```tsx
it('the Backups tab restores a dump and then follows it on the Deployments tab', async () => {
  api.startDeployment.mockResolvedValue({ ...RUNNING, id: 'd7', mode: 'restore_dump' });
  show();
  await userEvent.click(await screen.findByRole('tab', { name: 'Backups' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Restore 20261004T010203Z.dump' }));
  await userEvent.type(screen.getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Restore backup' }));
  expect(await screen.findByText('deployment view d7')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Deployments' }).getAttribute('aria-selected')).toBe('true');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments/BackupsTab.test.tsx src/pages/environments/EnvironmentDetail.test.tsx`
Expected: FAIL — `Failed to resolve import "./BackupsTab"`; no "Backups" tab.

- [ ] **Step 3: Implement**

Create `sirdar/web/src/pages/environments/RestoreBackupModal.tsx`:

```tsx
/** Restore one of the environment's pre-deploy dumps: a "Restore backup"
 *  deployment (start the data services, put the dump back into an empty
 *  database, migrate and start the app). Uploaded files are not rolled back. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import { deployErrorText, startDeployment, type Backup, type Deployment, type Environment } from '../../lib/sirdarApi';

import { formatBytes, when } from './labels';

type Attempt = { backup: string; confirm: string };

export default function RestoreBackupModal({ env, backup, onStarted, onClose }: {
  env: Environment; backup: Backup; onStarted: (dep: Deployment) => void; onClose: () => void;
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
    canTrust: can('deploy', 'change'), trustLabel: 'Trust and restore',
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
      onStarted(await startDeployment(env.name, {
        mode: 'restore_dump', backup: attempt.backup, confirm_name: attempt.confirm }));
    } catch (e) {
      if (!hostKey.handle(e, env.target, attempt)) setError(deployErrorText(e, "Couldn't start the restore."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const ready = confirm === env.name && !busy && can('deploy', 'change');

  return (
    <>
      <div className="modal-scrim" ref={scrimRef} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="modal-card reports-modal-card rgm-card sirdar-deploy-card" role="dialog" aria-modal="true"
             aria-labelledby="sirdar-restore-title">
          <div className="modal-head">
            <div className="rgm-head-text">
              <div className="eyebrow">Backups</div>
              <h3 id="sirdar-restore-title">Restore backup</h3>
              <p className="page-hint">
                Puts {env.name}'s database back to {backup.name}, then migrates it to the running commit and starts
                the app again.
              </p>
            </div>
            <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </div>
          <div className="modal-body pf-form sirdar-deploy-form">
            <dl className="sirdar-kv">
              <dt>Backup</dt><dd className="mono">{backup.name}</dd>
              <dt>Taken</dt><dd className="mono">{when(backup.modified_at)}</dd>
              <dt>Size</dt><dd>{formatBytes(backup.size_bytes)}</dd>
            </dl>
            <p className="page-hint">
              Everything written to the database since this backup is lost. Uploaded files are not rolled back: files
              added since stay, and files deleted since stay deleted. This can't be undone.
            </p>
            <div>
              <label className="field-label" htmlFor="restore-confirm">Type {env.name} to confirm</label>
              <input id="restore-confirm" ref={confirmInput} type="text" value={confirm} maxLength={64}
                     autoComplete="off" spellCheck={false} disabled={busy}
                     onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="btn-solid" disabled={!ready}
                    onClick={() => void run({ backup: backup.name, confirm })}>
              {busy ? 'Starting…' : 'Restore backup'}
            </button>
          </div>
        </div>
      </div>
      {hostKey.modal}
    </>
  );
}
```

Create `sirdar/web/src/pages/environments/BackupsTab.tsx`:

```tsx
/** Backups tab: the environment's pre-deploy dumps (read from the target
 *  over SSH), each restorable with the typed-name gate. */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';

import { deployErrorText, listBackups, type Backup, type Deployment, type Environment } from '../../lib/sirdarApi';

import { formatBytes, when } from './labels';
import RestoreBackupModal from './RestoreBackupModal';

export default function BackupsTab({ env, onStarted }: {
  env: Environment; onStarted: (dep: Deployment) => void;
}) {
  const { can } = useAuth();
  const [rows, setRows] = useState<Backup[] | null>(null);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const seq = useRef(0);

  // Only the newest request's answer lands.
  const load = useCallback(() => {
    const n = ++seq.current;
    return listBackups(env.name)
      .then((r) => { if (n === seq.current) { setRows(r.backups); setError(''); } })
      .catch((e) => { if (n === seq.current) { setRows([]); setError(deployErrorText(e, "Couldn't list the backups.")); } });
  }, [env.name]);
  // A deploy that ends adds a dump (and rotates the oldest out).
  useEffect(() => { void load(); }, [load, env.status]);
  useEffect(() => () => { seq.current += 1; }, []);

  const running = env.status === 'deploying';
  const mayRestore = can('deploy', 'change');
  return (
    <section className="sirdar-section">
      <div className="sirdar-section-head">
        <h2>Backups</h2>
        <button type="button" className="mini-btn" onClick={() => void load()}>Refresh</button>
      </div>
      <p className="page-hint">
        Each Update dumps the database before it migrates; the newest {env.keep_dumps} stay in {env.env_dir}/backups.
        Restoring one puts the database back. Uploaded files are not rolled back.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <DataTable
        ariaLabel="Backups"
        columns={[
          { key: 'name', label: 'File', mono: true }, { key: 'when', label: 'Taken', mono: true },
          { key: 'size', label: 'Size' }, { key: 'act', label: '', align: 'right' },
        ]}
        rows={(rows ?? []).map((b) => ({
          key: b.name,
          cells: [
            b.name, when(b.modified_at), formatBytes(b.size_bytes),
            mayRestore
              ? <button type="button" className="mini-btn" aria-label={`Restore ${b.name}`} disabled={running}
                        title={running ? 'A deployment is running.' : undefined}
                        onClick={() => setRestoring(b)}>Restore</button>
              : '',
          ],
        }))}
        emptyText={rows === null ? 'Loading…' : 'No backups yet. Each Update takes one before it migrates.'}
      />
      {restoring && (
        <RestoreBackupModal env={env} backup={restoring} onClose={() => setRestoring(null)}
                            onStarted={(dep) => { setRestoring(null); onStarted(dep); }} />
      )}
    </section>
  );
}
```

In `sirdar/web/src/pages/environments/EnvironmentDetail.tsx`, replace:

```tsx
import DeploymentsTab from './DeploymentsTab';
```

with:

```tsx
import BackupsTab from './BackupsTab';
import DeploymentsTab from './DeploymentsTab';
```

In `sirdar/web/src/pages/environments/EnvironmentDetail.tsx`, replace:

```tsx
type Tab = 'overview' | 'deployments' | 'settings';
const TABS: [Tab, string][] = [['overview', 'Overview'], ['deployments', 'Deployments'], ['settings', 'Settings']];
```

with:

```tsx
type Tab = 'overview' | 'deployments' | 'backups' | 'settings';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'], ['deployments', 'Deployments'], ['backups', 'Backups'], ['settings', 'Settings'],
];
```

In `sirdar/web/src/pages/environments/EnvironmentDetail.tsx`, replace:

```tsx
      {tab === 'settings' && <EnvSettings env={env} targets={targets} onSaved={setEnv} />}
```

with:

```tsx
      {tab === 'backups' && <BackupsTab env={env} onStarted={started} />}
      {tab === 'settings' && <EnvSettings env={env} targets={targets} onSaved={setEnv} />}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: every test passes (`BackupsTab.test.tsx`: 5); the build type-checks.

- [ ] **Step 5: Commit**

```bash
git add sirdar/web/src/pages/environments/RestoreBackupModal.tsx sirdar/web/src/pages/environments/BackupsTab.tsx sirdar/web/src/pages/environments/BackupsTab.test.tsx sirdar/web/src/pages/environments/EnvironmentDetail.tsx sirdar/web/src/pages/environments/EnvironmentDetail.test.tsx
git commit -m "feat(sirdar-web): Backups tab with Restore backup (typed-name gate)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Deployment view — Roll back and the new modes

**Files:**
- Modify: `sirdar/web/src/pages/environments/DeploymentView.tsx`, `sirdar/web/src/styles/sirdar.css`
- Test: `sirdar/web/src/pages/environments/DeploymentView.test.tsx`

**Interfaces:**
- Consumes: Task 1 `rollbackDeployment`, `GATED_MODES`, `RETRY_MODES`, `ROLLBACKABLE`, `RESTORE_FAILED`, `SNAP`.
- Produces: Retry works for update, reset, restore_dump and rollback (the last three need `deploy:change` and the typed name); a snapshot job shows no Retry; the details list shows "Snapshot" / "Restores snapshot" and "Restores backup"; when `rollback_available` and this is the latest deployment and the reader has add + change, a "Roll back" block explains the previous commit and that files are not rolled back, with its own typed-name gate, and calls `rollbackDeployment` then `onRetried(newDeployment)`. The host-key prompt's button reads "Trust and continue". CSS `.sirdar-rollback`.

- [ ] **Step 1: Write the failing tests**

In `sirdar/web/src/pages/environments/DeploymentView.test.tsx`, replace:

```tsx
  getDeployment: vi.fn(), cancelDeployment: vi.fn(), retryDeployment: vi.fn(), trustKnownHost: vi.fn(),
}));
```

with:

```tsx
  getDeployment: vi.fn(), cancelDeployment: vi.fn(), retryDeployment: vi.fn(), trustKnownHost: vi.fn(),
  rollbackDeployment: vi.fn(),
}));
```

In `sirdar/web/src/pages/environments/DeploymentView.test.tsx`, replace:

```tsx
import { ENV, FAILED, RESET_FAILED, RUNNING, RUNNING_MORE, SUCCEEDED } from './testData';
```

with:

```tsx
import {
  ENV, FAILED, RESET_FAILED, RESTORE_FAILED, ROLLBACKABLE, RUNNING, RUNNING_MORE, SNAP, SUCCEEDED,
} from './testData';
```

Append to the end of `sirdar/web/src/pages/environments/DeploymentView.test.tsx`:

```tsx
it('a failed Update with a dump offers Roll back behind the typed name', async () => {
  api.getDeployment.mockResolvedValue(ROLLBACKABLE);
  api.rollbackDeployment.mockResolvedValue({ ...RUNNING, id: 'd8', mode: 'rollback' });
  const { onRetried } = show({ id: 'd4' });
  expect(await screen.findByRole('heading', { name: 'Roll back' })).toBeTruthy();
  expect(screen.getByText(/Deploys the previous commit/).textContent).toContain('e73b99ca');
  const go = screen.getByRole('button', { name: 'Roll back' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await user.type(screen.getByLabelText('Type uat to confirm', { selector: '#rollback-confirm' }), 'uat');
  await user.click(go);
  await waitFor(() => expect(onRetried).toHaveBeenCalledWith(expect.objectContaining({ id: 'd8' })));
  expect(api.rollbackDeployment).toHaveBeenCalledWith('d4', 'uat');
});

it('Roll back is hidden without change, on an older deployment, and when unavailable', async () => {
  api.getDeployment.mockResolvedValue(ROLLBACKABLE);
  perms.change = false;
  show({ id: 'd4' });
  await screen.findByText(/migrate exited 1/);
  expect(screen.queryByRole('heading', { name: 'Roll back' })).toBeNull();
  cleanup();
  perms.change = true;
  show({ id: 'd4', isLatest: false });
  await screen.findByText(/migrate exited 1/);
  expect(screen.queryByRole('heading', { name: 'Roll back' })).toBeNull();
  cleanup();
  api.getDeployment.mockResolvedValue(FAILED);
  show();
  await screen.findByText(/docker build exited 1/);
  expect(screen.queryByRole('heading', { name: 'Roll back' })).toBeNull();
});

it('a failed Restore backup retries behind the typed name and shows its backup', async () => {
  api.getDeployment.mockResolvedValue(RESTORE_FAILED);
  api.retryDeployment.mockResolvedValue({ ...RUNNING, id: 'd6' });
  show({ id: 'd5' });
  expect(await screen.findByRole('heading', { level: 2, name: /^Restore backup · e73b99ca/ })).toBeTruthy();
  expect(screen.getByText('20261003T130500Z.dump', { selector: 'dd' })).toBeTruthy();
  const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  await user.type(screen.getByLabelText('Type uat to confirm', { selector: '#retry-confirm' }), 'uat');
  await user.click(retry);
  await waitFor(() => expect(api.retryDeployment).toHaveBeenCalledWith('d5', { from_step: 9, confirm_name: 'uat' }));
});

it('a snapshot job is never retried, and names its snapshot', async () => {
  api.getDeployment.mockResolvedValue({
    ...FAILED, mode: 'snapshot', snapshot: { id: SNAP.id, name: SNAP.name },
    steps: [{ ...FAILED.steps[0] }, { ...FAILED.steps[4], number: 11, key: 'export', name: 'Take snapshot' }],
  });
  show();
  expect(await screen.findByText('dev-2026-10-04', { selector: 'dd' })).toBeTruthy();
  expect(screen.getByRole('heading', { level: 2, name: /^Take snapshot ·/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix sirdar/web test -- src/pages/environments/DeploymentView.test.tsx`
Expected: FAIL — no "Roll back" heading; Restore backup offers no typed-name retry; the snapshot name isn't shown.

- [ ] **Step 3: Implement**

In `sirdar/web/src/pages/environments/DeploymentView.tsx`, replace:

```tsx
/** One deployment: its steps with live logs (polled while it runs), Cancel,
 *  and Retry from step. Logs render as text only (already redacted server-side). */
```

with:

```tsx
/** One deployment: its steps with live logs (polled while it runs), Cancel,
 *  Retry from step and, after a failed Update, Roll back. Logs render as text
 *  only (already redacted server-side). */
```

In `sirdar/web/src/pages/environments/DeploymentView.tsx`, replace:

```tsx
import {
  cancelDeployment, deployErrorText, errorText, getDeployment, retryDeployment,
  type Deployment, type Environment,
} from '../../lib/sirdarApi';

import {
  DEPLOYMENT_STATUS, MODE_LABEL, RETRYABLE, STEP_STATUS, StatusChip, duration, shortSha, stoppedStep, when,
} from './labels';
```

with:

```tsx
import {
  cancelDeployment, deployErrorText, errorText, getDeployment, retryDeployment, rollbackDeployment,
  type Deployment, type Environment,
} from '../../lib/sirdarApi';

import {
  DEPLOYMENT_STATUS, GATED_MODES, MODE_LABEL, RETRY_MODES, RETRYABLE, STEP_STATUS, StatusChip, duration, shortSha,
  stoppedStep, when,
} from './labels';
```

In `sirdar/web/src/pages/environments/DeploymentView.tsx`, replace:

```tsx
type RetryAttempt = { fromStep: number; confirm: string; reset: boolean };
```

with:

```tsx
/** A retry or a rollback, kept whole so a host-key prompt replays exactly it. */
type Attempt = { kind: 'retry'; fromStep: number; confirm: string; gated: boolean }
  | { kind: 'rollback'; confirm: string };
```

In `sirdar/web/src/pages/environments/DeploymentView.tsx`, replace:

```tsx
  const [retrying, setRetrying] = useState(false);
```

with:

```tsx
  const [rollbackConfirm, setRollbackConfirm] = useState('');
  const [retrying, setRetrying] = useState(false);
```

In `sirdar/web/src/pages/environments/DeploymentView.tsx`, replace:

```tsx
  const isReset = dep?.mode === 'reset';
  const allowed = dep?.mode === 'update' ? can('deploy', 'add')
    : dep?.mode === 'reset' ? can('deploy', 'add') && can('deploy', 'change') : false;
  const mayRetry = !!dep && RETRYABLE.includes(dep.status) && allowed && stopped !== null;

  // Replays exactly the attempt that hit the host-key prompt.
  const run = async (attempt: RetryAttempt) => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    setActionError('');
    try {
      onRetried(await retryDeployment(id, attempt.reset
        ? { from_step: attempt.fromStep, confirm_name: attempt.confirm }
        : { from_step: attempt.fromStep }));
    } catch (e) {
      if (!hostKey.handle(e, env.target, attempt)) setActionError(deployErrorText(e, "Couldn't retry the deployment."));
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  };
  const hostKey = useHostKeyTrust<RetryAttempt>({
    canTrust: can('deploy', 'change'), trustLabel: 'Trust and retry',
    onTrusted: (attempt) => { void run(attempt); }, onProblem: setActionError,
  });

  const retry = () => {
    if (!dep || stopped === null) return;
    if (isReset && confirm !== env.name) { setActionError(`Type ${env.name} to confirm.`); return; }
    void run({ fromStep: Number(fromStep || stopped), confirm, reset: isReset });
  };
```

with:

```tsx
  // Reset, Restore backup and Roll back replace data: change permission and the typed name.
  const gated = !!dep && GATED_MODES.includes(dep.mode);
  const allowed = !dep || !RETRY_MODES.includes(dep.mode) ? false
    : gated ? can('deploy', 'add') && can('deploy', 'change') : can('deploy', 'add');
  const mayRetry = !!dep && RETRYABLE.includes(dep.status) && allowed && stopped !== null;
  const mayRollBack = !!dep && dep.rollback_available && can('deploy', 'add') && can('deploy', 'change');

  // Replays exactly the attempt that hit the host-key prompt.
  const run = async (attempt: Attempt) => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    setActionError('');
    try {
      if (attempt.kind === 'rollback') onRetried(await rollbackDeployment(id, attempt.confirm));
      else {
        onRetried(await retryDeployment(id, attempt.gated
          ? { from_step: attempt.fromStep, confirm_name: attempt.confirm }
          : { from_step: attempt.fromStep }));
      }
    } catch (e) {
      if (!hostKey.handle(e, env.target, attempt)) {
        setActionError(deployErrorText(e, attempt.kind === 'rollback'
          ? "Couldn't roll back the deployment." : "Couldn't retry the deployment."));
      }
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  };
  const hostKey = useHostKeyTrust<Attempt>({
    canTrust: can('deploy', 'change'), trustLabel: 'Trust and continue',
    onTrusted: (attempt) => { void run(attempt); }, onProblem: setActionError,
  });

  const retry = () => {
    if (!dep || stopped === null) return;
    if (gated && confirm !== env.name) { setActionError(`Type ${env.name} to confirm.`); return; }
    void run({ kind: 'retry', fromStep: Number(fromStep || stopped), confirm, gated });
  };
```

In `sirdar/web/src/pages/environments/DeploymentView.tsx`, replace:

```tsx
        {dep.dump_path && <><dt>Pre-deploy dump</dt><dd className="mono">{dep.dump_path}</dd></>}
```

with:

```tsx
        {dep.dump_path && <><dt>Pre-deploy dump</dt><dd className="mono">{dep.dump_path}</dd></>}
        {dep.snapshot && (
          <><dt>{dep.mode === 'snapshot' ? 'Snapshot' : 'Restores snapshot'}</dt><dd>{dep.snapshot.name}</dd></>
        )}
        {dep.restore_dump && <><dt>Restores backup</dt><dd className="mono">{dep.restore_dump}</dd></>}
```

In `sirdar/web/src/pages/environments/DeploymentView.tsx`, replace:

```tsx
          {isReset && (
            <div>
              <label className="field-label" htmlFor="retry-confirm">Type {env.name} to confirm</label>
              <input id="retry-confirm" type="text" value={confirm} maxLength={64} autoComplete="off"
                     spellCheck={false} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          )}
          <button type="button" className="btn-solid" disabled={retrying || hostKey.open || (isReset && confirm !== env.name)}
                  onClick={retry}>
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
      {mayRetry && isLatest === false && <p className="page-hint">Only the most recent deployment can be retried.</p>}
```

with:

```tsx
          {gated && (
            <div>
              <label className="field-label" htmlFor="retry-confirm">Type {env.name} to confirm</label>
              <input id="retry-confirm" type="text" value={confirm} maxLength={64} autoComplete="off"
                     spellCheck={false} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          )}
          <button type="button" className="btn-solid" disabled={retrying || hostKey.open || (gated && confirm !== env.name)}
                  onClick={retry}>
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
      {mayRetry && isLatest === false && <p className="page-hint">Only the most recent deployment can be retried.</p>}
      {mayRollBack && isLatest === true && (
        <div className="sirdar-rollback">
          <h3 className="sirdar-sub">Roll back</h3>
          <p className="page-hint">
            Deploys the previous commit <span className="mono">{shortSha(dep.previous_sha)}</span> again and restores
            this deployment's pre-deploy dump. Uploaded files are not rolled back.
          </p>
          <div className="sirdar-retry pf-form">
            <div>
              <label className="field-label" htmlFor="rollback-confirm">Type {env.name} to confirm</label>
              <input id="rollback-confirm" type="text" value={rollbackConfirm} maxLength={64} autoComplete="off"
                     spellCheck={false} onChange={(e) => setRollbackConfirm(e.target.value)} />
            </div>
            <button type="button" className="btn-ghost"
                    disabled={retrying || hostKey.open || rollbackConfirm !== env.name}
                    onClick={() => void run({ kind: 'rollback', confirm: rollbackConfirm })}>
              {retrying ? 'Starting…' : 'Roll back'}
            </button>
          </div>
        </div>
      )}
```

Append to the end of `sirdar/web/src/styles/sirdar.css`:

```css
.sirdar-rollback { margin-top: 16px; }
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm --prefix sirdar/web test && npm --prefix sirdar/web run build`
Expected: every web test passes (260 in total after this task); the build type-checks and Vite builds.

- [ ] **Step 5: Commit**

```bash
git add sirdar/web/src/pages/environments/DeploymentView.tsx sirdar/web/src/pages/environments/DeploymentView.test.tsx sirdar/web/src/styles/sirdar.css
git commit -m "feat(sirdar-web): Roll back a failed Update; retry Restore backup and Roll back

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Live verify on the live Sirdar and the real uat VM (controller, not a subagent)

The controller runs this task itself, through Claude in Chrome, with Jimmy signed in to the live Sirdar at `https://sirdar.dev.serversherpa.com` (Tower, `10.10.48.14`). The target is the real uat VM (`10.10.48.63`); SSH checks use `jrh1812@10.10.48.63` with key auth from this Mac.

**Hard rules for this task**

- **uat is never reset or restored.** Every Reset, Restore backup and Roll back in this task targets `uat2`. Taking a snapshot of `uat` is read-only for uat (its status and commit don't change); re-check that at the end (Step 10).
- Before each click that changes something (Upload, Take snapshot, Create environment, Deploy, Restore backup, Delete, trusting a host key), tell Jimmy in chat exactly what it will do and wait for his yes. Read-only navigation needs no approval.
- Never type a password, a TOTP code or a secret. Where a sign-in proves something (Step 7), Jimmy runs the command himself. Never print `.env` values: compare them by SHA-256 only.
- `ssh … 'bash -s' <<EOF` eats stdin under `docker compose`; every SSH command below is a single command line (or a script piped to `python -` inside a container), so nothing reads the heredoc by accident.
- Load the browser tools once: ToolSearch `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__form_input,mcp__claude-in-chrome__file_upload,mcp__claude-in-chrome__read_network_requests,mcp__claude-in-chrome__tabs_create_mcp`.

**Files (scratch only, nothing committed):** the helper scripts below go in this session's scratchpad (`$SCRATCH` below), and the seed bundle in `~/Downloads`.

- [ ] **Step 1: Preconditions — the code is live on Tower**

1. Plans 3a and 3b are merged to `main` and pushed (Jimmy decides; `git -C /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar log -1 --format=%H origin/main` shows the merge).
2. Jimmy updates Tower by re-running the installer (as for phase 2, with the commit-SHA URL because raw.githubusercontent.com caches `main` for ~5 minutes):

   ```bash
   SHA=$(git -C /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar rev-parse origin/main)
   echo "curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/$SHA/sirdar/install.sh | SIRDAR_DIR=/mnt/user/serversherpa/sirdar bash"
   ```

   Jimmy runs the printed line on Tower. It must create `sirdar/snapshots` (uid 10001, mode 700) and restart the stack. Then, on Tower: `docker exec sirdar-sirdar-1 sh -c 'stat -c "%U %a" /app/snapshots; cd /app/api && alembic current'` → `sirdar 700` and `0005 (head)`.
3. In Chrome (`tabs_context_mcp`, then `navigate` to `https://sirdar.dev.serversherpa.com/deploy`): the page shows Environments (uat listed, Ready) and a **Snapshots** section with "No snapshots yet.", Take snapshot and Upload.
4. The VM is reachable and its ports for `uat2` are free:

   ```bash
   ssh -o BatchMode=yes jrh1812@10.10.48.63 "ss -ltnH | awk '{print \$4}' | grep -E ':(8100|8191|8190|8196|9100|8195|8125)\$' || echo free"
   ssh -o BatchMode=yes jrh1812@10.10.48.63 'df -h / | tail -1; docker ps --format "{{.Names}}" | grep -c "^ss-uat-"'
   ```

   Expected: `free`; at least 20 GB available; the uat containers running (12 or more).

- [ ] **Step 2: Baseline uat (read-only)**

Write the helper scripts:

`$SCRATCH/count_objects.py` (runs inside an environment's api container):

```python
import os

import boto3
from botocore.config import Config

s3 = boto3.client("s3", endpoint_url="http://seaweedfs:8333", region_name="us-east-1",
                  aws_access_key_id="serversherpa",
                  aws_secret_access_key=os.environ["SS_SPACES_SECRET_KEY"],
                  config=Config(s3={"addressing_style": "path"}))
bucket = os.environ["SS_SPACES_BUCKET"]
count = size = 0
for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
    for item in page.get("Contents", []):
        if item["Key"].endswith("/") and not item["Size"]:
            continue
        count += 1
        size += item["Size"]
print(f"{bucket}: {count} objects, {size} bytes")
```

`$SCRATCH/storage_keys.sql` (every object key the database points at):

```sql
SELECT k FROM (
  SELECT storage_key AS k FROM attachments
  UNION ALL SELECT storage_key FROM wiki_page_assets
  UNION ALL SELECT storage_key FROM wiki_file_versions
  UNION ALL SELECT preview_key FROM wiki_file_versions
  UNION ALL SELECT storage_key FROM report_runs
  UNION ALL SELECT avatar_key FROM people
  UNION ALL SELECT logo_key FROM clients
  UNION ALL SELECT logo_key FROM partners
  UNION ALL SELECT storage_key FROM label_fonts
  UNION ALL SELECT file_key FROM import_jobs
  UNION ALL SELECT storage_key FROM db_backups
) s WHERE k IS NOT NULL AND k <> '' ORDER BY 1;
```

`$SCRATCH/check_keys.py` (runs inside an api container; reads `/tmp/storage-keys.txt`):

```python
import os

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

s3 = boto3.client("s3", endpoint_url="http://seaweedfs:8333", region_name="us-east-1",
                  aws_access_key_id="serversherpa",
                  aws_secret_access_key=os.environ["SS_SPACES_SECRET_KEY"],
                  config=Config(s3={"addressing_style": "path"}))
bucket = os.environ["SS_SPACES_BUCKET"]
keys = [line.strip() for line in open("/tmp/storage-keys.txt") if line.strip()]
missing = []
for key in keys:
    try:
        s3.head_object(Bucket=bucket, Key=key)
    except ClientError:
        missing.append(key)
print(f"{len(keys)} keys in the database, {len(missing)} missing from {bucket}")
for key in missing[:10]:
    print("missing:", key)
```

`$SCRATCH/counts.sql`:

```sql
SELECT 'user_accounts', count(*) FROM user_accounts
UNION ALL SELECT 'people', count(*) FROM people
UNION ALL SELECT 'auth_sessions', count(*) FROM auth_sessions
UNION ALL SELECT 'wiki_nodes', count(*) FROM wiki_nodes
UNION ALL SELECT 'alembic', version_num::int FROM alembic_version;
```

Then record uat's baseline (`ENV=uat`):

```bash
ENV=uat
ssh jrh1812@10.10.48.63 "docker exec -i ss-$ENV-db-postgres-1 psql -U serversherpa -d serversherpa -tA -F' '" < $SCRATCH/counts.sql
ssh jrh1812@10.10.48.63 "docker exec -i ss-$ENV-api-api-1 python -" < $SCRATCH/count_objects.py
ssh jrh1812@10.10.48.63 "grep -E '^SS_(PASSWORD_PEPPER|TOTP_ENCRYPTION_KEY)=' /opt/serversherpa/$ENV/.env | sha256sum"
curl -s -o /dev/null -w '%{http_code}\n' https://api.uat.serversherpa.com/healthz
```

Expected: counts per table (note them), the alembic number (e.g. `89`), `serversherpa: N objects, B bytes` (about 17,600 objects), one SHA-256 line (note it: `UAT_KEYS_HASH`), and `200`.

- [ ] **Step 3: The Mac seed script, then Upload**

1. The dev stack must be up: `docker ps --format '{{.Names}}' | grep -E 'serversherpa-dev-(postgres|minio)-1'` shows both.
2. Build the bundle (from the worktree, with the main checkout's `.env` and API virtualenv):

   ```bash
   /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar/scripts/make-seed-snapshot.sh \
     --env-file /Users/jrh1812/Developer/BaseCampV3/.env \
     --python /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python \
     --out ~/Downloads/seed-dev-$(date +%Y%m%d).tar.gz
   ```

   Expected: `==> Dumping…`, `==> Exporting bucket serversherpa-dev…`, `==> Packing…`, then the summary (size, sha256, source `mac-dev`, the dev migration, about 17,600 objects) and the reminder that it holds plaintext keys. No secret in the output. Note the migration and object count.
3. In Chrome on `/deploy` → **Snapshots** → **Upload** (ask Jimmy first): the modal has the eyebrow "Snapshots", title "Upload snapshot" and the description. Attach the file with `file_upload` on the hidden input (`find` "snap-file" → its ref) using `~/Downloads/seed-dev-<date>.tar.gz`; if the tool can't attach a file that large, ask Jimmy to click **Choose file…** and pick it. The Name prefills `seed-dev-<date>`; Notes `Mac dev stack, phase 3 live verify` → **Upload**. "Uploading… Keep this page open until it finishes." shows.
4. Checks:
   - The row appears Ready: source `Upload · mac-dev`, Migration = the script's, Files = the script's object count, Size ≈ the file's.
   - If the browser shows a 413 ("larger than the proxy in front of Sirdar accepts"), Jimmy adds `client_max_body_size 6g;` to the `sirdar.dev.serversherpa.com` proxy host's Advanced tab in Nginx Proxy Manager and you retry. If the request ends in a 504 (the proxy timed out while Sirdar re-encrypted the keys), reload the page after a minute: the row appears when Sirdar finishes.
   - On Tower (Jimmy, or the controller if it has a shell there): `docker exec sirdar-sirdar-1 sh -c 'ls -la /app/snapshots /app/snapshots/incoming; python -c "import sys, tarfile; t = tarfile.open(sys.argv[1], \"r|gz\"); print([m.name for m in t][:2])" /app/snapshots/*.tar.gz'` → one `<uuid>.tar.gz` (mode 600), an empty `incoming/`, and `['manifest.json', 'keys.enc']` for each bundle (no `keys.env`).
5. Delete the local file (it holds the dev keys in plaintext): `rm ~/Downloads/seed-dev-*.tar.gz`.

- [ ] **Step 4: Take a snapshot of uat**

1. **Snapshots** → **Take snapshot** (ask Jimmy first): the modal offers `uat · uat.serversherpa.com`, the name `uat-<today>`; Notes `phase 3 live verify` → **Take snapshot**. The page moves to `/deploy/environments/uat?deployment=<id>` with the job open: steps `1 Preflight`, `11 Take snapshot`.
2. Follow the log until both steps are Done (`read_network_requests` filtered on `/deploy/deployments/` shows a GET about every 2 s while it runs). Expect several minutes for ~17,600 objects.
3. Checks:
   - `/deploy` → the snapshot row is Ready, source `uat`, Migration = uat's alembic number from Step 2, Files = uat's object count from Step 2.
   - uat's header still says Ready and its Overview commit is unchanged; the Deployments history shows the job as "Take snapshot".
   - Over SSH, the job left nothing behind:

     ```bash
     ssh jrh1812@10.10.48.63 'test -e /opt/serversherpa/uat/snapshot-work && echo left || echo gone'
     ssh jrh1812@10.10.48.63 'docker exec ss-uat-db-postgres-1 ls /tmp/sirdar-snapshot.dump 2>&1 | tail -1'
     curl -s -o /dev/null -w '%{http_code}\n' https://api.uat.serversherpa.com/healthz
     ```

     Expected: `gone`; `ls: /tmp/sirdar-snapshot.dump: No such file or directory`; `200`.

- [ ] **Step 5: Create uat2 from the uat snapshot**

On `/deploy` → **New environment** (ask Jimmy before **Create environment**):
- The steps bar shows Basics › Services › Data › Review.
- Basics: Create new; Name `uat2`; Type Custom; Target `uat VM`; Git ref `main`; Base domain empty (→ `uat2.serversherpa.com`); Proxy IP `10.10.48.6`; Bind IP `0.0.0.0` → Next.
- Services (+100 on every port): api `8100`, portal `8191`, kiosk `8190`, wiki `8196`, spaces `9100`, status `8195`, mailpit `8125` → Next.
- Data: **From a snapshot** → Snapshot `uat-<today> · uat · migration <n> · <size>` (the Mac seed is listed too; don't pick it) → Next.
- Review lists `/opt/serversherpa/uat2`, the ports and "Data: Snapshot uat-<today> (migration <n>), restored by the first deploy" → **Create environment**.

Checks: the page is `/deploy/environments/uat2`, status New; Overview shows "Seed snapshot uat-<today> (the first deploy restores it)" and the services at `10.10.48.63:8100` … . Optional, with Jimmy's yes: on `/deploy`, **Delete** on the uat snapshot and accept the confirm → the alert "That snapshot is in use…" and the row stays (uat2 hasn't deployed yet).

- [ ] **Step 6: Deploy uat2 (the first deploy restores the snapshot)**

**Deploy** (ask Jimmy first): the modal shows "This first deploy restores the snapshot uat-<today>: its database, files and sign-in keys." with Update selected → **Deploy**. The steps are 1 Preflight, 2 Bootstrap, 3 Fetch code, 4 Render config, 5 Build images, 8 Start data services, 9 Restore snapshot, 10 Start services. Build takes several minutes; Restore snapshot copies the bundle from Tower and uploads ~17,600 objects. If a step fails, read its log, fix the cause (a code bug is fixed TDD-style on the owning plan's task and redeployed to Tower), then **Retry** from that step.

Checks when it succeeds (status Ready, commit = main's head):

```bash
ENV=uat2
ssh jrh1812@10.10.48.63 "docker ps --filter label=com.docker.compose.project=ss-$ENV-api --format '{{.Names}} {{.Status}}'"
ssh jrh1812@10.10.48.63 "docker exec ss-$ENV-api-api-1 sh -c 'cd /app/api && alembic current' 2>/dev/null"
curl -s http://10.10.48.63:8100/healthz; echo
ssh jrh1812@10.10.48.63 "docker exec -i ss-$ENV-db-postgres-1 psql -U serversherpa -d serversherpa -tA -F' '" < $SCRATCH/counts.sql
ssh jrh1812@10.10.48.63 "docker exec -i ss-$ENV-api-api-1 python -" < $SCRATCH/count_objects.py
ssh jrh1812@10.10.48.63 "grep -E '^SS_(PASSWORD_PEPPER|TOTP_ENCRYPTION_KEY)=' /opt/serversherpa/$ENV/.env | sha256sum"
ssh jrh1812@10.10.48.63 'test -e /opt/serversherpa/uat2/restore-work && echo left || echo gone'
```

Expected: every `ss-uat2-api-*` container `Up` (api `healthy`); `<head> (head)`; `{"status":"ok"}`; `user_accounts`, `people` and `wiki_nodes` equal uat's from Step 2, `auth_sessions 0` (the restore cleared them), alembic = main's head (≥ uat's); the same object count and bytes as uat; the same SHA-256 as `UAT_KEYS_HASH`; `gone`.

The object-key check (every key the database points at exists in uat2's bucket):

```bash
ssh jrh1812@10.10.48.63 "docker exec -i ss-uat2-db-postgres-1 psql -U serversherpa -d serversherpa -tA" < $SCRATCH/storage_keys.sql > $SCRATCH/storage-keys.txt
wc -l < $SCRATCH/storage-keys.txt
scp $SCRATCH/storage-keys.txt jrh1812@10.10.48.63:/tmp/storage-keys.txt
ssh jrh1812@10.10.48.63 'docker cp /tmp/storage-keys.txt ss-uat2-api-api-1:/tmp/storage-keys.txt && rm /tmp/storage-keys.txt'
ssh jrh1812@10.10.48.63 "docker exec -i ss-uat2-api-api-1 python -" < $SCRATCH/check_keys.py
```

Expected: a key count in the hundreds or more, then `<N> keys in the database, 0 missing from serversherpa`.

In Sirdar: uat2's Overview shows Running commit = main's head and the Seed snapshot without the "(the first deploy restores it)" note; the Deployments row reads Update with the snapshot named in its details ("Restores snapshot uat-<today>").

- [ ] **Step 7: A seeded user signs in (Jimmy runs this)**

uat2 has no DNS or proxy hosts yet (phase 4), so sign in straight against its API port. Jimmy runs this in his own terminal and types his own email, password and 2FA code (Claude never sees or types them):

```bash
python3 - <<'PY'
import getpass, json, urllib.error, urllib.request
API = "http://10.10.48.63:8100"
def post(path, body, headers=None):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        return e.code, {"status": e.read().decode()[:120]}
status, body = post("/auth/login", {"email": input("Email: "), "password": getpass.getpass()})
print("password:", status, body.get("status"))
if body.get("status") == "totp_verify":
    status, body = post("/auth/totp/verify", {"code": input("2FA code: ")},
                        {"X-Totp-Challenge": body["challenge_token"]})
    print("2FA:", status, body.get("status"))
PY
```

Expected: `password: 200 totp_verify` then `2FA: 200 ok` (or `password: 200 ok` for an account without 2FA). A `401` means the snapshot's pepper or TOTP key didn't reach uat2's `.env`: compare the hashes from Steps 2 and 6 and stop.

- [ ] **Step 8: Backups and Restore backup on uat2 (never uat)**

1. uat2's first deploy took no dump. Make one: **Deploy** uat2 again with Update (ask Jimmy first). Steps 1–6 and 10 run; step 6 records a pre-deploy dump.
2. Change uat2's database so the restore is visible:

   ```bash
   ssh jrh1812@10.10.48.63 "docker exec ss-uat2-db-postgres-1 psql -U serversherpa -d serversherpa -c 'CREATE TABLE sirdar_restore_probe (id int)'"
   ```

3. uat2 → **Backups** tab: the table lists the dump just taken (`YYYYMMDDTHHMMSSZ.dump`, its time, its size), newest first; the hint says files are not rolled back. Compare with the target:

   ```bash
   ssh jrh1812@10.10.48.63 'ls -la --time-style=+%FT%T /opt/serversherpa/uat2/backups'
   ```

4. **Restore** on that dump (ask Jimmy first): the modal shows eyebrow "Backups", title "Restore backup", the backup's name, time and size, and the warning; **Restore backup** stays disabled until `uat2` is typed → click it. The page switches to Deployments with steps 1 Preflight, 8 Start data services, 9 Restore backup, 10 Start services.
5. Checks when it succeeds:

   ```bash
   ssh jrh1812@10.10.48.63 "docker exec ss-uat2-db-postgres-1 psql -U serversherpa -d serversherpa -tAc \"SELECT to_regclass('public.sirdar_restore_probe') IS NULL\""
   ssh jrh1812@10.10.48.63 "docker exec ss-uat2-api-api-1 sh -c 'cd /app/api && alembic current' 2>/dev/null"
   curl -s http://10.10.48.63:8100/healthz; echo
   ```

   Expected: `t` (the probe table is gone), `<head> (head)`, `{"status":"ok"}`. The Deployments row reads "Restore backup" and its details show "Restores backup <file>".
6. Roll back is not exercised here (it needs a failed Update; the API and UI tests cover it). If an Update of uat2 happens to fail at step 10 during this task, use it: the failed deployment shows **Roll back**; roll back uat2 (typed name) and check the commit returns to the previous one.

- [ ] **Step 9: UI checks (light and dark)**

In My preferences switch Theme to Dark, then revisit: the Snapshots section and both snapshot modals, the New environment Data step, the Deploy modal's "After the reset" (open it on **uat2** only, select Reset data to see it, then Cancel — never on uat), the Backups tab and Restore backup modal (Cancel), and a deployment's details. Readable contrast, no white blocks, the ComboBox lists open over the modal edges. Switch back to Light and spot-check. Optional permission check: if Jimmy has a view-only (`admin` role) account at hand, he signs in with it in a private window: no Upload, Take snapshot or Delete; no Restore on Backups; no Roll back.

- [ ] **Step 10: uat is untouched**

```bash
ENV=uat
ssh jrh1812@10.10.48.63 "docker exec -i ss-$ENV-db-postgres-1 psql -U serversherpa -d serversherpa -tA -F' '" < $SCRATCH/counts.sql
ssh jrh1812@10.10.48.63 "grep -E '^SS_(PASSWORD_PEPPER|TOTP_ENCRYPTION_KEY)=' /opt/serversherpa/$ENV/.env | sha256sum"
ssh jrh1812@10.10.48.63 'ls /opt/serversherpa/uat/backups'
curl -s -o /dev/null -w '%{http_code}\n' https://api.uat.serversherpa.com/healthz
```

Expected: the same counts as Step 2 (sessions may differ: people sign in), the same hash as `UAT_KEYS_HASH`, uat's backups unchanged (no restore touched them), `200`. In Sirdar, uat's Deployments show only the Take snapshot job added by this task.

- [ ] **Step 11: Clean up**

Ask Jimmy which of these to do (default: keep uat2 running for him to look at, keep the uat snapshot, delete the Mac seed upload):

- Delete snapshots he doesn't want: `/deploy` → Snapshots → **Delete** (confirm). The uat snapshot can be deleted now that uat2 has deployed. On Tower, `/app/snapshots` then holds only the kept bundles and `incoming/` is empty.
- Tear uat2 down (its data and containers; the Sirdar record stays until phase 4 adds Delete environment — note that in the report):

  ```bash
  ssh jrh1812@10.10.48.63 '/opt/serversherpa/uat2/repo/deploy/stack/ss-stack down /opt/serversherpa/uat2 --volumes </dev/null'
  ssh jrh1812@10.10.48.63 "docker ps -a --format '{{.Names}}' | grep -c '^ss-uat2-' ; docker volume ls -q | grep -c '^ss-uat2-'"
  ```

  Expected: `0` and `0`. Removing the folder needs root (Jimmy): `sudo rm -rf /opt/serversherpa/uat2`. The images built for main stay on the VM (the next uat Update reuses them).
- Remove the scratch helper files and the copied key list: `rm -f $SCRATCH/storage-keys.txt` (and confirm `~/Downloads/seed-dev-*.tar.gz` is gone).
- Leave Tower's installer settings as they are.

Report: each step's result (passed, or what failed and the fix commit), the numbers compared in Steps 2 and 6 (users, people, wiki nodes, objects, keys missing = 0, alembic), the sign-in result, what was kept or torn down, and that uat was never reset (Step 10).

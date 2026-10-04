// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@portal/lib/api', async (orig) => ({
  ...(await orig<typeof import('@portal/lib/api')>()), apiFetch: fetchMock,
}));

import { ApiError } from '@portal/lib/api';

import * as sirdar from './sirdarApi';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
beforeEach(() => { fetchMock.mockReset(); fetchMock.mockResolvedValue(ok({})); });

const NEW_BODY = { name: 'qa', type: 'custom' as const, target: 'ssh:lab', git_ref: 'main',
                   proxy_ip: '10.10.48.6', bind_ip: '0.0.0.0', ports: { api: 8100 } };
const CALLS: { name: string; call: () => Promise<unknown>; path: string; method?: string; body?: unknown }[] = [
  { name: 'listEnvironments', call: () => sirdar.listEnvironments(), path: '/deploy/environments' },
  { name: 'getEnvironment', call: () => sirdar.getEnvironment('qa east'), path: '/deploy/environments/qa%20east' },
  { name: 'getEnvironmentDefaults', call: () => sirdar.getEnvironmentDefaults(), path: '/deploy/environment-defaults' },
  { name: 'createEnvironment', call: () => sirdar.createEnvironment(NEW_BODY), path: '/deploy/environments',
    method: 'POST', body: { mode: 'new', ...NEW_BODY } },
  { name: 'adoptEnvironment', call: () => sirdar.adoptEnvironment({ name: 'uat', type: 'dev', target: 'ssh', git_ref: 'main' }),
    path: '/deploy/environments', method: 'POST',
    body: { mode: 'adopt', name: 'uat', type: 'dev', target: 'ssh', git_ref: 'main' } },
  { name: 'updateEnvironment', call: () => sirdar.updateEnvironment('uat', { keep_dumps: 3 }),
    path: '/deploy/environments/uat', method: 'PATCH', body: { keep_dumps: 3 } },
  { name: 'startDeployment', call: () => sirdar.startDeployment('uat', { mode: 'reset', git_ref: 'main', confirm_name: 'uat' }),
    path: '/deploy/environments/uat/deployments', method: 'POST',
    body: { mode: 'reset', git_ref: 'main', confirm_name: 'uat' } },
  { name: 'listDeployments', call: () => sirdar.listDeployments('uat'), path: '/deploy/environments/uat/deployments?limit=20' },
  { name: 'getDeployment', call: () => sirdar.getDeployment('d1'), path: '/deploy/deployments/d1' },
  { name: 'cancelDeployment', call: () => sirdar.cancelDeployment('d1'), path: '/deploy/deployments/d1/cancel', method: 'POST' },
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

it.each(CALLS)('$name calls $path', async ({ call, path, method, body }) => {
  await call();
  const [p, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
  expect(p).toBe(path);
  expect(init?.method).toBe(method);
  expect(init?.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(body);
});

/** Every error code the deploy routes and the environment/gitref services can answer. */
function deployCodes(): string[] {
  // jsdom replaces the global URL, so resolve from the file's path as a string.
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../../api/src/sirdar_api');
  const found = new Set<string>(['sudo_password_too_long']);
  for (const file of ['api/routes/deploy.py', 'deploy/environments.py', 'deploy/gitref.py',
                       'deploy/ssh_targets.py', 'deploy/snapshots.py']) {
    const src = readFileSync(join(root, file), 'utf8');
    for (const re of [/"code": "([a-z_]+)"/g, /(?:EnvError|RefError|TargetError|SnapshotError)\("([a-z_]+)"/g,
                      /"([a-z]+_too_long)"/g, /_check_ipv4\([^()]*,\s*"([a-z]+_[a-z_]+)"\)/g]) {
      for (const m of src.matchAll(re)) found.add(m[1]);
    }
  }
  return [...found].sort();
}

it('every error code the deploy routes can return has its own message', () => {
  const codes = deployCodes();
  expect(codes.length).toBeGreaterThan(40);       // not vacuous
  expect(codes).toContain('adopt_env_incomplete');
  expect(codes).toContain('proxy_ip_invalid');
  expect(codes).toContain('ref_lookup_failed');
  expect(codes).toContain('snapshot_in_use');
  expect(codes).toContain('rollback_not_latest');
  const missing = codes.filter((c) => sirdar.errorText(new ApiError(400, c), '__none__') === '__none__');
  expect(missing).toEqual([]);
});

it('deployErrorText adds the reason, the missing keys or the named key', () => {
  expect(sirdar.deployErrorText(
    new ApiError(502, 'connect_failed', { code: 'connect_failed', reason: 'Timed out.' }), 'x')).toBe('Timed out.');
  expect(sirdar.deployErrorText(
    new ApiError(422, 'adopt_env_incomplete', { code: 'adopt_env_incomplete', missing: ['SS_JWT_SECRET', 'SS_PASSWORD_PEPPER'] }), 'x'))
    .toBe('That .env is missing required secrets (SS_JWT_SECRET, SS_PASSWORD_PEPPER).');
  expect(sirdar.deployErrorText(
    new ApiError(422, 'adopt_value_invalid', { code: 'adopt_value_invalid', key: 'STACK_DOMAIN' }), 'x'))
    .toBe("A value in that .env isn't valid (STACK_DOMAIN).");
  expect(sirdar.deployErrorText(
    new ApiError(422, 'port_invalid', { code: 'port_invalid', service: 'api' }), 'x'))
    .toBe('Use a port from 1 to 65535 (api).');
  expect(sirdar.deployErrorText(new Error('boom'), 'Fallback.')).toBe('Fallback.');
});

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

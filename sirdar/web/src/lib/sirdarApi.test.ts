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
  for (const file of ['api/routes/deploy.py', 'api/routes/integrations.py', 'deploy/environments.py',
                       'deploy/gitref.py', 'deploy/ssh_targets.py', 'deploy/snapshots.py', 'deploy/integrations.py',
                       'deploy/vms.py', 'deploy/do_accounts.py', 'deploy/do_envs.py', 'deploy/pipeline.py']) {
    const src = readFileSync(join(root, file), 'utf8');
    for (const re of [/"code": "([a-z_]+)"/g,
                      /(?:EnvError|RefError|TargetError|SnapshotError|IntegrationError|VmError|DoEnvError)\("([a-z_]+)"/g,
                      /^\s+code = "([a-z_]+)"$/gm,
                      /"(vm_[a-z_]+_invalid)"/g, /, "([a-z_]+_invalid)"\)/g,
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
  for (const code of ['integration_not_configured', 'publish_off', 'nothing_to_claim', 'claim_conflict',
                      'token_invalid', 'npm_url_invalid', 'secret_required', 'publish_not_allowed',
                      'proxmox_url_invalid', 'node_invalid', 'template_vmid_invalid', 'proxmox_token_invalid',
                      'tls_untrusted', 'tls_mismatch', 'integration_in_use', 'vm_cores_invalid', 'vm_disk_shrink',
                      'vm_ip_invalid', 'ip_in_use', 'adopt_not_allowed', 'host_ip_managed', 'target_kind_locked',
                      'vm_snapshot_not_found', 'vm_snapshot_keys_changed', 'not_vm_environment', 'vm_not_ready',
                      'esxi_url_invalid', 'source_vm_invalid', 'dns_servers_invalid', 'vm_name_invalid',
                      'do_token_invalid', 'do_account_invalid', 'label_invalid', 'region_invalid',
                      'not_supported_on_digitalocean', 'seed_not_allowed', 'slot_not_deployed',
                      'snapshot_slot_unreachable', 'do_account_changed']) {
    expect(codes).toContain(code);
  }
  const missing = codes.filter((c) => sirdar.errorText(new ApiError(400, c), '__none__') === '__none__');
  expect(missing).toEqual([]);
});

it('a production snapshot that can\'t be taken says to retry, not to untick', () => {
  expect(sirdar.deployErrorText(new ApiError(409, 'snapshot_slot_unreachable',
    { code: 'snapshot_slot_unreachable', production: true }), 'x')).toMatch(/Retry once the droplet is back/);
  expect(sirdar.deployErrorText(new ApiError(409, 'snapshot_slot_unreachable',
    { code: 'snapshot_slot_unreachable' }), 'x')).toMatch(/Untick 'Save a snapshot first'/);
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

it('deployErrorText names the integrations a publish still needs', () => {
  const err = new ApiError(409, 'integration_not_configured',
    { code: 'integration_not_configured', kinds: ['cloudflare', 'npm'] });
  expect(sirdar.deployErrorText(err, 'x'))
    .toBe('Set up Cloudflare and Nginx Proxy Manager in Settings › Integrations first.');
  const one = new ApiError(409, 'integration_not_configured', { code: 'integration_not_configured', kinds: ['npm'] });
  expect(sirdar.deployErrorText(one, 'x')).toBe('Set up Nginx Proxy Manager in Settings › Integrations first.');
});

it('the publishing codes read as the controller addendum words them', () => {
  const text = (code: string) => sirdar.errorText(new ApiError(409, code, { code }), 'x');
  expect(text('claim_conflict')).toBe('Someone else claimed that entry first. Reload the Publish tab.');
  expect(text('nothing_to_claim')).toBe("There's nothing to claim.");
  expect(text('publish_not_allowed'))
    .toBe("Adopted environments start with publishing off; turn it on from the environment's Publish tab.");
  expect(text('publish_off')).toBe(
    'Publishing is off for this environment. Turn it on from the Publish tab, or retry from an earlier step.',
  );
});

it('secret_required shows the reason the API gives', () => {
  const err = new ApiError(422, 'secret_required',
    { code: 'secret_required', reason: 'Enter the token again: the zone changed.' });
  expect(sirdar.deployErrorText(err, 'x')).toBe('Enter the token again: the zone changed.');
});

it('integration_in_use names the environments that still use it', () => {
  expect(sirdar.deployErrorText(new ApiError(409, 'integration_in_use',
    { code: 'integration_in_use', environments: ['uat3', 'uat4'] }), 'x'))
    .toBe('Environments still use it: uat3, uat4. Delete them first.');
  expect(sirdar.INTEGRATION_LABEL.proxmox).toBe('Proxmox');
});

const apiError = (status: number, detail: { code: string } & Record<string, unknown>) =>
  new ApiError(status, detail.code, detail);

it('names ESXi in integration_not_configured and explains the new codes', () => {
  expect(sirdar.deployErrorText(apiError(409, { code: 'integration_not_configured', kinds: ['esxi'] }), 'x'))
    .toBe('Set up VMware ESXi in Settings › Integrations first.');
  for (const code of ['esxi_url_invalid', 'esxi_user_invalid', 'datastore_invalid', 'network_invalid',
    'resource_pool_invalid', 'source_vm_invalid', 'dns_servers_invalid', 'not_vm_environment', 'vm_name_invalid']) {
    expect(sirdar.deployErrorText(apiError(422, { code }), 'fallback')).not.toBe('fallback');
  }
  expect(sirdar.INTEGRATION_LABEL.esxi).toBe('VMware ESXi');
  expect(sirdar.errorText(new ApiError(409, 'not_proxmox'), '__none__')).toBe('__none__');
});

it('the VM-host codes read host-neutral', () => {
  const text = (code: string) => sirdar.errorText(new ApiError(409, code, { code }), 'x');
  expect(text('vm_not_allowed')).toBe('Only an environment on a VM host has a VM.');
  expect(text('target_kind_locked'))
    .toBe("An environment can't move between an SSH target and a VM host, or between VM hosts.");
  expect(text('tls_untrusted')).toBe("Sirdar doesn't trust this server's certificate yet.");
  expect(text('not_vm_environment')).toBe("This environment isn't on a VM host.");
  expect(text('vm_name_invalid')).toBe("The environment name can't be used as a VM host name.");
});

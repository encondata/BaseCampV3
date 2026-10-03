// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a !== 'change' || perms.change) }),
}));
const api = vi.hoisted(() => ({
  getDeployTargets: vi.fn(), getEnvironmentDefaults: vi.fn(), createEnvironment: vi.fn(),
  adoptEnvironment: vi.fn(), trustKnownHost: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import NewEnvironmentModal from './NewEnvironmentModal';
import { DEFAULTS, ENV, TARGETS } from './testData';

Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
beforeEach(() => {
  perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getDeployTargets.mockResolvedValue(TARGETS);
  api.getEnvironmentDefaults.mockResolvedValue(DEFAULTS);
  api.createEnvironment.mockResolvedValue(ENV);
});
afterEach(cleanup);

async function open(onCreated = vi.fn(), onClose = vi.fn()) {
  render(<NewEnvironmentModal onCreated={onCreated} onClose={onClose} />);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
  return { onCreated, onClose };
}
const next = () => userEvent.click(screen.getByRole('button', { name: 'Next' }));

async function fillBasics(name = 'qa') {
  await userEvent.type(screen.getByLabelText('Name'), name);
  await userEvent.click(screen.getByRole('radio', { name: 'Custom' }));
  await userEvent.type(screen.getByLabelText('Proxy IP'), '10.10.48.6');
}

it('has the report-generate header and the Create steps', async () => {
  await open();
  expect(screen.getByRole('heading', { name: 'New environment' })).toBeTruthy();
  expect(screen.getByText('Deploy', { selector: '.eyebrow' })).toBeTruthy();
  expect(screen.getByText(/Sirdar generates its secrets/)).toBeTruthy();
  expect(['Basics', 'Services', 'Review'].every((s) => screen.getByText(s))).toBe(true);
});

it('creates an environment through Basics, Services and Review', async () => {
  const { onCreated } = await open();
  await fillBasics();
  await next();
  const table = await screen.findByRole('table', { name: 'Services' });
  expect(within(table).getByText('api.qa.serversherpa.com')).toBeTruthy();
  const apiPort = screen.getByLabelText('api port') as HTMLInputElement;
  expect(apiPort.value).toBe('8000');
  await userEvent.clear(apiPort);
  await userEvent.type(apiPort, '8100');
  await next();
  expect(screen.getByText('/opt/serversherpa/qa')).toBeTruthy();
  expect(within(screen.getByRole('table', { name: 'Services to create' })).getByText('8100')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(ENV));
  expect(api.createEnvironment).toHaveBeenCalledWith({
    name: 'qa', type: 'custom', target: 'ssh:lab', git_ref: 'main', proxy_ip: '10.10.48.6', bind_ip: '0.0.0.0',
    ports: { api: 8100, portal: 8091, kiosk: 8090, wiki: 8096, spaces: 9000, status: 8095, mailpit: 8025 },
  });
});

it('checks the basics and the ports before moving on', async () => {
  await open();
  await next();
  expect(screen.getByText('Enter a name.')).toBeTruthy();
  expect(screen.getByText('Enter the proxy IP.')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Name'), 'dev');
  await userEvent.type(screen.getByLabelText('Proxy IP'), '10.10.48.6');
  await next();
  expect(screen.getByText('That name is reserved. Choose a different one.')).toBeTruthy();
  await userEvent.clear(screen.getByLabelText('Name'));
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await next();
  const portal = await screen.findByLabelText('portal port');
  await userEvent.clear(portal);
  await userEvent.type(portal, '8000');
  await next();
  expect(screen.getByText("Two services can't use the same port.")).toBeTruthy();
  expect(api.createEnvironment).not.toHaveBeenCalled();
});

it('an API error goes back to the step that owns the field', async () => {
  api.createEnvironment.mockRejectedValue(new ApiError(409, 'environment_exists', { code: 'environment_exists' }));
  await open();
  await fillBasics();
  await next();
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  expect(await screen.findByText('An environment with that name already exists.')).toBeTruthy();
  expect(screen.getByLabelText('Name')).toBeTruthy();
});

it('adopts an existing environment and lists what it imported and ignored', async () => {
  api.adoptEnvironment.mockResolvedValue({
    ...ENV, imported_secrets: ['POSTGRES_PASSWORD', 'SS_JWT_SECRET'], ignored_keys: ['MINIO_ROOT_PASSWORD'],
  });
  const { onCreated } = await open();
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  expect(screen.queryByLabelText('Proxy IP')).toBeNull();
  expect(screen.getByText('Result')).toBeTruthy();
  expect(screen.getByText(/changes nothing/)).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));
  expect(await screen.findByText('MINIO_ROOT_PASSWORD')).toBeTruthy();
  expect(screen.getByText('POSTGRES_PASSWORD')).toBeTruthy();
  expect(screen.getByText('SS_JWT_SECRET')).toBeTruthy();
  expect(api.adoptEnvironment).toHaveBeenCalledWith({ name: 'uat', type: 'dev', target: 'ssh:lab', git_ref: 'main' });
  await userEvent.click(screen.getByRole('button', { name: 'Open environment' }));
  expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ name: 'uat' }));
});

it('adopt: an unknown host key asks to trust it with the target, then adopts', async () => {
  api.adoptEnvironment
    .mockRejectedValueOnce(new ApiError(409, 'host_key_unknown', {
      code: 'host_key_unknown', host: '10.10.48.63', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc' }))
    .mockResolvedValueOnce({ ...ENV, imported_secrets: [], ignored_keys: [] });
  api.trustKnownHost.mockResolvedValue({});
  await open();
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Trust and adopt' }));
  expect(await screen.findByText('None. Sirdar knows every key in that .env.')).toBeTruthy();
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.63', 22, 'SHA256:abc', 'ssh:lab');
  expect(api.adoptEnvironment).toHaveBeenCalledTimes(2);
});

it('adopt: a mismatched host key explains what to do', async () => {
  api.adoptEnvironment.mockRejectedValue(new ApiError(409, 'host_key_mismatch', {
    code: 'host_key_mismatch', host: '10.10.48.63', port: 22, key_type: 'ssh-ed25519', expected: 'SHA256:old', actual: 'SHA256:new' }));
  await open();
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));
  expect(await screen.findByText(/doesn't match the one Sirdar trusted/)).toBeTruthy();
  expect(screen.getByText(/Trusted SSH hosts/)).toBeTruthy();
});

it('Escape and Cancel close it', async () => {
  const { onClose } = await open();
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(2);
});

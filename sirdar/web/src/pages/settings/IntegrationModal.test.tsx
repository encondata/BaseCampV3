// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ saveIntegration: vi.fn(), testIntegration: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import type { PublishKind, Integrations } from '../../lib/sirdarApi';
import { CF_CHECK, INTEGRATIONS, NO_INTEGRATIONS } from '../environments/testData';

import IntegrationModal from './IntegrationModal';

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.saveIntegration.mockResolvedValue(INTEGRATIONS);
  api.testIntegration.mockResolvedValue(CF_CHECK);
});
afterEach(cleanup);

function show(kind: PublishKind, current: Integrations = NO_INTEGRATIONS) {
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

it('any edit clears a Test result that no longer matches the form', async () => {
  const { dialog } = show('cloudflare');
  await userEvent.type(within(dialog).getByLabelText('Public IP'), '203.0.113.7');
  await userEvent.type(within(dialog).getByLabelText('API token'), 'cf-token-123456789012345');
  for (const edit of ['Zone', 'Public IP', 'API token']) {
    await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
    await within(dialog).findByRole('list', { name: 'Cloudflare test' });
    await userEvent.type(within(dialog).getByLabelText(edit), '9');
    expect(within(dialog).queryByRole('list', { name: 'Cloudflare test' })).toBeNull();
  }
});

it('a Test answer for values edited since is dropped', async () => {
  let release: (v: typeof CF_CHECK) => void = () => {};
  api.testIntegration.mockImplementation(() => new Promise((r) => { release = r; }));
  const { dialog } = show('npm', INTEGRATIONS);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  await userEvent.type(within(dialog).getByLabelText('Login email'), 'x');
  release(CF_CHECK);
  await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(false));
  expect(within(dialog).queryByRole('list', { name: 'Nginx Proxy Manager test' })).toBeNull();
});

it('editing NPM keeps the stored password unless it is replaced, and never offers Clear', async () => {
  const { onSaved, dialog } = show('npm', INTEGRATIONS);
  expect(within(dialog).getByText('Password: set')).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: 'Clear' })).toBeNull();
  expect((within(dialog).getByLabelText("Let's Encrypt email") as HTMLInputElement).value).toBe('');
  expect(within(dialog).getByText(
    "Older Nginx Proxy Manager versions use this; 2.13 and later use the NPM login's own email.")).toBeTruthy();
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

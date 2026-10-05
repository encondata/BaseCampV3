// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ saveIntegration: vi.fn(), testIntegration: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import type { Integrations } from '../../lib/sirdarApi';
import {
  ESXI_CERT, ESXI_CHECK, ESXI_FINGERPRINT, ESXI_PASSWORD, INTEGRATIONS, NO_INTEGRATIONS,
} from '../environments/testData';

import EsxiModal from './EsxiModal';

const UNTRUSTED = new ApiError(409, 'tls_untrusted', { code: 'tls_untrusted', ...ESXI_CERT });
const FIELDS = { url: 'https://10.10.48.10', user: 'sirdar', datastore: 'datastore1', network: 'VM Network',
                 resource_pool: null, source_vm: 'sirdar-ubuntu-2404-seed', dns_servers: [] };

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.saveIntegration.mockResolvedValue(INTEGRATIONS);
  api.testIntegration.mockResolvedValue(ESXI_CHECK);
});
afterEach(cleanup);

function show(current: Integrations = NO_INTEGRATIONS) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<EsxiModal current={current} onSaved={onSaved} onClose={onClose} />);
  return { onSaved, onClose, dialog: screen.getByRole('dialog', { name: 'VMware ESXi' }) };
}
const input = (dialog: HTMLElement, label: string) => within(dialog).getByLabelText(label) as HTMLInputElement;

it('has the report-generate header', () => {
  const { dialog } = show();
  expect(within(dialog).getByText('Integrations', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByRole('heading', { name: 'VMware ESXi' })).toBeTruthy();
  expect(dialog.querySelector('.rgm-head-text .page-hint')?.textContent).toMatch(/standalone host/);
});

it('setting up prefills the usual names and asks for a password', () => {
  const { dialog } = show();
  expect(input(dialog, 'User').value).toBe('sirdar');
  expect(input(dialog, 'Port group').value).toBe('VM Network');
  expect(input(dialog, 'Datastore').value).toBe('datastore1');
  expect(input(dialog, 'Seed VM').value).toBe('sirdar-ubuntu-2404-seed');
  expect(input(dialog, 'Password').value).toBe('');
  expect(input(dialog, 'Password').type).toBe('password');
  expect(within(dialog).getByText(/Not trusted yet/)).toBeTruthy();
});

it('sets up ESXi: the certificate is shown and trusted, then the same save is sent with it', async () => {
  api.saveIntegration.mockRejectedValueOnce(UNTRUSTED).mockResolvedValueOnce(INTEGRATIONS);
  const { onSaved, dialog } = show();
  await userEvent.type(input(dialog, 'URL'), 'https://10.10.48.10');
  await userEvent.type(input(dialog, 'Password'), ESXI_PASSWORD);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  const prompt = await within(dialog).findByRole('group', { name: 'Server certificate' });
  expect(within(prompt).getByText(/Host Client/)).toBeTruthy();
  expect(within(prompt).getByText(/rui\.crt/)).toBeTruthy();
  expect(within(prompt).getByText(ESXI_CERT.fingerprint)).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
  await userEvent.click(within(prompt).getByRole('button', { name: 'Trust this certificate' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(INTEGRATIONS));
  expect(api.saveIntegration.mock.calls[0]).toEqual(
    ['esxi', { ...FIELDS, tls_fingerprint: null, password: ESXI_PASSWORD }]);
  expect(api.saveIntegration.mock.calls[1]).toEqual(
    ['esxi', { ...FIELDS, tls_fingerprint: ESXI_CERT.fingerprint, password: ESXI_PASSWORD }]);
  expect(document.body.textContent).not.toContain(ESXI_PASSWORD);
});

it('Test checks the stored settings and lists the six checks', async () => {
  const { dialog } = show(INTEGRATIONS);
  expect(within(dialog).getByText('Password: set')).toBeTruthy();
  expect(within(dialog).getByText(ESXI_FINGERPRINT)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  const list = await within(dialog).findByRole('list', { name: 'VMware ESXi test' });
  expect([...list.querySelectorAll('b')].map((b) => b.textContent))
    .toEqual(['ESXi', 'License', 'Datastore', 'Network', 'Resource pool', 'Seed VM']);
  expect(api.testIntegration).toHaveBeenCalledWith('esxi', { ...FIELDS, tls_fingerprint: ESXI_FINGERPRINT });
});

it.each([
  ['URL', 'http://x', 'Start with https://, then the host and port only.'],
  ['Seed VM', '', 'Enter the seed VM, like sirdar-ubuntu-2404-seed.'],
  ['DNS servers', '10.10.48.1, nope', 'Use up to 3 IPv4 addresses, separated by commas.'],
  ['User', 'a b', 'Enter the ESXi user, like sirdar.'],
])('a bad %s blocks Save without a request', async (label, value, text) => {
  const { dialog } = show(INTEGRATIONS);
  const field = input(dialog, label);
  await userEvent.clear(field);
  if (value) await userEvent.type(field, value);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(within(dialog).getByText(text)).toBeTruthy();
  expect(api.saveIntegration).not.toHaveBeenCalled();
});

it('sends DNS servers as a list and an empty resource pool as null', async () => {
  const { dialog } = show(INTEGRATIONS);
  await userEvent.type(input(dialog, 'DNS servers'), '10.10.48.1, 1.1.1.1');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.saveIntegration).toHaveBeenCalled());
  const sent = api.saveIntegration.mock.calls[0][1];
  expect(sent.dns_servers).toEqual(['10.10.48.1', '1.1.1.1']);
  expect(sent.resource_pool).toBeNull();
  expect(sent).not.toHaveProperty('password');
});

it.each([
  ['URL', 'https://10.10.48.11'],
  ['User', 'root'],
])('a different %s needs the password again', async (label, value) => {
  const { dialog } = show(INTEGRATIONS);
  const field = input(dialog, label);
  await userEvent.clear(field);
  await userEvent.type(field, value);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(within(dialog).getByText('Enter the password again for a different host or user.')).toBeTruthy();
  expect(api.saveIntegration).not.toHaveBeenCalled();
});

it('API errors land on their field', async () => {
  api.saveIntegration.mockRejectedValue(new ApiError(422, 'datastore_invalid', { code: 'datastore_invalid' }));
  const { dialog } = show(INTEGRATIONS);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  const err = await within(dialog).findByRole('alert');
  expect(input(dialog, 'Datastore').getAttribute('aria-invalid')).toBe('true');
  expect(err.textContent).toBeTruthy();
});

it('a bare tls_untrusted shows the message instead of a prompt', async () => {
  api.testIntegration.mockRejectedValueOnce(new ApiError(409, 'tls_untrusted', { code: 'tls_untrusted' }));
  const { dialog } = show(INTEGRATIONS);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  expect(await within(dialog).findByText("Sirdar doesn't trust this server's certificate yet.")).toBeTruthy();
  expect(within(dialog).queryByRole('group', { name: 'Server certificate' })).toBeNull();
});

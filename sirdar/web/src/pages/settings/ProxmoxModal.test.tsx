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

it.each([
  ['a code-only detail', { code: 'tls_untrusted' }, "Sirdar doesn't trust this Proxmox server's certificate yet."],
  ['a null detail', null, "Sirdar doesn't trust this Proxmox server's certificate yet."],
  ['a mismatch without both fingerprints', { code: 'tls_mismatch', expected: PX_FINGERPRINT },
   "The Proxmox server's certificate doesn't match the one Sirdar trusted."],
])('a certificate answer with %s shows the message instead of a prompt', async (_name, detail, text) => {
  const code = (detail as { code?: string } | null)?.code ?? 'tls_untrusted';
  api.testIntegration.mockRejectedValueOnce(new ApiError(409, code, detail));
  const { dialog } = show(INTEGRATIONS);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  expect(await within(dialog).findByText(text)).toBeTruthy();
  expect(within(dialog).queryByRole('group', { name: 'Server certificate' })).toBeNull();
});

it('a certificate without names still shows the prompt', async () => {
  const { names: _names, ...rest } = PX_CERT;
  api.testIntegration.mockRejectedValueOnce(new ApiError(409, 'tls_untrusted', { code: 'tls_untrusted', ...rest }));
  const { dialog } = show(INTEGRATIONS);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  const prompt = await within(dialog).findByRole('group', { name: 'Server certificate' });
  expect(within(prompt).getByText(PX_CERT.fingerprint)).toBeTruthy();
});

it('never prefills the token; keeping it sends no token key', async () => {
  const { dialog } = show(INTEGRATIONS);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
  expect((within(dialog).getByLabelText('API token') as HTMLInputElement).value).toBe('');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.saveIntegration).toHaveBeenCalled());
  expect(api.saveIntegration.mock.calls[0][1]).not.toHaveProperty('token');
});

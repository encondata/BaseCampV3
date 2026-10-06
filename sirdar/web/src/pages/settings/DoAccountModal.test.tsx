// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ saveDoAccount: vi.fn(), testDoAccount: vi.fn(), getDoRegions: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { DO_ACCOUNTS } from '../environments/testData';

import DoAccountModal from './DoAccountModal';

const TOKEN = `dop_v1_${'0123456789abcdef'.repeat(4)}`;
const RENEW = `dop_v1_${'fedcba9876543210'.repeat(4)}`;
Element.prototype.scrollIntoView = () => {};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.saveDoAccount.mockResolvedValue({ accounts: DO_ACCOUNTS });
  api.getDoRegions.mockResolvedValue({ regions: [{ slug: 'nyc3', name: 'New York 3' }], default: 'nyc3' });
  api.testDoAccount.mockResolvedValue({
    ok: true, target: 'digitalocean', facts: {},
    checks: [{ label: 'Account', status: 'pass', value: 'ops@encondata.com · active' },
             { label: 'Renewal token', status: 'pass', value: 'Certificates and load balancers only' }],
  });
});
afterEach(cleanup);

function show(key: 'production' | 'development' = 'development') {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<DoAccountModal account={DO_ACCOUNTS.find((a) => a.key === key)!} onSaved={onSaved} onClose={onClose} />);
  return { onSaved, onClose, dialog: screen.getByRole('dialog', { name: /DigitalOcean/ }) };
}

it('has the report-generate header and two write-only tokens', () => {
  const { dialog } = show();
  expect(within(dialog).getByText('Integrations', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByRole('heading', { name: 'DigitalOcean · Development' })).toBeTruthy();
  expect(within(dialog).getByText(/Custom Scopes/)).toBeTruthy();
  expect((within(dialog).getByLabelText('API token') as HTMLInputElement).type).toBe('password');
  expect((within(dialog).getByLabelText('Renewal token') as HTMLInputElement).type).toBe('password');
});

it('sets up an account: label, region and both tokens; no token reaches the page', async () => {
  const { onSaved, dialog } = show();
  await userEvent.type(within(dialog).getByLabelText('API token'), TOKEN);
  await userEvent.type(within(dialog).getByLabelText('Renewal token'), RENEW);
  await userEvent.type(within(dialog).getByLabelText('Region'), 'nyc3');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(api.saveDoAccount).toHaveBeenCalledWith('development', {
    label: 'Development', region: 'nyc3', token: TOKEN, renewal_token: RENEW });
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(DO_ACCOUNTS));
  expect(document.body.textContent).not.toContain(TOKEN);
});

it('keeps the stored tokens and offers the account\'s regions', async () => {
  const { dialog } = show('production');
  await waitFor(() => expect(api.getDoRegions).toHaveBeenCalledWith('production'));
  expect(within(dialog).getByRole('combobox', { name: 'Region' })).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(api.saveDoAccount).toHaveBeenCalledWith('production', { label: 'Production', region: 'nyc3' });
});

it('checks the token shape before sending', async () => {
  const { dialog } = show();
  await userEvent.type(within(dialog).getByLabelText('API token'), 'dop_v1_short');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText("That doesn't look like a DigitalOcean API token.")).toBeTruthy();
  expect(api.saveDoAccount).not.toHaveBeenCalled();
});

it('Test shows the checks without saving', async () => {
  const { dialog } = show('production');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  expect(await within(dialog).findByText('Certificates and load balancers only')).toBeTruthy();
  expect(api.testDoAccount).toHaveBeenCalledWith('production', { label: 'Production', region: 'nyc3' });
  expect(api.saveDoAccount).not.toHaveBeenCalled();
});

it("shows the API's reason for a token from another team", async () => {
  api.saveDoAccount.mockRejectedValue(new ApiError(409, 'do_team_changed', { code: 'do_team_changed', environments: ['prod'] }));
  const { dialog } = show('production');
  const tokenRow = within(dialog).getByText('API token: set').parentElement!;      // SecretField's Replace is named "Replace"
  await userEvent.click(within(tokenRow).getByRole('button', { name: 'Replace' }));
  await userEvent.type(within(dialog).getByLabelText('API token'), TOKEN);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText(/different DigitalOcean team/)).toBeTruthy();
});

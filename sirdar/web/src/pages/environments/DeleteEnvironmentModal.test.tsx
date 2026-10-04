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
  expect(within(dialog).getByText(
    /removes the whole \/opt\/serversherpa\/uat folder from the host, backups included\. Snapshots taken from uat are kept/,
  )).toBeTruthy();
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
  expect(await within(dialog).findByText('Set up Cloudflare in Settings › Integrations first.'))
    .toBeTruthy();
});

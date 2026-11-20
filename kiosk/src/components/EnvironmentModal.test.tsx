// @vitest-environment jsdom
/** The laptop's environment chooser (Settings › This Kiosk › Change…):
 *  password, then the list, then the confirm, with the edge's refusals in
 *  the words the kiosk shows for them. */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  unlockEnvironment: vi.fn(),
  switchEnvironment: vi.fn(),
  getEdgeEnvironments: vi.fn(),
}));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<object>()), ...api }));

const order = vi.hoisted(() => [] as string[]);
const reset = vi.hoisted(() => ({ clearForSwitch: vi.fn() }));
vi.mock('../lib/factoryReset', () => reset);
const reload = vi.hoisted(() => ({ reloadToLogin: vi.fn() }));
vi.mock('./ClearSetupModal', () => reload);

import { ApiError, type EdgeEnvironment, type EdgeEnvironmentEntry } from '../lib/api';
import EnvironmentModal from './EnvironmentModal';

const entry = (id: string, name: string, domain: string): EdgeEnvironmentEntry => ({
  id, name, domain, api_url: `https://api.${domain}`, portal_url: `https://portal.${domain}`,
  is_prod: domain === 'serversherpa.com',
});
const LIST: EdgeEnvironmentEntry[] = [
  entry('prod', 'Prod', 'serversherpa.com'),
  entry('rc1', 'RC1', 'rc1.serversherpa.com'),
  entry('uat', 'UAT', 'uat.serversherpa.com'),
  entry('beta', 'Beta', 'beta.serversherpa.com'),
  entry('alpha', 'Alpha', 'alpha.serversherpa.com'),
  entry('dev', 'Dev', 'dev.serversherpa.com'),
];
const DEV: EdgeEnvironment = {
  kind: 'named', ...entry('dev', 'Dev', 'dev.serversherpa.com'), ever_registered: true,
};

beforeEach(() => {
  order.length = 0;
  api.unlockEnvironment.mockReset().mockResolvedValue(undefined);
  api.getEdgeEnvironments.mockReset().mockResolvedValue({ source: 'built_in', environments: LIST });
  api.switchEnvironment.mockReset().mockResolvedValue({ ...DEV, id: 'uat', name: 'UAT' });
  reset.clearForSwitch.mockReset().mockImplementation(async () => { order.push('clear'); });
  reload.reloadToLogin.mockReset().mockImplementation(() => { order.push('reload'); });
});
afterEach(cleanup);

function open(current: EdgeEnvironment = DEV, onClose = vi.fn()) {
  render(<EnvironmentModal current={current} onClose={onClose} />);
  return onClose;
}

async function unlock() {
  await userEvent.type(screen.getByLabelText('Environment password'), 'cumulus');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('button', { name: /Custom URL…/ });
}

const foot = () => document.querySelector('.modal-foot') as HTMLElement;

it('uses the Clear Setup shell: eyebrow, title, close and a footer for the buttons', () => {
  open();
  const dialog = screen.getByRole('dialog', { name: 'Change environment' });
  expect(dialog.classList.contains('modal-card')).toBe(true);
  expect(dialog.classList.contains('rgm-card')).toBe(true);
  expect(within(dialog).getByText('This kiosk').className).toBe('eyebrow');
  expect(within(dialog).getByRole('heading', { name: 'Change environment' })).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
  expect(within(foot()).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  expect(within(foot()).getByRole('button', { name: 'Continue' })).toBeTruthy();
});

it('the password step asks the edge; a wrong one says so and stays', async () => {
  api.unlockEnvironment.mockRejectedValueOnce(new ApiError(403, 'wrong_password'));
  open();
  await userEvent.type(screen.getByLabelText('Environment password'), 'nimbus');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(api.unlockEnvironment).toHaveBeenCalledWith('nimbus');
  expect((await screen.findByRole('alert')).textContent).toBe("That password isn't right.");
  expect(screen.getByLabelText('Environment password')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Custom URL…/ })).toBeNull();
});

it('after the password, lists the environments in order with the current one marked and Custom URL last', async () => {
  open();
  await unlock();
  expect(api.unlockEnvironment).toHaveBeenCalledWith('cumulus');
  const rows = within(screen.getByRole('list')).getAllByRole('button');
  expect(rows.map((r) => r.querySelector('.env-row-name')?.textContent))
    .toEqual(['Prod', 'RC1', 'UAT', 'Beta', 'Alpha', 'Dev', 'Custom URL…']);
  const dev = rows[5];
  expect(dev.getAttribute('aria-current')).toBe('true');
  expect(within(dev).getByText('Current')).toBeTruthy();
  expect((dev as HTMLButtonElement).disabled).toBe(true);
  expect(rows.slice(0, 5).every((r) => r.getAttribute('aria-current') === null)).toBe(true);
});

it('an entry whose domain changed since the switch is a normal choice, not the current one', async () => {
  api.getEdgeEnvironments.mockResolvedValue({
    source: 'fresh', environments: [entry('dev', 'Dev', 'dev2.serversherpa.com')],
  });
  open();
  await unlock();
  const row = screen.getByRole('button', { name: /^Dev/ });
  expect(row.getAttribute('aria-current')).toBeNull();
  expect((row as HTMLButtonElement).disabled).toBe(false);
});

it('picking UAT shows the confirm copy with Cancel and Switch; Cancel goes back to the list', async () => {
  open();
  await unlock();
  await userEvent.click(screen.getByRole('button', { name: /^UAT/ }));
  expect(screen.getByText('Switching to UAT signs this kiosk out and clears its setup and saved move data.'))
    .toBeTruthy();
  const buttons = within(foot()).getAllByRole('button').map((b) => b.textContent);
  expect(buttons).toEqual(['Cancel', 'Switch']);
  await userEvent.click(within(foot()).getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('button', { name: /Custom URL…/ })).toBeTruthy();
  expect(api.switchEnvironment).not.toHaveBeenCalled();
});

it('Switch sends the password and the id, then clears this browser and reloads to sign-in', async () => {
  open();
  await unlock();
  await userEvent.click(screen.getByRole('button', { name: /^UAT/ }));
  await userEvent.click(within(foot()).getByRole('button', { name: 'Switch' }));
  await waitFor(() => expect(order).toEqual(['clear', 'reload']));
  expect(api.switchEnvironment).toHaveBeenCalledWith({ password: 'cumulus', target: { id: 'uat' } });
});

describe('unsent work', () => {
  beforeEach(() => {
    api.switchEnvironment.mockRejectedValueOnce(new ApiError(409, 'outbox_not_empty', { code: 'outbox_not_empty', pending: 3 }));
  });

  async function switchToUat() {
    await unlock();
    await userEvent.click(screen.getByRole('button', { name: /^UAT/ }));
    await userEvent.click(within(foot()).getByRole('button', { name: 'Switch' }));
    await screen.findByText("3 unsent scans haven't been sent yet.");
  }

  it('says how many and offers to wait or discard', async () => {
    open();
    await switchToUat();
    expect(screen.getByText('Switching to UAT signs this kiosk out and clears its setup and saved move data.'))
      .toBeTruthy();
    const buttons = within(foot()).getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['Wait for them to send', 'Discard and switch']);
    expect(reset.clearForSwitch).not.toHaveBeenCalled();
  });

  it('Wait for them to send closes without switching', async () => {
    const onClose = open();
    await switchToUat();
    await userEvent.click(screen.getByRole('button', { name: 'Wait for them to send' }));
    expect(onClose).toHaveBeenCalled();
    expect(api.switchEnvironment).toHaveBeenCalledTimes(1);
  });

  it('Discard and switch asks again with discard, then clears and reloads', async () => {
    open();
    await switchToUat();
    await userEvent.click(screen.getByRole('button', { name: 'Discard and switch' }));
    await waitFor(() => expect(order).toEqual(['clear', 'reload']));
    expect(api.switchEnvironment).toHaveBeenLastCalledWith(
      { password: 'cumulus', target: { id: 'uat' }, discard: true });
  });

  it('discarding without an admin signed in is refused in words', async () => {
    api.switchEnvironment.mockRejectedValueOnce(new ApiError(403, 'discard_needs_admin', { code: 'discard_needs_admin' }));
    open();
    await switchToUat();
    await userEvent.click(screen.getByRole('button', { name: 'Discard and switch' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Sign in as an admin to discard unsent scans.');
    expect(reset.clearForSwitch).not.toHaveBeenCalled();
  });

  it('a server that cannot be asked about access says so', async () => {
    api.switchEnvironment.mockRejectedValueOnce(new ApiError(503, 'access_check_offline', { code: 'access_check_offline' }));
    open();
    await switchToUat();
    await userEvent.click(screen.getByRole('button', { name: 'Discard and switch' }));
    expect((await screen.findByRole('alert')).textContent).toBe("Can't reach the server to check your access.");
  });
});

describe('Custom URL', () => {
  async function toCustom() {
    open();
    await unlock();
    await userEvent.click(screen.getByRole('button', { name: /Custom URL…/ }));
  }

  it('shows the two URL fields, filled with where the kiosk points now, and the confirm copy', async () => {
    await toCustom();
    expect((screen.getByLabelText('API URL') as HTMLInputElement).value).toBe('https://api.dev.serversherpa.com');
    expect((screen.getByLabelText('Portal URL') as HTMLInputElement).value).toBe('https://portal.dev.serversherpa.com');
    expect(screen.getByText('Switching to Custom signs this kiosk out and clears its setup and saved move data.'))
      .toBeTruthy();
    expect(within(foot()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Cancel', 'Switch']);
  });

  it('Switch sends the typed URLs', async () => {
    await toCustom();
    const apiField = screen.getByLabelText('API URL');
    await userEvent.clear(apiField);
    await userEvent.type(apiField, 'http://10.10.48.103:8000');
    const portalField = screen.getByLabelText('Portal URL');
    await userEvent.clear(portalField);
    await userEvent.type(portalField, 'http://10.10.48.103:5173');
    await userEvent.click(within(foot()).getByRole('button', { name: 'Switch' }));
    await waitFor(() => expect(order).toEqual(['clear', 'reload']));
    expect(api.switchEnvironment).toHaveBeenCalledWith({
      password: 'cumulus',
      target: { custom: { api_url: 'http://10.10.48.103:8000', portal_url: 'http://10.10.48.103:5173' } },
    });
  });

  it('Switch waits for both fields', async () => {
    await toCustom();
    await userEvent.clear(screen.getByLabelText('Portal URL'));
    expect((within(foot()).getByRole('button', { name: 'Switch' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a registered kiosk without a developer signed in is refused in words', async () => {
    api.switchEnvironment.mockRejectedValueOnce(new ApiError(403, 'custom_needs_super_admin', { code: 'custom_needs_super_admin' }));
    await toCustom();
    await userEvent.click(within(foot()).getByRole('button', { name: 'Switch' }));
    expect((await screen.findByRole('alert')).textContent)
      .toBe('Sign in as a developer, founder or super admin to use a custom URL.');
    expect(reset.clearForSwitch).not.toHaveBeenCalled();
  });

  it('a server that cannot be asked about access says so', async () => {
    api.switchEnvironment.mockRejectedValueOnce(new ApiError(503, 'access_check_offline', { code: 'access_check_offline' }));
    await toCustom();
    await userEvent.click(within(foot()).getByRole('button', { name: 'Switch' }));
    expect((await screen.findByRole('alert')).textContent).toBe("Can't reach the server to check your access.");
  });

  it('an address the edge refuses says what it needs', async () => {
    api.switchEnvironment.mockRejectedValueOnce(new ApiError(422, 'bad_url', { code: 'bad_url' }));
    await toCustom();
    await userEvent.click(within(foot()).getByRole('button', { name: 'Switch' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Enter an http or https address for both URLs.');
  });
});

it('every step keeps its buttons in the modal footer', async () => {
  open();
  expect(foot().querySelector('.btn-solid')).not.toBeNull();
  await unlock();
  expect(within(foot()).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: /^UAT/ }));
  expect(foot().querySelector('.btn-solid')?.textContent).toBe('Switch');
});

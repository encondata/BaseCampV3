// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ activateSlot: vi.fn() }));
vi.mock('../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { RUNNING } from '../pages/environments/testData';

import ActivateModal from './ActivateModal';

beforeEach(() => { api.activateSlot.mockReset(); api.activateSlot.mockResolvedValue(RUNNING); });
afterEach(cleanup);

function show(props: Partial<Parameters<typeof ActivateModal>[0]> = {}) {
  const onStarted = vi.fn();
  const onClose = vi.fn();
  render(<ActivateModal envName="uat9" production={false} slot="purple" fromSlot="orange" version="f00dbabe"
                        onStarted={onStarted} onClose={onClose} {...props} />);
  return { onStarted, onClose, dialog: screen.getByRole('dialog') };
}

it('activates a slot: report-generate header, what happens, then the deployment', async () => {
  const { onStarted, dialog } = show();
  expect(within(dialog).getByText('Blue/Green', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByRole('heading', { name: 'Activate Purple' })).toBeTruthy();
  expect(within(dialog).getByText(/smoke-tests Purple \(f00dbabe\)/)).toBeTruthy();
  expect(within(dialog).getByText(/Orange keeps running/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Activate Purple' }));
  expect(api.activateSlot).toHaveBeenCalledWith('uat9', 'purple', undefined);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
});

it('production needs its name typed', async () => {
  const { dialog } = show({ envName: 'prod', production: true, slot: 'green', fromSlot: 'blue' });
  const go = within(dialog).getByRole('button', { name: 'Activate Green' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type prod to confirm'), 'prod');
  expect(go.disabled).toBe(false);
  await userEvent.click(go);
  expect(api.activateSlot).toHaveBeenCalledWith('prod', 'green', 'prod');
});

it('deactivates a retiring production', async () => {
  const { dialog } = show({ envName: 'prod', production: true, slot: null, fromSlot: 'blue' });
  expect(within(dialog).getByRole('heading', { name: 'Deactivate' })).toBeTruthy();
  await userEvent.type(within(dialog).getByLabelText('Type prod to confirm'), 'prod');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
  expect(api.activateSlot).toHaveBeenCalledWith('prod', null, 'prod');
});

it("shows the API's copy and stays open", async () => {
  api.activateSlot.mockRejectedValue(new ApiError(409, 'slot_not_deployed', { code: 'slot_not_deployed', slot: 'purple' }));
  const { dialog, onStarted } = show();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Activate Purple' }));
  expect(await within(dialog).findByText('That slot has never run a deploy. Deploy to it first.')).toBeTruthy();
  expect(onStarted).not.toHaveBeenCalled();
});

it('Escape and Cancel close it', async () => {
  const { dialog, onClose } = show();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(2);
});

it('LAN Blue/Green: smoke-tests the slot on its VM, then points the proxy hosts at it', () => {
  const { dialog } = show({ envName: 'lan9', lan: true });
  const hint = within(dialog).getByText(/smoke-tests Purple \(f00dbabe\)/);
  expect(hint.textContent).toMatch(/on its VM/);
  expect(hint.textContent).toMatch(/Nginx Proxy Manager proxy hosts/);
  expect(hint.textContent).toMatch(/Orange keeps running/);
  expect(hint.textContent).not.toMatch(/droplet|load balancer/);
});

it('DigitalOcean keeps the droplet and load balancer wording', () => {
  const { dialog } = show();
  const hint = within(dialog).getByText(/smoke-tests Purple/);
  expect(hint.textContent).toMatch(/on its droplet/);
  expect(hint.textContent).toMatch(/load balancer/);
  expect(hint.textContent).not.toMatch(/Nginx Proxy Manager/);
});

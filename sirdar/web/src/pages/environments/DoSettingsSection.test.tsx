// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ updateEnvironment: vi.fn(), addSlot: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import DoSettingsSection from './DoSettingsSection';
import { DO_ENV, ONE_SLOT_ENV, PROD_ENV, RUNNING } from './testData';

beforeEach(() => { Object.values(api).forEach((f) => f.mockReset()); });
afterEach(cleanup);

function show(env = DO_ENV) {
  const onSaved = vi.fn();
  const onDeployStarted = vi.fn();
  render(<DoSettingsSection env={env} disabled={false} onSaved={onSaved} onDeployStarted={onDeployStarted} />);
  return { onSaved, onDeployStarted, section: screen.getByRole('region', { name: 'DigitalOcean' }) };
}

it('turns on Activate automatically for a two-slot environment', async () => {
  api.updateEnvironment.mockResolvedValue({ ...DO_ENV, auto_activate: true });
  const { onSaved, section } = show();
  await userEvent.click(within(section).getByRole('checkbox', { name: 'Activate automatically' }));
  expect(api.updateEnvironment).toHaveBeenCalledWith('uat9', { auto_activate: true });
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...DO_ENV, auto_activate: true }));
  expect(within(section).queryByRole('button', { name: 'Add a second slot' })).toBeNull();
});

it('adds the second slot and follows its deployment', async () => {
  const grown = { ...ONE_SLOT_ENV, slots: ['orange', 'purple'] };
  api.addSlot.mockResolvedValue({ environment: grown, deployment: RUNNING });
  const { onSaved, onDeployStarted, section } = show(ONE_SLOT_ENV);
  expect(within(section).queryByRole('checkbox', { name: 'Activate automatically' })).toBeNull();
  await userEvent.click(within(section).getByRole('button', { name: 'Add a second slot' }));
  expect(api.addSlot).toHaveBeenCalledWith('solo');
  await waitFor(() => expect(onDeployStarted).toHaveBeenCalledWith(RUNNING));
  expect(onSaved).toHaveBeenCalledWith(grown);
});

it('sizes only grow: Save sends only what changed', async () => {
  api.updateEnvironment.mockResolvedValue(DO_ENV);
  const { section } = show();
  expect(within(section).getByText(/Sizes only grow/)).toBeTruthy();
  const save = within(section).getByRole('button', { name: 'Save sizes' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  const droplet = within(section).getByLabelText('Droplet size');
  await userEvent.clear(droplet);
  await userEvent.type(droplet, 's-4vcpu-8gb');
  await userEvent.click(save);
  expect(api.updateEnvironment).toHaveBeenCalledWith('uat9', { do: { droplet_size: 's-4vcpu-8gb' } });
});

it("shows the API's copy for a refused size", async () => {
  api.updateEnvironment.mockRejectedValue(new ApiError(422, 'do_shrink_refused', { code: 'do_shrink_refused' }));
  const { section } = show();
  const db = within(section).getByLabelText('Database size');
  await userEvent.clear(db);
  await userEvent.type(db, 'db-s-1vcpu-1gb');
  await userEvent.click(within(section).getByRole('button', { name: 'Save sizes' }));
  expect(await within(section).findByText('Sizes can only grow.')).toBeTruthy();
});

it('production: no auto-activate or second slot; Mark retiring needs the name', async () => {
  api.updateEnvironment.mockResolvedValue({ ...PROD_ENV, retiring: true });
  const { section } = show(PROD_ENV);
  expect(within(section).queryByRole('checkbox', { name: 'Activate automatically' })).toBeNull();
  expect(within(section).queryByRole('button', { name: 'Add a second slot' })).toBeNull();
  const mark = within(section).getByRole('button', { name: 'Mark retiring' }) as HTMLButtonElement;
  expect(mark.disabled).toBe(true);
  await userEvent.type(within(section).getByLabelText('Type prod to confirm'), 'prod');
  await userEvent.click(mark);
  expect(api.updateEnvironment).toHaveBeenCalledWith('prod', { retiring: true, confirm_name: 'prod' });
});

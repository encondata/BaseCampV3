// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ saveIntegration: vi.fn(), testIntegration: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import type { IntegrationCheck, Integrations } from '../../lib/sirdarApi';
import { INTEGRATIONS, NO_INTEGRATIONS } from '../environments/testData';

import DigitalOceanModal from './DigitalOceanModal';

const TOKEN = `dop_v1_${'0123456789abcdef'.repeat(4)}`;
const DO_CHECK: IntegrationCheck = {
  ok: true, target: 'digitalocean',
  checks: [
    { label: 'Account', status: 'pass', value: 'ops@example.com · active' },
    { label: 'Droplets', status: 'pass', value: '7 of 25' },
  ],
  facts: { email: 'ops@example.com' },
};
const FROM_ENV: Integrations = {
  ...NO_INTEGRATIONS, digitalocean: { ...NO_INTEGRATIONS.digitalocean, configured: true, source: 'environment' },
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.saveIntegration.mockResolvedValue(INTEGRATIONS);
  api.testIntegration.mockResolvedValue(DO_CHECK);
});
afterEach(cleanup);

function show(current: Integrations = NO_INTEGRATIONS) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<DigitalOceanModal current={current} onSaved={onSaved} onClose={onClose} />);
  return { onSaved, onClose, dialog: screen.getByRole('dialog', { name: 'DigitalOcean' }) };
}

it('has the report-generate header, sizes to its one field, and focuses the token', () => {
  const { dialog } = show();
  expect(within(dialog).getByText('Integrations', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByText(/read-only/)).toBeTruthy();
  expect(dialog.classList).toContain('sirdar-do-card');
  expect(dialog.classList).toContain('rgm-card');
  const input = within(dialog).getByLabelText('API token') as HTMLInputElement;
  expect(input.type).toBe('password');
  expect(document.activeElement).toBe(input);
});

it('sets up: the token is required, then it saves only the token', async () => {
  const { onSaved, dialog } = show();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(within(dialog).getByText('Enter the API token.')).toBeTruthy();
  expect(api.saveIntegration).not.toHaveBeenCalled();
  await userEvent.type(within(dialog).getByLabelText('API token'), TOKEN);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(INTEGRATIONS));
  expect(api.saveIntegration).toHaveBeenCalledWith('digitalocean', { token: TOKEN });
});

it('checks the token shape before asking the API', async () => {
  const { dialog } = show();
  for (const bad of ['dop_v1_short', 'has space', 'x'.repeat(201)]) {
    const input = within(dialog).getByLabelText('API token');
    await userEvent.clear(input);
    await userEvent.click(input);
    await userEvent.paste(bad);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(within(dialog).getByText(/doesn't look like a DigitalOcean API token/)).toBeTruthy();
  }
  expect(api.testIntegration).not.toHaveBeenCalled();
});

it('Test tries the unsaved token and lists the checks', async () => {
  const { dialog } = show();
  await userEvent.type(within(dialog).getByLabelText('API token'), TOKEN);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  const list = await within(dialog).findByRole('list', { name: 'DigitalOcean test' });
  expect(within(list).getByText('ops@example.com · active')).toBeTruthy();
  expect(api.testIntegration).toHaveBeenCalledWith('digitalocean', { token: TOKEN });
  expect(api.saveIntegration).not.toHaveBeenCalled();
  await userEvent.type(within(dialog).getByLabelText('API token'), '0');
  expect(within(dialog).queryByRole('list', { name: 'DigitalOcean test' })).toBeNull();
});

it('editing keeps the stored token unless it is replaced, and never shows it', async () => {
  const { dialog } = show(INTEGRATIONS);
  expect(within(dialog).getByText('API token: set')).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: 'Clear' })).toBeNull();
  expect(dialog.textContent).not.toMatch(/dop_v1_/);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  await within(dialog).findByRole('list', { name: 'DigitalOcean test' });
  expect(api.testIntegration).toHaveBeenCalledWith('digitalocean', {});
  await userEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
  await userEvent.type(within(dialog).getByLabelText('API token'), TOKEN);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.saveIntegration).toHaveBeenCalledWith('digitalocean', { token: TOKEN }));
});

it("says when Sirdar is using the server environment's token", () => {
  const { dialog } = show(FROM_ENV);
  expect(within(dialog).getByText(/SIRDAR_DEPLOY_DO_TOKEN/)).toBeTruthy();
  expect(within(dialog).getByText(/until you save one here/)).toBeTruthy();
});

it('API errors land on the token; a failed test shows the reason', async () => {
  api.saveIntegration.mockRejectedValue(new ApiError(422, 'do_token_invalid', { code: 'do_token_invalid' }));
  api.testIntegration.mockRejectedValue(new ApiError(502, 'connect_failed',
    { code: 'connect_failed', reason: 'DigitalOcean rejected the API token.' }));
  const { dialog } = show();
  await userEvent.type(within(dialog).getByLabelText('API token'), 'legacy-token');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText(/doesn't look like a DigitalOcean API token/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
  expect(await within(dialog).findByText('DigitalOcean rejected the API token.')).toBeTruthy();
});

it('Escape and Cancel close it', async () => {
  const { onClose, dialog } = show();
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(2);
});

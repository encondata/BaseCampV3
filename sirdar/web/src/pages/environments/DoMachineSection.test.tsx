// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import DoMachineSection from './DoMachineSection';
import { DO_ENV, ONE_SLOT_ENV, PROD_ENV } from './testData';

afterEach(cleanup);

it('shows the account, load balancer, certificate, database and slots, with Activate on the idle one', async () => {
  const onActivate = vi.fn();
  render(<DoMachineSection env={DO_ENV} canActivate onActivate={onActivate} />);
  const section = screen.getByRole('region', { name: 'DigitalOcean' });
  expect(within(section).getByText('Development · nyc3')).toBeTruthy();
  expect(within(section).getByText('203.0.113.50')).toBeTruthy();
  expect(within(section).getByText(/Let's Encrypt staging/)).toBeTruthy();
  const table = within(section).getByRole('table', { name: 'Slots' });
  expect(within(table).getByText('Live')).toBeTruthy();
  await userEvent.click(within(table).getByRole('button', { name: 'Activate Purple' }));
  expect(onActivate).toHaveBeenCalledWith('purple');
});

it('warns when the certificate has 14 days or fewer, and hides Activate without the permission', () => {
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
  render(<DoMachineSection env={{ ...PROD_ENV, do: { ...PROD_ENV.do!, cert_not_after: soon } }}
                           canActivate={false} onActivate={vi.fn()} />);
  expect(screen.getByText('Renews soon')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Activate/ })).toBeNull();
});

it('a retiring production offers Deactivate, not Activate', async () => {
  const onActivate = vi.fn();
  render(<DoMachineSection env={{ ...PROD_ENV, retiring: true }} canActivate onActivate={onActivate} />);
  expect(screen.queryByRole('button', { name: 'Activate Green' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
  expect(onActivate).toHaveBeenCalledWith(null);
});

it('one slot: no Activate, and the hint says it updates in place', () => {
  render(<DoMachineSection env={ONE_SLOT_ENV} canActivate onActivate={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /Activate/ })).toBeNull();
  expect(screen.getByText(/updates in place/)).toBeTruthy();
});

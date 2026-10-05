// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import EnvOverview from './EnvOverview';
import { ENV, ESXI_ENV, ESXI_NEW_ENV, PX_ENV, PX_NEW_ENV } from './testData';

afterEach(cleanup);

it('a Proxmox environment shows its machine', () => {
  render(<EnvOverview env={PX_ENV} />);
  const machine = screen.getByRole('heading', { name: 'Machine' }).closest('section') as HTMLElement;
  expect(within(machine).getByText('ss-uat3 (VM 120)')).toBeTruthy();
  expect(within(machine).getByText('Node')).toBeTruthy();
  expect(within(machine).queryByText('Host')).toBeNull();
  expect(within(machine).getByText('4 vCPU · 8 GB · 64 GB disk')).toBeTruthy();
  expect(within(machine).getByText('10.10.48.70/24 via 10.10.48.1')).toBeTruthy();
  expect(within(machine).getByText('10.10.48.70')).toBeTruthy();
});

it('before its first deploy the VM is only planned; SSH environments have no Machine section', () => {
  render(<EnvOverview env={PX_NEW_ENV} />);
  expect(screen.getByText('ss-uat3 · built by the first deploy')).toBeTruthy();
  expect(screen.getByText('Not known yet')).toBeTruthy();
  cleanup();
  render(<EnvOverview env={ENV} />);
  expect(screen.queryByRole('heading', { name: 'Machine' })).toBeNull();
});

it('an ESXi environment shows its machine, on its host', () => {
  render(<EnvOverview env={ESXI_ENV} />);
  const machine = screen.getByRole('heading', { name: 'Machine' }).closest('section') as HTMLElement;
  expect(within(machine).getByText('ss-uat3 (VM 12)')).toBeTruthy();
  expect(within(machine).getByText('Host')).toBeTruthy();
  expect(within(machine).queryByText('Node')).toBeNull();
  expect(within(machine).getByText('10.10.48.10')).toBeTruthy();
  expect(within(machine).getByText('4 vCPU · 8 GB · 64 GB disk')).toBeTruthy();
  expect(within(machine).getByText('10.10.48.71')).toBeTruthy();
  cleanup();
  render(<EnvOverview env={ESXI_NEW_ENV} />);
  expect(screen.getByText('ss-uat3 · built by the first deploy')).toBeTruthy();
});

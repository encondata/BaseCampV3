// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { flowCtx } from '../flowFixtures';
import { initialState, trafficPlan, type FlowState } from '../flowState';

import TrafficStep from './TrafficStep';

afterEach(cleanup);
const ctx = flowCtx();
const stateOf = (over: Partial<FlowState>): FlowState => ({ ...initialState(ctx), name: 'qa', ...over });
const show = (over: Partial<FlowState>) =>
  render(<TrafficStep state={stateOf(over)} set={vi.fn()} errors={{}} ctx={ctx} />);

it('lists each public name and where it points first', () => {
  show({ target: 'esxi', ipCidr: '10.10.48.70/24', gateway: '10.10.48.1' });
  const table = screen.getByRole('table', { name: 'Traffic plan' });
  expect(within(table).getByText('portal.qa.serversherpa.com')).toBeTruthy();
  expect(within(table).getAllByText('10.10.48.70:8091').length).toBe(1);
  expect(screen.getByText(/one proxy host per public app/)).toBeTruthy();
});

it('has one row per trafficPlan row, with its columns', () => {
  const s = stateOf({ target: 'esxi', ipCidr: '10.10.48.70/24', gateway: '10.10.48.1' });
  render(<TrafficStep state={s} set={vi.fn()} errors={{}} ctx={ctx} />);
  const table = screen.getByRole('table', { name: 'Traffic plan' });
  for (const h of ['Public name', 'Through', 'To']) expect(within(table).getByText(h)).toBeTruthy();
  const rows = trafficPlan(s, ctx).rows;
  expect(within(table).getAllByRole('row').length).toBe(rows.length + 1);
  for (const r of rows) expect(within(table).getByText(r.hostname)).toBeTruthy();
});

it('DigitalOcean shows the load balancer', () => {
  show({ target: 'digitalocean' });
  expect(screen.getByText(/A DigitalOcean load balancer/)).toBeTruthy();
});

it('Blue/Green on the LAN says Activate moves the proxy hosts', () => {
  show({ target: 'esxi', servers: 'bluegreen' });
  expect(screen.getByText(/Activate moves every proxy host but spaces to the other app VM/)).toBeTruthy();
});

it('a single server with Publish off is set up by hand', () => {
  show({ target: 'ssh:lab', publish: false });
  expect(screen.getByText(/DNS records and proxy hosts are set up by hand/)).toBeTruthy();
});

it('Blue/Green with Publish off still manages the proxy hosts', () => {
  show({ target: 'esxi', servers: 'bluegreen', publish: false });
  expect(screen.getByText(/DNS records stay as they are; Sirdar still manages the proxy hosts/)).toBeTruthy();
});

it('has no inputs', () => {
  show({ target: 'ssh:lab' });
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('radio')).toBeNull();
});

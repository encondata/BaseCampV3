// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { flowCtx } from '../flowFixtures';
import { initialState } from '../flowState';

import ServersStep from './ServersStep';

afterEach(cleanup);
const ctx = flowCtx();

it('Single or Blue/Green', async () => {
  const set = vi.fn();
  render(<ServersStep state={initialState(ctx)} set={set} errors={{}} ctx={ctx} />);
  await userEvent.click(screen.getByRole('radio', { name: 'Blue/Green' }));
  expect(set).toHaveBeenCalledWith({ servers: 'bluegreen' });
  expect(screen.getByText(/One server: each deploy updates it in place/)).toBeTruthy();
  expect(screen.getByText(/SSH targets run a single server/)).toBeTruthy();
});

it('production is Blue/Green only', async () => {
  const set = vi.fn();
  render(<ServersStep state={{ ...initialState(ctx), type: 'production', servers: 'bluegreen' }} set={set} errors={{}} ctx={ctx} />);
  expect(screen.getByRole('radio', { name: 'Single server' }).getAttribute('aria-disabled')).toBe('true');
  await userEvent.click(screen.getByRole('radio', { name: 'Single server' }));
  expect(set).not.toHaveBeenCalled();
  expect(screen.getByText(/Production always runs Blue and Green/)).toBeTruthy();
  expect(screen.getByText(/Blue and Green: each deploy goes to the idle one; Activate moves traffic to it/)).toBeTruthy();
});

it('Blue/Green outside production is Orange and Purple', () => {
  render(<ServersStep state={{ ...initialState(ctx), servers: 'bluegreen' }} set={vi.fn()} errors={{}} ctx={ctx} />);
  expect(screen.getByText(/^Orange and Purple: each deploy goes to the idle one/)).toBeTruthy();
  expect(screen.queryByText(/Production always runs/)).toBeNull();
});

// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(cleanup);

const auth = vi.hoisted(() => ({ global: true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ scope: { global: auth.global, client_ids: [], partner_ids: [] } }),
}));

import TierSelect from './TierSelect';

const names = () => screen.getAllByRole('option').map((o) => o.textContent);

it('offers Individual on client links to global staff', () => {
  auth.global = true;
  render(<TierSelect kind="client" value="viewer" onChange={() => {}} />);
  expect(names()).toEqual(['Owner', 'Admin', 'Viewer', 'Individual']);
});
it('never offers Individual on partner links', () => {
  auth.global = true;
  render(<TierSelect kind="partner" value="viewer" onChange={() => {}} />);
  expect(names()).toEqual(['Owner', 'Admin', 'Viewer']);
});
it('does not offer Individual to non-global users', () => {
  auth.global = false;
  render(<TierSelect kind="client" value="viewer" onChange={() => {}} />);
  expect(names()).toEqual(['Owner', 'Admin', 'Viewer']);
});

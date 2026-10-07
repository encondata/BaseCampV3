// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { SNAP } from '../../environments/testData';
import { flowCtx } from '../flowFixtures';
import { initialState, stepErrors, type Errors, type FlowContext, type FlowState } from '../flowState';

import DataStep from './DataStep';

Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
afterEach(cleanup);
function renderStep(over: Partial<FlowState> = {}, ctxOver: Partial<FlowContext> = {}, errors: Errors = {}) {
  const ctx = flowCtx(ctxOver);
  const set = vi.fn();
  render(<DataStep state={{ ...initialState(ctx), name: 'qa', target: 'ssh:lab', ...over }} set={set} errors={errors} ctx={ctx} />);
  return set;
}

it('starts empty with a typed password and the policy hint', () => {
  renderStep();
  expect(screen.getByRole('radio', { name: 'Start empty' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText(/At least 8 characters \(ServerSherpa's password policy\)/)).toBeTruthy();
  expect(screen.getByText(/valid 4 hours/)).toBeTruthy();
  const pw = screen.getByLabelText('Password') as HTMLInputElement;
  expect(pw.type).toBe('password');
  expect(pw.autocomplete).toBe('new-password');
  expect((screen.getByLabelText('Type it again') as HTMLInputElement).type).toBe('password');
  expect(screen.getByText(/first super admin/)).toBeTruthy();
});

it('typing the admin fields sends them', async () => {
  const set = renderStep();
  await userEvent.type(screen.getByLabelText('First name'), 'A');
  expect(set).toHaveBeenCalledWith({ adminFirst: 'A' });
  await userEvent.type(screen.getByLabelText('Type it again'), 'x');
  expect(set).toHaveBeenCalledWith({ adminConfirm: 'x' });
});

it('Generate & invite has no password fields and explains the link', async () => {
  const set = renderStep({ adminEmail: 'ada@test.example.com', adminPasswordMode: 'invite' });
  expect(screen.queryByLabelText('Password')).toBeNull();
  expect(screen.queryByLabelText('Type it again')).toBeNull();
  expect(screen.getByText(/Sirdar sends ada@test.example.com a link to set their password, valid 4 hours/)).toBeTruthy();
  await userEvent.click(screen.getByRole('radio', { name: 'Type a password' }));
  expect(set).toHaveBeenCalledWith({ adminPasswordMode: 'typed' });
});

it('a snapshot replaces the first admin', async () => {
  const set = renderStep({ dataMode: 'snapshot' });
  expect(screen.queryByLabelText('First name')).toBeNull();
  await userEvent.click(screen.getByLabelText('Snapshot'));
  await userEvent.click(await screen.findByText(new RegExp(SNAP.name)));
  expect(set).toHaveBeenCalledWith({ snapshotId: SNAP.id });
});

it('without snapshots only Start empty is offered', async () => {
  const set = renderStep({}, { snapshots: [] });
  const snap = screen.getByRole('radio', { name: 'From a snapshot' });
  expect(snap.getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByText(/No snapshot yet/)).toBeTruthy();
  await userEvent.click(snap);
  expect(set).not.toHaveBeenCalled();
});

it('shows the errors under their fields', () => {
  renderStep({}, {}, {
    adminPassword: "The two passwords don't match.", adminEmail: 'Enter a valid email address for the first admin.',
    adminName: 'Enter a first and last name (up to 100 characters each).',
  });
  expect(screen.getByText("The two passwords don't match.")).toBeTruthy();
  expect(screen.getByText('Enter a valid email address for the first admin.')).toBeTruthy();
  expect(screen.getByText(/Enter a first and last name/)).toBeTruthy();
});

const PROD = { type: 'production' as const, servers: 'bluegreen' as const, target: 'digitalocean' };
const ADMIN = { adminFirst: 'Ada', adminLast: 'Lovelace', adminEmail: 'ada@test.example.com',
                adminPassword: 'correct-horse', adminConfirm: 'correct-horse' };

it('production starting empty needs SMTP: the step says why', () => {
  renderStep({ ...PROD, mailMode: 'mailpit' });
  expect(screen.getByText(/On production the first admin's email goes out through SMTP/)).toBeTruthy();
});

it('production starting empty with Mailpit is refused by the step check', () => {
  const ctx = flowCtx();
  const base = { ...initialState(ctx), name: 'prod', ...PROD, ...ADMIN };
  expect(stepErrors('data', { ...base, mailMode: 'mailpit' }, ctx).data).toMatch(/choose SMTP in Extras › Mail/);
  expect(stepErrors('data', { ...base, mailMode: 'smtp' }, ctx)).toEqual({});
  expect(stepErrors('data', { ...base, mailMode: 'mailpit', dataMode: 'snapshot', snapshotId: SNAP.id }, ctx)).toEqual({});
  expect(stepErrors('data', { ...base, type: 'dev', mailMode: 'mailpit' }, ctx)).toEqual({});
});

it('shows the data error on Start empty too', () => {
  renderStep({ ...PROD }, {}, { data: 'Production needs SMTP.' });
  expect(screen.getByText('Production needs SMTP.')).toBeTruthy();
});

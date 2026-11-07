// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const seed = vi.hoisted(() => ({
  getRecipe: vi.fn(), openSnapshot: vi.fn(), snapshotStatus: vi.fn(), resolveSelection: vi.fn(),
}));
vi.mock('../../seed/seedApi', async (orig) => ({ ...(await orig<typeof import('../../seed/seedApi')>()), ...seed }));

import { SNAP } from '../../environments/testData';
import { flowCtx } from '../flowFixtures';
import { initialState, stepErrors, type Errors, type FlowContext, type FlowState } from '../flowState';

import DataStep from './DataStep';

Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
afterEach(cleanup);
const RECIPES = [{ id: 'r1', name: 'Acme only', notes: '', tables: 2, rows: 3, files: 0, updated_at: '2026-11-07T10:00:00Z' }];
beforeEach(() => {
  Object.values(seed).forEach((f) => f.mockReset());
  seed.getRecipe.mockResolvedValue({
    id: 'r1', name: 'Acme only', notes: '', files: {},
    tables: { people: { mode: 'rows', pks: [{ id: '1' }, { id: '2' }, { id: '3' }] }, roles: { mode: 'all', pks: [] } },
  });
  seed.openSnapshot.mockResolvedValue({ status: 'ready' });
  seed.resolveSelection.mockResolvedValue({
    added: {}, reasons: [], added_tables: [], missing_tables: [], missing: { people: [{ id: '3' }] },
  });
});
function renderStep(over: Partial<FlowState> = {}, ctxOver: Partial<FlowContext> = {}, errors: Errors = {}) {
  const ctx = flowCtx({ recipes: RECIPES, ...ctxOver });
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

it('the admin fields point at their errors', () => {
  renderStep({}, {}, { adminName: 'Enter their first and last name.', adminEmail: 'Enter a valid email.',
                       adminPassword: 'Too short.' });
  const describedText = (label: string) => {
    const input = screen.getByLabelText(label);
    expect(input.getAttribute('aria-invalid'), label).toBe('true');
    return input.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent);
  };
  expect(describedText('First name')).toContain('Enter their first and last name.');
  expect(describedText('Last name')).toContain('Enter their first and last name.');
  expect(describedText('Email')).toContain('Enter a valid email.');
  expect(describedText('Password')).toContain('Too short.');
  expect(describedText('Type it again')).toContain('Too short.');
});

it('without errors the admin fields are not marked invalid', () => {
  renderStep();
  for (const label of ['First name', 'Email', 'Password'])
    expect(screen.getByLabelText(label).getAttribute('aria-invalid'), label).toBeNull();
});

it('starting empty offers Seed starter content, on by default', async () => {
  const set = renderStep();
  const toggle = screen.getByLabelText('Seed starter content') as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  expect(screen.getByText(/Zebra's TT0003M_\.TTF still goes in by hand \(Label builder › Fonts\)/)).toBeTruthy();
  await userEvent.click(toggle);
  expect(set).toHaveBeenCalledWith({ seedContent: false });
});

it('a snapshot has nothing to seed', () => {
  renderStep({ dataMode: 'snapshot' });
  expect(screen.queryByLabelText('Seed starter content')).toBeNull();
});

it('offers three choices: Start empty, From a snapshot, From a recipe', async () => {
  const set = renderStep();
  expect(screen.getAllByRole('radio').slice(0, 3).map((r) => r.textContent))
    .toEqual(['Start empty', 'From a snapshot', 'From a recipe']);
  await userEvent.click(screen.getByRole('radio', { name: 'From a recipe' }));
  expect(set).toHaveBeenCalledWith({ dataMode: 'recipe' });
});

it('without recipes From a recipe is locked', async () => {
  const set = renderStep({}, { recipes: [] });
  const r = screen.getByRole('radio', { name: 'From a recipe' });
  expect(r.getAttribute('aria-disabled')).toBe('true');
  await userEvent.click(r);
  expect(set).not.toHaveBeenCalled();
});

it('From a recipe: recipe, snapshot, the password options and the first admin fields', async () => {
  const set = renderStep({ dataMode: 'recipe' });
  await userEvent.click(screen.getByLabelText('Recipe'));
  await userEvent.click(await screen.findByText('Acme only'));
  expect(set).toHaveBeenCalledWith({ recipeId: 'r1' });
  await userEvent.click(screen.getByLabelText('Snapshot'));
  await userEvent.click(await screen.findByText(new RegExp(SNAP.name)));
  expect(set).toHaveBeenCalledWith({ recipeSnapshotId: SNAP.id });
  expect(screen.getByRole('radio', { name: 'Keep passwords and 2FA' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText('Every copied user gets no usable password and their 2FA is cleared; they set new ones from a reset link.'))
    .toBeTruthy();
  await userEvent.click(screen.getByRole('radio', { name: 'Make everyone reset their password' }));
  expect(set).toHaveBeenCalledWith({ resetPasswords: true });
  expect(screen.getByLabelText('First name')).toBeTruthy();
  expect(screen.getByLabelText('Email')).toBeTruthy();
  expect(screen.queryByLabelText('Seed starter content')).toBeNull();
});

it('From a recipe shows the ticked records found and missing in the snapshot', async () => {
  renderStep({ dataMode: 'recipe', recipeId: 'r1', recipeSnapshotId: SNAP.id });
  expect(await screen.findByText('2 of 3 ticked records found in this snapshot; 1 missing')).toBeTruthy();
  expect(seed.openSnapshot).toHaveBeenCalledWith(SNAP.id);
  expect(seed.resolveSelection).toHaveBeenCalledWith(SNAP.id, expect.objectContaining({ people: expect.anything() }));
});

it('a snapshot the scratch copy dropped is opened again before counting', async () => {
  const { ApiError } = await import('@portal/lib/api');
  seed.resolveSelection.mockRejectedValueOnce(new ApiError(409, 'snapshot_not_open', { code: 'snapshot_not_open' }));
  renderStep({ dataMode: 'recipe', recipeId: 'r1', recipeSnapshotId: SNAP.id });
  expect(await screen.findByText(/2 of 3 ticked records found/)).toBeTruthy();
  expect(seed.openSnapshot).toHaveBeenCalledTimes(2);
});

it('From a recipe shows its data error', () => {
  renderStep({ dataMode: 'recipe' }, {}, { data: 'Choose a recipe.' });
  expect(screen.getByRole('alert').textContent).toBe('Choose a recipe.');
});

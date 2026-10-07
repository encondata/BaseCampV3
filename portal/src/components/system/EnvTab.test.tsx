// @vitest-environment jsdom
/**
 * Round-3 feedback: Status became its own column (chip out of the Value
 * cell) and Description became an editable input whose edits feed into
 * Save alongside value edits. These tests pin that wiring — the pure
 * helpers (changedValues/changedDescriptions/describeEntry) are already
 * covered in lib/envConfig.test.ts.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { EnvEntry, EnvMissingEntry } from '../../lib/api';
import { LIST_FIT } from '../../lib/listTools';

const api = vi.hoisted(() => ({
  getEnvEntries: vi.fn(),
  putEnvConfig: vi.fn(),
  restartProcesses: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

/** EnvTab reads `preferences.list_size` for the shared column floors
 *  (listScale, lib/listTools) — mock the context the same way the other
 *  list tests do rather than wrapping every render in an AuthProvider. */
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ preferences: { list_size: 'default' } }),
}));

const ENTRIES: EnvEntry[] = [
  { key: 'SS_ENV', secret: false, value: 'development',
    description: 'Deployment environment name', section: '' },
  { key: 'SS_JWT_SECRET', secret: true, set: true,
    description: 'Signs session JWTs', section: '' },
];

const MISSING: EnvMissingEntry[] = [
  { key: 'SS_NEW_LIMIT', secret: false, section: 'Limits',
    description: 'A brand new limit', example: '25' },
  { key: 'SS_NEW_TOKEN', secret: true, section: 'Limits',
    description: 'A brand new token' },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getEnvEntries.mockResolvedValue({ entries: ENTRIES, missing: [] });
  api.putEnvConfig.mockResolvedValue({ changed: [] });
});

afterEach(cleanup);

const { default: EnvTab } = await import('./EnvTab');

/** The list is read-only until "Edit table" is toggled on. */
async function enterEditMode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Edit table/ }));
}

it('is read-only until Edit table is toggled on', async () => {
  const user = userEvent.setup();
  render(<EnvTab />);
  await screen.findByText('SS_ENV');
  // no value/description inputs before entering edit mode
  expect(screen.queryByLabelText('SS_ENV')).toBeNull();
  expect(screen.queryByDisplayValue('Deployment environment name')).toBeNull();
  await enterEditMode(user);
  expect(screen.getByLabelText('SS_ENV')).not.toBeNull();
});

it('renders the set/unset chip in its own Status column, not inside Value', async () => {
  const user = userEvent.setup();
  render(<EnvTab />);
  await screen.findByText('SS_JWT_SECRET');
  await enterEditMode(user);
  const row = screen.getByText('SS_JWT_SECRET');
  const rowEl = row.closest('.list-row') as HTMLElement;
  const valueCell = within(rowEl).getByLabelText('SS_JWT_SECRET').closest('.cell') as HTMLElement;
  expect(within(valueCell).queryByText('set')).toBeNull();
  expect(within(rowEl).getByText('set')).not.toBeNull();
});

it('renders an editable Description input seeded from entry.description', async () => {
  const user = userEvent.setup();
  render(<EnvTab />);
  await screen.findByText('SS_ENV');
  await enterEditMode(user);
  const descInput = screen.getByDisplayValue('Deployment environment name');
  expect(descInput.tagName).toBe('INPUT');
});

it('counts a changed description toward pending and sends it on save', async () => {
  const user = userEvent.setup();
  render(<EnvTab />);
  await screen.findByText('SS_ENV');
  await enterEditMode(user);

  const descInput = screen.getByDisplayValue('Deployment environment name');
  await user.clear(descInput);
  await user.type(descInput, 'New description');

  expect(await screen.findByRole('button', { name: /Save 1 change/ })).not.toBeNull();

  await user.click(screen.getByRole('button', { name: /Save 1 change/ }));

  await waitFor(() => expect(api.putEnvConfig).toHaveBeenCalledWith({
    values: {},
    descriptions: { SS_ENV: 'New description' },
  }));
});

it('combines value and description edits into one pending count', async () => {
  const user = userEvent.setup();
  render(<EnvTab />);
  await screen.findByText('SS_ENV');
  await enterEditMode(user);

  const valueInput = screen.getByLabelText('SS_ENV');
  await user.clear(valueInput);
  await user.type(valueInput, 'production');

  const descInput = screen.getByDisplayValue('Deployment environment name');
  await user.clear(descInput);
  await user.type(descInput, 'New description');

  expect(await screen.findByRole('button', { name: /Save 2 changes/ })).not.toBeNull();
});

it('env list: column floors, shared template + minimum, sideways-scroll card', async () => {
  render(<EnvTab />);
  const row = (await screen.findByText('SS_ENV')).closest('.list-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  expect(card.classList.contains('editing')).toBe(false);

  const head = card.querySelector('.list-head') as HTMLElement;
  expect(head.style.gridTemplateColumns)
    .toBe('240px minmax(240px, 1.4fr) 90px minmax(220px, 1.6fr)');
  expect(row.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  // Fit: default columns ≤ LIST_FIT.page (1172px — .sysconf-tab-body.sysconf-wide
  // adds no padding or border of its own to .portal-page).
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});

it('env list: edit mode drops the row minimum so the inputs are not squeezed', async () => {
  const user = userEvent.setup();
  render(<EnvTab />);
  await screen.findByText('SS_ENV');
  await enterEditMode(user);

  const row = screen.getByText('SS_ENV').closest('.list-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('editing')).toBe(true);
  expect(row.style.minWidth).toBe('');
});


// ── "Not in .env yet" block ─────────────────────────────────────────

it('hides the Not in .env yet block when nothing is missing', async () => {
  render(<EnvTab />);
  await screen.findByText('SS_ENV');
  expect(screen.queryByText('Not in .env yet')).toBeNull();
  expect(screen.queryByText('Not in .env')).toBeNull();
});

it('lists missing settings in their own block with the heading, hint, chip and description', async () => {
  api.getEnvEntries.mockResolvedValue({ entries: ENTRIES, missing: MISSING });
  render(<EnvTab />);
  await screen.findByText('SS_NEW_LIMIT');
  expect(screen.getByText('Not in .env yet')).not.toBeNull();
  expect(screen.getByText(
    'These settings are in .env.example but not in this server\'s .env, so they use their built-in defaults. Add one to set it here.',
  )).not.toBeNull();
  const row = screen.getByText('SS_NEW_LIMIT').closest('.list-row') as HTMLElement;
  expect(within(row).getByText('Not in .env')).not.toBeNull();
  expect(within(row).getByText('A brand new limit')).not.toBeNull();
  // the block comes after the normal list
  const all = Array.from(document.querySelectorAll('.list-row')).map((r) => r.textContent);
  expect(all.findIndex((t) => t?.includes('SS_NEW_LIMIT')))
    .toBeGreaterThan(all.findIndex((t) => t?.includes('SS_JWT_SECRET')));
});

it('missing rows are read-only until Edit table, then show example/secret placeholders', async () => {
  const user = userEvent.setup();
  api.getEnvEntries.mockResolvedValue({ entries: ENTRIES, missing: MISSING });
  render(<EnvTab />);
  await screen.findByText('SS_NEW_LIMIT');
  expect(screen.queryByLabelText('SS_NEW_LIMIT')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Use example' })).toBeNull();
  await enterEditMode(user);
  expect(screen.getByLabelText('SS_NEW_LIMIT').getAttribute('placeholder')).toBe('25');
  expect(screen.getByLabelText('SS_NEW_TOKEN').getAttribute('placeholder')).toBe('secret');
  expect(screen.getByLabelText('SS_NEW_TOKEN').getAttribute('type')).toBe('password');
  // Use example only for the non-secret
  expect(screen.getAllByRole('button', { name: 'Use example' })).toHaveLength(1);
});

it('Use example fills the value and counts as a pending change', async () => {
  const user = userEvent.setup();
  api.getEnvEntries.mockResolvedValue({ entries: ENTRIES, missing: MISSING });
  render(<EnvTab />);
  await screen.findByText('SS_NEW_LIMIT');
  await enterEditMode(user);
  await user.click(screen.getByRole('button', { name: 'Use example' }));
  expect((screen.getByLabelText('SS_NEW_LIMIT') as HTMLInputElement).value).toBe('25');
  expect(screen.getByRole('button', { name: /Save 1 change/ })).not.toBeNull();
});

it('saving sends a typed missing key in values, skips an empty secret, and reloads', async () => {
  const user = userEvent.setup();
  api.getEnvEntries
    .mockResolvedValueOnce({ entries: ENTRIES, missing: MISSING })
    .mockResolvedValue({
      entries: [...ENTRIES, { key: 'SS_NEW_LIMIT', secret: false, value: '30',
        description: 'A brand new limit', section: 'Limits' }],
      missing: [MISSING[1]],
    });
  api.putEnvConfig.mockResolvedValue({ changed: ['SS_NEW_LIMIT'] });
  render(<EnvTab />);
  await screen.findByText('SS_NEW_LIMIT');
  await enterEditMode(user);
  await user.type(screen.getByLabelText('SS_NEW_LIMIT'), '30');
  await user.click(screen.getByLabelText('SS_NEW_TOKEN'));   // touched, left empty
  await user.click(screen.getByRole('button', { name: /Save 1 change/ }));
  await waitFor(() => expect(api.putEnvConfig).toHaveBeenCalledWith({
    values: { SS_NEW_LIMIT: '30' }, descriptions: {},
  }));
  // reload: the added key moves into the normal list, the secret stays missing
  await waitFor(() => expect(api.getEnvEntries).toHaveBeenCalledTimes(2));
  await screen.findByText('Saved 1 value. Changes take effect after a restart.');
  expect(screen.getAllByText('SS_NEW_LIMIT')).toHaveLength(1);
  expect(screen.getByText('SS_NEW_TOKEN')).not.toBeNull();
  expect(screen.getAllByText('Not in .env')).toHaveLength(1);
});

it('sends a typed secret for a missing key', async () => {
  const user = userEvent.setup();
  api.getEnvEntries.mockResolvedValue({ entries: ENTRIES, missing: MISSING });
  render(<EnvTab />);
  await screen.findByText('SS_NEW_TOKEN');
  await enterEditMode(user);
  await user.type(screen.getByLabelText('SS_NEW_TOKEN'), 'abc');
  await user.click(screen.getByRole('button', { name: /Save 1 change/ }));
  await waitFor(() => expect(api.putEnvConfig).toHaveBeenCalledWith({
    values: { SS_NEW_TOKEN: 'abc' }, descriptions: {},
  }));
});

it('a cleared missing non-secret is unchanged: not sent, not counted', async () => {
  const user = userEvent.setup();
  api.getEnvEntries.mockResolvedValue({ entries: ENTRIES, missing: MISSING });
  render(<EnvTab />);
  await screen.findByText('SS_NEW_LIMIT');
  await enterEditMode(user);
  const input = screen.getByLabelText('SS_NEW_LIMIT');
  await user.type(input, '3');
  expect(screen.getByRole('button', { name: /Save 1 change/ })).not.toBeNull();
  await user.clear(input);
  const save = screen.getByRole('button', { name: /Save 0 changes/ }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
});

it('Use example with no example value does nothing', async () => {
  const user = userEvent.setup();
  api.getEnvEntries.mockResolvedValue({
    entries: ENTRIES,
    missing: [{ key: 'SS_NO_EXAMPLE', secret: false, section: '', description: 'd', example: '' }],
  });
  render(<EnvTab />);
  await screen.findByText('SS_NO_EXAMPLE');
  await enterEditMode(user);
  await user.click(screen.getByRole('button', { name: 'Use example' }));
  expect((screen.getByRole('button', { name: /Save 0 changes/ }) as HTMLButtonElement).disabled)
    .toBe(true);
});

it('the result count includes missing rows', async () => {
  const user = userEvent.setup();
  api.getEnvEntries.mockResolvedValue({ entries: ENTRIES, missing: MISSING });
  render(<EnvTab />);
  await screen.findByText('SS_NEW_LIMIT');
  expect(screen.getByText('4 of 4 shown')).not.toBeNull();
  await user.type(screen.getByLabelText('Filter environment variables'), 'new_limit');
  expect(screen.getByText('1 of 4 shown')).not.toBeNull();
});

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

import type { EnvEntry } from '../../lib/api';

const api = vi.hoisted(() => ({
  getEnvEntries: vi.fn(),
  putEnvConfig: vi.fn(),
  restartProcesses: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const ENTRIES: EnvEntry[] = [
  { key: 'SS_ENV', secret: false, value: 'development',
    description: 'Deployment environment name', section: '' },
  { key: 'SS_JWT_SECRET', secret: true, set: true,
    description: 'Signs session JWTs', section: '' },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getEnvEntries.mockResolvedValue({ entries: ENTRIES });
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

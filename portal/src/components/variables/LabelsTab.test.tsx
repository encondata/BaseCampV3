// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ can: (() => true) as (r: string, a: string) => boolean }));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can, godMode: true }),
}));

const api = vi.hoisted(() => ({
  listLabelVocab: vi.fn(),
  listLabelPlaceholders: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const VOCAB = [
  { kind: 'type', key: 'top', label: 'Top Label', description: '', meta: {},
    sort_order: 1, is_active: true, usage_count: 2 },
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '',
    meta: { width_in: 4, height_in: 2, has_tab: false },
    sort_order: 1, is_active: true, usage_count: 0 },
];
const PLACEHOLDERS = [
  { key: 'asset_id', label: 'Asset ID', description: '', sample_value: '10482',
    applies_to: ['top'], sort_order: 1, is_active: true, usage_count: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.listLabelVocab.mockResolvedValue(VOCAB);
  api.listLabelPlaceholders.mockResolvedValue(PLACEHOLDERS);
});
afterEach(cleanup);

const { default: LabelsTab } = await import('./LabelsTab');

it('renders the Types pane by default with usage counts', async () => {
  render(<LabelsTab />);
  await waitFor(() => expect(screen.queryByText('Top Label')).not.toBeNull());
  expect(screen.queryByText('4" x 2"')).toBeNull(); // size pane not shown yet
});

it('switches panes via the segmented control', async () => {
  render(<LabelsTab />);
  await waitFor(() => expect(screen.queryByText('Top Label')).not.toBeNull());
  await userEvent.click(screen.getByRole('tab', { name: 'Sizes' }));
  expect(screen.queryByText('4" x 2"')).not.toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: 'Placeholders' }));
  expect(screen.queryByText('Asset ID')).not.toBeNull();
  expect(screen.queryByText('10482')).not.toBeNull();
});

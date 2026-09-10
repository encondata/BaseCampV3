// @vitest-environment jsdom
/**
 * /labels/templates — Label Templates directory list. Covers what a unit
 * test can see: vocab-resolved cell labels, kind chips (Builder/Raw
 * code), the "New template" split-kind menu, and the row-actions
 * deactivate round trip (RowActionsMenu portals to document.body, so its
 * items are queried at `screen` level, not `within(row)`). Full
 * toolbar/column-menu/reorder/CSV behavior is exercised generically by
 * lib/listTools.test.tsx and lib/columnMenu.test.tsx.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { LabelTemplate, LabelVocab, SiteItem, UiPreferences } from '../lib/api';

const auth = vi.hoisted(() => {
  const state: { can: (resource: string, action: string) => boolean } = {
    can: () => true,
  };
  return state;
});

const updatePreferences = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true,
      notif: { critical: true, email: true, maint: true, digest: true },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences,
  }),
}));

const api = vi.hoisted(() => ({
  listLabelTemplates: vi.fn(),
  deleteLabelTemplate: vi.fn(),
  updateLabelTemplate: vi.fn(),
  listLabelVocab: vi.fn(),
  listSites: vi.fn(),
  convertLabelTemplate: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const TEMPLATES: LabelTemplate[] = [
  {
    id: 't1', name: 'Front tag', description: 'Front-of-cage tag',
    label_type: 'top', size_key: '4x2', dpi_key: '203', language_key: 'zpl',
    kind: 'design', design: {}, code: null, version: 3, is_active: true,
    site_ids: ['s1', 's2'],
    created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-20T00:00:00Z',
  },
  {
    id: 't2', name: 'Crate tag', description: 'Container crate tag',
    label_type: 'container', size_key: '6x4', dpi_key: '203', language_key: 'escp',
    kind: 'code', design: null, code: '! 0 200 200 400 1\r\n', version: 1, is_active: false,
    site_ids: [],
    created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-15T00:00:00Z',
  },
];

const SITES: SiteItem[] = [
  { id: 's1', name: 'NAP7' } as SiteItem,
  { id: 's2', name: 'NAP11' } as SiteItem,
];

const VOCAB: LabelVocab[] = [
  { kind: 'type', key: 'top', label: 'Top Label', description: '', meta: {}, sort_order: 0, is_active: true, usage_count: null },
  { kind: 'type', key: 'container', label: 'Container Label', description: '', meta: {}, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'size', key: '4x2', label: '4 x 2 in', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 0, is_active: true, usage_count: null },
  { kind: 'size', key: '6x4', label: '6 x 4 in', description: '', meta: { width_in: 6, height_in: 4 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'language', key: 'zpl', label: 'ZPL', description: '', meta: {}, sort_order: 0, is_active: true, usage_count: null },
  { kind: 'language', key: 'escp', label: 'ESC/P', description: '', meta: {}, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'dpi', key: '203', label: '203 dpi', description: '', meta: { dots: 203 }, sort_order: 0, is_active: true, usage_count: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.listLabelTemplates.mockResolvedValue(TEMPLATES);
  api.listLabelVocab.mockResolvedValue(VOCAB);
  api.deleteLabelTemplate.mockResolvedValue(undefined);
  api.updateLabelTemplate.mockResolvedValue(TEMPLATES[0]);
  api.listSites.mockResolvedValue(SITES);
  api.convertLabelTemplate.mockResolvedValue(TEMPLATES[0]);
});

afterEach(cleanup);

const { default: LabelTemplates } = await import('./LabelTemplates');

it('lists templates with vocab labels and kind chips', async () => {
  render(<MemoryRouter><LabelTemplates /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Front tag')).not.toBeNull());
  expect(screen.queryByText('Top Label')).not.toBeNull();     // vocabLabel applied
  expect(screen.queryByText('Builder')).not.toBeNull();       // kind chip design
  expect(screen.queryByText('Raw code')).not.toBeNull();      // kind chip code
});

it('Sites column shows names with overflow and All sites for globals', async () => {
  render(<MemoryRouter><LabelTemplates /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Front tag')).not.toBeNull());
  expect(screen.queryByText('NAP7 +1')).not.toBeNull();
  expect(screen.queryByText('All sites')).not.toBeNull();
});

it('New template menu offers both kinds', async () => {
  render(<MemoryRouter><LabelTemplates /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Front tag')).not.toBeNull());
  await userEvent.click(screen.getByRole('button', { name: /New template/ }));
  expect(screen.queryByText('Visual builder')).not.toBeNull();
  expect(screen.queryByText('Raw code (paste ZPL)')).not.toBeNull();
});

it('row menu deactivates via deleteLabelTemplate', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<MemoryRouter><LabelTemplates /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Front tag')).not.toBeNull());
  const row = screen.getByText('Front tag').closest('.dir-row')!;
  await userEvent.click(within(row as HTMLElement).getByRole('button', { name: /Actions/ }));
  await userEvent.click(screen.getByText('Deactivate'));  // portal: query at screen level
  expect(api.deleteLabelTemplate).toHaveBeenCalledWith('t1');
});

it('row menu offers Edit as raw ZPL on design rows only', async () => {
  render(<MemoryRouter><LabelTemplates /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Front tag')).not.toBeNull());
  const designRow = screen.getByText('Front tag').closest('.dir-row')!;
  await userEvent.click(within(designRow as HTMLElement)
    .getByRole('button', { name: /Actions/ }));
  expect(screen.queryByText('Edit as raw ZPL')).not.toBeNull();
  await userEvent.keyboard('{Escape}');
  const codeRow = screen.getByText('Crate tag').closest('.dir-row')!;
  await userEvent.click(within(codeRow as HTMLElement)
    .getByRole('button', { name: /Actions/ }));
  expect(screen.queryByText(/Edit as raw/)).toBeNull();
});

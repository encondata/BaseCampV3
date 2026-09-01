// @vitest-environment jsdom
/**
 * /labels/templates/new and /labels/templates/:id/edit — the label
 * template editor page shell. Covers what Task 15 delivers: vocab-seeded
 * defaults for a new design template, the fully-functional raw-code
 * editor (textarea + save → create), the edit route's load + patch round
 * trip, and the save-error → pf-error mapping. The design-kind canvas/
 * palette/properties regions are stub slots until Tasks 16-18 land.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { LabelPlaceholder, LabelVocab, UiPreferences } from '../lib/api';

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
      accent: 'blue', theme: 'dark', density: 'comfortable', motion: true,
      notif: { critical: true, email: true, maint: true, digest: true },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences,
  }),
}));

const api = vi.hoisted(() => ({
  listLabelVocab: vi.fn(),
  listLabelPlaceholders: vi.fn(),
  getLabelTemplate: vi.fn(),
  createLabelTemplate: vi.fn(),
  updateLabelTemplate: vi.fn(),
  compileLabel: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const VOCAB: LabelVocab[] = [
  { kind: 'type', key: 'top', label: 'Top Label', description: '', meta: {}, sort_order: 0, is_active: true, usage_count: null },
  { kind: 'type', key: 'front', label: 'Front Label', description: '', meta: {}, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'size', key: '4x2', label: '4 x 2 in', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 0, is_active: true, usage_count: null },
  { kind: 'size', key: '6x4', label: '6 x 4 in', description: '', meta: { width_in: 6, height_in: 4 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'dpi', key: '203', label: '203 dpi', description: '', meta: { dots: 203 }, sort_order: 0, is_active: true, usage_count: null },
  { kind: 'dpi', key: '300', label: '300 dpi', description: '', meta: { dots: 300 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'language', key: 'zpl', label: 'ZPL', description: '', meta: {}, sort_order: 0, is_active: true, usage_count: null },
  { kind: 'language', key: 'escp', label: 'ESC/P', description: '', meta: {}, sort_order: 1, is_active: true, usage_count: null },
];

const PLACEHOLDERS: LabelPlaceholder[] = [
  { key: 'asset_id', label: 'Asset ID', description: '', sample_value: 'A-1001',
    applies_to: ['top', 'front'], sort_order: 0, is_active: true, usage_count: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.listLabelVocab.mockResolvedValue(VOCAB);
  api.listLabelPlaceholders.mockResolvedValue(PLACEHOLDERS);
  api.compileLabel.mockResolvedValue({ code: '^XA^FS^XZ' });
});

afterEach(cleanup);

const { default: LabelTemplateEditor } = await import('./LabelTemplateEditor');

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/labels/templates/new" element={<LabelTemplateEditor />} />
        <Route path="/labels/templates/:id/edit" element={<LabelTemplateEditor />} />
      </Routes>
    </MemoryRouter>);
}

it('new design template: vocab selectors seeded with first active keys', async () => {
  renderAt('/labels/templates/new?kind=design');
  await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeNull());
  expect((screen.getByLabelText('Size') as HTMLSelectElement).value).toBe('4x2');
  expect((screen.getByLabelText('Language') as HTMLSelectElement).value).toBe('zpl');
});

it('new code template shows the code textarea and saves via create', async () => {
  api.createLabelTemplate.mockResolvedValue({ id: 't-new', kind: 'code' });
  renderAt('/labels/templates/new?kind=code');
  await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeNull());
  await userEvent.type(screen.getByLabelText('Name'), 'Vegas front');
  // userEvent.type() treats single { } as special-key syntax, so a literal
  // "{asset_id}" placeholder must be escaped as doubled braces.
  await userEvent.type(screen.getByLabelText('Template code'), '^XA^FD{{asset_id}}^FS^XZ');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.createLabelTemplate).toHaveBeenCalled());
  const body = api.createLabelTemplate.mock.calls[0][0];
  expect(body).toMatchObject({ name: 'Vegas front', kind: 'code',
    size_key: '4x2', language_key: 'zpl', design: null });
  expect(body.code).toContain('{asset_id}');
});

it('edit route loads the template and patches on save', async () => {
  api.getLabelTemplate.mockResolvedValue({
    id: 't1', name: 'Front tag', description: '', label_type: 'front',
    size_key: '4x2', dpi_key: '203', language_key: 'zpl', kind: 'code',
    design: null, code: '^XA^XZ', version: 2, is_active: true,
    created_at: '', updated_at: '' });
  api.updateLabelTemplate.mockResolvedValue({ id: 't1' });
  renderAt('/labels/templates/t1/edit');
  await waitFor(() =>
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Front tag'));
  await userEvent.type(screen.getByLabelText('Name'), ' v2');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateLabelTemplate).toHaveBeenCalledWith(
    't1', expect.objectContaining({ name: 'Front tag v2' })));
});

it('save error surfaces the pf-error', async () => {
  const { ApiError } = await import('../lib/api');
  api.createLabelTemplate.mockRejectedValue(new ApiError(409, 'label_template_exists'));
  renderAt('/labels/templates/new?kind=code');
  await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeNull());
  await userEvent.type(screen.getByLabelText('Name'), 'dupe');
  await userEvent.type(screen.getByLabelText('Template code'), 'x');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.queryByText('A template with this name already exists.')).not.toBeNull());
});

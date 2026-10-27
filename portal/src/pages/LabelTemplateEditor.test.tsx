// @vitest-environment jsdom
/**
 * /labels/templates/:id/code — a code template's editor ("Edit as raw
 * ZPL"): the load + patch round trip, a deactivated vocab value kept
 * selectable, site chips, the save-error → pf-error mapping, and a design
 * template sent on to the label builder.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { LabelVocab, UiPreferences } from '../lib/api';

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
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default', list_view: 'expanded',
      notif: { sound: 'chime', categories: { approvals: 'email', reports: 'email', wiki: 'email', learning: 'email', security: 'email' } },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences,
  }),
}));

const api = vi.hoisted(() => ({
  listLabelVocab: vi.fn(),
  listSites: vi.fn(),
  getLabelTemplate: vi.fn(),
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

const SITES = [{ id: 's1', name: 'NAP7' }, { id: 's2', name: 'NAP11' }] as never;

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.listLabelVocab.mockResolvedValue(VOCAB);
  api.listSites.mockResolvedValue(SITES);
  api.compileLabel.mockResolvedValue({ code: '^XA^FS^XZ' });
});

afterEach(cleanup);

const { default: LabelTemplateEditor } = await import('./LabelTemplateEditor');

const CODE_TEMPLATE = {
  id: 't1', name: 'Front tag', description: '', label_type: 'front',
  size_key: '4x2', dpi_key: '203', language_key: 'zpl', kind: 'code',
  design: null, code: '^XA^XZ', version: 2, is_active: true,
  site_ids: [] as string[], created_at: '', updated_at: '',
};

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/labels/templates/:id/code" element={<LabelTemplateEditor />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>);
}

it('loads the code template and patches on save', async () => {
  api.getLabelTemplate.mockResolvedValue(CODE_TEMPLATE);
  api.updateLabelTemplate.mockResolvedValue({ id: 't1' });
  renderAt('/labels/templates/t1/code');
  await waitFor(() =>
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Front tag'));
  await userEvent.type(screen.getByLabelText('Name'), ' v2');
  // userEvent.type() reads `{` as the start of a special key, so a literal
  // one is typed as `{{` (a `}` needs no escape).
  await userEvent.type(screen.getByLabelText('Template code'), '^FD{{asset_id}');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateLabelTemplate).toHaveBeenCalledWith(
    't1', expect.objectContaining({ name: 'Front tag v2', code: '^XA^XZ^FD{asset_id}' })));
  const body = api.updateLabelTemplate.mock.calls[0][1];
  expect(body).not.toHaveProperty('kind');
  expect(body).not.toHaveProperty('design');
  expect(body).not.toHaveProperty('generation_rules');   // kept as stored; the API takes them
});

it('a deactivated current vocab value renders selected', async () => {
  api.getLabelTemplate.mockResolvedValue({ ...CODE_TEMPLATE, name: 'Old size tag', size_key: '9x9' });
  api.listLabelVocab.mockResolvedValue([
    ...VOCAB,
    { kind: 'size', key: '9x9', label: '9 x 9 in', description: '',
      meta: { width_in: 9, height_in: 9 }, sort_order: 2, is_active: false,
      usage_count: null },
  ]);
  renderAt('/labels/templates/t1/code');
  await waitFor(() =>
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Old size tag'));
  expect((screen.getByLabelText('Size') as HTMLSelectElement).value).toBe('9x9');
});

it('save error surfaces the pf-error', async () => {
  const { ApiError } = await import('../lib/api');
  api.getLabelTemplate.mockResolvedValue(CODE_TEMPLATE);
  api.updateLabelTemplate.mockRejectedValue(new ApiError(409, 'label_template_exists'));
  renderAt('/labels/templates/t1/code');
  await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.queryByText('A template with this name already exists.')).not.toBeNull());
});

it('renaming an active template says to deactivate it first', async () => {
  const { ApiError } = await import('../lib/api');
  api.getLabelTemplate.mockResolvedValue(CODE_TEMPLATE);
  api.updateLabelTemplate.mockRejectedValue(new ApiError(409, 'template_active'));
  renderAt('/labels/templates/t1/code');
  await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(
    screen.queryByText('This template is active; deactivate it on Labels › Templates to rename it.')).not.toBeNull());
});

it('loads site chips and save sends site_ids', async () => {
  api.getLabelTemplate.mockResolvedValue({ ...CODE_TEMPLATE, site_ids: ['s1'] });
  api.updateLabelTemplate.mockResolvedValue({ id: 't1' });
  renderAt('/labels/templates/t1/code');
  await waitFor(() => expect(screen.queryByText('NAP7')).not.toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateLabelTemplate).toHaveBeenCalledWith(
    't1', expect.objectContaining({ site_ids: ['s1'] })));
});

it('a design template goes to the label builder', async () => {
  api.getLabelTemplate.mockResolvedValue({
    ...CODE_TEMPLATE, id: 't9', kind: 'design', code: null,
    design: { schema: 2, size: { w: 4, h: 2 }, elements: [] } });
  renderAt('/labels/templates/t9/code');
  await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/labels/templates/t9/edit'));
});

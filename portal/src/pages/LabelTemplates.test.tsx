// @vitest-environment jsdom
/**
 * /labels/templates — the template list as a tree (spec §3.4, §4.9): a
 * builder parent opens onto its DPI children (state chips From parent /
 * Customized / Out of date / Kept · inactive), the DPI column reads "All"
 * or the DPIs present, and each kind of row has its own menu — a parent's
 * (design, versions, clone, sites, Add DPI, Replace…, on/off, typed
 * delete), a child's (that DPI alone, update from parent, versions, test
 * print, delete; never on/off), and an older single row's (today's raw
 * code/convert/on-off, plus delete). Below rank 80 the tree is read-only.
 *
 * RowActionsMenu portals to document.body, so its items are queried at
 * `screen` level, not `within(row)`. Toolbar/column-menu/reorder/CSV
 * behavior is exercised generically by lib/listTools.test.tsx and
 * lib/columnMenu.test.tsx.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, type LabelTemplate, type LabelTemplateChild, type LabelTemplateTreeNode, type LabelVocab,
  type SiteItem, type UiPreferences,
} from '../lib/api';
import { LIST_FIT } from '../lib/listTools';

const auth = vi.hoisted(() => {
  const state: { can: (resource: string, action: string) => boolean; maxRank: number } = {
    can: () => true, maxRank: 80,
  };
  return state;
});

const updatePreferences = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    maxRank: auth.maxRank,
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default', list_view: 'expanded',
      notif: { sound: 'chime', categories: { approvals: 'email', reports: 'email', wiki: 'email', security: 'email' } },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences,
  }),
}));

const api = vi.hoisted(() => ({
  listLabelTemplateTree: vi.fn(),
  listLabelVocab: vi.fn(),
  listSites: vi.fn(),
  deleteLabelTemplate: vi.fn(),
  activateLabelTemplate: vi.fn(),
  updateLabelTemplate: vi.fn(),
  convertLabelTemplate: vi.fn(),
  updateLabelTemplateFromParent: vi.fn(),
  replaceLabelTemplates: vi.fn(),
  addLabelTemplateDpi: vi.fn(),
  cloneLabelTemplate: vi.fn(),
  getLabelTemplateDeleteSummary: vi.fn(),
  deleteLabelTemplateForGood: vi.fn(),
  listLabelTemplateVersions: vi.fn(),
  getLabelTemplateVersion: vi.fn(),
  restoreLabelTemplateVersion: vi.fn(),
  noteLabelTemplateVersion: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const BASE: LabelTemplate = {
  id: 'x', name: 'x', description: '', label_type: 'top', size_key: '4x2', dpi_key: '300', language_key: 'zpl',
  kind: 'design', design: { schema: 2 }, code: null, version: 1, is_active: true, site_ids: [],
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-19T21:41:00Z',
  parent_id: null, schema_version: 2, samples: {}, dpis: ['203', '300', '600'],
  generated_from_version: null, child_edits: 0, customized: false, is_old: false,
};

const kid = (parent: LabelTemplate, dpi: string, over: Partial<LabelTemplateChild> = {}): LabelTemplateChild => ({
  ...BASE, id: `${parent.id}-${dpi}`, name: `${parent.name} · ${dpi}`, dpi_key: dpi, parent_id: parent.id,
  version: 3, site_ids: [], dpis: [dpi], generated_from_version: parent.version, is_active: parent.is_active,
  out_of_date: false, ...over,
});

const VEGAS_ROW: LabelTemplate = { ...BASE, id: 'p1', name: 'Vegas Destination', version: 7, site_ids: ['s1', 's2'] };
const VEGAS: LabelTemplateTreeNode = {
  ...VEGAS_ROW, family: 'Vegas Destination',
  children: [
    kid(VEGAS_ROW, '203'),
    kid(VEGAS_ROW, '300', { customized: true, generated_from_version: 6, child_edits: 2, out_of_date: true }),
    kid(VEGAS_ROW, '300', {
      id: 'p1-300old', name: 'Vegas Destination · 300 Old', customized: true, is_old: true, is_active: false,
      generated_from_version: 6, child_edits: 3,
    }),
    kid(VEGAS_ROW, '600'),
  ],
};

const AMS_ROW: LabelTemplate = {
  ...BASE, id: 'p2', name: 'Amsterdam Destination', version: 2, is_active: false, dpis: ['203', '300'],
};
const AMS: LabelTemplateTreeNode = {
  ...AMS_ROW, family: 'Amsterdam Destination', children: [kid(AMS_ROW, '203'), kid(AMS_ROW, '300')],
};

const legacy = (over: Partial<LabelTemplateTreeNode>): LabelTemplateTreeNode => ({
  ...BASE, kind: 'code', design: null, code: '^XA^XZ', schema_version: 1, dpi_key: '203', dpis: [],
  family: 'x', children: [], ...over,
});

const AMS_OLD = legacy({
  id: 'l1', name: 'Amsterdam Destination - 203DPI', family: 'Amsterdam Destination', version: 4,
});
const FRONT = legacy({
  id: 't1', name: 'Front tag', family: 'Front tag', description: 'Front-of-cage tag', kind: 'design',
  design: {}, code: null, version: 3, site_ids: ['s1', 's2'], label_type: 'front',
});
const CRATE = legacy({
  id: 't2', name: 'Crate tag', family: 'Crate tag', label_type: 'container', size_key: '6x4',
  language_key: 'escp', code: '! 0 200 200 400 1\r\n', is_active: false,
});

const TREE = [AMS, AMS_OLD, CRATE, FRONT, VEGAS];

const SITES: SiteItem[] = [
  { id: 's1', name: 'NAP7' } as SiteItem,
  { id: 's2', name: 'NAP11' } as SiteItem,
];

const vocabRow = (kind: string, key: string, label: string, sort = 0): LabelVocab => ({
  kind, key, label, description: '', meta: {}, sort_order: sort, is_active: true, usage_count: null,
});

const VOCAB: LabelVocab[] = [
  vocabRow('type', 'top', 'Top Label'),
  vocabRow('type', 'front', 'Front Label', 1),
  vocabRow('type', 'container', 'Container Label', 2),
  vocabRow('size', '4x2', '4 x 2 in'),
  vocabRow('size', '6x4', '6 x 4 in', 1),
  vocabRow('language', 'zpl', 'ZPL'),
  vocabRow('language', 'escp', 'ESC/P', 1),
  vocabRow('dpi', '203', '203 dpi'),
  vocabRow('dpi', '300', '300 dpi', 1),
  vocabRow('dpi', '600', '600 dpi', 2),
];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  auth.can = () => true;
  auth.maxRank = 80;
  api.listLabelTemplateTree.mockResolvedValue(TREE);
  api.listLabelVocab.mockResolvedValue(VOCAB);
  api.listSites.mockResolvedValue(SITES);
  api.deleteLabelTemplate.mockResolvedValue(undefined);
  api.activateLabelTemplate.mockResolvedValue({ ...AMS_ROW, is_active: true });
  api.updateLabelTemplate.mockResolvedValue(VEGAS_ROW);
  api.convertLabelTemplate.mockResolvedValue(FRONT);
  api.updateLabelTemplateFromParent.mockResolvedValue(VEGAS.children[1]);
  api.replaceLabelTemplates.mockResolvedValue({ ...AMS_ROW, is_active: true });
  api.addLabelTemplateDpi.mockResolvedValue(kid(AMS_ROW, '600'));
  api.cloneLabelTemplate.mockResolvedValue({ ...VEGAS_ROW, id: 'p9', name: 'Vegas Destination copy' });
  api.getLabelTemplateDeleteSummary.mockResolvedValue({
    children: VEGAS.children.map((c) => c.name), generated_labels: 12,
  });
  api.deleteLabelTemplateForGood.mockResolvedValue(undefined);
  api.listLabelTemplateVersions.mockResolvedValue([
    { version: 7, child_edits: 0, label: 'v7', summary: 'Moved the QR', note: '', created_by: null,
      created_by_name: 'Jimmy', created_at: '2026-10-19T21:41:00Z' },
    { version: 6, child_edits: 0, label: 'v6', summary: 'Banner to Oswald', note: '', created_by: null,
      created_by_name: 'Jimmy', created_at: '2026-10-18T15:02:00Z' },
  ]);
  api.getLabelTemplateVersion.mockResolvedValue({
    version: 6, child_edits: 0, label: 'v6', summary: 'Banner to Oswald', note: '', created_by: null,
    created_by_name: 'Jimmy', created_at: '2026-10-18T15:02:00Z', design: { schema: 2 }, code: null, samples: {},
  });
});

afterEach(cleanup);

const { default: LabelTemplates } = await import('./LabelTemplates');

function Where() {
  const loc = useLocation();
  const state = loc.state as { openVersion?: { label: string }; testPrint?: boolean } | null;
  return (
    <div>
      <div data-testid="where">{loc.pathname}</div>
      <div data-testid="where-version">{state?.openVersion?.label ?? ''}</div>
      <div data-testid="where-print">{state?.testPrint ? 'print' : ''}</div>
    </div>
  );
}

function renderRouted() {
  return render(
    <MemoryRouter initialEntries={['/labels/templates']}>
      <Routes>
        <Route path="/labels/templates" element={<LabelTemplates />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>);
}

const rowOf = (name: string) => screen.getByText(name, { selector: '.cell b, .cell span' }).closest('.dir-row') as HTMLElement;

async function ready() {
  await screen.findByText('Vegas Destination');
}

async function expand(name: string) {
  await userEvent.click(within(rowOf(name)).getByRole('button', { name: `Expand ${name}` }));
}

async function openMenu(name: string): Promise<string[]> {
  await userEvent.click(within(rowOf(name)).getByRole('button', { name: /Actions/ }));
  return screen.getAllByRole('menuitem').map((m) => m.textContent ?? '');
}

it('label templates list: column floors, shared template + minimum, sideways-scroll card', async () => {
  renderRouted();
  await ready();
  const row = rowOf('Front tag');
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});

it('lists the top-level templates; a parent’s DPI versions wait until it is opened', async () => {
  renderRouted();
  await ready();
  expect(screen.getByText('Amsterdam Destination - 203DPI')).toBeTruthy();
  expect(screen.queryByText('Vegas Destination · 203')).toBeNull();
  expect(within(rowOf('Vegas Destination')).getByText('Top Label')).toBeTruthy();
  // an older single row has no DPI versions to open
  expect(within(rowOf('Crate tag')).queryByRole('button', { name: /Expand/ })).toBeNull();

  await expand('Vegas Destination');
  for (const c of VEGAS.children) expect(screen.getByText(c.name)).toBeTruthy();
  expect(screen.queryByText('Amsterdam Destination · 203')).toBeNull();     // only the one opened

  // the children sit right under their parent
  const names = [...document.querySelectorAll('.dir-row')].map((r) => r.querySelector('.cell-line')?.textContent);
  const at = names.indexOf('Vegas Destination');
  expect(names.slice(at, at + 5)).toEqual(['Vegas Destination', ...VEGAS.children.map((c) => c.name)]);

  await userEvent.click(within(rowOf('Vegas Destination')).getByRole('button', { name: 'Collapse Vegas Destination' }));
  expect(screen.queryByText('Vegas Destination · 203')).toBeNull();
});

it('a DPI version shows its version and state chips', async () => {
  renderRouted();
  await ready();
  await expand('Vegas Destination');
  const chips = (name: string) => [...rowOf(name).querySelectorAll('.chip')].map((c) => c.textContent);
  expect(chips('Vegas Destination · 203')).toEqual(expect.arrayContaining(['From parent']));
  expect(chips('Vegas Destination · 300')).toEqual(expect.arrayContaining(['Customized', 'Out of date (parent v7)']));
  expect(chips('Vegas Destination · 300 Old')).toEqual(expect.arrayContaining(['Kept · inactive']));
  expect(chips('Vegas Destination · 300 Old')).not.toContain('Customized');
  expect(chips('Vegas Destination · 600')).not.toContain('Customized');
  expect(within(rowOf('Vegas Destination · 300')).getByText('v6.2')).toBeTruthy();
  expect(within(rowOf('Vegas Destination · 300 Old')).getByText('v6.3')).toBeTruthy();
  expect(within(rowOf('Vegas Destination · 203')).getByText('v7')).toBeTruthy();
  expect(within(rowOf('Vegas Destination')).getByText('Active')).toBeTruthy();
  expect(within(rowOf('Amsterdam Destination')).getByText('Inactive')).toBeTruthy();
});

it('the DPI column reads All, else the DPIs present; an older row shows its own', async () => {
  renderRouted();
  await ready();
  expect(within(rowOf('Vegas Destination')).getByText('All')).toBeTruthy();
  expect(within(rowOf('Amsterdam Destination')).getByText('203 · 300')).toBeTruthy();
  expect(within(rowOf('Amsterdam Destination - 203DPI')).getByText('203')).toBeTruthy();
  await expand('Vegas Destination');
  expect(within(rowOf('Vegas Destination · 600')).getByText('600')).toBeTruthy();
});

it('Sites column shows names with overflow and All sites for globals', async () => {
  renderRouted();
  await ready();
  expect(within(rowOf('Vegas Destination')).getByText('NAP7 +1')).toBeTruthy();
  expect(within(rowOf('Crate tag')).getByText('All sites')).toBeTruthy();
});

it('remembers which parents are open', async () => {
  renderRouted();
  await ready();
  await expand('Vegas Destination');
  cleanup();
  renderRouted();
  await ready();
  expect(screen.getByText('Vegas Destination · 300 Old')).toBeTruthy();
});

it('a search that matches a DPI version holds its parent open', async () => {
  renderRouted();
  await ready();
  const search = screen.getByPlaceholderText('Filter this list…');
  await userEvent.type(search, '300 old');
  expect(screen.getByText('Vegas Destination · 300 Old')).toBeTruthy();
  expect(screen.queryByText('Crate tag')).toBeNull();
  const toggle = within(rowOf('Vegas Destination')).getByRole('button', { name: 'Collapse Vegas Destination' });
  expect((toggle as HTMLButtonElement).disabled).toBe(true);
  await userEvent.clear(search);
  expect(screen.queryByText('Vegas Destination · 300 Old')).toBeNull();     // it was never opened by hand
});

it('a search that matches the parent itself leaves it closed and its toggle free', async () => {
  renderRouted();
  await ready();
  // every child's name carries the parent's, so only the parent's own match counts here
  await userEvent.type(screen.getByPlaceholderText('Filter this list…'), 'vegas');
  expect(screen.getByText('Vegas Destination')).toBeTruthy();
  expect(screen.queryByText('Vegas Destination · 203')).toBeNull();
  const toggle = within(rowOf('Vegas Destination')).getByRole('button', { name: 'Expand Vegas Destination' });
  expect((toggle as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(toggle);
  expect(screen.getByText('Vegas Destination · 203')).toBeTruthy();
});

it('New template opens the label builder', async () => {
  renderRouted();
  await ready();
  await userEvent.click(screen.getByRole('button', { name: /New template/ }));
  expect(screen.getByTestId('where').textContent).toBe('/labels/templates/new');
});

it('a parent’s menu: design, versions, clone, sites, on/off and delete', async () => {
  renderRouted();
  await ready();
  expect(await openMenu('Vegas Destination')).toEqual([
    'Edit design', 'Versions…', 'Clone to new template…', 'Sites…', 'Deactivate', 'Delete…',
  ]);
});

it('a parent missing a DPI offers Add DPI…, and one with older rows of its family Replace…', async () => {
  renderRouted();
  await ready();
  expect(await openMenu('Amsterdam Destination')).toEqual([
    'Edit design', 'Versions…', 'Clone to new template…', 'Sites…', 'Add DPI…', 'Replace…', 'Activate', 'Delete…',
  ]);
});

it('a DPI version’s menu never turns it on or off', async () => {
  renderRouted();
  await ready();
  await expand('Vegas Destination');
  expect(await openMenu('Vegas Destination · 300')).toEqual([
    'Edit this DPI only', 'Update from parent…', 'Versions…', 'Test print…', 'Delete this DPI…',
  ]);
  expect(await openMenu('Vegas Destination · 203')).toEqual([
    'Edit this DPI only', 'Versions…', 'Test print…', 'Delete this DPI…',
  ]);
  expect(await openMenu('Vegas Destination · 300 Old')).toEqual([
    'Edit this DPI only', 'Versions…', 'Test print…', 'Delete this DPI…',
  ]);
});

it('Edit design, Edit this DPI only and Test print… open the builder', async () => {
  renderRouted();
  await ready();
  await openMenu('Vegas Destination');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Edit design' }));
  expect(screen.getByTestId('where').textContent).toBe('/labels/templates/p1/edit');
  cleanup();

  renderRouted();
  await ready();
  await expand('Vegas Destination');
  await openMenu('Vegas Destination · 300');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Test print…' }));
  expect(screen.getByTestId('where').textContent).toBe('/labels/templates/p1-300/edit');
  expect(screen.getByTestId('where-print').textContent).toBe('print');   // the builder prints on arrival
  cleanup();

  renderRouted();
  await ready();
  await openMenu('Vegas Destination · 203');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Edit this DPI only' }));
  expect(screen.getByTestId('where').textContent).toBe('/labels/templates/p1-203/edit');
  expect(screen.getByTestId('where-print').textContent).toBe('');
});

it('Update from parent… explains the Old copy, then makes a fresh one', async () => {
  renderRouted();
  await ready();
  await expand('Vegas Destination');
  await openMenu('Vegas Destination · 300');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Update from parent…' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('Vegas Destination · 300 Old 2');   // the next free Old name
  await userEvent.click(within(dialog).getByRole('button', { name: 'Update from parent' }));
  await waitFor(() => expect(api.updateLabelTemplateFromParent).toHaveBeenCalledWith('p1-300'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.listLabelTemplateTree).toHaveBeenCalledTimes(2);
});

it('Delete… on a parent lists what goes and needs its typed name', async () => {
  renderRouted();
  await ready();
  await openMenu('Vegas Destination');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }));
  const dialog = screen.getByRole('dialog');
  await within(dialog).findByText('Vegas Destination · 300 Old');
  const button = within(dialog).getByRole('button', { name: 'Delete template and 4 DPI versions' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type Vegas Destination to confirm'), 'Vegas Destination');
  await userEvent.click(button);
  await waitFor(() => expect(api.deleteLabelTemplateForGood).toHaveBeenCalledWith('p1', 'Vegas Destination'));
  await waitFor(() => expect(api.listLabelTemplateTree).toHaveBeenCalledTimes(2));
});

it('Delete this DPI… deletes the one child', async () => {
  api.getLabelTemplateDeleteSummary.mockResolvedValue({ children: [], generated_labels: 0 });
  renderRouted();
  await ready();
  await expand('Vegas Destination');
  await openMenu('Vegas Destination · 600');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Delete this DPI…' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Delete this DPI' }));
  await waitFor(() => expect(api.deleteLabelTemplateForGood).toHaveBeenCalledWith('p1-600'));
});

it('Replace… takes over from the active rows of the same family and type', async () => {
  renderRouted();
  await ready();
  await openMenu('Amsterdam Destination');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Replace…' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('checkbox', { name: 'Turn off Amsterdam Destination - 203DPI' })).toBeTruthy();
  expect(within(dialog).queryByText('Vegas Destination')).toBeNull();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
  await waitFor(() => expect(api.replaceLabelTemplates).toHaveBeenCalledWith('p2', ['l1']));
});

it('Activate turns a parent on through /activate', async () => {
  renderRouted();
  await ready();
  await openMenu('Amsterdam Destination');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Activate' }));
  await waitFor(() => expect(api.activateLabelTemplate).toHaveBeenCalledWith('p2'));
  expect(api.updateLabelTemplate).not.toHaveBeenCalled();
});

it('a refused activation offers Replace… with the rows in the way', async () => {
  api.activateLabelTemplate.mockRejectedValue(
    new ApiError(422, 'active_conflict', { code: 'active_conflict', names: ['Amsterdam Destination - 203DPI'] }));
  renderRouted();
  await ready();
  await openMenu('Amsterdam Destination');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Activate' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('heading', { name: 'Replace with “Amsterdam Destination”' })).toBeTruthy();
});

it('Deactivate asks first and turns the parent off', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderRouted();
  await ready();
  await openMenu('Vegas Destination');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Deactivate' }));
  expect(api.deleteLabelTemplate).toHaveBeenCalledWith('p1');
});

it('Add DPI… brings back a missing DPI', async () => {
  renderRouted();
  await ready();
  await openMenu('Amsterdam Destination');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Add DPI…' }));
  const dialog = screen.getByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Add 600 DPI' }));
  await waitFor(() => expect(api.addLabelTemplateDpi).toHaveBeenCalledWith('p2', '600'));
});

it('Sites… saves the parent’s sites', async () => {
  renderRouted();
  await ready();
  await openMenu('Vegas Destination');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Sites…' }));
  const dialog = screen.getByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove NAP11' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateLabelTemplate).toHaveBeenCalledWith('p1', { site_ids: ['s1'] }));
});

it('Clone to new template… makes an inactive copy', async () => {
  renderRouted();
  await ready();
  await openMenu('Vegas Destination');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Clone to new template…' }));
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clone' }));
  await waitFor(() => expect(api.cloneLabelTemplate).toHaveBeenCalledWith('p1', 'Vegas Destination copy'));
  await waitFor(() => expect(api.listLabelTemplateTree).toHaveBeenCalledTimes(2));
});

it('Versions… lists the saves; Open shows that version in the builder', async () => {
  renderRouted();
  await ready();
  await openMenu('Vegas Destination');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Versions…' }));
  const dialog = screen.getByRole('dialog', { name: 'Versions of Vegas Destination' });
  await within(dialog).findByText('Banner to Oswald');
  const v6 = within(dialog).getByText('Banner to Oswald').closest('tr') as HTMLElement;
  await userEvent.click(within(v6).getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/labels/templates/p1/edit'));
  expect(api.getLabelTemplateVersion).toHaveBeenCalledWith('p1', 6, 0);
  expect(screen.getByTestId('where-version').textContent).toBe('v6');
});

it('an older single row keeps its raw-code menu, plus a typed delete', async () => {
  renderRouted();
  await ready();
  expect(await openMenu('Crate tag')).toEqual(['Edit as raw code', 'Activate', 'Delete…']);   // an ESC/P template
  await userEvent.click(screen.getByRole('menuitem', { name: 'Edit as raw code' }));
  expect(screen.getByTestId('where').textContent).toBe('/labels/templates/t2/code');
});

it('an older design template converts to code, then opens in the code editor', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderRouted();
  await ready();
  expect(await openMenu('Front tag')).toEqual(['Edit as raw ZPL', 'Deactivate', 'Delete…']);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Edit as raw ZPL' }));
  await waitFor(() => expect(api.convertLabelTemplate).toHaveBeenCalledWith('t1'));
  await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/labels/templates/t1/code'));
});

it('below rank 80 the tree is read-only: no menus, no New template', async () => {
  auth.maxRank = 60;
  renderRouted();
  await ready();
  expect(screen.queryByRole('button', { name: /New template/ })).toBeNull();
  expect(screen.queryAllByRole('button', { name: /Actions/ })).toHaveLength(0);
  await expand('Vegas Destination');
  expect(screen.getByText('Vegas Destination · 300 Old')).toBeTruthy();
  expect(screen.queryAllByRole('button', { name: /Actions/ })).toHaveLength(0);
});

it('without labels:change a designer still reads and opens versions, but edits nothing', async () => {
  auth.can = (_r, action) => action === 'view';
  renderRouted();
  await ready();
  expect(screen.queryByRole('button', { name: /New template/ })).toBeNull();
  expect(await openMenu('Vegas Destination')).toEqual(['Versions…']);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Versions…' }));
  const dialog = screen.getByRole('dialog', { name: 'Versions of Vegas Destination' });
  await within(dialog).findByText('Banner to Oswald');
  expect(within(dialog).getAllByRole('button', { name: 'Open' })).toHaveLength(2);
  expect(within(dialog).queryAllByRole('button', { name: 'Restore' })).toHaveLength(0);
});

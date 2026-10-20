// @vitest-environment jsdom
/**
 * The label builder page over the Vegas fixture (the panels' fake font,
 * builderTestKit.ts): it loads a parent into the three panels, ⌘S saves
 * and moves the version on, a parent save that passes a customized child
 * asks about it, ⌘P compiles the label and sends it to the USB printer,
 * unsaved changes are guarded, a child saves only its design, and the
 * routes keep anyone below rank 80 out (App.tsx's route props).
 *
 * The keys are pressed as Ctrl (the platform is pinned to Windows).
 */

import { StrictMode } from 'react';
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import vegas from '../../../api/src/serversherpa/labels/fixtures/vegas_v2.json';
import { FAKE_METRICS, FIELDS, SAMPLES } from '../components/labels/builder/builderTestKit';
import type { LabelFont, LabelTemplate, LabelTemplateTreeNode, LabelVocab } from '../lib/api';

const auth = vi.hoisted(() => ({ maxRank: 80 }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    status: 'authed', mustChangePassword: false, maxRank: auth.maxRank, can: () => true,
  }),
}));

const printer = vi.hoisted(() => ({
  supported: true, connected: true, productName: 'ZD421', notice: null,
  clearNotice: vi.fn(), connect: vi.fn(), send: vi.fn(),
  disconnect: vi.fn(), connectTo: vi.fn(), knownDevices: vi.fn(async () => []), sendBytes: vi.fn(),
  identify: vi.fn(async () => ({ model: 'ZD421-203dpi', firmware: 'V93', dotsPerMm: 8, memory: '8192k', dpi: 203 })),
  status: vi.fn(async () => null),
  query: vi.fn(async (cmd: string) => (cmd.includes('HWZ') ? '- DIR Z:*.TTF\r\n* Z:TT0003M_.TTF 160676\r\n'
    : '- DIR E:*.TTF\r\n-1928576 bytes free E: ONBOARD FLASH\r\n')),
}));
vi.mock('../lib/useZebraPrinter', () => ({ useZebraPrinter: () => printer }));

const api = vi.hoisted(() => ({
  getLabelTemplate: vi.fn(), listLabelVocab: vi.fn(), listLabelFonts: vi.fn(), listLabelTemplateTree: vi.fn(),
  listLabelFields: vi.fn(), getLabelFontMetrics: vi.fn(), getLabelFontBytes: vi.fn(),
  updateLabelTemplate: vi.fn(), updateLabelTemplateFromParent: vi.fn(), compileLabel: vi.fn(),
  previewZplRequest: vi.fn(), createLabelTemplate: vi.fn(), createLabelVocab: vi.fn(),
  listLabelTemplateVersions: vi.fn(), getLabelTemplateVersion: vi.fn(), restoreLabelTemplateVersion: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));

// the whole page renders in jsdom, several times a test: run beside the rest
// of the suite one step can take longer than the default second, and a test
// longer than the default five
configure({ asyncUtilTimeout: 4000 });
vi.setConfig({ testTimeout: 20000 });

const { default: LabelBuilder } = await import('./LabelBuilder');
const { default: ProtectedRoute } = await import('../components/ProtectedRoute');

const vocabRow = (kind: string, key: string, label: string, meta: Record<string, unknown> = {}, sort = 0): LabelVocab => ({
  kind, key, label, description: '', meta, sort_order: sort, is_active: true, usage_count: null,
});

const VOCAB: LabelVocab[] = [
  vocabRow('type', 'top', 'Top Label'),
  vocabRow('size', '4x2', '4" x 2"', { width_in: 4, height_in: 2, has_tab: false }),
  vocabRow('dpi', '203', '203 DPI', { dots: 203 }, 1),
  vocabRow('dpi', '300', '300 DPI', { dots: 300 }, 2),
  vocabRow('dpi', '600', '600 DPI', { dots: 600 }, 3),
  vocabRow('language', 'zpl', 'ZPL', { family: 'zebra' }),
];

const FONTS: LabelFont[] = [
  { id: 'f-swiss', name: 'TT0003M_.TTF', family: 'swiss721-cond-bold', weight: 'regular', resident: true },
  { id: 'f-rcb', name: 'ROBOCO_B.TTF', family: 'roboto-condensed', weight: 'bold', resident: false },
].map((f) => ({
  ...f, display_name: f.name, size_bytes: 1, content_type: 'font/ttf', uploaded_by: null, uploaded_by_name: null,
  created_at: '', used_by: [],
} as LabelFont));

const PARENT: LabelTemplate = {
  id: 'p1', name: 'Vegas Destination', description: '', label_type: 'top', size_key: '4x2', dpi_key: '300',
  language_key: 'zpl', kind: 'design', design: vegas as Record<string, unknown>, code: null, version: 7,
  is_active: false, site_ids: [], created_at: '', updated_at: '', parent_id: null, schema_version: 2,
  samples: SAMPLES, dpis: ['203', '300', '600'], generated_from_version: null, child_edits: 0,
  customized: false, is_old: false,
};

const child = (dpi: string, over: Partial<LabelTemplate> = {}) => ({
  ...PARENT, id: `c${dpi}`, name: `Vegas Destination · ${dpi}`, dpi_key: dpi, parent_id: 'p1', samples: {},
  dpis: [dpi], generated_from_version: 7, ...over, out_of_date: false,
});

const NODE: LabelTemplateTreeNode = {
  ...PARENT, family: 'Vegas Destination',
  children: [child('203', { customized: true, child_edits: 2, generated_from_version: 6 }), child('300'), child('600')],
};

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

/** The routes as App.tsx declares them. */
function renderAt(path: string) {
  const gate = (el: JSX.Element) => (
    <ProtectedRoute resource="labels" minRank={80} fallback="/labels/templates">{el}</ProtectedRoute>
  );
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/labels/templates/new" element={gate(<LabelBuilder />)} />
        <Route path="/labels/templates/:id/edit" element={gate(<LabelBuilder />)} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>);
}

const ctrl = (key: string, extra: Record<string, unknown> = {}) => {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key;
  fireEvent.keyDown(document.body, { key, code, ctrlKey: true, ...extra });
};

/** The builder has mounted AND run its mount effects. The page renders
 *  when its loads resolve, outside act, so its effects (the key listeners
 *  among them) can still be pending when the top bar shows; under a busy
 *  suite a key pressed then went nowhere. Builder's fields request is one
 *  of those effects, and a commit's effects all run together. */
async function builderReady() {
  const bar = await screen.findByRole('group', { name: 'Template' });
  await waitFor(() => expect(api.listLabelFields).toHaveBeenCalled());
  return bar;
}

async function openParent() {
  renderAt('/labels/templates/p1/edit');
  await builderReady();
}

/** Select everything and nudge it a dot right: an unsaved change. */
function edit() {
  ctrl('a');
  fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight' });
}

beforeAll(() => {
  Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true });
});

beforeEach(() => {
  auth.maxRank = 80;
  printer.connected = true;
  api.getLabelTemplate.mockImplementation(async (id: string) => (id === 'p1' ? PARENT : child(id.slice(1))));
  api.listLabelVocab.mockResolvedValue(VOCAB);
  api.listLabelFonts.mockResolvedValue(FONTS);
  api.listLabelTemplateTree.mockResolvedValue([NODE]);
  api.listLabelFields.mockResolvedValue(FIELDS);
  api.getLabelFontMetrics.mockResolvedValue(FAKE_METRICS);
  api.compileLabel.mockResolvedValue({ code: '^XA^FD10482^FS^XZ' });
  api.updateLabelTemplate.mockImplementation(async (id: string, body: Record<string, unknown>) => (
    { ...PARENT, ...body, id, version: 8, out_of_date: [] }));
  printer.send.mockResolvedValue(undefined);
  printer.connect.mockImplementation(async () => { printer.connected = true; });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('a parent template', () => {
  it('loads into the top bar and the three panels', async () => {
    await openParent();
    const bar = screen.getByRole('group', { name: 'Template' });
    expect(within(bar).getByText('Vegas Destination')).toBeTruthy();
    expect(within(bar).getByText('Top Label · 4" x 2"')).toBeTruthy();
    expect(within(bar).getByText((_, el) => el?.textContent === 'Parent (203 · 300 · 600)'
      && el.classList.contains('chip'))).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Show at 300 DPI' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(bar).getByLabelText('Version v7').textContent).toBe('v7');
    expect(within(bar).queryByText('Unsaved')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Fields' })).toBeTruthy();
    expect(screen.getByRole('application', { name: 'Label canvas' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Fields on this label' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Properties' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Printer preview' })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('lvn-hm1w2-vc1-c1n7').length).toBeGreaterThan(0));
    expect(api.listLabelFields).toHaveBeenCalledWith('top');
  });

  it('⌘S saves the design and samples and moves the version chip on', async () => {
    await openParent();
    edit();
    const bar = screen.getByRole('group', { name: 'Template' });
    await waitFor(() => expect(within(bar).queryByText('Unsaved')).not.toBeNull());
    ctrl('s');
    await waitFor(() => expect(api.updateLabelTemplate).toHaveBeenCalledTimes(1));
    const [id, body] = api.updateLabelTemplate.mock.calls[0];
    expect(id).toBe('p1');
    expect(body.samples).toEqual(SAMPLES);
    expect(body.design.schema).toBe(2);
    const moved = body.design.elements.find((e: { id: string }) => e.id === 'caption-name');
    const before = (vegas.elements as { id: string; x: number }[]).find((e) => e.id === 'caption-name')!;
    expect(moved.x).toBeCloseTo(before.x + 1 / 300, 6);
    await waitFor(() => expect(within(bar).getByLabelText('Version v8').textContent).toBe('v8'));
    expect(within(bar).queryByText('Unsaved')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Saved v8.');
  });

  it('keeps each barcode as wide as it prints its sample: opening is no change, an edit stores it', async () => {
    // the fixture's box is 272 dots; the sample '10482' prints 90 modules of 4 = 360
    await openParent();
    const bar = screen.getByRole('group', { name: 'Template' });
    expect(within(bar).queryByText('Unsaved')).toBeNull();
    // a page edit (⌘B on the selected text), not one of the canvas's
    ctrl('a');
    ctrl('b');
    await waitFor(() => expect(within(bar).queryByText('Unsaved')).not.toBeNull());
    ctrl('s');
    await waitFor(() => expect(api.updateLabelTemplate).toHaveBeenCalledTimes(1));
    const sent = api.updateLabelTemplate.mock.calls[0][1].design.elements as { id: string; w: number }[];
    expect(sent.find((e) => e.id === 'barcode')!.w).toBeCloseTo(360 / 300, 9);
  });

  it('asks about each customized child the save passed by', async () => {
    api.updateLabelTemplate.mockResolvedValue({ ...PARENT, version: 8, out_of_date: ['c203'] });
    api.updateLabelTemplateFromParent.mockResolvedValue(child('203'));
    await openParent();
    edit();
    ctrl('s');
    const dialog = await screen.findByRole('dialog', { name: 'Customized DPIs out of date' });
    expect(within(dialog).getByText('Vegas Destination · 203')).toBeTruthy();
    expect(within(dialog).getByText('v6.2')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(api.updateLabelTemplateFromParent).toHaveBeenCalledWith('c203'));
    expect(await within(dialog).findByText('Updated')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Keep leaves the child as it is', async () => {
    api.updateLabelTemplate.mockResolvedValue({ ...PARENT, version: 8, out_of_date: ['c203'] });
    await openParent();
    edit();
    ctrl('s');
    const dialog = await screen.findByRole('dialog', { name: 'Customized DPIs out of date' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
    expect(within(dialog).getByText('Kept')).toBeTruthy();
    expect(api.updateLabelTemplateFromParent).not.toHaveBeenCalled();
  });

  it('⌘P compiles the label with its samples at the DPI shown and prints it over USB', async () => {
    await openParent();
    fireEvent.click(screen.getByRole('button', { name: 'Show at 203 DPI' }));
    ctrl('p');
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^FD10482^FS^XZ'));
    expect(api.compileLabel).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'design', dpi_key: '203', size_key: '4x2', language_key: 'zpl', samples: SAMPLES,
      design: expect.objectContaining({ schema: 2 }), label_type: 'top',
    }));
    expect(printer.connect).not.toHaveBeenCalled();
  });

  it('the printer preview compiles for the template\'s label type (out-of-type keys preview blank)', async () => {
    api.previewZplRequest.mockRejectedValue(new Error('offline'));
    await openParent();
    const preview = screen.getByRole('region', { name: 'Printer preview' });
    fireEvent.click(within(preview).getByRole('button', { name: 'Render' }));
    await waitFor(() => expect(api.compileLabel).toHaveBeenCalledTimes(1));
    expect(api.compileLabel).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'design', dpi_key: '300', size_key: '4x2', mode: 'sample', samples: SAMPLES, label_type: 'top',
    }));
    await within(preview).findByRole('alert');
  });

  it('Printer opens the printer dialog on this template, its fonts and the DPI shown', async () => {
    await openParent();
    fireEvent.click(within(screen.getByRole('group', { name: 'Template' })).getByRole('button', { name: 'Printer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Printer' });
    expect(within(dialog).getByText('Vegas Destination · Printer')).toBeTruthy();
    // the Vegas design prints in the built-in Swiss cut only, here on Z:
    const row = within(dialog).getByText('TT0003M_.TTF').closest('tr') as HTMLElement;
    expect(await within(row).findByText('Present')).toBeTruthy();
    expect(within(dialog).getByText('Prints at 203 DPI; the canvas is showing 300.')).toBeTruthy();
    // under the dialog ⌘S saves nothing
    ctrl('s');
    expect(api.updateLabelTemplate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Printer' })).toBeNull();
  });

  it('⌘P connects a printer first when none is connected', async () => {
    printer.connected = false;
    await openParent();
    ctrl('p');
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^FD10482^FS^XZ'));
    expect(printer.connect).toHaveBeenCalledTimes(1);
  });

  it('asks before leaving with unsaved changes', async () => {
    await openParent();
    edit();
    await waitFor(() => expect(screen.queryByText('Unsaved')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '← Templates' }));
    const dialog = screen.getByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('where')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '← Templates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave without saving' }));
    expect(screen.getByTestId('where').textContent).toBe('/labels/templates');
  });

  it('a reload with unsaved changes gets the browser prompt', async () => {
    await openParent();
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    edit();
    await waitFor(() => expect(screen.queryByText('Unsaved')).not.toBeNull());
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it('⌘/ opens the shortcut sheet, and under it ⌘S saves nothing', async () => {
    await openParent();
    edit();
    ctrl('/', { code: 'Slash' });
    const sheet = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(sheet).getByRole('table', { name: 'Workflow' })).toBeTruthy();
    const save = new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(save);
    expect(save.defaultPrevented).toBe(true);     // the browser's own Save stays away
    expect(api.updateLabelTemplate).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    ctrl('s');
    await waitFor(() => expect(api.updateLabelTemplate).toHaveBeenCalledTimes(1));
  });

  it('refits text whose new font arrives after it was picked', async () => {
    const roboto = { unitsPerEm: 1000, ascent: 900, descent: 300, advances: FAKE_METRICS.advances };
    let arrive: (m: typeof roboto) => void = () => {};
    api.listLabelFonts.mockResolvedValue([...FONTS, { ...FONTS[1], id: 'f-rob', name: 'ROBOTO_R.TTF', family: 'roboto', weight: 'regular' }]);
    api.getLabelFontMetrics.mockImplementation((id: string) => (id === 'f-rob'
      ? new Promise((resolve) => { arrive = resolve; })
      : Promise.resolve(FAKE_METRICS)));
    await openParent();
    const table = screen.getByRole('region', { name: 'Fields on this label' });
    fireEvent.click(within(table).getByText('Asset name').closest('tr')!);
    fireEvent.click(await screen.findByRole('button', { name: /^Font: Swiss/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Roboto' }));
    await act(async () => { arrive(roboto); });
    ctrl('s');
    await waitFor(() => expect(api.updateLabelTemplate).toHaveBeenCalledTimes(1));
    const el = api.updateLabelTemplate.mock.calls[0][1].design.elements
      .find((e: { id: string }) => e.id === 'value-name');
    expect(el.font).toEqual({ family: 'roboto', weight: 'regular' });
    expect(el.h).toBeCloseTo((1.2 * 8.4) / 72, 9);            // one line of Roboto
    expect(el.baselineIn).toBeCloseTo((0.9 * 8.4) / 72, 9);
  });

  it('a restored version the builder can’t read still counts as restored', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.listLabelTemplateVersions.mockResolvedValue([
      { version: 7, child_edits: 0, label: 'v7', summary: 'Moved', note: '', created_by: null, created_by_name: null, created_at: '' },
      { version: 6, child_edits: 0, label: 'v6', summary: 'Created', note: '', created_by: null, created_by_name: null, created_at: '' },
    ]);
    api.getLabelTemplateVersion.mockResolvedValue({
      version: 6, child_edits: 0, label: 'v6', summary: 'Created', note: '', created_by: null, created_by_name: null,
      created_at: '', design: vegas, code: null, samples: SAMPLES,
    });
    api.restoreLabelTemplateVersion.mockResolvedValue({ ...PARENT, version: 8, design: { schema: 9 }, out_of_date: [] });
    await openParent();
    fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
    const dialog = await screen.findByRole('dialog', { name: 'Versions of Vegas Destination' });
    const v6 = (await within(dialog).findByText('Created')).closest('tr') as HTMLElement;
    fireEvent.click(within(v6).getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore this version' }));
    await waitFor(() => expect(api.restoreLabelTemplateVersion).toHaveBeenCalledWith('p1', 6, 0));
    const bar = screen.getByRole('group', { name: 'Template' });
    await waitFor(() => expect(within(bar).getByLabelText('Version v8')).toBeTruthy());
    expect(screen.queryByText(/Couldn.t restore/)).toBeNull();
    expect(screen.getByText(/Restored as v8/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back to editing' })).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('opens on a version handed over by the templates list, read-only', async () => {
    const v6 = {
      version: 6, child_edits: 0, label: 'v6', summary: 'Created', note: '', created_by: null, created_by_name: null,
      created_at: '', design: vegas, code: null, samples: SAMPLES,
    };
    render(
      <MemoryRouter initialEntries={[{ pathname: '/labels/templates/p1/edit', state: { openVersion: v6 } }]}>
        <Routes>
          <Route path="/labels/templates/:id/edit" element={<LabelBuilder />} />
        </Routes>
      </MemoryRouter>);
    await screen.findByRole('group', { name: 'Template' });
    expect((await screen.findByRole('status')).textContent).toContain('Viewing v6, read-only.');
    // Back to editing leaves the version, and it doesn't come back
    fireEvent.click(screen.getByRole('button', { name: 'Back to editing' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Back to editing' })).toBeNull());
  });

  it('/ puts the cursor in the field search and opens the picker', async () => {
    await openParent();
    fireEvent.keyDown(document.body, { key: '/', code: 'Slash' });
    expect(document.activeElement).toBe(screen.getByRole('complementary', { name: 'Fields' })
      .querySelector('.lbp-search input'));
    expect(screen.getByRole('dialog', { name: 'Add to the label' })).toBeTruthy();
  });

  it('removing a field from the panel is one undo step, with a notice that undoes it', async () => {
    await openParent();
    const fields = screen.getByRole('complementary', { name: 'Fields' });
    const racks = () => screen.getByRole('application', { name: 'Label canvas' })
      .querySelectorAll('[data-el-id^="banner-"], [data-el-id^="grid-"]:not([data-el-id^="grid-caption"])');
    expect(racks()).toHaveLength(12);   // 5 + 5 pieces, 2 RUs
    // the field list fills once GET /labels/fields answers
    fireEvent.click(await within(fields).findByRole('button', { name: 'Remove Destination rack from the label' }));
    expect(racks()).toHaveLength(2);
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('Removed 10 placements of Destination rack.');
    fireEvent.click(within(notice).getByRole('button', { name: 'Undo' }));
    expect(racks()).toHaveLength(12);
    expect(screen.queryByText(/Removed 10 placements/)).toBeNull();
    // ⌘Z takes it back in one step too
    fireEvent.click(within(fields).getByRole('button', { name: 'Remove Destination rack from the label' }));
    expect(racks()).toHaveLength(2);
    ctrl('z');
    expect(racks()).toHaveLength(12);
    // undone: the notice goes with it, not just its Undo
    await waitFor(() => expect(screen.queryByText(/Removed 10 placements/)).toBeNull());
    // and once another step lands on top of the removal
    fireEvent.click(within(fields).getByRole('button', { name: 'Remove Destination rack from the label' }));
    expect(screen.getByText(/Removed 10 placements/)).toBeTruthy();
    ctrl('a');
    fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight' });
    await waitFor(() => expect(screen.queryByText(/Removed 10 placements/)).toBeNull());
  });
});

describe('a DPI child', () => {
  it('shows the parent’s samples read-only', async () => {
    renderAt('/labels/templates/c300/edit');
    const fields = await screen.findByRole('complementary', { name: 'Fields' });
    expect(within(fields).getByText('Samples belong to the parent template.')).toBeTruthy();
    const serial = within(fields).getByRole('button', { name: 'Edit the sample of Serial number' }) as HTMLButtonElement;
    expect(serial.textContent).toBe('36B7144');
    expect(serial.disabled).toBe(true);
    expect((within(fields).getByRole('button', { name: 'Load from asset…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows its DPI and saves only its design', async () => {
    api.updateLabelTemplate.mockResolvedValue({ ...child('300'), customized: true, child_edits: 1, version: 8 });
    renderAt('/labels/templates/c300/edit');
    const bar = await builderReady();
    expect(within(bar).getByText('Child · 300')).toBeTruthy();
    expect(within(bar).getByLabelText('Version v7').textContent).toBe('v7');
    expect(within(bar).queryByRole('button', { name: 'Clone' })).toBeNull();
    edit();
    ctrl('s');
    await waitFor(() => expect(api.updateLabelTemplate).toHaveBeenCalledTimes(1));
    const [id, body] = api.updateLabelTemplate.mock.calls[0];
    expect(id).toBe('c300');
    expect(Object.keys(body)).toEqual(['design']);
    await waitFor(() => expect(within(bar).getByLabelText('Version v7.1')).toBeTruthy());
  });
});

describe('arriving from the templates list', () => {
  /** The route as the list's Test print… opens it, under StrictMode (its
   *  effects run twice on mount, so "once" is tested for real). */
  function arrive(path: string, state: unknown) {
    return render(
      <StrictMode>
        <MemoryRouter initialEntries={[{ pathname: path, state }]}>
          <Routes>
            <Route path="/labels/templates/:id/edit" element={<LabelBuilder />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>);
  }

  it('Test print… prints the child once on arrival, connecting first', async () => {
    printer.connected = false;
    arrive('/labels/templates/c600/edit', { testPrint: true });
    await screen.findByRole('group', { name: 'Template' });
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^FD10482^FS^XZ'));
    expect(printer.connect).toHaveBeenCalledTimes(1);
    expect(api.compileLabel).toHaveBeenCalledWith(expect.objectContaining({ dpi_key: '600', mode: 'sample' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(printer.send).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Sent a test label at 600 DPI.')).toBeTruthy();
  });

  it('a plain arrival prints nothing', async () => {
    arrive('/labels/templates/c600/edit', null);
    await screen.findByRole('group', { name: 'Template' });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(api.compileLabel).not.toHaveBeenCalled();
    expect(printer.send).not.toHaveBeenCalled();
  });
});

describe('the routes', () => {
  it('send a rank-60 account from New template back to the list', async () => {
    auth.maxRank = 60;
    renderAt('/labels/templates/new');
    expect(screen.getByTestId('where').textContent).toBe('/labels/templates');
    expect(api.listLabelVocab).not.toHaveBeenCalled();
  });

  it('send a rank-60 account from a template back to the list', async () => {
    auth.maxRank = 60;
    renderAt('/labels/templates/p1/edit');
    expect(screen.getByTestId('where').textContent).toBe('/labels/templates');
    expect(api.getLabelTemplate).not.toHaveBeenCalled();
  });

  it('open New template for a designer, and the builder on what it made', async () => {
    api.createLabelTemplate.mockResolvedValue({ ...PARENT, id: 'p9', name: 'Odd' });
    renderAt('/labels/templates/new');
    const dialog = await screen.findByRole('dialog', { name: 'New label template' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Odd' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    });
    await waitFor(() => expect(api.createLabelTemplate).toHaveBeenCalled());
    await waitFor(() => expect(api.getLabelTemplate).toHaveBeenCalledWith('p9'));
  });

  it('send a code template to its code editor', async () => {
    api.getLabelTemplate.mockResolvedValue({ ...PARENT, id: 't5', kind: 'code', design: null, code: '^XA^XZ' });
    renderAt('/labels/templates/t5/edit');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/labels/templates/t5/code'));
  });
});

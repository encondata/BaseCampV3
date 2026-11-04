// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type LabelTemplate, type LabelTemplateChild, type LabelTemplateTreeNode, type LabelVocab } from '../../lib/api';
import { applyPrintSettings, DEFAULT_PRINT_SETTINGS, readPrintSettings } from '../../lib/printLabels';
import AlignmentTestModal, { alignmentLabelZpl } from './AlignmentTestModal';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);
beforeEach(() => localStorage.clear());

const vocab: LabelVocab[] = [
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'size', key: '2x1', label: '2" x 1"', description: '', meta: { width_in: 2, height_in: 1 }, sort_order: 2, is_active: true, usage_count: null },
  { kind: 'dpi', key: '203', label: '203 DPI', description: '', meta: { dots: 203 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'dpi', key: '300', label: '300 DPI', description: '', meta: { dots: 300 }, sort_order: 2, is_active: true, usage_count: null },
  { kind: 'type', key: 'front', label: 'Front', description: '', meta: {}, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'type', key: 'top', label: 'Top', description: '', meta: {}, sort_order: 2, is_active: true, usage_count: null },
  { kind: 'type', key: 'id_badge', label: 'ID Badge', description: '', meta: {}, sort_order: 3, is_active: true, usage_count: null },
];

const row = (id: string, over: Partial<LabelTemplate> = {}): LabelTemplate => ({
  id, name: id, description: '', label_type: 'top', size_key: '4x2', dpi_key: '203', language_key: 'zpl',
  kind: 'code', design: null, code: '^XA^XZ', version: 1, is_active: true, site_ids: [],
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...over,
});
const kid = (id: string, over: Partial<LabelTemplate>): LabelTemplateChild =>
  ({ ...row(id, { kind: 'design', schema_version: 2, parent_id: 'p1', ...over }), out_of_date: false });

/** Front Tag: a builder parent with 203 and 300 children. Generic Rack and
 *  RU Top: one older row, 203 only. Staff Badge: an ID badge, 203 only. */
const TREE: LabelTemplateTreeNode[] = [
  { ...row('p1', { kind: 'design', schema_version: 2, dpi_key: '300', label_type: 'front', name: 'Front Tag' }), family: 'Front Tag',
    children: [kid('c203', { dpi_key: '203', label_type: 'front', name: 'Front Tag v1' }), kid('c300', { dpi_key: '300', label_type: 'front', name: 'Front Tag v1 (300)' })] },
  { ...row('g1', { name: 'Generic Rack and RU' }), family: 'Generic Rack and RU', children: [] },
  { ...row('b1', { name: 'Staff Badge', label_type: 'id_badge' }), family: 'Staff Badge', children: [] },
];

const RENDERED = { zpl: '^XA\n^PW812\n^FDsample^FS\n^XZ', template_name: 'Front Tag' };

function setup(printerDpi: number | null = 203, tree: LabelTemplateTreeNode[] = TREE) {
  const onPrint = vi.fn(async (_zpl: string) => undefined);
  const onClose = vi.fn();
  const loadTemplates = vi.fn(async () => tree);
  const renderLabel = vi.fn(async (_templateId: string, _dpiKey: string) => RENDERED);
  render(<AlignmentTestModal vocab={vocab} printerDpi={printerDpi} onPrint={onPrint} onClose={onClose}
                             loadTemplates={loadTemplates} renderLabel={renderLabel} />);
  return { onPrint, onClose, loadTemplates, renderLabel };
}

const chooseMock = () => userEvent.click(screen.getByRole('radio', { name: /Mock-data label/ }));
async function pickTemplate(label: string) {
  await userEvent.click(screen.getByRole('combobox', { name: 'Template' }));
  await userEvent.click(await screen.findByRole('button', { name: label }));
}
const printButton = () => screen.getByRole('button', { name: /Print test label|Sending/ }) as HTMLButtonElement;

describe('AlignmentTestModal', () => {
  it('preselects the printer DPI and prints the 4x2 test with the stored offsets', async () => {
    localStorage.setItem('labels.print.settings', JSON.stringify({ verticalOffset: 5, horizontalOffset: -3 }));
    const { onPrint } = setup(203);
    expect(screen.getByRole('tab', { name: '203 DPI' }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByLabelText('Vertical offset') as HTMLInputElement).value).toBe('5');
    await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
    const zpl = onPrint.mock.calls[0][0];
    expect(zpl).toContain('^PW812');
    expect(zpl).toContain('^LL406');
    expect(zpl).toContain('^LT5');
    expect(zpl).toContain('^LS3');
    expect(zpl).not.toContain('^PQ');
    expect(await screen.findByText('Alignment test label (4x2) sent to printer')).toBeTruthy();
  });
  it('defaults to 300 DPI without a printer DPI and shows the boxes preview', () => {
    setup(null);
    expect(screen.getByRole('tab', { name: '300 DPI' }).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelectorAll('svg rect').length).toBeGreaterThanOrEqual(3);
  });
  it('Save offsets persists edited offsets and is disabled until changed', async () => {
    setup();
    const save = screen.getByRole('button', { name: 'Save offsets' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const v = screen.getByLabelText('Vertical offset');
    fireEvent.change(v, { target: { value: '12' } });
    fireEvent.blur(v);
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    expect(JSON.parse(localStorage.getItem('labels.print.settings') ?? '{}').verticalOffset).toBe(12);
    expect(screen.getByText('Offsets saved — Print Labels will use them.')).toBeTruthy();
  });
  it('shows a print failure', async () => {
    const { onPrint } = setup();
    onPrint.mockRejectedValueOnce(new Error('Printer connection lost. Please reconnect.'));
    await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
    expect(await screen.findByText('Printer connection lost. Please reconnect.')).toBeTruthy();
  });
  it('closes on Done, ×, and Escape', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('Test labels dialog', () => {
  it('is "Test labels" with Alignment label and Mock-data label choices', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Test labels' });
    expect(within(dialog).getByRole('heading', { name: 'Test labels' })).toBeTruthy();
    expect(within(dialog).getByText('Printers')).toBeTruthy();
    expect(within(dialog).getByText(
      'Print an alignment label or a label with sample data, then adjust the offsets and reprint until it lines up. The same offsets are used by Print Labels.')).toBeTruthy();
    const group = within(dialog).getByRole('radiogroup', { name: 'Test label' });
    const cards = within(group).getAllByRole('radio');
    expect(cards.map((c) => c.querySelector('.rgm-choice-title')?.textContent)).toEqual(['Alignment label', 'Mock-data label']);
    expect(within(group).getByText('Concentric boxes filling the whole label.')).toBeTruthy();
    expect(within(group).getByText('A real template filled with sample values.')).toBeTruthy();
    expect(cards[0].getAttribute('aria-checked')).toBe('true');
    expect(cards[1].getAttribute('aria-checked')).toBe('false');
  });
  it('alignment is the default: no template list is asked for until Mock-data label is chosen', async () => {
    const { loadTemplates } = setup();
    expect(loadTemplates).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox', { name: 'Template' })).toBeNull();
    expect(screen.getByText('812 × 406 dots at 203 DPI')).toBeTruthy();
    await chooseMock();
    expect(loadTemplates).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('radio', { name: /Alignment label/ }));
    await chooseMock();
    expect(loadTemplates).toHaveBeenCalledTimes(1);
  });
  it('lists the templates, one option per family and label type, natural order', async () => {
    setup();
    await chooseMock();
    await userEvent.click(screen.getByRole('combobox', { name: 'Template' }));
    const options = (await screen.findAllByRole('button')).filter((b) => b.classList.contains('kbar-item')).map((b) => b.textContent);
    expect(options).toEqual(['Front Tag · Front', 'Generic Rack and RU · Top', 'Staff Badge · ID Badge']);
  });
  it('shows the sizes ComboBox and the DPI tabs only for alignment; mock hides the tabs when the printer DPI is known', async () => {
    setup(203);
    expect(screen.getByRole('tab', { name: '300 DPI' })).toBeTruthy();
    await chooseMock();
    expect(screen.queryByRole('tab', { name: '300 DPI' })).toBeNull();
    expect(screen.queryByRole('tab', { name: '203 DPI' })).toBeNull();
    // offsets and Save offsets stay in both modes
    expect(screen.getByLabelText('Vertical offset')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save offsets' })).toBeTruthy();
  });
  it('prints the picked template\'s version at the printer\'s DPI with the stored offsets and no ^MM', async () => {
    localStorage.setItem('labels.print.settings', JSON.stringify({ verticalOffset: 5, horizontalOffset: -3 }));
    const { onPrint, renderLabel } = setup(203);
    await chooseMock();
    await pickTemplate('Front Tag · Front');
    await userEvent.click(printButton());
    await waitFor(() => expect(onPrint).toHaveBeenCalledTimes(1));
    expect(renderLabel).toHaveBeenCalledWith('c203', '203');
    const sent = onPrint.mock.calls[0][0];
    expect(sent).toBe(applyPrintSettings(RENDERED.zpl, { ...readPrintSettings(), verticalOffset: 5, horizontalOffset: -3 }, { singleCopy: true }));
    expect(sent).toContain('^LT5');
    expect(sent).toContain('^LS3');
    expect(sent).not.toMatch(/\^MM/i);
    expect(await screen.findByText('Mock-data label (Front Tag) sent to the printer.')).toBeTruthy();
  });
  it('previews what prints, at the picked DPI', async () => {
    setup(203);
    await chooseMock();
    expect(screen.getByText('Pick a template to print.')).toBeTruthy();
    expect(printButton().disabled).toBe(true);
    await pickTemplate('Front Tag · Front');
    expect(screen.getByText('Prints Front Tag v1 at 203 DPI with sample values, filled in by the portal.')).toBeTruthy();
    expect(printButton().disabled).toBe(false);
  });
  it('Reprint reuses the rendered label and shifts it by the current offsets', async () => {
    const { onPrint, renderLabel } = setup(203);
    await chooseMock();
    await pickTemplate('Front Tag · Front');
    await userEvent.click(printButton());
    await waitFor(() => expect(onPrint).toHaveBeenCalledTimes(1));
    const v = screen.getByLabelText('Vertical offset');
    fireEvent.change(v, { target: { value: '9' } });
    fireEvent.blur(v);
    await userEvent.click(printButton());
    await waitFor(() => expect(onPrint).toHaveBeenCalledTimes(2));
    expect(renderLabel).toHaveBeenCalledTimes(1);
    expect(onPrint.mock.calls[0][0]).not.toContain('^LT9');
    expect(onPrint.mock.calls[1][0]).toContain('^LT9');
  });
  it('picking another template renders that one', async () => {
    const { renderLabel } = setup(203);
    await chooseMock();
    await pickTemplate('Front Tag · Front');
    await userEvent.click(printButton());
    await waitFor(() => expect(renderLabel).toHaveBeenCalledTimes(1));
    await pickTemplate('Generic Rack and RU · Top');
    await userEvent.click(printButton());
    await waitFor(() => expect(renderLabel).toHaveBeenCalledTimes(2));
    expect(renderLabel).toHaveBeenLastCalledWith('g1', '203');
  });
  it('says why when the template has no version at the printer\'s DPI, and disables Print', async () => {
    const { renderLabel } = setup(300);
    await chooseMock();
    await pickTemplate('Generic Rack and RU · Top');
    expect(screen.getByText('"Generic Rack and RU" is only available at 203 DPI, so it can\'t print on this 300 DPI printer.')).toBeTruthy();
    expect(printButton().disabled).toBe(true);
    expect(renderLabel).not.toHaveBeenCalled();
  });
  it('with no active templates says so and disables Print', async () => {
    setup(203, []);
    await chooseMock();
    expect(await screen.findByText('No active templates to print.')).toBeTruthy();
    expect(printButton().disabled).toBe(true);
  });
  it('when the template list will not load says the same and disables Print', async () => {
    const onPrint = vi.fn(async (_zpl: string) => undefined);
    const loadTemplates = vi.fn(async (): Promise<LabelTemplateTreeNode[]> => { throw new Error('offline'); });
    render(<AlignmentTestModal vocab={vocab} printerDpi={203} onPrint={onPrint} onClose={vi.fn()}
                               loadTemplates={loadTemplates} renderLabel={vi.fn()} />);
    await chooseMock();
    expect(await screen.findByText('No active templates to print.')).toBeTruthy();
    expect(printButton().disabled).toBe(true);
  });
  it('shows Loading templates… while the list is on its way', async () => {
    const loadTemplates = vi.fn(() => new Promise<LabelTemplateTreeNode[]>(() => undefined));
    render(<AlignmentTestModal vocab={vocab} printerDpi={203} onPrint={vi.fn()} onClose={vi.fn()}
                               loadTemplates={loadTemplates} renderLabel={vi.fn()} />);
    await chooseMock();
    expect(screen.getByText('Loading templates…')).toBeTruthy();
    expect(screen.queryByText('No active templates to print.')).toBeNull();
    expect(printButton().disabled).toBe(true);
  });
  it('with no printer DPI shows the DPI picker in mock mode and prints that DPI\'s version', async () => {
    const { renderLabel } = setup(null);
    await chooseMock();
    const tab300 = screen.getByRole('tab', { name: '300 DPI' });
    expect(tab300.getAttribute('aria-selected')).toBe('true');
    await pickTemplate('Front Tag · Front');
    expect(screen.getByText('Prints Front Tag v1 (300) at 300 DPI with sample values, filled in by the portal.')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: '203 DPI' }));
    expect(screen.getByText('Prints Front Tag v1 at 203 DPI with sample values, filled in by the portal.')).toBeTruthy();
    await userEvent.click(printButton());
    await waitFor(() => expect(renderLabel).toHaveBeenCalledWith('c203', '203'));
  });
  it('a failed render shows the code and caches nothing', async () => {
    const { onPrint, renderLabel } = setup(203);
    renderLabel.mockRejectedValueOnce(new ApiError(422, 'template_unconvertible'));
    await chooseMock();
    await pickTemplate('Front Tag · Front');
    await userEvent.click(printButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("Couldn't print the test label (template_unconvertible).");
    expect(onPrint).not.toHaveBeenCalled();
    expect(printButton().disabled).toBe(false);
    await userEvent.click(printButton());
    await waitFor(() => expect(onPrint).toHaveBeenCalledTimes(1));
    expect(renderLabel).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('a printer failure in mock mode reads the same way, with the error\'s message', async () => {
    const { onPrint } = setup(203);
    onPrint.mockRejectedValueOnce(new Error('Printer connection lost. Please reconnect.'));
    await chooseMock();
    await pickTemplate('Front Tag · Front');
    await userEvent.click(printButton());
    expect((await screen.findByRole('alert')).textContent)
      .toBe("Couldn't print the test label (Printer connection lost. Please reconnect.).");
  });
  it('a badge says photos and logos print blank; another type does not', async () => {
    setup(203);
    await chooseMock();
    await pickTemplate('Staff Badge · ID Badge');
    const line = screen.getByText(/^Prints Staff Badge at 203 DPI/);
    expect(line.textContent).toBe('Prints Staff Badge at 203 DPI with sample values, filled in by the portal. Photos and logos print blank.');
    await pickTemplate('Generic Rack and RU · Top');
    expect(screen.getByText(/^Prints Generic Rack and RU at 203 DPI/).textContent).not.toContain('Photos and logos');
  });
  it('switching back to alignment prints the boxes, not the mock label', async () => {
    const { onPrint, renderLabel } = setup(203);
    await chooseMock();
    await pickTemplate('Front Tag · Front');
    await userEvent.click(screen.getByRole('radio', { name: /Alignment label/ }));
    await userEvent.click(printButton());
    await waitFor(() => expect(onPrint).toHaveBeenCalledTimes(1));
    expect(onPrint.mock.calls[0][0]).toContain('ALIGN 4x2 203DPI');
    expect(renderLabel).not.toHaveBeenCalled();
    expect(await screen.findByText('Alignment test label (4x2) sent to printer')).toBeTruthy();
  });
});

describe('alignmentLabelZpl', () => {
  it('builds the boxes for a size at a DPI with the given offsets, one copy', () => {
    const zpl = alignmentLabelZpl(vocab[0], 300, { ...DEFAULT_PRINT_SETTINGS, verticalOffset: 4, horizontalOffset: 0 });
    expect(zpl).toContain('^PW1200');
    expect(zpl).toContain('^LL600');
    expect(zpl).toContain('ALIGN 4x2 300DPI');
    expect(zpl).toContain('^LT4');
    expect(zpl).not.toContain('^PQ');
  });
});

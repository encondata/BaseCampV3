// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type KioskLabelTemplate } from '../../lib/api';

/** One fake Zebra printer, answered the same way over USB and the edge. */
const printerState = vi.hoisted(() => ({
  dpmm: 8, paperOut: false, headOpen: false, paused: false, fonts: [] as string[],
  peeler: '"Not Present"' as string | Error,
}));

function reply(command: string): string {
  const s = printerState;
  if (command === '~HI') return `\x02ZT411,V85.20.19,${s.dpmm},8176KB\x03`;
  if (command === '~HS') {
    return `\x02030,${s.paperOut ? 1 : 0},${s.paused ? 1 : 0},1218,000,0,0,0,000,0,0,0\x03\r\n`
      + `\x02001,0,${s.headOpen ? 1 : 0},0,1,2,6,0,00000000,1,000\x03\r\n\x021234,0\x03`;
  }
  if (command === '! U1 getvar "sensor.peeler_present"\r\n') {
    if (s.peeler instanceof Error) throw s.peeler;
    return s.peeler;
  }
  if (command === '^XA^HWE:*.*^XZ') {
    return `- DIR E:*.*\r\n${s.fonts.map((f) => `* E:${f} 1000`).join('\r\n')}\r\n-500000 bytes free\r\n`;
  }
  return '';
}

const auth = vi.hoisted(() => ({ kioskMove: null as null | { initiative_id: string; name: string } }));
vi.mock('../../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

const apiMock = vi.hoisted(() => ({
  fetchKioskLabelFonts: vi.fn(),
  fetchKioskFontContent: vi.fn(),
  startPrinterScan: vi.fn(),
  getPrinterScan: vi.fn(),
  printerQuery: vi.fn(),
  printerSend: vi.fn(),
  printerSendFont: vi.fn(),
  putLabelStation: vi.fn(),
  postTestRender: vi.fn(),
  getLabelPlan: vi.fn(),
}));
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, ...apiMock };
});

const templatesMock = vi.hoisted(() => ({ templates: [] as KioskLabelTemplate[], calls: 0 }));
vi.mock('../../lib/labelTemplates', () => ({
  getLabelTemplates: async () => { templatesMock.calls += 1; return templatesMock.templates; },
}));

const syncState = vi.hoisted(() => ({ phase: 'done' }));
vi.mock('../../lib/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/sync')>();
  return { ...actual, useSyncStatus: () => ({ phase: syncState.phase }) };
});

const usb = vi.hoisted(() => ({
  known: [] as { productName: string; serialNumber: string }[],
  picked: { productName: 'ZD621', serialNumber: 'PICKED1' },
  sent: [] as string[],
}));
vi.mock('../../lib/useZebraPrinter', async () => {
  const { useState } = await import('react');
  return {
    useZebraPrinter: () => {
      const [device, setDevice] = useState<null | { productName: string; serialNumber: string }>(null);
      return {
        supported: true, connected: device !== null, productName: device?.productName ?? null, device,
        notice: null, clearNotice: () => {},
        connect: async () => setDevice(usb.picked),
        connectTo: async (d: { productName: string; serialNumber: string }) => setDevice(d),
        knownDevices: async () => usb.known,
        query: async (cmd: string) => reply(cmd),
        send: async (zpl: string) => {
          usb.sent.push(zpl);
          const m = zpl.match(/^~DYE:([^,]+),/);
          if (m) printerState.fonts.push(m[1]);
        },
        sendBytes: async () => {},
      };
    },
  };
});

import PrinterStep from './PrinterStep';

function template(over: Partial<KioskLabelTemplate>): KioskLabelTemplate {
  return {
    id: 't', name: 'T', label_type: 'top', size_key: '4x2', dpi_key: '203', language_key: 'zpl',
    version: 1, updated_at: '2026-10-19T00:00:00Z', move_site_names: [], reasons: ['generic'],
    code: '^XA^XZ', generation_rules: {}, width_in: 4, height_in: 2, dots: 203, error: null, ...over,
  };
}

beforeEach(() => {
  Object.assign(printerState, {
    dpmm: 8, paperOut: false, headOpen: false, paused: false, fonts: [],
    peeler: '"Not Present"',
  });
  auth.kioskMove = null;
  usb.known = [{ productName: 'ZD421', serialNumber: 'USB1' }];
  usb.sent = [];
  templatesMock.templates = [template({ id: 'g', name: 'Generic Rack and RU' })];
  templatesMock.calls = 0;
  syncState.phase = 'done';
  apiMock.fetchKioskLabelFonts.mockReset().mockResolvedValue({ fonts: [], missing: [] });
  apiMock.fetchKioskFontContent.mockReset().mockResolvedValue(new Uint8Array([0, 1, 0, 0]));
  apiMock.startPrinterScan.mockReset().mockResolvedValue({ scan_id: 's1' });
  apiMock.getPrinterScan.mockReset().mockResolvedValue({
    scan_id: 's1', state: 'done', probed: 254, total: 254,
    printers: [
      { ip: '10.0.0.40', model: 'ZD621-203dpi', firmware: 'V93.21.18Z', dpi: 203 },
      { ip: '10.0.0.41', model: null, firmware: null, dpi: null },
    ],
  });
  apiMock.printerQuery.mockReset().mockImplementation(async (_ip: string, command: string) => ({
    response: reply(command), truncated: false,
  }));
  apiMock.printerSend.mockReset().mockResolvedValue(undefined);
  apiMock.printerSendFont.mockReset().mockImplementation(async (body: { name: string }) => {
    printerState.fonts.push(body.name);
  });
  apiMock.putLabelStation.mockReset().mockImplementation(async (s: unknown) => s);
  // An older edge with no plan route: the DPI row falls back to the downloaded templates.
  apiMock.getLabelPlan.mockReset().mockRejectedValue(new ApiError(404, 'unknown_error'));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderStep(over: Partial<Parameters<typeof PrinterStep>[0]> = {}) {
  const onFinish = vi.fn();
  const onBack = vi.fn();
  const view = render(<PrinterStep initiativeId="i-1" labelKind="top" initial={null}
                                   onFinish={onFinish} onBack={onBack} {...over} />);
  const rerender = (next: Partial<Parameters<typeof PrinterStep>[0]> = {}) => view.rerender(
    <PrinterStep initiativeId="i-1" labelKind="top" initial={null}
                 onFinish={onFinish} onBack={onBack} {...over} {...next} />);
  return { onFinish, onBack, rerender };
}

function row(label: string): HTMLElement {
  const li = screen.getByText(label).closest('li');
  if (!li) throw new Error(`no check row "${label}"`);
  return li;
}

async function passed(label: string) {
  await waitFor(() => expect(row(label).querySelector('[aria-label="passed"]')).toBeTruthy(), { timeout: 3000 });
}

async function failed(label: string) {
  await waitFor(() => expect(row(label).querySelector('[aria-label="failed"]')).toBeTruthy(), { timeout: 3000 });
}

async function allGreen() {
  for (const l of ['Printer answers', 'DPI matches the templates', 'Ready to print', 'Peeler', 'Fonts installed']) {
    await passed(l);
  }
}

const finishButton = () => screen.getByRole('button', { name: 'Finish' }) as HTMLButtonElement;

describe('USB', () => {
  it('offers allowed printers first, runs the checks, and saves the settings on Finish', async () => {
    const user = userEvent.setup();
    const { onFinish } = renderStep();
    const allowed = await screen.findByRole('button', { name: 'Use ZD421' });
    const connect = screen.getByRole('button', { name: 'Connect a USB printer' });
    expect(allowed.compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(finishButton().disabled).toBe(true);
    await user.click(allowed);
    await allGreen();
    expect(finishButton().disabled).toBe(false);
    await user.click(finishButton());
    await waitFor(() => expect(onFinish).toHaveBeenCalled());
    expect(apiMock.putLabelStation).toHaveBeenCalledWith({
      label_kind: 'top', printer: { type: 'usb', ip: null, model: 'ZT411', serial: 'USB1' },
      dpi: 203, offset_x: 0, offset_y: 0, peel: false,
    });
  });

  it('Connect opens the browser picker', async () => {
    const user = userEvent.setup();
    usb.known = [];
    renderStep();
    await user.click(await screen.findByRole('button', { name: 'Connect a USB printer' }));
    await allGreen();
  });
});

describe('network', () => {
  it('choosing Network starts the scan, and a picked printer runs the checks through the edge', async () => {
    const user = userEvent.setup();
    const { onFinish } = renderStep();
    await user.click(screen.getByRole('option', { name: /Network printer/ }));
    expect(apiMock.startPrinterScan).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole('button', { name: /^10\.0\.0\.41/ }));
    await allGreen();
    expect(apiMock.printerQuery).toHaveBeenCalledWith('10.0.0.41', '~HI');
    await user.click(finishButton());
    await waitFor(() => expect(onFinish).toHaveBeenCalled());
    expect(apiMock.putLabelStation).toHaveBeenCalledWith(expect.objectContaining({
      printer: { type: 'network', ip: '10.0.0.41', model: 'ZT411', serial: null },
    }));
  });

  it('accepts a typed IP address', async () => {
    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('option', { name: /Network printer/ }));
    await user.type(screen.getByLabelText('Printer IP'), '192.168.1.50');
    await user.click(screen.getByRole('button', { name: 'Use this address' }));
    await allGreen();
    expect(apiMock.printerQuery).toHaveBeenCalledWith('192.168.1.50', '~HI');
  });
});

describe('checks', () => {
  async function connectUsb(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Use ZD421' }));
    await passed('Printer answers');
  }

  it('DPI fails when no template of the chosen kind is at the printer DPI', async () => {
    const user = userEvent.setup();
    templatesMock.templates = [
      template({ id: 'g', label_type: 'top', dpi_key: '300' }),
      template({ id: 'f', label_type: 'front', dpi_key: '203' }),
    ];
    renderStep();
    await connectUsb(user);
    await failed('DPI matches the templates');
    expect(within(row('DPI matches the templates')).getByText(/203 DPI.*300 DPI/)).toBeTruthy();
  });

  it('DPI passes against the Front templates for a Front station', async () => {
    const user = userEvent.setup();
    templatesMock.templates = [
      template({ id: 'g', label_type: 'top', dpi_key: '300' }),
      template({ id: 'f', label_type: 'front', dpi_key: '203' }),
    ];
    renderStep({ labelKind: 'front' });
    await connectUsb(user);
    await passed('DPI matches the templates');
  });

  it('DPI asks the edge plan: green with the template name, notes as non-blocking warnings', async () => {
    const user = userEvent.setup();
    apiMock.getLabelPlan.mockResolvedValue({
      template: { id: 't1', name: 'ORD1 Top 203', family: 'Top', dpi_key: '203', version: 3 },
      notes: ['No destination template at 203 DPI; using the source template.'],
    });
    const { onFinish } = renderStep();
    await connectUsb(user);
    await passed('DPI matches the templates');
    expect(apiMock.getLabelPlan).toHaveBeenCalledWith({ dpi: 203, kind: 'top' });
    const dpiRow = row('DPI matches the templates');
    expect(within(dpiRow).getByText('ORD1 Top 203')).toBeTruthy();
    const note = within(dpiRow).getByText('No destination template at 203 DPI; using the source template.');
    expect(note.classList.contains('check-warning')).toBe(true);
    await allGreen();
    expect(finishButton().disabled).toBe(false);
    await user.click(finishButton());
    await waitFor(() => expect(onFinish).toHaveBeenCalled());
  });

  it('DPI fails when the move has no active template at all, and says who fixes it', async () => {
    const user = userEvent.setup();
    apiMock.getLabelPlan.mockResolvedValue({ template: null, notes: [], available_dpis: [] });
    renderStep();
    await connectUsb(user);
    await failed('DPI matches the templates');
    expect(within(row('DPI matches the templates')).getByText('No active Top template for this move. Someone '
      + 'with label access needs to activate one on Labels › Templates in the portal (Generic Rack and RU '
      + 'covers every move), then pick the move again.')).toBeTruthy();
    expect(finishButton().disabled).toBe(true);
  });

  it('DPI fails when the move\'s template is at other DPIs, and names them', async () => {
    const user = userEvent.setup();
    apiMock.getLabelPlan.mockResolvedValue({ template: null, notes: [], available_dpis: ['300'] });
    renderStep();
    await connectUsb(user);
    await failed('DPI matches the templates');
    expect(within(row('DPI matches the templates')).getByText('This move\'s Top template prints at 300 DPI only; '
      + 'this printer is 203 DPI. Activate a 203 DPI version on Labels › Templates, or use a 300 DPI printer.'))
      .toBeTruthy();
  });

  it('DPI names several other DPIs naturally', async () => {
    const user = userEvent.setup();
    apiMock.getLabelPlan.mockResolvedValue({ template: null, notes: [], available_dpis: ['300', '600'] });
    renderStep();
    await connectUsb(user);
    await failed('DPI matches the templates');
    expect(within(row('DPI matches the templates')).getByText('This move\'s Top template prints at 300 and 600 '
      + 'DPI only; this printer is 203 DPI. Activate a 203 DPI version on Labels › Templates, or use a 300 or 600 '
      + 'DPI printer.')).toBeTruthy();
  });

  it('DPI names the Front kind for a Front station', async () => {
    const user = userEvent.setup();
    apiMock.getLabelPlan.mockResolvedValue({ template: null, notes: [], available_dpis: [] });
    renderStep({ labelKind: 'front' });
    await connectUsb(user);
    await failed('DPI matches the templates');
    expect(apiMock.getLabelPlan).toHaveBeenCalledWith({ dpi: 203, kind: 'front' });
    expect(within(row('DPI matches the templates')).getByText(/^No active Front template for this move\./))
      .toBeTruthy();
  });

  it('an edge whose plan has no available_dpis reads them off the downloaded templates', async () => {
    const user = userEvent.setup();
    templatesMock.templates = [
      template({ id: 'g203', name: 'Generic Rack and RU', dpi_key: '203' }),
      template({ id: 'g600', name: 'Generic Rack and RU', dpi_key: '600' }),
    ];
    apiMock.getLabelPlan.mockResolvedValue({ template: null, notes: [] });
    renderStep();
    await connectUsb(user);
    await failed('DPI matches the templates');
    // the printer's own DPI isn't offered back: the plan found nothing there
    expect(within(row('DPI matches the templates')).getByText(/^This move's Top template prints at 600 DPI only;/))
      .toBeTruthy();
  });

  it('an older edge (no plan route) gets the same two messages from the downloaded templates', async () => {
    const user = userEvent.setup();
    templatesMock.templates = [template({ id: 'g300', name: 'Generic Rack and RU', dpi_key: '300' })];
    renderStep();
    await connectUsb(user);
    await failed('DPI matches the templates');
    expect(within(row('DPI matches the templates')).getByText('This move\'s Top template prints at 300 DPI only; '
      + 'this printer is 203 DPI. Activate a 203 DPI version on Labels › Templates, or use a 300 DPI printer.'))
      .toBeTruthy();
    cleanup();
    templatesMock.templates = [template({ id: 'f203', label_type: 'front', dpi_key: '203' })];
    renderStep();
    await connectUsb(user);
    await failed('DPI matches the templates');
    expect(within(row('DPI matches the templates')).getByText(/^No active Top template for this move\. Someone with label access/))
      .toBeTruthy();
  });

  it('status problems say what to fix, and Recheck turns them green', async () => {
    const user = userEvent.setup();
    printerState.paperOut = true;
    printerState.headOpen = true;
    renderStep();
    await connectUsb(user);
    await failed('Ready to print');
    expect(screen.getByText(/Paper out: load labels\./)).toBeTruthy();
    expect(screen.getByText(/Head open: close the print head\./)).toBeTruthy();
    printerState.paperOut = false;
    printerState.headOpen = false;
    await user.click(screen.getByRole('button', { name: 'Recheck' }));
    await allGreen();
    expect(finishButton().disabled).toBe(false);
  });

  it('installs a missing font from the library, then the check goes green', async () => {
    const user = userEvent.setup();
    templatesMock.templates = [template({ code: '^XA^A@N,30,30,E:ROBOTO.TTF^FDx^FS^XZ' })];
    apiMock.fetchKioskLabelFonts.mockResolvedValue({ fonts: [{ id: 'f-r', name: 'ROBOTO.TTF', size: 4 }], missing: [] });
    renderStep();
    await user.click(screen.getByRole('option', { name: /Network printer/ }));
    await user.type(screen.getByLabelText('Printer IP'), '10.0.0.40');
    await user.click(screen.getByRole('button', { name: 'Use this address' }));
    await failed('Fonts installed');
    expect(apiMock.fetchKioskLabelFonts).toHaveBeenCalledWith('i-1');
    await user.click(screen.getByRole('button', { name: 'Install 1 missing font' }));
    await waitFor(() => expect(apiMock.printerSendFont).toHaveBeenCalledWith({
      ip: '10.0.0.40', font_id: 'f-r', name: 'ROBOTO.TTF', initiative_id: 'i-1',
    }));
    await passed('Fonts installed');
  });

  it('the same install over USB sends ~DY with the bytes', async () => {
    const user = userEvent.setup();
    templatesMock.templates = [template({ code: '^XA^A@N,30,30,E:ROBOTO.TTF^FDx^FS^XZ' })];
    apiMock.fetchKioskLabelFonts.mockResolvedValue({ fonts: [{ id: 'f-r', name: 'ROBOTO.TTF', size: 4 }], missing: [] });
    renderStep();
    await connectUsb(user);
    await failed('Fonts installed');
    await user.click(screen.getByRole('button', { name: 'Install 1 missing font' }));
    await passed('Fonts installed');
    expect(apiMock.fetchKioskFontContent).toHaveBeenCalledWith('f-r', 'i-1');
    expect(usb.sent).toContain('~DYE:ROBOTO.TTF,B,T,4,,');
  });

  it('a failed font install keeps its error on screen after the recheck', async () => {
    const user = userEvent.setup();
    templatesMock.templates = [template({ code: '^XA^A@N,30,30,E:ROBOTO.TTF^FDx^FS^XZ' })];
    apiMock.fetchKioskLabelFonts.mockResolvedValue({ fonts: [{ id: 'f-r', name: 'ROBOTO.TTF', size: 4 }], missing: [] });
    apiMock.printerSendFont.mockRejectedValue(new ApiError(502, 'printer_unreachable'));
    renderStep();
    await user.click(screen.getByRole('option', { name: /Network printer/ }));
    await user.type(screen.getByLabelText('Printer IP'), '10.0.0.40');
    await user.click(screen.getByRole('button', { name: 'Use this address' }));
    await failed('Fonts installed');
    await user.click(screen.getByRole('button', { name: 'Install 1 missing font' }));
    const message = "Couldn't install ROBOTO.TTF (printer_unreachable).";
    await screen.findByText(message);
    // past the settle delay and the follow-up recheck
    await screen.findByRole('button', { name: 'Install 1 missing font' });
    await new Promise((r) => { setTimeout(r, 900); });
    await failed('Fonts installed');
    expect(screen.getByText(message)).toBeTruthy();
  });

  it("fonts are the plan template's only: other templates' fonts never block", async () => {
    const user = userEvent.setup();
    templatesMock.templates = [
      template({ id: 'picked', code: '^XA^A@N,30,30,E:ROBOTO.TTF^FDx^FS^XZ' }),
      template({ id: 'global', code: '^XA^A@N,30,30,E:OTHER.TTF^FDx^FS^XZ' }),
      template({ id: 'other-dpi', dpi_key: '300', code: '^XA^A@N,30,30,E:BIG.TTF^FDx^FS^XZ' }),
    ];
    printerState.fonts.push('ROBOTO.TTF');
    apiMock.getLabelPlan.mockResolvedValue({
      template: { id: 'picked', name: 'ORD1 Top 203', family: 'ORD1 Top', dpi_key: '203', version: 1 },
      notes: [],
    });
    renderStep();
    await connectUsb(user);
    await allGreen();
    expect(apiMock.fetchKioskLabelFonts).not.toHaveBeenCalled();

    // the picked template's own missing font still fails
    cleanup();
    printerState.fonts = [];
    renderStep();
    await connectUsb(user);
    await failed('Fonts installed');
    expect(within(row('Fonts installed')).getByText('Missing: ROBOTO.TTF.')).toBeTruthy();
  });

  it('without a plan (older edge) fonts fall back to every template of the kind', async () => {
    const user = userEvent.setup();
    templatesMock.templates = [
      template({ id: 'a', code: '^XA^A@N,30,30,E:ROBOTO.TTF^FDx^FS^XZ' }),
      template({ id: 'b', code: '^XA^A@N,30,30,E:OTHER.TTF^FDx^FS^XZ' }),
    ];
    printerState.fonts.push('ROBOTO.TTF');
    renderStep();
    await connectUsb(user);
    await failed('Fonts installed');
    expect(within(row('Fonts installed')).getByText('Missing: OTHER.TTF.')).toBeTruthy();
  });

  it('a font that is not in the library stays red with the upload hint', async () => {
    const user = userEvent.setup();
    templatesMock.templates = [template({ code: '^XA^A@N,30,30,E:MISSING.TTF^FDx^FS^XZ' })];
    apiMock.fetchKioskLabelFonts.mockResolvedValue({ fonts: [], missing: ['MISSING.TTF'] });
    renderStep();
    await connectUsb(user);
    await failed('Fonts installed');
    expect(screen.getByText(/MISSING\.TTF isn't in the font library\. Upload it in the portal's font library\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Install/ })).toBeNull();
    expect(finishButton().disabled).toBe(true);
  });

  const SWISS_CODE = '^XA^A@N,40,40,E:TT0003M_.TTF^FDx^FS^XZ';
  const SWISS_FONT = { id: 'f-s', name: 'TT0003M_.TTF', size: 0, resident: true };

  it('a missing built-in font is red with no Install button, and is never installed', async () => {
    const user = userEvent.setup();
    templatesMock.templates = [template({ code: SWISS_CODE })];
    apiMock.fetchKioskLabelFonts.mockResolvedValue({ fonts: [SWISS_FONT], missing: [] });
    renderStep();
    await connectUsb(user);
    await failed('Fonts installed');
    expect(within(row('Fonts installed')).getByText('Printer is missing its built-in font TT0003M_.TTF.'))
      .toBeTruthy();
    expect(screen.queryByRole('button', { name: /Install/ })).toBeNull();
    expect(screen.queryByText(/isn't in the font library/)).toBeNull();
    expect(apiMock.printerSendFont).not.toHaveBeenCalled();
    expect(apiMock.fetchKioskFontContent).not.toHaveBeenCalled();
    expect(usb.sent.some((z) => z.startsWith('~DY'))).toBe(false);
    // Finish anyway stays as it was: a user session may still finish
    expect(finishButton().disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Finish anyway' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a built-in font on the printer passes the check', async () => {
    const user = userEvent.setup();
    templatesMock.templates = [template({ code: SWISS_CODE })];
    printerState.fonts.push('TT0003M_.TTF');
    renderStep();
    await connectUsb(user);
    await allGreen();
    expect(apiMock.fetchKioskLabelFonts).not.toHaveBeenCalled();
  });

  it('beside a missing library font, only the library font installs; the built-in one stays red', async () => {
    const user = userEvent.setup();
    templatesMock.templates = [template({
      code: '^XA^A@N,40,40,E:TT0003M_.TTF^FDx^FS^A@N,30,30,E:ROBOTO.TTF^FDy^FS^XZ',
    })];
    // an older library row for the Swiss file, not yet flagged resident
    apiMock.fetchKioskLabelFonts.mockResolvedValue({
      fonts: [{ id: 'f-r', name: 'ROBOTO.TTF', size: 4 }, { ...SWISS_FONT, resident: false }], missing: [],
    });
    renderStep();
    await connectUsb(user);
    await failed('Fonts installed');
    expect(within(row('Fonts installed')).getByText(
      'Missing: ROBOTO.TTF. Printer is missing its built-in font TT0003M_.TTF.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Install 1 missing font' }));
    await waitFor(() => expect(within(row('Fonts installed')).getByText(
      'Printer is missing its built-in font TT0003M_.TTF.')).toBeTruthy(), { timeout: 3000 });
    expect(apiMock.fetchKioskFontContent).toHaveBeenCalledTimes(1);
    expect(apiMock.fetchKioskFontContent).toHaveBeenCalledWith('f-r', 'i-1');
    expect(usb.sent.filter((z) => z.startsWith('~DY'))).toEqual(['~DYE:ROBOTO.TTF,B,T,4,,']);
    expect(screen.queryByRole('button', { name: /Install/ })).toBeNull();
  });

  it("a label builder template's fonts come from the plan (its code is empty)", async () => {
    const user = userEvent.setup();
    templatesMock.templates = [template({ id: 'v', code: '', kind: 'design', schema_version: 2 })];
    apiMock.getLabelPlan.mockResolvedValue({
      template: { id: 'v', name: 'Vegas · 203', family: 'Vegas', dpi_key: '203', version: 1 },
      notes: [], fonts: ['ROBOTO_R.TTF', 'TT0003M_.TTF'],
    });
    apiMock.fetchKioskLabelFonts.mockResolvedValue({ fonts: [{ id: 'f-r', name: 'ROBOTO_R.TTF', size: 4 }], missing: [] });
    renderStep();
    await connectUsb(user);
    await failed('Fonts installed');
    expect(within(row('Fonts installed')).getByText(
      'Missing: ROBOTO_R.TTF. Printer is missing its built-in font TT0003M_.TTF.')).toBeTruthy();

    cleanup();
    printerState.fonts = ['ROBOTO_R.TTF', 'TT0003M_.TTF'];
    renderStep();
    await connectUsb(user);
    await allGreen();
  });
});

describe('peeler', () => {
  const peelerRow = () => row('Peeler');

  it.each([
    ['"Present"', 'Peeler detected · printing in peel-off mode', true],
    ['"Not Present"', 'No peeler · printing in tear-off mode', false],
    ['"?"', "Printer doesn't report a peeler · printing in tear-off mode", false],
    ['', "Printer doesn't report a peeler · printing in tear-off mode", false],
    [new Error('read timeout'), "Printer doesn't report a peeler · printing in tear-off mode", false],
  ])('reply %j shows "%s" and saves peel %s', async (reply, detail, peel) => {
    const user = userEvent.setup();
    printerState.peeler = reply;
    const { onFinish } = renderStep();
    await user.click(await screen.findByRole('button', { name: 'Use ZD421' }));
    await allGreen();
    expect(within(peelerRow()).getByText(detail)).toBeTruthy();
    expect(finishButton().disabled).toBe(false);
    await user.click(finishButton());
    await waitFor(() => expect(onFinish).toHaveBeenCalled());
    expect(apiMock.putLabelStation).toHaveBeenCalledWith(expect.objectContaining({ peel }));
  });

  it('runs after the status check, through the edge for a network printer, and never writes settings', async () => {
    const user = userEvent.setup();
    printerState.peeler = '"Present"';
    renderStep();
    await user.click(screen.getByRole('option', { name: /Network printer/ }));
    await user.click(await screen.findByRole('button', { name: /^10\.0\.0\.40/ }));
    await allGreen();
    const commands = apiMock.printerQuery.mock.calls.map(([, c]) => c as string);
    const hs = commands.indexOf('~HS');
    const peeler = commands.indexOf('! U1 getvar "sensor.peeler_present"\r\n');
    expect(hs).toBeGreaterThanOrEqual(0);
    expect(peeler).toBeGreaterThan(hs);
    expect(commands.filter((c) => c.includes('getvar'))).toEqual(['! U1 getvar "sensor.peeler_present"\r\n']);
    expect(apiMock.printerSend).not.toHaveBeenCalled();
    expect(commands.join('\n')).not.toMatch(/setvar|\^JUS/);
    expect(within(peelerRow()).getByText('Peeler detected · printing in peel-off mode')).toBeTruthy();
  });
});

describe('finishing', () => {
  it('Finish anyway shows for a user session when a check fails, and saves', async () => {
    const user = userEvent.setup();
    printerState.paused = true;
    const { onFinish } = renderStep({ initial: {
      label_kind: 'top', printer: { type: 'usb', ip: null, model: 'ZT411', serial: 'USB1' },
      dpi: 203, offset_x: 7, offset_y: -3, peel: false,
    } });
    await user.click(await screen.findByRole('button', { name: 'Use ZD421' }));
    await failed('Ready to print');
    expect(finishButton().disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Finish anyway' }));
    await waitFor(() => expect(onFinish).toHaveBeenCalled());
    expect(apiMock.putLabelStation).toHaveBeenCalledWith(expect.objectContaining({ offset_x: 7, offset_y: -3 }));
  });

  it('never shows Finish anyway to a move-password session, even when everything fails', async () => {
    const user = userEvent.setup();
    auth.kioskMove = { initiative_id: 'i-1', name: 'Move' };
    printerState.paperOut = true;
    templatesMock.templates = [template({ dpi_key: '300', code: '^XA^A@N,1,1,E:X.TTF^XZ' })];
    apiMock.fetchKioskLabelFonts.mockResolvedValue({ fonts: [], missing: ['X.TTF'] });
    renderStep();
    expect(screen.queryByRole('button', { name: 'Finish anyway' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Use ZD421' }));
    await failed('Ready to print');
    await failed('DPI matches the templates');
    await failed('Fonts installed');
    expect(screen.queryByRole('button', { name: 'Finish anyway' })).toBeNull();
    expect(finishButton().disabled).toBe(true);
  });

  it('a printer that never answers fails the first check', async () => {
    const user = userEvent.setup();
    apiMock.printerQuery.mockRejectedValue(Object.assign(new Error('printer_unreachable'), { code: 'printer_unreachable' }));
    renderStep();
    await user.click(screen.getByRole('option', { name: /Network printer/ }));
    await user.type(screen.getByLabelText('Printer IP'), '10.0.0.99');
    await user.click(screen.getByRole('button', { name: 'Use this address' }));
    await failed('Printer answers');
    expect(finishButton().disabled).toBe(true);
  });

  it('Back calls through', async () => {
    const user = userEvent.setup();
    const { onBack } = renderStep();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalled();
  });
});

it('opens the test labels modal once the printer answers', async () => {
  const user = userEvent.setup();
  renderStep();
  expect((screen.getByRole('button', { name: 'Print test labels' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(await screen.findByRole('button', { name: 'Use ZD421' }));
  await passed('Printer answers');
  await user.click(screen.getByRole('button', { name: 'Print test labels' }));
  expect(screen.getByRole('dialog', { name: 'Test labels' })).toBeTruthy();
});

it('loads the templates once, after the first sync phase that is not running', async () => {
  syncState.phase = 'running';
  const { rerender } = renderStep();
  await screen.findByText(/Downloading the move's label templates/);
  expect(templatesMock.calls).toBe(0);
  syncState.phase = 'done';
  rerender();
  await waitFor(() => expect(templatesMock.calls).toBe(1));
  syncState.phase = 'running';
  rerender();
  syncState.phase = 'error';
  rerender();
  syncState.phase = 'done';
  rerender();
  await new Promise((r) => { setTimeout(r, 50); });
  expect(templatesMock.calls).toBe(1);
});

it('picks up saved offsets that arrive after the step opened', async () => {
  const user = userEvent.setup();
  const { onFinish, rerender } = renderStep();
  rerender({ initial: {
    label_kind: 'top', printer: { type: 'usb', ip: null, model: 'ZT411', serial: 'USB1' },
    dpi: 203, offset_x: 9, offset_y: -2, peel: false,
  } });
  await user.click(await screen.findByRole('button', { name: 'Use ZD421' }));
  await allGreen();
  await user.click(finishButton());
  await waitFor(() => expect(onFinish).toHaveBeenCalled());
  expect(apiMock.putLabelStation).toHaveBeenCalledWith(expect.objectContaining({ offset_x: 9, offset_y: -2 }));
});


it('found network printers show their model, firmware and DPI with the IP', async () => {
  const user = userEvent.setup();
  renderStep();
  await user.click(screen.getByRole('option', { name: /Network printer/ }));
  const found = await screen.findByRole('group', { name: 'Printers found' });
  const first = within(found).getByRole('button', { name: /10\.0\.0\.40/ });
  expect(first.textContent).toContain('ZD621-203dpi');
  expect(first.textContent).toContain('V93.21.18Z');
  expect(first.textContent).toContain('203 DPI');
  const silent = within(found).getByRole('button', { name: /10\.0\.0\.41/ });
  expect(silent.textContent).toContain("Didn't say what it is");
});

it('a finished scan can run again, and re-choosing Network does not rescan', async () => {
  const user = userEvent.setup();
  renderStep();
  await user.click(screen.getByRole('option', { name: /Network printer/ }));
  await screen.findByRole('group', { name: 'Printers found' });
  await user.click(screen.getByRole('option', { name: /Network printer/ }));
  expect(apiMock.startPrinterScan).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Scan again' }));
  await waitFor(() => expect(apiMock.startPrinterScan).toHaveBeenCalledTimes(2));
});

describe('in the Label Station printer tools', () => {
  const saved = {
    label_kind: 'top' as const, printer: { type: 'network' as const, ip: '10.0.0.40', model: 'ZD621', serial: null },
    dpi: 203, offset_x: 2, offset_y: 1, peel: false,
  };

  it('preselect starts on the saved network printer; no Back; its own Finish label', async () => {
    const user = userEvent.setup();
    const { onFinish } = renderStep({ initial: saved, preselect: true, finishLabel: 'Save printer', onBack: undefined });
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    await allGreen();
    expect(apiMock.printerQuery).toHaveBeenCalledWith('10.0.0.40', '~HI');
    expect(apiMock.startPrinterScan).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save printer' }));
    await waitFor(() => expect(onFinish).toHaveBeenCalled());
    expect(apiMock.putLabelStation).toHaveBeenCalledWith(expect.objectContaining({
      printer: expect.objectContaining({ type: 'network', ip: '10.0.0.40' }), offset_x: 2, offset_y: 1,
    }));
  });

  it('without preselect a saved network printer waits for a pick', async () => {
    renderStep({ initial: saved });
    await screen.findByLabelText('Printer IP');
    expect(apiMock.printerQuery).not.toHaveBeenCalled();
  });
});

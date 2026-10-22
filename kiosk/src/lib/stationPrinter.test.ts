// @vitest-environment jsdom
/** One printer interface over WebUSB and the laptop edge's network
 *  transport: the same commands and the same bytes go out either way. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from './api';
import {
  builtInFontText, checkDpi, fontFixFor, fontsUsed, isResidentFont, mockTemplateFor, templateFamily,
  neededFonts, networkStationPrinter, statusProblems, templatesOfKind, usbStationPrinter, parseGetvar,
  withPrintMode, PEELER_PRESENT_QUERY, RESIDENT_FONTS,
} from './stationPrinter';
import type { KioskLabelFont, KioskLabelTemplate } from './api';
import type { ZebraPrinter } from './useZebraPrinter';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type Call = [string, RequestInit | undefined];
/** The calls a test made, without the session refresh apiFetch tries first. */
const callsOf = (fetchMock: ReturnType<typeof vi.fn>) => (fetchMock.mock.calls as unknown as Call[])
  .filter(([url]) => !String(url).includes('/auth/refresh'));

const HI = '\x02ZT411-300dpi,V85.20.19,12,8176KB\x03';
const HS = '\x02030,0,0,1218,000,0,0,0,000,0,0,0\x03\r\n\x02001,0,0,0,1,2,6,0,00000000,1,000\x03\r\n\x021234,0\x03';

function template(over: Partial<KioskLabelTemplate>): KioskLabelTemplate {
  return {
    id: 't', name: 'T', label_type: 'top', size_key: '4x2', dpi_key: '300', language_key: 'zpl',
    version: 1, updated_at: '2026-10-19T00:00:00Z', move_site_names: [], reasons: ['generic'],
    code: '^XA^XZ', generation_rules: {}, width_in: 4, height_in: 2, dots: 300, error: null, ...over,
  };
}

beforeEach(() => {
  api.clearLocalSession();
  window.__KIOSK_CONFIG__ = { apiUrl: 'http://api.test' };
});

describe('networkStationPrinter', () => {
  it('queries ~HI through the edge and parses the reply', async () => {
    const fetchMock = vi.fn(async () => json({ response: HI, truncated: false }));
    vi.stubGlobal('fetch', fetchMock);
    const p = networkStationPrinter('10.0.0.40', 'i-1');
    expect(p.kind).toBe('network');
    const id = await p.identify();
    expect(id).toMatchObject({ model: 'ZT411-300dpi', dpi: 300 });
    const [url, init] = callsOf(fetchMock)[0];
    expect(url).toBe('http://api.test/edge/printers/query');
    expect(JSON.parse(String(init?.body))).toEqual({ ip: '10.0.0.40', command: '~HI' });
  });

  it('reads ~HS status through the same parser', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ response: HS, truncated: false })));
    const s = await networkStationPrinter('10.0.0.40', 'i-1').status();
    expect(s).toMatchObject({ paperOut: false, headOpen: false, paused: false });
  });

  it('sends ZPL and fonts through the edge routes', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const p = networkStationPrinter('10.0.0.40', 'i-1');
    await p.send('^XA^XZ');
    await p.sendFont({ id: 'f-1', name: 'arial.ttf', size: 10 });
    const calls = callsOf(fetchMock);
    expect(calls[0][0]).toBe('http://api.test/edge/printers/send');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ ip: '10.0.0.40', zpl: '^XA^XZ' });
    expect(calls[1][0]).toBe('http://api.test/edge/printers/send-font');
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({
      ip: '10.0.0.40', font_id: 'f-1', name: 'ARIAL.TTF', initiative_id: 'i-1',
    });
  });
});

describe('usbStationPrinter', () => {
  function fakeZebra() {
    const sent: string[] = [];
    const bytes: Uint8Array[] = [];
    const zebra = {
      query: vi.fn(async (cmd: string) => (cmd === '~HI' ? HI : HS)),
      send: vi.fn(async (zpl: string) => { sent.push(zpl); }),
      sendBytes: vi.fn(async (b: Uint8Array) => { bytes.push(b); }),
      productName: 'ZD421',
      device: { serialNumber: 'USB123' },
    } as unknown as ZebraPrinter;
    return { zebra, sent, bytes };
  }

  it('identifies and reads status with the same parsers', async () => {
    const { zebra } = fakeZebra();
    const p = usbStationPrinter(zebra, 'i-1');
    expect(p.kind).toBe('usb');
    expect(p.serial).toBe('USB123');
    expect(await p.identify()).toMatchObject({ dpi: 300 });
    expect(await p.status()).toMatchObject({ paused: false });
    expect(zebra.query).toHaveBeenCalledWith('~HI', undefined);
    expect(zebra.query).toHaveBeenCalledWith('~HS', { maxReads: 4 });
  });

  it('downloads the font through the kiosk route and sends ~DY then the bytes', async () => {
    const ttf = new Uint8Array([0, 1, 0, 0, 9, 9]);
    const fetchMock = vi.fn(async () => new Response(ttf, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { zebra, sent, bytes } = fakeZebra();
    await usbStationPrinter(zebra, 'i-1').sendFont({ id: 'f-1', name: 'arial.ttf', size: 6 });
    expect(String(callsOf(fetchMock)[0][0]))
      .toBe('http://api.test/kiosk/labels/fonts/f-1/content?initiative_id=i-1');
    expect(sent).toEqual(['~DYE:ARIAL.TTF,B,T,6,,']);
    expect(Array.from(bytes[0])).toEqual([0, 1, 0, 0, 9, 9]);
  });
});

describe('peeler', () => {
  function zebraAnswering(reply: string | Error) {
    return {
      query: vi.fn(async () => {
        if (reply instanceof Error) throw reply;
        return reply;
      }),
      send: vi.fn(), sendBytes: vi.fn(), productName: 'ZD421', device: {},
    } as unknown as ZebraPrinter;
  }

  it('sends the one SGD getvar byte for byte', () => {
    expect(PEELER_PRESENT_QUERY).toBe('! U1 getvar "sensor.peeler_present"\r\n');
  });

  it.each([
    ['"Present"', true],
    ['"Not Present"', false],
    ['"?"', null],
    ['', null],
    ['"maybe"', null],
    [new Error('read timeout'), null],
  ])('reply %j reads as present %j, never throwing', async (reply, present) => {
    const zebra = zebraAnswering(reply);
    expect(await usbStationPrinter(zebra, 'i-1').peeler()).toEqual({ present });
    expect(zebra.query).toHaveBeenCalledTimes(1);
    expect(zebra.query).toHaveBeenCalledWith(PEELER_PRESENT_QUERY, undefined);
  });

  it('goes through the edge for a network printer, with one query', async () => {
    const fetchMock = vi.fn(async () => json({ response: '"Present"', truncated: false }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await networkStationPrinter('10.0.0.40', 'i-1').peeler()).toEqual({ present: true });
    const commands = callsOf(fetchMock).map(([, init]) => JSON.parse(String(init?.body)).command);
    expect(commands).toEqual([PEELER_PRESENT_QUERY]);
  });
});

describe('parseGetvar', () => {
  it.each([
    ['"Present"', 'Present'],
    ['"Not Present"', 'Not Present'],
    ['"?"', null],
    ['', null],
    [' "peel off" ', 'peel off'],
    ['"peel off"\r\n', 'peel off'],
    ['""', null],
  ])('%j -> %j', (reply, want) => {
    expect(parseGetvar(reply)).toBe(want);
  });
});

describe('withPrintMode', () => {
  it('drops a ^MM with no mode letter too', () => {
    expect(withPrintMode('^XA^MM,N^FDx^FS^XZ', true)).toBe('^XA^MMP^FDx^FS^XZ');
  });

  it('puts ^MMP right after ^XA for peel and ^MMT for tear', () => {
    expect(withPrintMode('^XA^FO10,10^FDx^FS^XZ', true)).toBe('^XA^MMP^FO10,10^FDx^FS^XZ');
    expect(withPrintMode('^XA^FO10,10^FDx^FS^XZ', false)).toBe('^XA^MMT^FO10,10^FDx^FS^XZ');
  });

  it('marks every label in a multi-label job', () => {
    expect(withPrintMode('^XA^FDa^FS^XZ\n^XA^FDb^FS^XZ', true))
      .toBe('^XA^MMP^FDa^FS^XZ\n^XA^MMP^FDb^FS^XZ');
    expect(withPrintMode('^XA^FDa^FS^XZ^XA^FDb^FS^XZ', false))
      .toBe('^XA^MMT^FDa^FS^XZ^XA^MMT^FDb^FS^XZ');
  });

  it('matches ^XA in any case and keeps its casing', () => {
    expect(withPrintMode('^xa^FDa^FS^xz^Xa^FDb^FS^XZ', true)).toBe('^xa^MMP^FDa^FS^xz^Xa^MMP^FDb^FS^XZ');
  });

  it("drops the label's own ^MM so the station's mode is the only one", () => {
    const out = withPrintMode('^XA^MMT,N^FO10,10^FDx^FS^XZ', true);
    expect(out).toBe('^XA^MMP^FO10,10^FDx^FS^XZ');
    expect(out.match(/\^MM/gi)).toHaveLength(1);
    expect(withPrintMode('^XA^PW812^mmc,y^MMP^FDx^FS^XZ', false)).toBe('^XA^MMT^PW812^FDx^FS^XZ');
    expect(withPrintMode('^XA^MMT^FDa^FS^XZ^XA^MMP,N^FDb^FS^XZ', true))
      .toBe('^XA^MMP^FDa^FS^XZ^XA^MMP^FDb^FS^XZ');
  });

  it('never saves the mode to the printer', () => {
    const out = withPrintMode('^XA^XZ', true);
    expect(out).not.toMatch(/\^JUS|setvar/i);
  });
});

describe('pure helpers', () => {
  it('fontsUsed finds E: TrueType fonts in ^A@ and ^CW, upper-cased', () => {
    const code = '^XA^CWA,E:arial.ttf^A@N,30,30,E:ROBOTO_B.TTF^FDx^FS^A0N,20^FS^A@N,1,1,R:NOPE.TTF^XZ';
    expect(fontsUsed(code).sort()).toEqual(['ARIAL.TTF', 'ROBOTO_B.TTF']);
  });

  it('templatesOfKind, neededFonts, checkDpi', () => {
    const ts = [
      template({ id: 'a', label_type: 'top', dpi_key: '203', code: '^XA^A@N,1,1,E:A.TTF^XZ' }),
      template({ id: 'b', label_type: 'front', dpi_key: '300', code: '^XA^A@N,1,1,E:B.TTF^XZ' }),
      template({ id: 'c', label_type: 'container', dpi_key: '300' }),
    ];
    expect(templatesOfKind(ts, 'top').map((t) => t.id)).toEqual(['a']);
    expect(neededFonts(templatesOfKind(ts, 'front'))).toEqual(['B.TTF']);
    expect(checkDpi(ts, 'top', 203).state).toBe('ok');
    expect(checkDpi(ts, 'top', 300)).toMatchObject({ state: 'fail' });
    expect(checkDpi(ts, 'top', 300).detail).toBe("This move's Top template prints at 203 DPI only; this printer "
      + 'is 300 DPI. Activate a 300 DPI version on Labels › Templates, or use a 203 DPI printer.');
    expect(checkDpi([], 'top', 300).detail).toBe('No active Top template for this move. Someone with label '
      + 'access needs to activate one on Labels › Templates in the portal (Generic Rack and RU covers every move), '
      + 'then pick the move again.');
    // Generic Rack and RU is a Top family: a Front station isn't told it helps
    expect(checkDpi([], 'front', 300).detail).toBe('No active Front template for this move. Someone with label '
      + 'access needs to activate one on Labels › Templates in the portal, then pick the move again.');
    const several = [...ts, template({ id: 'd', label_type: 'top', dpi_key: '600' }),
      template({ id: 'e', label_type: 'top', dpi_key: '1200' })];
    expect(checkDpi(several, 'top', 300).detail).toBe("This move's Top template prints at 203, 600 and 1200 DPI "
      + 'only; this printer is 300 DPI. Activate a 300 DPI version on Labels › Templates, or use a 203, 600 or 1200 '
      + 'DPI printer.');
  });

  it('statusProblems names paper, head and pause', () => {
    expect(statusProblems({ paperOut: true, headOpen: true, paused: true } as never)).toEqual([
      'Paper out: load labels.', 'Head open: close the print head.',
      'Paused: press Pause on the printer to resume.',
    ]);
    expect(statusProblems({ paperOut: false, headOpen: false, paused: false } as never)).toEqual([]);
  });

  it('mockTemplateFor picks Generic Rack and RU for Top and the Front template for Front, at the DPI', () => {
    const ts = [
      template({ id: 'g203', name: 'Generic Rack and RU', dpi_key: '203' }),
      template({ id: 'g300', name: 'Generic Rack and RU', dpi_key: '300' }),
      template({ id: 'f300', name: 'Front', label_type: 'front', dpi_key: '300' }),
    ];
    expect(mockTemplateFor(ts, 'top', 203).template?.id).toBe('g203');
    expect(mockTemplateFor(ts, 'front', 300).template?.id).toBe('f300');
    const skipped = mockTemplateFor(ts, 'front', 203);
    expect(skipped.template).toBeNull();
    expect(skipped.note).toBe('"Front" is only available at 300 DPI, so the mock-data label is skipped.');
    expect(mockTemplateFor([], 'top', 203).note).toBe('No "Generic Rack and RU" template was downloaded for this move.');
  });

  it('templateFamily uses the server family, else strips a trailing DPI marker', () => {
    expect(templateFamily(template({ name: 'Anything', family: 'Server says' }))).toBe('Server says');
    expect(templateFamily(template({ name: 'Generic Rack and RU - 203DPI' }))).toBe('Generic Rack and RU');
    expect(templateFamily(template({ name: 'Generic Rack and RU - 300 dpi' }))).toBe('Generic Rack and RU');
    expect(templateFamily(template({ name: 'Container Label 4x6 203dpi' }))).toBe('Container Label 4x6');
    expect(templateFamily(template({ name: 'Top asset tag (600DPI)' }))).toBe('Top asset tag');
    expect(templateFamily(template({ name: 'DPI test 203' }))).toBe('DPI test 203');
    expect(templateFamily(template({ name: 'Generic Rack and RU - 3400DPI' }))).toBe('Generic Rack and RU');
    expect(templateFamily(template({ name: '203DPI' }))).toBe('203DPI');
  });

  it('templateFamily strips a trailing " Old" / " Old N" too, around a DPI marker', () => {
    expect(templateFamily(template({ name: 'Vegas Destination Old' }))).toBe('Vegas Destination');
    expect(templateFamily(template({ name: 'Vegas Destination Old 2' }))).toBe('Vegas Destination');
    expect(templateFamily(template({ name: 'Generic Rack and RU - 203DPI Old' }))).toBe('Generic Rack and RU');
    expect(templateFamily(template({ name: 'Generic Rack and RU Old - 300DPI' }))).toBe('Generic Rack and RU');
    expect(templateFamily(template({ name: 'Switch Front Tag old' }))).toBe('Switch Front Tag old');
    expect(templateFamily(template({ name: 'Asset Tag Bold' }))).toBe('Asset Tag Bold');
    expect(templateFamily(template({ name: 'Old 2' }))).toBe('Old 2');
  });

  it('mockTemplateFor picks the Generic Rack and RU version named for the printer DPI', () => {
    const ts = [
      template({ id: 'g203', name: 'Generic Rack and RU - 203DPI', family: 'Generic Rack and RU', dpi_key: '203' }),
      template({ id: 'g300', name: 'Generic Rack and RU - 300DPI', family: 'Generic Rack and RU', dpi_key: '300' }),
      template({ id: 'other', name: 'Top Site A - 203DPI', family: 'Top Site A', dpi_key: '203' }),
    ];
    expect(mockTemplateFor(ts, 'top', 203).template?.id).toBe('g203');
    expect(mockTemplateFor(ts, 'top', 300).template?.id).toBe('g300');
    // An older cached set has no `family`; the name still groups it.
    const old = ts.map(({ family: _f, ...rest }) => rest as KioskLabelTemplate);
    expect(mockTemplateFor(old, 'top', 300).template?.id).toBe('g300');
    const skipped = mockTemplateFor(ts.slice(0, 1), 'top', 300);
    expect(skipped.template).toBeNull();
    expect(skipped.note).toBe('"Generic Rack and RU" is only available at 203 DPI, so the mock-data label is skipped.');
  });
});

describe('resident fonts', () => {
  it("mirrors the resident families' printer objects in the API's labels/fonts.py", () => {
    const src = readFileSync(join(__dirname, '../../../api/src/serversherpa/labels/fonts.py'), 'utf8');
    const rows = [...src.matchAll(/_family\("[^"]+", "([^"]+)", (None|"([^"]+)")([^)]*)\)/g)];
    expect(rows).toHaveLength(8);
    const resident = rows.filter((m) => /resident=True/.test(m[4])).flatMap((m) => [m[1], m[3]])
      .filter((n): n is string => Boolean(n));
    expect([...RESIDENT_FONTS]).toEqual(resident);
    expect(RESIDENT_FONTS).toEqual(['TT0003M_.TTF']);
  });

  it('neededFonts still lists a resident font: the check confirms it is on the printer', () => {
    const t = template({ code: '^XA^A@N,40,40,E:TT0003M_.TTF^FDx^FS^A@N,1,1,E:ROBOTO_R.TTF^FDy^FS^XZ' });
    expect(neededFonts([t])).toEqual(['ROBOTO_R.TTF', 'TT0003M_.TTF']);
  });

  it('a resident font is known by name, or by the library flag', () => {
    expect(isResidentFont('TT0003M_.TTF')).toBe(true);
    expect(isResidentFont('tt0003m_.ttf')).toBe(true);
    expect(isResidentFont('ROBOTO_R.TTF')).toBe(false);
    const flagged: KioskLabelFont = { id: 'f-x', name: 'swiss2.ttf', size: 0, resident: true };
    expect(isResidentFont('SWISS2.TTF', [flagged])).toBe(true);
    expect(isResidentFont('SWISS2.TTF')).toBe(false);
  });

  it('the fix for missing fonts never installs a resident one', () => {
    const library: KioskLabelFont[] = [
      // an older library row not yet flagged: the name still keeps it off the install list
      { id: 'f-s', name: 'TT0003M_.TTF', size: 160676 },
      { id: 'f-r', name: 'ROBOTO_R.TTF', size: 4, resident: false },
      { id: 'f-x', name: 'SWISS2.TTF', size: 0, resident: true },
    ];
    expect(fontFixFor(['NOPE.TTF', 'ROBOTO_R.TTF', 'SWISS2.TTF', 'TT0003M_.TTF'], library)).toEqual({
      installable: [library[1]], builtIn: ['SWISS2.TTF', 'TT0003M_.TTF'], notInLibrary: ['NOPE.TTF'],
    });
    // missing from the library too: still built in, never "upload it"
    expect(fontFixFor(['TT0003M_.TTF'], [])).toEqual({
      installable: [], builtIn: ['TT0003M_.TTF'], notInLibrary: [],
    });
  });

  it('says which built-in font the printer is missing', () => {
    expect(builtInFontText(['TT0003M_.TTF'])).toBe('Printer is missing its built-in font TT0003M_.TTF.');
    expect(builtInFontText(['A.TTF', 'B.TTF'])).toBe('Printer is missing its built-in fonts A.TTF, B.TTF.');
  });
});

describe('the mock-data template', () => {
  const ts = [
    template({ id: 'g203', name: 'Generic Rack and RU', dpi_key: '203' }),
    template({ id: 'v203', name: 'Vegas · 203', family: 'Vegas', dpi_key: '203', code: '', kind: 'design' }),
  ];

  it("is the station plan's template when it was downloaded", () => {
    expect(mockTemplateFor(ts, 'top', 203, 'v203')).toEqual({ template: ts[1], note: '' });
  });

  it("falls back to the Generic Rack and RU rule when the plan's template isn't downloaded or there is none", () => {
    expect(mockTemplateFor(ts, 'top', 203, 'gone').template?.id).toBe('g203');
    expect(mockTemplateFor(ts, 'top', 203, null).template?.id).toBe('g203');
    expect(mockTemplateFor(ts, 'top', 203).template?.id).toBe('g203');
  });
});

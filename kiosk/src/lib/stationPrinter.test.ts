// @vitest-environment jsdom
/** One printer interface over WebUSB and the laptop edge's network
 *  transport: the same commands and the same bytes go out either way. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from './api';
import {
  checkDpi, fontsUsed, mockTemplateFor, neededFonts, networkStationPrinter, statusProblems,
  templatesOfKind, usbStationPrinter,
} from './stationPrinter';
import type { KioskLabelTemplate } from './api';
import type { ZebraPrinter } from './useZebraPrinter';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type Call = [string, RequestInit | undefined];
/** The calls a test made, without the session refresh apiFetch tries first. */
const callsOf = (fetchMock: ReturnType<typeof vi.fn>) => (fetchMock.mock.calls as unknown as Call[])
  .filter(([url]) => !String(url).endsWith('/auth/refresh'));

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
    expect(checkDpi(ts, 'top', 300).detail).toContain('203');
    expect(checkDpi([], 'front', 300).detail).toBe('No Front templates were downloaded for this move.');
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
});

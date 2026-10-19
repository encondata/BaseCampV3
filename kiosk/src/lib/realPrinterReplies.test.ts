/** Every Label Station check, run against a REAL printer's replies.
 *
 *  Captured 2026-10-19 from a Zebra ZT220 (203 DPI, firmware V72.20.25Z) on
 *  the office LAN, byte for byte. The font bug that day (a stored font
 *  listed with a trailing `K` flag read as "missing") slipped through
 *  because every parser was only tested against hand-written replies.
 *  Add a block here for each new printer model met in the field. */
import { describe, expect, it } from 'vitest';

import { parseDirectory, parseHostIdentification, parseHostStatus } from '@portal/labels/zebraUsb';
import type { KioskLabelTemplate } from './api';
import { checkDpi, neededFonts, statusProblems } from './stationPrinter';

const ZT220 = {
  hi: '\x02ZT220-200dpi,V72.20.25Z,8,4096KB\x03\r\n',
  hs: '\x02030,0,0,1313,000,0,0,0,000,0,0,0\x03\r\n\x02000,0,0,0,0,2,6,0,00000000,1,000\x03\r\n\x020000,0\x03\r\n',
  dir: '\x02\r\n- DIR E:*.* \r\n* E:85620388.TTF   1045960          \r\n* E:TEXT.ZPL         5          \r\n'
    + '* E:TT0003M_.TTF    160676       K  \r\n\r\n-  32346624 bytes free E: ONBOARD FLASH \r\n\x03',
};

// The template that needed the font that day.
const GENERIC_203: KioskLabelTemplate = {
  id: 't', name: 'Generic Rack and RU - 203DPI', label_type: 'top', size_key: '4x2', dpi_key: '203',
  language_key: 'zpl', version: 1, updated_at: '2026-10-19T00:00:00Z', move_site_names: [],
  reasons: ['generic'], code: '^XA^A@N,40,40,E:TT0003M_.TTF^FD{asset_name}^FS^XZ',
  generation_rules: {}, width_in: 4, height_in: 2, dots: 203, error: null,
};

describe('Zebra ZT220 (203 DPI), real replies', () => {
  it('identifies as a 203 DPI printer', () => {
    expect(parseHostIdentification(ZT220.hi)).toEqual({
      model: 'ZT220-200dpi', firmware: 'V72.20.25Z', dotsPerMm: 8, memory: '4096KB', dpi: 203,
    });
  });

  it('passes the DPI check against the 203 DPI template', () => {
    expect(checkDpi([GENERIC_203], 'top', 203).state).toBe('ok');
  });

  it('reports a ready status: no paper out, head open or pause', () => {
    const status = parseHostStatus(ZT220.hs);
    expect(status).not.toBeNull();
    expect(statusProblems(status!)).toEqual([]);
  });

  it('lists every stored object, including the flagged font', () => {
    const listing = parseDirectory(ZT220.dir);
    expect(listing?.objects.map((o) => o.name)).toEqual(['85620388.TTF', 'TEXT.ZPL', 'TT0003M_.TTF']);
    expect(listing?.bytesFree).toBe(32346624);
  });

  it('finds every font the template needs on the printer', () => {
    const installed = new Set(parseDirectory(ZT220.dir)!.objects.map((o) => o.name));
    const needed = neededFonts([GENERIC_203]);
    expect(needed).toEqual(['TT0003M_.TTF']);
    expect(needed.filter((n) => !installed.has(n))).toEqual([]);
  });
});

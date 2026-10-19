/**
 * The Label Station's printer, whichever way it's reached: a WebUSB Zebra
 * (`useZebraPrinter`) or a LAN Zebra on port 9100 through the laptop edge
 * (`/edge/printers/*`). Each transport only knows how to send text, send
 * a font, and read a reply; identity (`~HI`), status (`~HS`) and the E:
 * listing (`^HW`) are built and parsed once, here, so the setup checks,
 * font install and test prints run the same code and send the same
 * commands either way. The peeler check (one SGD getvar) and the
 * per-label print mode (`withPrintMode`) live here too.
 *
 * Also the pure helpers the setup step needs: which templates belong to
 * a label kind, the DPI check, the fonts those templates use, what a
 * printer status says to fix, and the mock-label template.
 */

import {
  directoryQuery, downloadFontHeader, HOST_IDENTIFICATION, HOST_STATUS,
} from '@portal/labels/zebraCommands';
import {
  parseDirectory, parseHostIdentification, parseHostStatus,
  type DirectoryListing, type HostIdentification, type HostStatus, type ReadOptions,
} from '@portal/labels/zebraUsb';
import { naturalCompare } from '@portal/lib/naturalSort';

import {
  fetchKioskFontContent, printerQuery, printerSend, printerSendFont,
  type KioskLabelFont, type KioskLabelTemplate, type LabelKind,
} from './api';
import type { ZebraPrinter } from './useZebraPrinter';

/** The SGD read, byte for byte as the edge allows it (CR LF included). A
 *  ZD421 with a peeler answers `"Present"`, one without `"Not Present"`,
 *  a printer that doesn't know the variable `"?"`, an old one maybe
 *  nothing. (`^HH` doesn't report the peeler, and `sensor.peeler` is the
 *  peel sensor's state, not whether one is fitted.) */
export const PEELER_PRESENT_QUERY = '! U1 getvar "sensor.peeler_present"\r\n';

/** `present`: null when the printer doesn't say (unknown variable, no or
 *  unreadable answer, a query error). */
export interface PeelerInfo { present: boolean | null }

export interface StationPrinter {
  kind: 'usb' | 'network';
  /** The LAN address of a network printer; null over USB. */
  ip: string | null;
  /** The USB serial number when the browser reports one. */
  serial: string | null;
  identify(): Promise<HostIdentification | null>;
  status(): Promise<HostStatus | null>;
  /** Whether a peeler is fitted. Never throws. */
  peeler(): Promise<PeelerInfo>;
  query(command: string): Promise<string>;
  send(zpl: string): Promise<void>;
  /** Installs a library font on E: (`~DY` plus its bytes). */
  sendFont(font: KioskLabelFont): Promise<void>;
}

/** What a transport has to provide; everything else is shared. */
interface Transport {
  kind: StationPrinter['kind'];
  ip: string | null;
  serial: string | null;
  query(command: string, opts?: ReadOptions): Promise<string>;
  send(zpl: string): Promise<void>;
  sendFont(name: string, font: KioskLabelFont): Promise<void>;
}

/** `sensor.peeler_present`, null on any failure. Over USB the reply is a
 *  single short packet with no framing, so the default read is enough. */
async function readPeeler(t: Transport): Promise<PeelerInfo> {
  let value: string | null;
  try {
    value = parseGetvar(await t.query(PEELER_PRESENT_QUERY));
  } catch {
    value = null;
  }
  const fitted = value?.toLowerCase();
  return { present: fitted === 'present' ? true : fitted === 'not present' ? false : null };
}

function fromTransport(t: Transport): StationPrinter {
  return {
    kind: t.kind,
    ip: t.ip,
    serial: t.serial,
    identify: async () => parseHostIdentification(await t.query(HOST_IDENTIFICATION)),
    // ~HS answers in three frames; USB reads them in up to four packets.
    status: async () => parseHostStatus(await t.query(HOST_STATUS, { maxReads: 4 })),
    peeler: () => readPeeler(t),
    query: (command) => t.query(command),
    send: (zpl) => t.send(zpl),
    // Zebra object names are upper case; the same name goes out either way.
    sendFont: (font) => t.sendFont(font.name.toUpperCase(), font),
  };
}

/** A WebUSB printer the hook already holds. The font's bytes come from the
 *  kiosk font route (scoped to the move's templates). */
export function usbStationPrinter(zebra: ZebraPrinter, initiativeId: string): StationPrinter {
  const serial = (zebra.device as { serialNumber?: unknown } | null | undefined)?.serialNumber;
  return fromTransport({
    kind: 'usb',
    ip: null,
    serial: typeof serial === 'string' && serial ? serial : null,
    query: (command, opts) => zebra.query(command, opts),
    send: (zpl) => zebra.send(zpl),
    sendFont: async (name, font) => {
      const bytes = await fetchKioskFontContent(font.id, initiativeId);
      await zebra.send(downloadFontHeader('E', name, bytes.length));
      await zebra.sendBytes(bytes);
    },
  });
}

/** A LAN printer reached through the laptop edge, which builds the same
 *  `~DYE:NAME,B,T,<bytes>,,` header for a font. */
export function networkStationPrinter(ip: string, initiativeId: string): StationPrinter {
  return fromTransport({
    kind: 'network',
    ip,
    serial: null,
    query: async (command) => (await printerQuery(ip, command)).response,
    send: (zpl) => printerSend(ip, zpl),
    sendFont: (name, font) => printerSendFont({ ip, font_id: font.id, name, initiative_id: initiativeId }),
  });
}

/** The printer's E: drive listing, or null when the reply can't be read. */
export async function readFonts(printer: StationPrinter): Promise<DirectoryListing | null> {
  return parseDirectory(await printer.query(directoryQuery('E')));
}

// ── pure helpers ────────────────────────────────────────────────────

/** An SGD getvar reply's value: surrounding whitespace and double quotes
 *  stripped; `"?"` (unknown variable) and an empty reply are null. */
export function parseGetvar(reply: string): string | null {
  let v = reply.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).trim();
  return v === '' || v === '?' ? null : v;
}

// A label's own print mode: ^MM[<mode>][,<prepeel Y/N>], any case.
const PRINT_MODE_RE = /\^MM[A-Z]?(?:,[A-Z])?/gi;

/** The label printed peel-off (`^MMP`) or tear-off (`^MMT`): any `^MM` the
 *  label carries is dropped, and the station's mode goes right after every
 *  `^XA` (any case, kept as written). It is never saved (no `^JUS`, no
 *  setvar), but the printer keeps it until a label sets another mode or
 *  it restarts. */
export function withPrintMode(zpl: string, peel: boolean): string {
  const mode = peel ? '^MMP' : '^MMT';
  return zpl.replace(PRINT_MODE_RE, '').replace(/\^XA/gi, (xa) => `${xa}${mode}`);
}

export const KIND_LABEL: Record<LabelKind, string> = { top: 'Top', front: 'Front' };

/** "The station's templates": the downloaded templates of the chosen kind
 *  (`label_type` top or front). */
export function templatesOfKind(templates: KioskLabelTemplate[], kind: LabelKind): KioskLabelTemplate[] {
  return templates.filter((t) => t.label_type === kind);
}

// The API's `template_fonts.fonts_used`, ported: only E: drive TrueType
// fonts count (built-ins and R:/Z: are ignored), names upper-cased.
const NAME = '([A-Z0-9_\\-]+\\.TTF)';
const A_AT_RE = new RegExp(`\\^A@[^\\^~]*?E:${NAME}`, 'gi');
const CW_RE = new RegExp(`\\^CW[A-Z0-9],\\s*E:${NAME}`, 'gi');

export function fontsUsed(code: string): string[] {
  const names = new Set<string>();
  for (const re of [A_AT_RE, CW_RE]) {
    for (const m of code.matchAll(re)) names.add(m[1].toUpperCase());
  }
  return [...names];
}

/** Every printer font the given templates use, natural-sorted. */
export function neededFonts(templates: KioskLabelTemplate[]): string[] {
  const names = new Set<string>();
  for (const t of templates) for (const n of fontsUsed(t.code)) names.add(n);
  return [...names].sort(naturalCompare);
}

export interface CheckOutcome { state: 'ok' | 'fail'; detail: string }

/** Passes when at least one template of the kind is at the printer's DPI. */
export function checkDpi(templates: KioskLabelTemplate[], kind: LabelKind, dpi: number): CheckOutcome {
  const ofKind = templatesOfKind(templates, kind);
  const kindLabel = KIND_LABEL[kind];
  if (ofKind.length === 0) {
    return { state: 'fail', detail: `No ${kindLabel} templates were downloaded for this move.` };
  }
  if (ofKind.some((t) => t.dpi_key === String(dpi))) {
    return { state: 'ok', detail: `${dpi} DPI` };
  }
  const dpis = [...new Set(ofKind.map((t) => t.dpi_key))].sort(naturalCompare);
  return {
    state: 'fail',
    detail: `This printer prints at ${dpi} DPI, but the move's ${kindLabel} templates are ${dpis.join(' or ')} DPI.`,
  };
}

/** What a `~HS` reply says to fix before printing: paper, head, pause. */
export function statusProblems(status: HostStatus): string[] {
  const problems: string[] = [];
  if (status.paperOut) problems.push('Paper out: load labels.');
  if (status.headOpen) problems.push('Head open: close the print head.');
  if (status.paused) problems.push('Paused: press Pause on the printer to resume.');
  return problems;
}

export const GENERIC_TEMPLATE_NAME = 'Generic Rack and RU';

// A trailing DPI marker: " - 203DPI", " 300 dpi", "(600DPI)". Same rule as
// the server's labels.kiosk_templates.family_name.
const DPI_SUFFIX = /\s*[-–—]?\s*\(?\s*\d+\s*dpi\s*\)?\s*$/i;

/** The template's family: the name its DPI versions share. The server sends
 *  it; a set cached before that is grouped by the same name rule here. */
export function templateFamily(t: KioskLabelTemplate): string {
  if (t.family) return t.family;
  const base = t.name.replace(DPI_SUFFIX, '').trim();
  return base || t.name.trim();
}

/** The mock-data test label's template: the "Generic Rack and RU" family
 *  for a Top station, its Front template for a Front one, in the version
 *  at the printer's DPI. A template only at another DPI is skipped, and
 *  `note` says why. */
export function mockTemplateFor(
  templates: KioskLabelTemplate[], kind: LabelKind, dpi: number,
): { template: KioskLabelTemplate | null; note: string } {
  const candidates = kind === 'top'
    ? templates.filter((t) => templateFamily(t).toLowerCase() === GENERIC_TEMPLATE_NAME.toLowerCase())
    : templatesOfKind(templates, 'front');
  const match = candidates.find((t) => t.dpi_key === String(dpi));
  if (match) return { template: match, note: '' };
  if (candidates.length === 0) {
    return {
      template: null,
      note: kind === 'top'
        ? `No "${GENERIC_TEMPLATE_NAME}" template was downloaded for this move.`
        : 'No Front template was downloaded for this move.',
    };
  }
  const other = candidates[0];
  const dpis = [...new Set(candidates.map((t) => t.dpi_key))].sort(naturalCompare);
  return {
    template: null,
    note: `"${templateFamily(other)}" is only available at ${dpis.join(' or ')} DPI, so the mock-data label is skipped.`,
  };
}

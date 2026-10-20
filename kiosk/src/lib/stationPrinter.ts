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
 * a label kind, the DPI check, the fonts those templates use and what to
 * do about missing ones (a resident font is only checked, never
 * installed), what a printer status says to fix, and the mock-label
 * template.
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

/** Every printer font the given templates' code uses, natural-sorted: the
 *  fonts the check looks for on E:, a resident one included (it must be
 *  there too; it is just never installed from here, see `fontFixFor`). */
export function neededFonts(templates: KioskLabelTemplate[]): string[] {
  const names = new Set<string>();
  for (const t of templates) for (const n of fontsUsed(t.code)) names.add(n);
  return [...names].sort(naturalCompare);
}

/** Zebra's resident fonts: built into the printer, so never pushed to it
 *  (the kiosk font route refuses them). The printer objects of the
 *  resident families in the API's labels/fonts.py, which the test pins. */
export const RESIDENT_FONTS: readonly string[] = ['TT0003M_.TTF'];

/** A resident font, by its name or by the library's `resident` flag. */
export function isResidentFont(name: string, library: KioskLabelFont[] = []): boolean {
  const upper = name.toUpperCase();
  return RESIDENT_FONTS.includes(upper)
    || library.some((f) => f.resident === true && f.name.toUpperCase() === upper);
}

/** What to do about the fonts missing from the printer: install the
 *  library's (never a resident one), say a built-in one is missing, and
 *  name the rest as not in the library. */
export interface FontFix { installable: KioskLabelFont[]; builtIn: string[]; notInLibrary: string[] }

export function fontFixFor(missing: string[], library: KioskLabelFont[]): FontFix {
  const builtIn = missing.filter((n) => isResidentFont(n, library));
  const rest = missing.filter((n) => !builtIn.includes(n));
  const installable = library.filter((f) => rest.includes(f.name.toUpperCase()));
  const inLibrary = new Set(installable.map((f) => f.name.toUpperCase()));
  return { installable, builtIn, notInLibrary: rest.filter((n) => !inLibrary.has(n)) };
}

/** The fonts row's words for built-in fonts the printer doesn't have. */
export function builtInFontText(names: string[]): string {
  return names.length === 1
    ? `Printer is missing its built-in font ${names[0]}.`
    : `Printer is missing its built-in fonts ${names.join(', ')}.`;
}

export interface CheckOutcome { state: 'ok' | 'fail'; detail: string }

/** "a", "a and b", "a, b and c" (`word` "or": "a, b or c"). */
function joinWords(items: readonly string[], word: 'and' | 'or'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}

/** What the DPI row says when the move has no template of the kind at the
 *  printer's DPI: who fixes it and where, from `available` — the DPIs the
 *  move does have one at (any order; listed naturally). Never implies the
 *  station is online: a fix in the portal reaches it on the next pick. */
export function noTemplateText(kind: LabelKind, printerDpi: number, available: readonly string[]): string {
  const kindLabel = KIND_LABEL[kind];
  const dpis = [...new Set(available)].filter((d) => d !== String(printerDpi)).sort(naturalCompare);
  if (dpis.length === 0) {
    return `No active ${kindLabel} template for this move. Someone with label access needs to activate one on `
      + 'Labels › Templates in the portal (Generic Rack and RU covers every move), then pick the move again.';
  }
  return `This move's ${kindLabel} template prints at ${joinWords(dpis, 'and')} DPI only; this printer is `
    + `${printerDpi} DPI. Activate a ${printerDpi} DPI version on Labels › Templates, or use a `
    + `${joinWords(dpis, 'or')} DPI printer.`;
}

/** The DPIs the downloaded templates of the kind print at. */
export function downloadedDpis(templates: KioskLabelTemplate[], kind: LabelKind): string[] {
  return [...new Set(templatesOfKind(templates, kind).map((t) => t.dpi_key))].sort(naturalCompare);
}

/** Passes when at least one template of the kind is at the printer's DPI
 *  (an edge without the label plan: the downloaded templates decide). */
export function checkDpi(templates: KioskLabelTemplate[], kind: LabelKind, dpi: number): CheckOutcome {
  const dpis = downloadedDpis(templates, kind);
  if (dpis.includes(String(dpi))) {
    return { state: 'ok', detail: `${dpi} DPI` };
  }
  return { state: 'fail', detail: noTemplateText(kind, dpi, dpis) };
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

// A trailing DPI marker: " - 203DPI", " 300 dpi", "(600DPI)", and a kept
// older row's " Old" / " Old 2", in either order. Same rule as the server's
// labels.kiosk_templates.family_name.
const DPI_SUFFIX = /\s*[-–—]?\s*\(?\s*\d+\s*dpi\s*\)?\s*$/i;
const OLD_SUFFIX = /\s+Old(?:\s+\d+)?\s*$/;

/** The template's family: the name its DPI versions share. The server sends
 *  it; a set cached before that is grouped by the same name rule here. */
export function templateFamily(t: KioskLabelTemplate): string {
  if (t.family) return t.family;
  let base = t.name.trim();
  for (;;) {
    const stripped = base.replace(DPI_SUFFIX, '').replace(OLD_SUFFIX, '').trim();
    if (!stripped || stripped === base) return base;
    base = stripped;
  }
}

/** The mock-data test label's template: the one the station's plan picks
 *  (`planTemplateId`, from `GET /edge/labels/plan`) when it was
 *  downloaded. Otherwise (no plan, it picked none, or that template isn't
 *  here) the "Generic Rack and RU" family for a Top station, its Front
 *  template for a Front one, in the version at the printer's DPI; a
 *  template only at another DPI is skipped, and `note` says why. */
export function mockTemplateFor(
  templates: KioskLabelTemplate[], kind: LabelKind, dpi: number, planTemplateId?: string | null,
): { template: KioskLabelTemplate | null; note: string } {
  const planned = planTemplateId ? templates.find((t) => t.id === planTemplateId) : undefined;
  if (planned) return { template: planned, note: '' };
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

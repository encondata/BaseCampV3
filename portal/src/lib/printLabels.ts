/**
 * Pure helpers for the Print Labels page — settings (with the per-browser
 * localStorage store), V2's exact ZPL transforms, print ordering, batch
 * arithmetic, and per-asset label status. No React, no fetching.
 * Behavior contract: docs/superpowers/specs/2026-09-12-print-labels-design.md.
 */
import { dpiDots, sizeMeta } from './labels';
import { naturalCompare } from './naturalSort';
import type { ContainerItem, GeneratedLabelBundle, GeneratedLabelBundleItem, InitiativeAssetRow, LabelVocab } from './api';

export interface PrintSettings {
  verticalOffset: number;
  horizontalOffset: number;
  copies: number;
  batchSize: number;
  printByRack: boolean;
  blanksBetweenRacks: number;
}

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  verticalOffset: 0, horizontalOffset: 0, copies: 1, batchSize: 50,
  printByRack: false, blanksBetweenRacks: 1,
};

export const PRINT_SETTINGS_STORAGE_KEY = 'labels.print.settings';

/** The synthetic label-type key for V2's "Custom" (raw ZPL) choice. */
export const LABEL_TYPE_CUSTOM = 'custom';

export type NumericSetting = 'verticalOffset' | 'horizontalOffset' | 'copies' | 'batchSize' | 'blanksBetweenRacks';

export const SETTING_LIMITS: Record<NumericSetting, { min: number; max: number }> = {
  verticalOffset: { min: -9999, max: 9999 },
  horizontalOffset: { min: -9999, max: 9999 },
  copies: { min: 1, max: 99 },
  batchSize: { min: 1, max: 500 },
  blanksBetweenRacks: { min: 0, max: 20 },
};

/** V2's handleSettingChange: copies/batch ≥ 1, blanks ≥ 0, offsets any
 *  integer (junk → the field's floor / 0); V3 adds the upper bounds V2
 *  only hinted at in the inputs' max attributes. */
export function clampSetting(field: NumericSetting, raw: unknown): number {
  const { min, max } = SETTING_LIMITS[field];
  const n = Math.round(Number(raw));
  const fallback = field === 'copies' || field === 'batchSize' ? 1 : 0;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function settingsModified(s: PrintSettings): boolean {
  return (Object.keys(DEFAULT_PRINT_SETTINGS) as (keyof PrintSettings)[])
    .some((k) => s[k] !== DEFAULT_PRINT_SETTINGS[k]);
}

export function sanitizePrintSettings(raw: unknown): PrintSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PRINT_SETTINGS };
  const r = raw as Record<string, unknown>;
  const num = (k: NumericSetting) => (k in r ? clampSetting(k, r[k]) : DEFAULT_PRINT_SETTINGS[k]);
  return {
    verticalOffset: num('verticalOffset'),
    horizontalOffset: num('horizontalOffset'),
    copies: num('copies'),
    batchSize: num('batchSize'),
    printByRack: 'printByRack' in r ? Boolean(r.printByRack) : DEFAULT_PRINT_SETTINGS.printByRack,
    blanksBetweenRacks: num('blanksBetweenRacks'),
  };
}

/** The per-type copies default seeded on the `type` vocab meta (migration
 *  0066): 5 for a container barcode label, 1 for its info label. Null when
 *  the type carries no default or the value is not a usable count — the
 *  caller then leaves the copies setting alone. */
export function defaultCopiesFor(vocab: LabelVocab[], labelType: string): number | null {
  const meta = vocab.find((v) => v.kind === 'type' && v.key === labelType)?.meta;
  const raw = (meta as Record<string, unknown> | undefined)?.default_copies;
  return typeof raw === 'number' && Number.isInteger(raw)
    && raw >= SETTING_LIMITS.copies.min && raw <= SETTING_LIMITS.copies.max
    ? raw : null;
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readPrintSettings(storage: Pick<Storage, 'getItem'> | null = defaultStorage()): PrintSettings {
  try {
    const raw = storage?.getItem(PRINT_SETTINGS_STORAGE_KEY);
    return sanitizePrintSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_PRINT_SETTINGS };
  }
}

export function writePrintSettings(s: PrintSettings, storage: Pick<Storage, 'setItem'> | null = defaultStorage()): void {
  try {
    storage?.setItem(PRINT_SETTINGS_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — settings just don't persist */
  }
}

/** V2's sendZplToPrinter transform, verbatim: ^LS is a shift-LEFT value so
 *  the horizontal offset is negated (positive setting = move right), and a
 *  rightward shift widens ^PW so the layout isn't clipped; ^LT for the
 *  vertical offset; ^PQ copies before ^XZ unless `singleCopy` (blanks and
 *  the alignment test never multiply). */
export function applyPrintSettings(
  zpl: string, s: PrintSettings, { singleCopy = false }: { singleCopy?: boolean } = {},
): string {
  let out = zpl;
  if (s.horizontalOffset !== 0) {
    const lsValue = -s.horizontalOffset;
    if (/\^LS-?\d+/i.test(out)) out = out.replace(/\^LS-?\d+/i, `^LS${lsValue}`);
    else out = out.replace(/\^XA/i, `^XA\n^LS${lsValue}`);
    if (s.horizontalOffset > 0) {
      out = out.replace(/\^PW(\d+)/i, (_m, w: string) => `^PW${parseInt(w, 10) + s.horizontalOffset}`);
    }
  }
  if (s.verticalOffset !== 0) {
    out = out.replace(/\^XA/i, `^XA\n^LT${s.verticalOffset}`);
  }
  if (!singleCopy && s.copies > 1) {
    out = out.replace(/\^XZ/i, `^PQ${s.copies}^XZ`);
  }
  return out;
}

/** V2's rack-separator format — ^PQ rides inside so the copies setting
 *  can't multiply the blanks (callers send it with singleCopy). */
export function blankLabelsZpl(count: number): string {
  return `^XA^FO10,10^A0N,10,10^FD ^FS^PQ${count}^XZ`;
}

/** The label type whose rack separators carry the source rack name: the
 *  Front label is the one a tech applies at the rack, so each rack's stack
 *  starts with the rack to walk to. Every other asset type keeps V2's
 *  plain blanks between racks. */
export const RACK_NAME_LABEL_TYPE = 'front';

export function showsRackName(labelType: string): boolean {
  return labelType === RACK_NAME_LABEL_TYPE;
}

export interface LabelDots { width: number; height: number }

/** The stock a label prints on, in dots: the ^PW / ^LL its own code
 *  carries (the compiler writes both, and the code is there offline when
 *  the vocab isn't), else its size row × DPI. Null when neither says. */
export function labelDots(
  item: Pick<GeneratedLabelBundleItem, 'code' | 'size_key' | 'dpi_key'> | undefined, vocab: LabelVocab[],
): LabelDots | null {
  if (!item) return null;
  const size = vocab.find((v) => v.kind === 'size' && v.key === item.size_key);
  const fromVocab = (inches: number) => Math.round(inches * dpiDots(vocab, item.dpi_key));
  const pw = /\^PW(\d+)/i.exec(item.code)?.[1];
  const ll = /\^LL(\d+)/i.exec(item.code)?.[1];
  const width = pw ? Number(pw) : size ? fromVocab(sizeMeta(size).width_in) : 0;
  const height = ll ? Number(ll) : size ? fromVocab(sizeMeta(size).height_in) : 0;
  return width > 0 && height > 0 ? { width, height } : null;
}

/** ZPL's smallest ^A height. */
const MIN_FONT_DOTS = 10;

/** A character's advance as a share of font 0's height — Helvetica Bold's
 *  widths, on the wide side of font 0 (its condensed cut), so a name
 *  fitted with them never runs past the label. */
function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) {
    if (" .,:;!|'iIjl/\\".includes(ch)) units += 0.3;
    else if ('-()[]frt'.includes(ch)) units += 0.36;
    else if ('MmWw@%'.includes(ch)) units += 0.95;
    else if (/[A-Z#&?]/.test(ch)) units += 0.75;
    else units += 0.62;
  }
  return units;
}

/** The label compiler's ^FH_ escaping (api labels/zpl.py `_esc`): ^ ~ _ \
 *  and anything outside printable ASCII go out as UTF-8 hex bytes. */
function fhEscape(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ('^~_\\'.includes(ch) || code < 32 || code > 126) {
      for (const b of new TextEncoder().encode(ch)) out += `_${b.toString(16).padStart(2, '0')}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** The Front label's rack separator: `count` labels reading `rack` on one
 *  line — never wrapped — as large as the stock allows (a longer name
 *  prints smaller), centered inside a margin. ^PQ rides inside, as in the
 *  blank, so callers send it with singleCopy. With no name or no known
 *  stock it is the plain blank. */
export function rackSeparatorZpl(rack: string, count: number, dots: LabelDots | null): string {
  const name = rack.trim();
  if (!name || !dots) return blankLabelsZpl(count);
  const margin = Math.round(Math.min(dots.width, dots.height) * 0.08);
  const innerWidth = dots.width - 2 * margin;
  const innerHeight = dots.height - 2 * margin;
  const font = Math.max(MIN_FONT_DOTS, Math.floor(Math.min(innerHeight, innerWidth / textUnits(name))));
  const top = margin + Math.max(0, Math.round((innerHeight - font) / 2));
  return [
    '^XA', '^CI28', `^PW${dots.width}`, `^LL${dots.height}`, '^LH0,0',
    `^FO${margin},${top}^A0N,${font},${font}^FB${innerWidth},1,0,C,0^FH_^FD${fhEscape(name)}^FS`,
    `^PQ${count}`, '^XZ',
  ].join('\n');
}

/** V2's generateAlignmentTestZpl: an outer box 5 dots in at 4-dot
 *  thickness marking the label edge, then 2-dot boxes every 25 dots
 *  inward while both sides stay ≥ 50 dots, and the size/dpi caption
 *  centered on the label. */
export function alignmentTestZpl(widthDots: number, heightDots: number, sizeLabel: string, dpi: number): string {
  const lines = ['^XA', `^PW${widthDots}`, `^LL${heightDots}`, '^LH0,0'];
  const outerInset = 5;
  lines.push(`^FO${outerInset},${outerInset}^GB${widthDots - 2 * outerInset},${heightDots - 2 * outerInset},4^FS`);
  for (let inset = outerInset + 25; widthDots - 2 * inset >= 50 && heightDots - 2 * inset >= 50; inset += 25) {
    lines.push(`^FO${inset},${inset}^GB${widthDots - 2 * inset},${heightDots - 2 * inset},2^FS`);
  }
  lines.push(`^FO0,${Math.round(heightDots / 2) - 12}^A0N,24,24^FB${widthDots},1,0,C,0^FDALIGN ${sizeLabel} ${dpi}DPI^FS`);
  lines.push('^XZ');
  return lines.join('\n');
}

export function rackOf(row: InitiativeAssetRow | undefined): string {
  return row?.source_rack ?? '';
}

/** Print order: the selected assets in the list's displayed order, or —
 *  with Print by rack — rack ascending (numeric-aware) then RU top-down
 *  (largest first). Ids are asset ids (`row.asset_id`). */
export function printOrder(selectedIds: string[], displayedRows: InitiativeAssetRow[], s: PrintSettings): string[] {
  const selected = new Set(selectedIds);
  const ordered = displayedRows.filter((r) => selected.has(r.asset_id));
  if (!s.printByRack) return ordered.map((r) => r.asset_id);
  return [...ordered].sort((a, b) => {
    const rackCmp = naturalCompare(rackOf(a), rackOf(b));
    if (rackCmp !== 0) return rackCmp;
    return (b.source_ru ?? 0) - (a.source_ru ?? 0);
  }).map((r) => r.asset_id);
}

/** The container counterpart of `printOrder`: the selection intersected
 *  with the displayed rows, in display order. There is no rack ordering —
 *  `printByRack` and `blanksBetweenRacks` are asset concepts (a rack is a
 *  property of an asset's position in a move) and are ignored here, so the
 *  settings object is accepted only to keep the two call sites symmetric. */
export function containerPrintOrder(
  selectedIds: string[], displayedRows: ContainerItem[], _s: PrintSettings,
): string[] {
  const chosen = new Set(selectedIds);
  return displayedRows.filter((r) => chosen.has(r.id)).map((r) => r.id);
}

export function batchCount(total: number, batchSize: number): number {
  return Math.ceil(total / Math.max(1, batchSize));
}

export function batchBounds(batchNumber: number, batchSize: number, total: number): { start: number; end: number } {
  const start = (batchNumber - 1) * batchSize;
  return { start, end: Math.min(start + batchSize, total) };
}

export type LabelStatus = 'ready' | 'stale' | 'missing' | 'unsupported';

/** The labels a printer at `dpi` takes: a bundle holds every DPI an
 *  entity was generated at, and only the printer's own DPI may print. No
 *  DPI (no printer, or one whose `~HI` couldn't be read) keeps them all. */
export function bundleAtDpi(bundle: GeneratedLabelBundle | null, dpi: string | null): GeneratedLabelBundle | null {
  if (!bundle || !dpi) return bundle;
  return { ...bundle, labels: bundle.labels.filter((item) => item.dpi_key === dpi) };
}

/** Each entity's label DPIs, lowest first — the lists' DPI column. */
export function dpisByEntity(bundle: GeneratedLabelBundle | null): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const item of bundle?.labels ?? []) {
    const dpis = map.get(item.entity_id) ?? [];
    if (!dpis.includes(item.dpi_key)) dpis.push(item.dpi_key);
    map.set(item.entity_id, dpis);
  }
  for (const dpis of map.values()) dpis.sort(naturalCompare);
  return map;
}

export function bundleByEntity(bundle: GeneratedLabelBundle | null): Map<string, GeneratedLabelBundleItem> {
  const map = new Map<string, GeneratedLabelBundleItem>();
  for (const item of bundle?.labels ?? []) map.set(item.entity_id, item);
  return map;
}

/** Only ZPL can go to a Zebra; a label compiled for another language is
 *  `unsupported` (blocks the print like a missing one). Stale labels still
 *  have code, so they print. Given the printer's `dpi`, a label generated
 *  for another DPI is `missing`: it would print at the wrong scale. */
export function labelStatusFor(
  entityId: string, byEntity: Map<string, GeneratedLabelBundleItem>, dpi?: string | null,
): LabelStatus {
  const item = byEntity.get(entityId);
  if (!item || (dpi && item.dpi_key !== dpi)) return 'missing';
  if (item.language_key !== 'zpl') return 'unsupported';
  return item.stale ? 'stale' : 'ready';
}

export function isPrintableStatus(s: LabelStatus): boolean {
  return s === 'ready' || s === 'stale';
}

export function missingLabelIds(
  selectedIds: string[], byEntity: Map<string, GeneratedLabelBundleItem>, dpi?: string | null,
): string[] {
  return selectedIds.filter((id) => !isPrintableStatus(labelStatusFor(id, byEntity, dpi)));
}

export function staleLabelCount(
  selectedIds: string[], byEntity: Map<string, GeneratedLabelBundleItem>, dpi?: string | null,
): number {
  return selectedIds.filter((id) => labelStatusFor(id, byEntity, dpi) === 'stale').length;
}

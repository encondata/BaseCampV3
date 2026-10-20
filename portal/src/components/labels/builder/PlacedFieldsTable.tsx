/**
 * The table of placed fields under the canvas (spec §3.5, §4.6): one row
 * per placement of a field (a barcode or QR code bound to one included)
 * and per image (an ID badge's Photo, Logo or static Image), in stacking
 * order, with a field's Split pieces nested under one parent
 * row standing where its first piece is. Columns: Field, Display, Font,
 * B, Inv, Expected, Max, Trim, Strip — the per-placement controls, each
 * edit going through builderEdits so a text field stays as wide as it
 * reserves.
 *
 * Selection is the canvas's: a selected element's row is highlighted, a
 * click selects a row (⇧ or ⌘ adds or removes it), and the parent row
 * selects every piece placement. With the table itself focused (a click on
 * a row gives it focus), Tab / ⇧Tab and ↓ / ↑ step through the placements
 * in table order; Tab past the last row, or ⇧Tab before the first, moves
 * on out of the table. The table keeps the plain keys to itself
 * (`data-builder-keys="own"`), so the canvas doesn't also act on them.
 */

import { useEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

import { familyInfo } from '../../../labels/builder/fonts';
import { imageName } from '../../../labels/builder/image';
import { MAX_COUNT, type DesignV2, type ElementV2, type FieldElement, type StripWhere, type Trim } from '../../../labels/builder/model';
import type { LabelFields } from '../../../lib/api';
import '../../../styles/directory.css';
import '../../../styles/labelBuilder.css';
import ComboBox from '../../ComboBox';
import DataTable, { type DataTableColumn, type DataTableRow } from '../../DataTable';
import { canSplit, fontOf, isTypeset, patchElements, setDisplay, type DisplayChoice, type Patch } from './builderEdits';
import type { MetricsFor } from './Canvas';
import { ToggleButton, TextBox } from './controls';
import { boundField, fieldLabel, pieceNames } from './fieldCatalog';
import NumberBox from './NumberBox';

export interface PlacedFieldsTableProps {
  design: DesignV2;
  fields: LabelFields | null;
  /** The template's samples: Split takes its pieces from them. */
  samples: Readonly<Record<string, string>>;
  selection: readonly string[];
  onSelect: (ids: string[]) => void;
  onChange: (design: DesignV2) => void;
  metricsFor: MetricsFor;
  readOnly?: boolean;
}

export interface PlacedRow {
  /** The element's id, or `split:<field>` for a Split's parent row. */
  key: string;
  kind: 'placement' | 'split';
  /** The field it prints; '' for an image. */
  field: string;
  label: string;
  /** The placement, or every placement of the Split's pieces. */
  ids: string[];
  el: ElementV2 | null;
  /** Nested under its Split's parent row. */
  piece: boolean;
}

/** The table's rows: one per field placement and image in stacking order,
 *  Split pieces gathered under one parent row where the first piece stands. */
export function placedRows(design: DesignV2, fields: LabelFields | null): PlacedRow[] {
  const out: (PlacedRow | { split: PlacedRow; children: PlacedRow[] })[] = [];
  const splits = new Map<string, { split: PlacedRow; children: PlacedRow[] }>();
  for (const el of design.elements) {
    if (el.type === 'image') {
      out.push({ key: el.id, kind: 'placement', field: '', label: imageName(el), ids: [el.id], el, piece: false });
      continue;
    }
    const key = boundField(el);
    if (!key) continue;
    const label = fieldLabel(fields, key);
    if (el.type === 'field' && el.piece != null) {
      let group = splits.get(key);
      if (!group) {
        group = { split: { key: `split:${key}`, kind: 'split', field: key, label, ids: [], el: null, piece: false }, children: [] };
        splits.set(key, group);
        out.push(group);
      }
      group.split.ids.push(el.id);
      const name = pieceNames(design, key)[el.piece] ?? `${label} › ${el.piece + 1}`;
      group.children.push({ key: el.id, kind: 'placement', field: key, label: name, ids: [el.id], el, piece: true });
    } else {
      out.push({ key: el.id, kind: 'placement', field: key, label, ids: [el.id], el, piece: false });
    }
  }
  return out.flatMap((r) => ('split' in r ? [r.split, ...r.children] : [r]));
}

/** The placement after (or before) the selection in table order; null
 *  past either end. */
export function stepPlacement(rows: readonly PlacedRow[], selection: readonly string[], dir: 1 | -1): string | null {
  const order = rows.filter((r) => r.kind === 'placement').map((r) => r.ids[0]);
  if (!order.length) return null;
  const at = order.map((id, i) => (selection.includes(id) ? i : -1)).filter((i) => i >= 0);
  if (!at.length) return dir > 0 ? order[0] : order[order.length - 1];
  const next = dir > 0 ? Math.max(...at) + 1 : Math.min(...at) - 1;
  return next >= 0 && next < order.length ? order[next] : null;
}

const COLUMNS: DataTableColumn[] = [
  { key: 'field', label: 'Field' },
  { key: 'display', label: 'Display', width: '142px' },
  { key: 'font', label: 'Font', width: '140px' },
  { key: 'bold', label: 'B', align: 'center', width: '40px' },
  { key: 'inv', label: 'Inv', align: 'center', width: '44px' },
  { key: 'expected', label: 'Expected', width: '78px' },
  { key: 'max', label: 'Max', width: '64px' },
  { key: 'trim', label: 'Trim', width: '104px' },
  { key: 'strip', label: 'Strip', width: '160px' },
];

const DISPLAYS: { value: DisplayChoice; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'barcode', label: 'Barcode' },
  { value: 'qr', label: 'QR code' },
];
const SPLIT_OPTION = { value: 'split' as const, label: 'Split' };
const TRIMS: { value: Trim; label: string }[] = [{ value: 'front', label: 'Front' }, { value: 'rear', label: 'Rear' }];
const STRIP_WHERES: { value: StripWhere; label: string }[] = [
  { value: 'front', label: 'Front' }, { value: 'rear', label: 'Rear' }, { value: 'anywhere', label: 'Anywhere' },
];

/** A family's name, shortened for the table. */
export function shortFontName(family: string): string {
  return (familyInfo(family)?.label ?? family).replace(' Condensed', ' Cond.').replace(' (printer built-in)', ' (built-in)');
}

const NONE = <span className="lbp-none" aria-hidden="true">—</span>;

/** A click on a control in a row also selects the row, but keeps focus. */
function inControl(target: EventTarget): boolean {
  return !!(target as Element).closest?.('input, textarea, button, [role="combobox"], .combo-wrap');
}

export default function PlacedFieldsTable({
  design, fields, samples, selection, onSelect, onChange, metricsFor, readOnly = false,
}: PlacedFieldsTableProps) {
  const wrapRef = useRef<HTMLElement>(null);
  const rows = placedRows(design, fields);

  // bring the first selected row into view inside the table's own scroll
  // box (never scrolling the page around it)
  useEffect(() => {
    const box = wrapRef.current?.querySelector<HTMLElement>('.data-table-scroll');
    const row = box?.querySelector<HTMLElement>('tbody tr[aria-selected="true"]');
    if (!box || !row) return;
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const head = box.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    if (r.top < b.top + head) box.scrollTop -= b.top + head - r.top;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
  }, [selection]);

  const patch = (id: string, p: Patch) => {
    const next = patchElements(design, [id], p, metricsFor);
    if (next !== design) onChange(next);
  };

  const display = (el: FieldElement, choice: DisplayChoice) => {
    const out = setDisplay(design, [el.id], choice, samples, metricsFor);
    if (out.design === design) return;
    onChange(out.design);
    if (choice === 'split') onSelect(out.ids);
  };

  const pick = (row: PlacedRow) => (e: MouseEvent<HTMLTableRowElement>) => {
    let next: string[];
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      const all = row.ids.every((id) => selection.includes(id));
      next = all ? selection.filter((id) => !row.ids.includes(id)) : [...selection, ...row.ids.filter((id) => !selection.includes(id))];
    } else {
      next = row.ids;
    }
    if (next.length !== selection.length || next.some((id, i) => id !== selection[i])) onSelect(next);
    if (!inControl(e.target)) wrapRef.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    const dir = e.key === 'Tab' ? (e.shiftKey ? -1 : 1) : e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    const next = stepPlacement(rows, selection, dir);
    // Tab past either end leaves the table; an arrow stays at the end
    if (next === null && e.key === 'Tab') return;
    e.preventDefault();
    if (next !== null) onSelect([next]);
  };

  const fieldCells = (el: FieldElement): ReactNode[] => {
    const typeset = isTypeset(el);
    const font = fontOf(el);
    const options = el.piece == null && canSplit(design, el, samples) ? [...DISPLAYS, SPLIT_OPTION] : DISPLAYS;
    return [
      <ComboBox key="display" portal ariaLabel="Display" options={options} value={el.display} disabled={readOnly}
        onChange={(v) => { if (v) display(el, v as DisplayChoice); }} />,
      typeset ? <span className="lbp-font-short">{shortFontName(font.family)}</span> : NONE,
      typeset ? (
        <ToggleButton label="Bold" pressed={font.weight === 'bold'} disabled={readOnly}
          onToggle={(on) => patch(el.id, { font: { ...font, weight: on ? 'bold' : 'regular' } })} />
      ) : NONE,
      typeset ? (
        <ToggleButton label="Inverted" pressed={!!el.inverted} disabled={readOnly}
          onToggle={(on) => patch(el.id, { inverted: on })} />
      ) : NONE,
      typeset ? (
        <NumberBox ariaLabel="Expected length" value={el.expectedLength ?? null} allowEmpty integer min={1} max={MAX_COUNT}
          disabled={readOnly} onCommit={(v) => patch(el.id, { expectedLength: v })} />
      ) : NONE,
      <NumberBox key="max" ariaLabel="Max characters" value={el.maxChars ?? null} allowEmpty integer min={1} max={MAX_COUNT}
        disabled={readOnly}
        onCommit={(v) => patch(el.id, v === null ? { maxChars: null, trim: null } : { maxChars: v, trim: el.trim ?? 'rear' })} />,
      el.maxChars ? (
        <ComboBox key="trim" portal ariaLabel="Trim" options={TRIMS} value={el.trim ?? 'rear'} disabled={readOnly}
          onChange={(v) => { if (v) patch(el.id, { trim: v as Trim }); }} />
      ) : NONE,
      <div key="strip" className="lbp-strip">
        <TextBox ariaLabel="Strip" value={el.strip ?? ''} disabled={readOnly} className="lbp-text lbp-strip-text"
          placeholder="—"
          onCommit={(v) => patch(el.id, v ? { strip: v, stripWhere: el.stripWhere ?? 'front' } : { strip: null, stripWhere: null })} />
        {el.strip ? (
          <ComboBox portal ariaLabel="Strip from" options={STRIP_WHERES} value={el.stripWhere ?? 'front'} disabled={readOnly}
            onChange={(v) => { if (v) patch(el.id, { stripWhere: v as StripWhere }); }} />
        ) : null}
      </div>,
    ];
  };

  const cellsFor = (row: PlacedRow): ReactNode[] => {
    const name = row.piece
      ? <span className="lbp-piece-name"><b className="cell-top">{row.label}</b></span>
      : <b className="cell-top">{row.label}</b>;
    if (row.kind === 'split') return [name, <span key="d" className="chip tag">Split</span>, '', '', '', '', '', '', ''];
    const el = row.el!;
    if (el.type === 'field') return [name, ...fieldCells(el)];
    const kind = el.type === 'barcode' ? 'Barcode' : el.type === 'image' ? 'Image' : 'QR code';
    return [name, <span key="d" className="chip tag">{kind}</span>, NONE, NONE, NONE, NONE, NONE, NONE, NONE];
  };

  const tableRows: DataTableRow[] = rows.map((row) => {
    const selected = row.ids.length > 0 && row.ids.every((id) => selection.includes(id));
    const cls = [row.kind === 'split' ? 'is-split' : '', row.piece ? 'is-piece' : '', selected ? 'is-selected' : '']
      .filter(Boolean).join(' ');
    return { key: row.key, cells: cellsFor(row), className: cls || undefined, onClick: pick(row), selected };
  });

  return (
    <section ref={wrapRef} className="lbp-placed" aria-label="Fields on this label" tabIndex={0}
      data-builder-keys="own" onKeyDown={onKeyDown}>
      <div className="lbp-title">
        <span>Fields on this label</span>
        <span className="lbp-hint">Tab / ⇧Tab to step</span>
      </div>
      <DataTable ariaLabel="Placed fields" columns={COLUMNS} rows={tableRows}
        emptyText="No fields on the label yet. Add one from the field list or the + picker." />
    </section>
  );
}

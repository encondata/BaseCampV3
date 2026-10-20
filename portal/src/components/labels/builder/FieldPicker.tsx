/**
 * The field panel's + picker (spec §3.5, §4.6): what can go on the label —
 * static text, a line, a box, then every field, unused ones first and
 * placed ones last in grey with "on label ×n" (pick one again for another
 * copy), Split pieces under their field. Typing filters; on a label that
 * has a From-To row, a header the list hasn't seen can be added as typed
 * (`ft:<header>`). No images this round (spec §7.6).
 *
 * A pick places the element at the next free spot, selects it and closes
 * the picker. Keyboard: the filter box keeps focus, ↓ ↑ move, Enter picks,
 * Escape or Tab closes. The panel closes it on a click outside.
 *
 * The field panel drives it from its own search box (`query`): the picker
 * then shows no filter box, the panel's box forwards ↓ ↑ Enter (`key`, a
 * FieldPickerHandle) and points at the active option (`onActive`), and the
 * panel handles Escape and Tab itself.
 */

import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';

import type { DesignV2 } from '../../../labels/builder/model';
import type { LabelFields } from '../../../lib/api';
import { placeField, placeShape } from './builderEdits';
import type { MetricsFor } from './Canvas';
import { allowsFromTo, byUse, catalogGroups, FT_PREFIX, matches, type FieldKind } from './fieldCatalog';

export interface FieldPickerProps {
  fields: LabelFields | null;
  design: DesignV2;
  samples: Readonly<Record<string, string>>;
  metricsFor: MetricsFor;
  onChange: (design: DesignV2) => void;
  /** The new element's id, to select it. */
  onSelect: (ids: string[]) => void;
  onClose: () => void;
  /** The template's label type: a container label has no From-To row. */
  labelType?: string;
  /** The filter typed in the field panel's search box; the picker then has
   *  no filter box of its own. */
  query?: string;
  /** The listbox's id, for the panel's box to point at (aria-controls). */
  listId?: string;
  /** The active option's id as it moves (the panel's aria-activedescendant). */
  onActive?: (optionId: string | undefined) => void;
}

export interface FieldPickerHandle {
  /** A key from the panel's search box: ↓ ↑ move, Enter picks. True when
   *  the picker took it. */
  key: (key: string) => boolean;
}

type PickItem =
  | { kind: 'shape'; tool: 'text' | 'line' | 'box'; name: string; sub: string }
  | { kind: 'field'; key: string; fieldKind: FieldKind; piece: number | null; name: string; sub: string; used: boolean }
  | { kind: 'free'; header: string; name: string; sub: string };

const SHAPES: PickItem[] = [
  { kind: 'shape', tool: 'text', name: 'Static text', sub: 'caption' },
  { kind: 'shape', tool: 'line', name: 'Line', sub: 'shape' },
  { kind: 'shape', tool: 'box', name: 'Box', sub: 'shape' },
];

function onLabel(count: number): string {
  return `on label ×${count}`;
}

/** The field items for `query`, unused first, each Split's pieces under
 *  their field (a field that matches shows all its pieces; a piece that
 *  matches shows with its field). */
function fieldItems(fields: LabelFields | null, design: DesignV2, labelType: string | undefined,
  query: string): PickItem[] {
  const all = catalogGroups(fields, design, labelType).flatMap((g) => g.fields);
  const out: PickItem[] = [];
  for (const use of byUse(all, design)) {
    const own = matches(use.field.label, query);
    const pieces = use.pieces.filter((p) => own || matches(p.name, query));
    if (!own && !pieces.length) continue;
    out.push({
      kind: 'field', key: use.field.key, fieldKind: use.field.kind, piece: null, name: use.field.label,
      sub: use.count ? onLabel(use.count) : use.field.groupLabel, used: use.count > 0,
    });
    for (const p of pieces) {
      out.push({
        kind: 'field', key: use.field.key, fieldKind: use.field.kind, piece: p.index, name: p.name,
        sub: p.count ? onLabel(p.count) : 'piece', used: p.count > 0,
      });
    }
  }
  const header = query.trim();
  const known = all.some((f) => f.key === `${FT_PREFIX}${header}`);
  if (header && !known && allowsFromTo(labelType)) {
    out.push({ kind: 'free', header, name: `From-To column “${header}”`, sub: 'From-To' });
  }
  return out;
}

const FieldPicker = forwardRef<FieldPickerHandle, FieldPickerProps>(function FieldPicker({
  fields, design, samples, metricsFor, onChange, onSelect, onClose, labelType, query: given, listId: givenList,
  onActive,
}, ref) {
  const [own, setOwn] = useState('');
  const query = given ?? own;
  const [active, setActive] = useState(0);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const listId = givenList ?? `${uid}-picks`;
  const optionId = (i: number) => `${listId}-${i}`;

  const shapes = useMemo(() => SHAPES.filter((s) => matches(s.name, query)), [query]);
  const items = useMemo(() => fieldItems(fields, design, labelType, query), [fields, design, labelType, query]);
  const all = [...shapes, ...items];

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeId = all.length ? optionId(Math.min(active, all.length - 1)) : undefined;
  useEffect(() => { onActive?.(activeId); }, [activeId, onActive]);

  const run = (item: PickItem | undefined) => {
    if (!item) return;
    const placed = item.kind === 'shape'
      ? placeShape(design, item.tool, metricsFor)
      : item.kind === 'free'
        ? placeField(design, `${FT_PREFIX}${item.header}`, 'text', samples, metricsFor)
        : placeField(design, item.key, item.fieldKind, samples, metricsFor, item.piece);
    onChange(placed.design);
    onSelect([placed.id]);
    onClose();
  };

  const step = (key: string): boolean => {
    switch (key) {
      case 'ArrowDown': setActive((a) => Math.min(all.length - 1, a + 1)); return true;
      case 'ArrowUp': setActive((a) => Math.max(0, a - 1)); return true;
      case 'Enter': run(all[active]); return true;
      default: return false;
    }
  };
  useImperativeHandle(ref, () => ({ key: step }));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (step(e.key)) {
      e.preventDefault();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') {
      onClose();
    }
  };

  const option = (item: PickItem, i: number) => {
    const cls = ['lbp-pick'];
    if (item.kind === 'field' && item.used) cls.push('is-used');
    if (item.kind === 'field' && item.piece !== null) cls.push('is-piece');
    if (i === active) cls.push('active');
    return (
      <div key={`${item.kind}-${item.kind === 'field' ? `${item.key}-${item.piece}` : item.name}`} id={optionId(i)}
        role="option" aria-selected={i === active} className={cls.join(' ')}
        onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => run(item)}>
        <span className="lbp-pick-name">{item.name}</span>
        <span className="lbp-pick-sub">{item.sub}</span>
      </div>
    );
  };

  return (
    <div className={`lbp-picker${given === undefined ? '' : ' is-driven'}`} role="dialog" aria-label="Add to the label">
      {given === undefined && (
        <div className="dir-search lbp-picker-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input autoFocus role="combobox" aria-label="Filter fields" aria-expanded="true" aria-controls={listId}
            aria-activedescendant={activeId} placeholder="Filter…" value={query}
            onChange={(e) => setOwn(e.target.value)} onKeyDown={onKeyDown} autoComplete="off" spellCheck={false} />
        </div>
      )}
      <div className="lbp-picker-scroll" role="listbox" id={listId} aria-label="What to add">
        {shapes.length > 0 && (
          <div role="group" aria-label="Add to the label">
            <div className="lbp-pick-title" aria-hidden="true">Add to the label</div>
            {shapes.map((s, i) => option(s, i))}
          </div>
        )}
        {items.length > 0 && (
          <div role="group" aria-label="Fields">
            <div className="lbp-pick-title" aria-hidden="true">Fields</div>
            {items.map((item, i) => option(item, shapes.length + i))}
          </div>
        )}
        {!all.length && <div className="pop-empty">Nothing matches “{query.trim()}”.</div>}
      </div>
      <div className="lbp-picker-note">Placed fields sit last, in grey. Pick one again to add another copy.</div>
    </div>
  );
});

export default FieldPicker;

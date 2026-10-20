/**
 * The builder's left panel (spec §3.5, §4.6): the fields on the label,
 * grouped as GET /labels/fields returns them, then the From-To columns,
 * each with how many times it is placed and its sample value, edited in
 * place (click it; Enter or leaving keeps it, Escape drops it). A field's
 * placed Split pieces sit under it with their own counts and their piece
 * of the sample. Fields not on the label aren't listed: the search box and
 * the + open the picker (FieldPicker), which holds the whole catalog, and
 * the search box filters it (↓ ↑ Enter pick, Escape closes).
 *
 * A click on a name places another copy of the field (as the picker does);
 * a click on its ×n selects its placements on the canvas; its × removes
 * every one of them (or of a piece) in one change, dropping them from the
 * selection. A field can also be dragged out (FIELD_DRAG_TYPE, for the
 * canvas to take). The page wires `/` to `focusSearch()` (a ref,
 * FieldPanelHandle), which opens the picker, and shows LoadFromAssetModal
 * when Load from asset… is pressed. An ID badge offers Load from person…
 * instead (LoadFromPersonModal), and, while it has a sample person (the
 * samples' `person:id`), names them and offers Clear sample person — once
 * the fields are here, since they say which samples are the person's.
 */

import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';

import { samplePersonId } from '../../../labels/builder/image';
import { removeElements, type DesignV2 } from '../../../labels/builder/model';
import type { LabelFields } from '../../../lib/api';
import { isPersonLabelType } from '../../../lib/labels';
import '../../../styles/directory.css';
import '../../../styles/labelBuilder.css';
import { placeField } from './builderEdits';
import type { MetricsFor } from './Canvas';
import FieldPicker, { type FieldPickerHandle } from './FieldPicker';
import {
  allowsFromTo, byUse, catalogGroups, FIELD_DRAG_TYPE, pieceSample, placementsOf, sampleOf,
  type FieldUse,
} from './fieldCatalog';

export interface FieldPanelProps {
  /** GET /labels/fields for the template's label type; null while loading. */
  fields: LabelFields | null;
  design: DesignV2;
  /** The template's sample values, by field key. */
  samples: Readonly<Record<string, string>>;
  /** A sample edited in place (a blank one is dropped). */
  onSamples: (samples: Record<string, string>) => void;
  onChange: (design: DesignV2) => void;
  onSelect: (ids: string[]) => void;
  /** The canvas's selection: a removed field's placements leave it. */
  selection?: readonly string[];
  /** A field's (or piece's) placements were removed, for a notice. */
  onRemoved?: (count: number, name: string) => void;
  metricsFor: MetricsFor;
  /** The template's label type: container labels have no From-To row and
   *  no asset to load samples from. */
  labelType?: string;
  /** Shows Load from asset… (the page opens LoadFromAssetModal). */
  onLoadFromAsset?: () => void;
  /** Shows Load from person… on an ID badge (the page opens
   *  LoadFromPersonModal). */
  onLoadFromPerson?: () => void;
  /** Shows Clear sample person while an ID badge has one. */
  onClearPerson?: () => void;
  /** Why the fields could not load. */
  loadError?: string | null;
  readOnly?: boolean;
  /** A DPI child: the samples shown are its parent template's, so they and
   *  Load from asset… (or from person…) are read-only here (fields can
   *  still be placed). */
  samplesFromParent?: boolean;
}

export interface FieldPanelHandle {
  /** `/`: focus the search box and open the picker. */
  focusSearch: () => void;
}

function placements(n: number): string {
  return `Select its ${n} placement${n === 1 ? '' : 's'}`;
}

/** A field's sample: a button showing it, an input while editing. */
function SampleValue({ label, value, onCommit, readOnly, fromParent = false }: {
  label: string; value: string; onCommit: (v: string) => void; readOnly: boolean; fromParent?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const done = useRef(false);
  if (draft === null) {
    const title = fromParent ? `The parent template's sample: ${value || 'none'}`
      : value ? `Sample: ${value}` : 'Give this field a sample';
    return (
      <button type="button" className={`lbp-sample${value ? '' : ' is-empty'}`} disabled={readOnly || fromParent}
        aria-label={`Edit the sample of ${label}`} title={title}
        onClick={() => { done.current = false; setDraft(value); }}>
        {value || 'No sample'}
      </button>
    );
  }
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    if (keep && draft !== value) onCommit(draft);
    setDraft(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  return (
    <input className="lbp-sample-input" aria-label={`${label} sample`} value={draft} autoFocus spellCheck={false}
      autoComplete="off" onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown}
      onBlur={() => finish(true)} onFocus={(e) => e.currentTarget.select()} />
  );
}

const FieldPanel = forwardRef<FieldPanelHandle, FieldPanelProps>(function FieldPanel({
  fields, design, samples, onSamples, onChange, onSelect, selection = [], onRemoved, metricsFor, labelType,
  onLoadFromAsset, onLoadFromPerson, onClearPerson, loadError = null, readOnly = false, samplesFromParent = false,
}, ref) {
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);
  const [activeOption, setActiveOption] = useState<string | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<FieldPickerHandle>(null);
  const listId = `${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-picks`;

  const open = () => {
    if (!readOnly) setPicking(true);
  };
  /** Closes the picker; the search only ever filtered it. */
  const close = () => {
    setPicking(false);
    setQuery('');
  };

  useImperativeHandle(ref, () => ({
    focusSearch: () => {
      searchRef.current?.focus();
      searchRef.current?.select();
      if (!readOnly) setPicking(true);
    },
  }), [readOnly]);

  // a click outside the search bar (which holds the picker) closes it,
  // leaving focus where the click put it; a pick puts focus on the +
  useEffect(() => {
    if (!picking) return undefined;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) {
        setPicking(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [picking]);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (picking || query) {
        e.preventDefault();
        close();
        searchRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    if (e.key === 'Tab') {
      if (picking) close();
      return;
    }
    if (!picking) {
      if (e.key === 'ArrowDown' && !readOnly) {
        e.preventDefault();
        open();
      }
      return;
    }
    if (pickerRef.current?.key(e.key)) e.preventDefault();
  };

  const add = (key: string, kind: FieldUse['field']['kind'], piece: number | null) => {
    if (readOnly) return;
    const placed = placeField(design, key, kind, samples, metricsFor, piece);
    onChange(placed.design);
    onSelect([placed.id]);
  };

  const setSample = (key: string, value: string) => {
    const next = { ...samples };
    if (value) next[key] = value;
    else delete next[key];
    onSamples(next);
  };

  const drag = (key: string, piece: number | null) => (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(FIELD_DRAG_TYPE, JSON.stringify({ key, piece }));
    e.dataTransfer.effectAllowed = 'copy';
  };

  // only what is on the label, pieces included, in catalog order
  const groups = catalogGroups(fields, design, labelType)
    .map((g) => ({
      ...g,
      uses: byUse(g.fields, design)
        .filter((u) => u.count > 0)
        .map((u) => ({ ...u, pieces: u.pieces.filter((p) => p.count > 0) })),
    }))
    .filter((g) => g.uses.length);

  const select = (key: string, piece?: number | null) => onSelect(placementsOf(design, key, piece).map((e) => e.id));

  /** Where focus goes once a row's × has taken its row away: the next
   *  row's ×, else the one before, else the search box (resolved after the
   *  list re-renders without the row). */
  const asideRef = useRef<HTMLElement>(null);
  const refocus = useRef<{ from: DesignV2; next: string[] } | null>(null);
  const removeLabel = (name: string) => `Remove ${name} from the label`;
  useLayoutEffect(() => {
    const want = refocus.current;
    const root = asideRef.current;
    if (!want || !root) return;
    if (want.from === design) return;   // not re-rendered without the row yet
    refocus.current = null;
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button.lbp-remove'));
    const byLabel = (label: string) => buttons.find((b) => b.getAttribute('aria-label') === label);
    const target = want.next.map(byLabel).find((b) => b !== undefined);
    if (target) target.focus({ preventScroll: true });
    else searchRef.current?.focus({ preventScroll: true });
  });

  /** Every placement of `key` (or of one Split piece), in one change. */
  const remove = (name: string, key: string, piece?: number | null) => {
    if (readOnly) return;
    const gone = placementsOf(design, key, piece).map((e) => e.id);
    if (!gone.length) return;
    const labels = Array.from(asideRef.current?.querySelectorAll<HTMLButtonElement>('button.lbp-remove') ?? [])
      .map((b) => b.getAttribute('aria-label') ?? '');
    const at = labels.indexOf(removeLabel(name));
    if (at >= 0) {
      refocus.current = { from: design, next: [...labels.slice(at + 1), ...labels.slice(0, at).reverse()] };
    }
    onChange(removeElements(design, gone));
    if (selection.some((id) => gone.includes(id))) onSelect(selection.filter((id) => !gone.includes(id)));
    onRemoved?.(gone.length, name);
  };

  const removeButton = (name: string, key: string, piece?: number | null) => (readOnly ? null : (
    <button type="button" className="lbp-remove" aria-label={removeLabel(name)}
      title="Remove from the label" onClick={() => remove(name, key, piece)}>
      <svg viewBox="0 0 16 16" aria-hidden="true" className="lbp-icon"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
    </button>
  ));

  const assetLoad = !!onLoadFromAsset && allowsFromTo(labelType);
  const personLoad = !!onLoadFromPerson && !!labelType && isPersonLabelType(labelType);
  const personId = samplePersonId(samples);
  const personName = sampleOf(samples, 'person_name');
  let footHint = 'Fills every sample from a real roster row.';
  if (samplesFromParent) footHint = 'Samples belong to the parent template.';
  else if (personLoad && personId !== null) {
    footHint = personName ? `Sample person: ${personName}` : 'A sample person is loaded.';
  } else if (personLoad) footHint = 'Fills every sample, the photo and the logo from a real person.';

  return (
    <aside className="lbp lbp-fields-panel" aria-label="Fields" ref={asideRef}>
      <div className="lbp-title">
        <span>Fields</span>
        <kbd className="lbp-kbd" title="Press / to search the fields">/</kbd>
      </div>
      <div className="lbp-search-bar" ref={barRef}>
        <div className="dir-search lbp-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input ref={searchRef} type="search" role="combobox" aria-label="Search fields"
            placeholder="Search fields to add…" value={query} autoComplete="off" spellCheck={false}
            aria-autocomplete="list" aria-expanded={picking} aria-controls={picking ? listId : undefined}
            aria-activedescendant={picking ? activeOption : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              open();
            }}
            onClick={open} onKeyDown={onSearchKey} />
        </div>
        <button ref={plusRef} type="button" className="mini-btn lbp-add" aria-label="Add to the label" title="Add to the label"
          aria-haspopup="dialog" aria-expanded={picking} disabled={readOnly}
          onClick={() => {
            if (picking) {
              close();
            } else {
              open();
              searchRef.current?.focus({ preventScroll: true });
            }
          }}>
          <svg viewBox="0 0 16 16" aria-hidden="true" className="lbp-icon"><path d="M8 3v10M3 8h10" /></svg>
        </button>
        {picking && (
          <FieldPicker ref={pickerRef} fields={fields} design={design} samples={samples} metricsFor={metricsFor}
            labelType={labelType} query={query} listId={listId} onActive={setActiveOption}
            onChange={onChange} onSelect={onSelect}
            onClose={() => { close(); plusRef.current?.focus({ preventScroll: true }); }} />
        )}
      </div>
      <div className="lbp-scroll">
        {loadError && <div className="pf-error">{loadError}</div>}
        {!fields && !loadError && <div className="lbp-empty">Loading fields…</div>}
        {fields && !groups.length && (
          <div className="lbp-empty">No fields on this label yet. Press + or / to add one.</div>
        )}
        {groups.map((g) => (
          <div key={g.key} role="group" aria-label={g.label} className="lbp-group">
            <div className="lbp-group-label" aria-hidden="true">{g.label}</div>
            {g.uses.map((u) => (
              <div key={u.field.key} className="lbp-field-wrap">
                <div className="lbp-field" draggable={!readOnly} onDragStart={drag(u.field.key, null)}>
                  <button type="button" className="lbp-field-name" disabled={readOnly} title="Add to the label"
                    aria-label={`Add ${u.field.label} to the label`} onClick={() => add(u.field.key, u.field.kind, null)}>
                    {u.field.label}
                  </button>
                  {u.count > 0 && (
                    <button type="button" className="lbp-count" aria-label={placements(u.count)}
                      title={placements(u.count)} onClick={() => select(u.field.key)}>×{u.count}</button>
                  )}
                  <SampleValue label={u.field.label} value={sampleOf(samples, u.field.key)} readOnly={readOnly}
                    fromParent={samplesFromParent}
                    onCommit={(v) => setSample(u.field.key, v)} />
                  {removeButton(u.field.label, u.field.key)}
                </div>
                {u.pieces.map((p) => (
                  <div key={p.index} className="lbp-field is-piece" draggable={!readOnly}
                    onDragStart={drag(u.field.key, p.index)}>
                    <button type="button" className="lbp-field-name" disabled={readOnly} title="Add to the label"
                      aria-label={`Add ${p.name} to the label`} onClick={() => add(u.field.key, u.field.kind, p.index)}>
                      {p.name}
                    </button>
                    {p.count > 0 && (
                      <button type="button" className="lbp-count" aria-label={placements(p.count)}
                        title={placements(p.count)} onClick={() => select(u.field.key, p.index)}>×{p.count}</button>
                    )}
                    <span className="lbp-sample" title="This piece of the sample">
                      {pieceSample(sampleOf(samples, u.field.key), p.index)}
                    </span>
                    {removeButton(p.name, u.field.key, p.index)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
      {(samplesFromParent || assetLoad || personLoad) && (
        <div className="lbp-foot">
          {assetLoad && (
            <button type="button" className="mini-btn" disabled={readOnly || samplesFromParent}
              onClick={onLoadFromAsset}>Load from asset…</button>
          )}
          {personLoad && (
            <div className="lbp-foot-actions">
              <button type="button" className="mini-btn" disabled={readOnly || samplesFromParent}
                onClick={onLoadFromPerson}>Load from person…</button>
              {personId !== null && onClearPerson && (
                <button type="button" className="mini-btn" disabled={readOnly || samplesFromParent || !fields}
                  onClick={onClearPerson}>Clear sample person</button>
              )}
            </div>
          )}
          <span className="lbp-hint">{footHint}</span>
        </div>
      )}
    </aside>
  );
});

export default FieldPanel;

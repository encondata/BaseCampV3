/**
 * The builder's left panel (spec §3.5, §4.6): the fields a template of its
 * label type can print, grouped as GET /labels/fields returns them, then
 * the From-To columns. Each field shows its sample value, edited in place
 * (click it; Enter or leaving keeps it, Escape drops it). Unused fields come
 * first in their group; placed ones follow in grey with how many times
 * they are on the label, and a field's Split pieces sit under it with
 * their own counts and their piece of the sample.
 *
 * A click on a name places another copy of the field (as the + picker
 * does); a click on its ×n selects its placements on the canvas. A field
 * can also be dragged out (FIELD_DRAG_TYPE, for the canvas to take).
 * The page wires `/` to `focusSearch()` (a ref, FieldPanelHandle) and shows
 * LoadFromAssetModal when Load from asset… is pressed.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';

import type { DesignV2 } from '../../../labels/builder/model';
import type { LabelFields } from '../../../lib/api';
import '../../../styles/directory.css';
import '../../../styles/labelBuilder.css';
import { placeField } from './builderEdits';
import type { MetricsFor } from './Canvas';
import FieldPicker from './FieldPicker';
import {
  allowsFromTo, byUse, catalogGroups, FIELD_DRAG_TYPE, matches, pieceSample, placementsOf, sampleOf,
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
  metricsFor: MetricsFor;
  /** The template's label type: container labels have no From-To row and
   *  no asset to load samples from. */
  labelType?: string;
  /** Shows Load from asset… (the page opens LoadFromAssetModal). */
  onLoadFromAsset?: () => void;
  /** Why the fields could not load. */
  loadError?: string | null;
  readOnly?: boolean;
}

export interface FieldPanelHandle {
  /** `/`: focus the search box. */
  focusSearch: () => void;
}

function placements(n: number): string {
  return `Select its ${n} placement${n === 1 ? '' : 's'}`;
}

/** A field's sample: a button showing it, an input while editing. */
function SampleValue({ label, value, onCommit, readOnly }: {
  label: string; value: string; onCommit: (v: string) => void; readOnly: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const done = useRef(false);
  if (draft === null) {
    return (
      <button type="button" className={`lbp-sample${value ? '' : ' is-empty'}`} disabled={readOnly}
        aria-label={`Edit the sample of ${label}`} title={value ? `Sample: ${value}` : 'Give this field a sample'}
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
  fields, design, samples, onSamples, onChange, onSelect, metricsFor, labelType, onLoadFromAsset,
  loadError = null, readOnly = false,
}, ref) {
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);

  useImperativeHandle(ref, () => ({
    focusSearch: () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    },
  }), []);

  // a click outside the search bar (which holds the picker) closes it,
  // leaving focus where the click put it; any other close (a pick, Escape,
  // Tab) puts focus back on the +
  useEffect(() => {
    if (!picking) return undefined;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setPicking(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [picking]);

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

  const groups = catalogGroups(fields, design, labelType)
    .map((g) => ({
      ...g,
      uses: byUse(g.fields, design).flatMap((u) => {
        const own = matches(u.field.label, query);
        const pieces = u.pieces.filter((p) => own || matches(p.name, query));
        return own || pieces.length ? [{ ...u, pieces }] : [];
      }),
    }))
    .filter((g) => g.uses.length);

  const select = (key: string, piece?: number | null) => onSelect(placementsOf(design, key, piece).map((e) => e.id));

  return (
    <aside className="lbp lbp-fields-panel" aria-label="Fields">
      <div className="lbp-title">
        <span>Fields</span>
        <kbd className="lbp-kbd" title="Press / to search the fields">/</kbd>
      </div>
      <div className="lbp-search-bar" ref={barRef}>
        <div className="dir-search lbp-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input ref={searchRef} type="search" aria-label="Search fields" placeholder="Search fields…" value={query}
            autoComplete="off" spellCheck={false} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault();
                setQuery('');
              }
            }} />
        </div>
        <button ref={plusRef} type="button" className="mini-btn lbp-add" aria-label="Add to the label" title="Add to the label"
          aria-haspopup="dialog" aria-expanded={picking} disabled={readOnly} onClick={() => setPicking((p) => !p)}>
          <svg viewBox="0 0 16 16" aria-hidden="true" className="lbp-icon"><path d="M8 3v10M3 8h10" /></svg>
        </button>
        {picking && (
          <FieldPicker fields={fields} design={design} samples={samples} metricsFor={metricsFor} labelType={labelType}
            onChange={onChange} onSelect={onSelect}
            onClose={() => { setPicking(false); plusRef.current?.focus({ preventScroll: true }); }} />
        )}
      </div>
      <div className="lbp-scroll">
        {loadError && <div className="pf-error">{loadError}</div>}
        {!fields && !loadError && <div className="lbp-empty">Loading fields…</div>}
        {fields && !groups.length && <div className="lbp-empty">No fields match “{query.trim()}”.</div>}
        {groups.map((g) => (
          <div key={g.key} role="group" aria-label={g.label} className="lbp-group">
            <div className="lbp-group-label" aria-hidden="true">{g.label}</div>
            {g.uses.map((u) => (
              <div key={u.field.key} className="lbp-field-wrap">
                <div className={`lbp-field${u.count ? ' is-used' : ''}`} draggable={!readOnly}
                  onDragStart={drag(u.field.key, null)}>
                  <button type="button" className="lbp-field-name" disabled={readOnly} title="Add to the label"
                    aria-label={`Add ${u.field.label} to the label`} onClick={() => add(u.field.key, u.field.kind, null)}>
                    {u.field.label}
                  </button>
                  {u.count > 0 && (
                    <button type="button" className="lbp-count" aria-label={placements(u.count)}
                      title={placements(u.count)} onClick={() => select(u.field.key)}>×{u.count}</button>
                  )}
                  <SampleValue label={u.field.label} value={sampleOf(samples, u.field.key)} readOnly={readOnly}
                    onCommit={(v) => setSample(u.field.key, v)} />
                </div>
                {u.pieces.map((p) => (
                  <div key={p.index} className={`lbp-field is-piece${p.count ? ' is-used' : ''}`} draggable={!readOnly}
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
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
      {onLoadFromAsset && allowsFromTo(labelType) && (
        <div className="lbp-foot">
          <button type="button" className="mini-btn" disabled={readOnly} onClick={onLoadFromAsset}>Load from asset…</button>
          <span className="lbp-hint">Fills every sample from a real roster row.</span>
        </div>
      )}
    </aside>
  );
});

export default FieldPanel;

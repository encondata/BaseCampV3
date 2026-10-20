/**
 * New template (spec §4.10): a name, a label type and a size, then the
 * builder opens on the new template — a parent designed in inches with its
 * 203, 300 and 600 DPI children (POST /labels/templates with a schema 2
 * design). It starts inactive, as a clone does, so an empty design never
 * reaches a kiosk; it goes live from Templates.
 *
 * Sizes: the active size list, plus Custom… — a width and height in inches
 * or millimeters, always sent in inches. A custom size is a size row
 * (POST /labels/vocab): "Save this size to the list" leaves it listed for
 * the next template, otherwise it is kept off the list for this template
 * alone. A listed size of the same dimensions is reused instead. When a
 * create fails and the size or the switch changes before the retry, the
 * dialog rewrites the row it made off the list (PATCH /labels/vocab, which
 * lets a designer change a pending size: off the list, on no template)
 * rather than leave it behind and post another.
 *
 * The report-generate header; the card sizes to its content.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { newDesign, serializeDesign } from '../../../labels/builder/model';
import {
  ApiError, createLabelTemplate, createLabelVocab, updateLabelVocab, type LabelTemplate, type LabelVocab,
} from '../../../lib/api';
import { sizeMeta, vocabOfKind } from '../../../lib/labels';
import '../../../styles/directory.css';
import '../../../styles/profile.css';   /* .pf-form, .btn-solid, .pf-error */
import '../../../styles/reports.css';
import '../../../styles/settings.css';  /* .switch */
import '../../../styles/labelBuilder.css';
import ComboBox from '../../ComboBox';
import { Switch } from '../../Switch';

export interface NewTemplateModalProps {
  /** Every vocab row (GET /labels/vocab): the types and sizes offered. */
  vocab: LabelVocab[];
  onCreated: (template: LabelTemplate) => void;
  onCancel: () => void;
}

type Unit = 'in' | 'mm';

const CUSTOM = '__custom__';
const MM_PER_IN = 25.4;

/** A dimension typed in `unit`, in inches to the thousandth; null unless
 *  it is a positive number. */
export function toInches(text: string, unit: Unit): number | null {
  const n = Number(text.trim());
  if (!text.trim() || !Number.isFinite(n) || n <= 0) return null;
  const inches = Math.round((unit === 'mm' ? n / MM_PER_IN : n) * 1000) / 1000;
  return inches > 0 ? inches : null;
}

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** A size row's key and label for `w` × `h` inches, as the seeded rows
 *  read (`4x2`, `4" x 2"`): dots become underscores, and a key another
 *  size already holds gets `-2`, `-3`… */
export function customSizeKey(w: number, h: number, taken: ReadonlySet<string>): string {
  const base = `${fmt(w)}x${fmt(h)}`.replace(/\./g, '_');
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function sameSize(row: LabelVocab, w: number, h: number): boolean {
  const m = sizeMeta(row);
  return Math.abs(m.width_in - w) < 0.0005 && Math.abs(m.height_in - h) < 0.0005 && !m.has_tab;
}

const ERRORS: Record<string, string> = {
  label_template_exists: 'A template, or one of its DPI versions, already has that name.',
  unknown_vocab: 'That type or size is no longer offered. Pick another.',
  label_vocab_exists: 'Someone added a size under the same name just now. Press Create template again.',
  forbidden: 'Only a super admin or a developer can create templates.',
};

export default function NewTemplateModal({ vocab, onCreated, onCancel }: NewTemplateModalProps) {
  const types = useMemo(() => vocabOfKind(vocab, 'type'), [vocab]);
  const sizes = useMemo(() => vocabOfKind(vocab, 'size'), [vocab]);
  const [name, setName] = useState('');
  const [type, setType] = useState(types[0]?.key ?? '');
  const [size, setSize] = useState(sizes[0]?.key ?? CUSTOM);
  const [unit, setUnit] = useState<Unit>('in');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [keepSize, setKeepSize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The custom size row this dialog last posted, so a retry after a failed
   *  create uses it instead of posting another: `made` once the API has it
   *  (or a repeat of the post found it there). */
  const ownSize = useRef<{ key: string; w: number; h: number; active: boolean; made: boolean } | null>(null);
  /** Keys this dialog posted or found taken: never offered again. */
  const usedKeys = useRef(new Set<string>());

  const custom = size === CUSTOM;
  const w = toInches(width, unit);
  const h = toInches(height, unit);
  const ready = !!name.trim() && !!type && (custom ? w !== null && h !== null : !!size);

  /** The size row to create the template on: a listed one, or for Custom…
   *  a listed row of those dimensions, else a new row. */
  const sizeKey = async (): Promise<{ key: string; w: number; h: number }> => {
    if (!custom) {
      const m = sizeMeta(sizes.find((s) => s.key === size)!);
      return { key: size, w: m.width_in, h: m.height_in };
    }
    const listed = sizes.find((s) => sameSize(s, w!, h!));
    if (listed) return { key: listed.key, w: w!, h: h! };
    const own = ownSize.current;
    const again = own !== null && own.w === w && own.h === h && own.active === keepSize;
    if (again && own.made) return { key: own.key, w: w!, h: h! };
    // the size or the switch changed since this dialog made its row off the list
    if (own !== null && own.made && !own.active) {
      try {
        await updateLabelVocab('size', own.key, {
          label: `${fmt(w!)}" x ${fmt(h!)}"`, is_active: keepSize,
          meta: { width_in: w, height_in: h, has_tab: false },
        });
        ownSize.current = { key: own.key, w: w!, h: h!, active: keepSize, made: true };
        return { key: own.key, w: w!, h: h! };
      } catch (err) {
        // no longer a pending row (a template took it, it was listed or
        // removed): post a new one; anything else, the next try rewrites again
        if (!(err instanceof ApiError) || (err.status !== 403 && err.status !== 404)) throw err;
        ownSize.current = null;
      }
    }
    // a repeat of a post whose answer was lost: a 409 now means it landed
    const repeat = again && !own.made;
    const taken = new Set([...vocab.filter((v) => v.kind === 'size').map((v) => v.key), ...usedKeys.current]);
    const key = repeat ? own.key : customSizeKey(w!, h!, taken);
    usedKeys.current.add(key);
    ownSize.current = { key, w: w!, h: h!, active: keepSize, made: false };
    try {
      await createLabelVocab({
        kind: 'size', key, label: `${fmt(w!)}" x ${fmt(h!)}"`, is_active: keepSize,
        meta: { width_in: w, height_in: h, has_tab: false },
      });
    } catch (err) {
      const landed = repeat && err instanceof ApiError && err.code === 'label_vocab_exists';
      if (!landed) {
        // another's row under that key: the next try takes a new one
        if (err instanceof ApiError && err.code === 'label_vocab_exists') ownSize.current = null;
        throw err;
      }
    }
    ownSize.current.made = true;
    return { key, w: w!, h: h! };
  };

  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const picked = await sizeKey();
      const created = await createLabelTemplate({
        name: name.trim(), label_type: type, size_key: picked.key, language_key: 'zpl',
        kind: 'design', design: serializeDesign(newDesign({ w: picked.w, h: picked.h })),
        samples: {}, is_active: false,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiError ? ERRORS[err.code] ?? `Couldn't create the template (${err.code}).`
        : "Couldn't create the template.");
      setBusy(false);
    }
  };

  const close = () => { if (!busy) onCancel(); };

  // Escape closes the dialog, unless an open list inside it took the key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal-card reports-modal-card rgm-card lbb-new-card" role="dialog" aria-modal="true"
        aria-label="New label template">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Label builder</div>
            <h3>New template</h3>
            <p className="page-hint">
              Designed in inches, with a 203, 300 and 600 DPI version made from it. It starts
              inactive: turn it on from Templates once it&apos;s ready.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={close} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="pf-form">
            <div className="full">
              <label htmlFor="lbb-new-name">Name</label>
              <input id="lbb-new-name" value={name} autoFocus autoComplete="off" disabled={busy}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
            </div>
            <div className="full">
              <label htmlFor="lbb-new-type">Label type</label>
              <ComboBox inputId="lbb-new-type" options={types.map((t) => ({ value: t.key, label: t.label }))}
                value={type} onChange={setType} disabled={busy} placeholder="Pick a type…" />
            </div>
            <div className="full">
              <label id="lbb-new-size-label">Size</label>
              <div className="segmented lbb-sizes" role="group" aria-labelledby="lbb-new-size-label">
                {sizes.map((s) => (
                  <button key={s.key} type="button" className={size === s.key ? 'on' : ''} aria-pressed={size === s.key}
                    disabled={busy} onClick={() => setSize(s.key)}>{s.label}</button>
                ))}
                <button type="button" className={custom ? 'on' : ''} aria-pressed={custom} disabled={busy}
                  onClick={() => setSize(CUSTOM)}>Custom…</button>
              </div>
            </div>
            {custom && (
              <>
                <div>
                  <label htmlFor="lbb-new-w">Width ({unit})</label>
                  <input id="lbb-new-w" inputMode="decimal" value={width} disabled={busy} autoComplete="off"
                    onChange={(e) => setWidth(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="lbb-new-h">Height ({unit})</label>
                  <input id="lbb-new-h" inputMode="decimal" value={height} disabled={busy} autoComplete="off"
                    onChange={(e) => setHeight(e.target.value)} />
                </div>
                <div className="full lbb-new-custom">
                  <div className="segmented" role="group" aria-label="Units">
                    {(['in', 'mm'] as const).map((u) => (
                      <button key={u} type="button" className={unit === u ? 'on' : ''} aria-pressed={unit === u}
                        disabled={busy} onClick={() => setUnit(u)}>{u === 'in' ? 'Inches' : 'Millimeters'}</button>
                    ))}
                  </div>
                  <span className="lbb-new-keep">
                    <Switch label="Save this size to the list" checked={keepSize} disabled={busy}
                      onChange={setKeepSize} />
                    <span>Save this size to the list</span>
                  </span>
                  {w !== null && h !== null && unit === 'mm' && (
                    <span className="page-hint lbb-new-inches">{fmt(w)}&quot; x {fmt(h)}&quot;</span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" disabled={!ready || busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create template'}
          </button>
          <button type="button" className="mini-btn" onClick={close} disabled={busy}>Cancel</button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </div>
      </div>
    </div>
  );
}

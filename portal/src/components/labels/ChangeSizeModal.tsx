/**
 * Change size… on the templates list: an inactive builder parent moves to a
 * larger label (PATCH /labels/templates/{id} with a new size_key). The
 * size only grows — at least as wide and at least as tall as now — so
 * every element keeps its place from the top-left corner and the new room
 * is on the right and bottom. Its DPI versions take the size too
 * (customized ones keep their hand edits).
 *
 * Sizes: the listed sizes that are at least the current one in both
 * directions, plus Custom… (customSize.ts: inches or millimeters, Save
 * this size to the list, a listed size of the same dimensions reused).
 *
 * The report-generate header (ListDialog); the card sizes to its content.
 */

import { useMemo, useState } from 'react';

import { ApiError, updateLabelTemplate, type LabelTemplate, type LabelVocab } from '../../lib/api';
import { sizeMeta, vocabLabel, vocabOfKind } from '../../lib/labels';
import { Switch } from '../Switch';
import { fmtInches, toInches, useCustomSizeRow, type Unit } from './builder/customSize';
import { ListDialog } from './TemplateRowDialogs';
import '../../styles/directory.css';
import '../../styles/profile.css';   /* .pf-form, .btn-solid, .pf-error */
import '../../styles/settings.css';  /* .switch */
import '../../styles/labelBuilder.css';
import '../../styles/labels.css';

const CUSTOM = '__custom__';
const SLACK = 0.0005;

/** The current size of a template, in inches: its size row, else its design. */
export function currentSize(template: Pick<LabelTemplate, 'size_key' | 'design'>, vocab: LabelVocab[]) {
  const row = vocab.find((v) => v.kind === 'size' && v.key === template.size_key);
  if (row) {
    const m = sizeMeta(row);
    return { w: m.width_in, h: m.height_in };
  }
  const size = (template.design as { size?: { w?: number; h?: number } } | null)?.size;
  return { w: size?.w ?? 0, h: size?.h ?? 0 };
}

/** Whether `w` × `h` is no smaller than `cur` in either direction. */
export function fitsGrow(cur: { w: number; h: number }, w: number, h: number): boolean {
  return w >= cur.w - SLACK && h >= cur.h - SLACK;
}

const ERRORS: Record<string, string> = {
  template_active: 'Deactivate the template first to change its size.',
  size_smaller: "A template's size can only grow. Pick a size at least as wide and as tall.",
  unknown_vocab: 'That size is no longer offered. Pick another.',
  label_vocab_exists: 'Someone added a size under the same name just now. Press Change size again.',
  forbidden: 'Only a super admin or a developer can change a template.',
};

export default function ChangeSizeModal({ template, vocab, onChanged, onClose }: {
  /** An inactive builder parent. */
  template: Pick<LabelTemplate, 'id' | 'name' | 'size_key' | 'design'>;
  /** Every vocab row (GET /labels/vocab). */
  vocab: LabelVocab[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const cur = useMemo(() => currentSize(template, vocab), [template, vocab]);
  const listed = useMemo(() => vocabOfKind(vocab, 'size'), [vocab]);
  const offered = useMemo(() => listed.filter((s) => {
    if (s.key === template.size_key) return false;
    const m = sizeMeta(s);
    return fitsGrow(cur, m.width_in, m.height_in);
  }), [listed, cur, template.size_key]);
  const customSizeRow = useCustomSizeRow(vocab, listed);

  const [size, setSize] = useState(offered[0]?.key ?? CUSTOM);
  const [unit, setUnit] = useState<Unit>('in');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [keepSize, setKeepSize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const custom = size === CUSTOM;
  const w = toInches(width, unit);
  const h = toInches(height, unit);
  const tooSmall = custom && w !== null && h !== null && !fitsGrow(cur, w, h);
  const same = custom && w !== null && h !== null
    && Math.abs(w - cur.w) < SLACK && Math.abs(h - cur.h) < SLACK;
  const ready = !busy && (custom ? w !== null && h !== null && !tooSmall && !same : !!size);

  const change = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const key = custom ? await customSizeRow(w!, h!, keepSize) : size;
      await updateLabelTemplate(template.id, { size_key: key });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? ERRORS[err.code] ?? `Couldn't change the size (${err.code}).`
        : "Couldn't change the size.");
      setBusy(false);
    }
  };

  const now = vocabLabel(vocab, 'size', template.size_key);
  return (
    <ListDialog label="Change size" eyebrow={`${template.name} · Change size`} title="Change size"
      card="lt-resize-card" busy={busy} onClose={onClose}
      hint={'A larger label for this template; its DPI versions take it too. Everything on it stays where it '
        + 'is, and the new room is on the right and bottom. A size can only grow, and only while the '
        + 'template is inactive.'}
      foot={(
        <>
          <button type="button" className="btn-solid" disabled={!ready} onClick={() => void change()}>
            {busy ? 'Changing…' : 'Change size'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </>
      )}>
      <div className="pf-form">
        <div className="full">
          <label id="lt-resize-size-label">New size</label>
          <p className="page-hint lt-resize-now">Now {now}</p>
          <div className="segmented lbb-sizes" role="group" aria-labelledby="lt-resize-size-label">
            {offered.map((s) => (
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
              <label htmlFor="lt-resize-w">Width ({unit})</label>
              <input id="lt-resize-w" inputMode="decimal" value={width} disabled={busy} autoComplete="off"
                autoFocus onChange={(e) => setWidth(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void change(); }} />
            </div>
            <div>
              <label htmlFor="lt-resize-h">Height ({unit})</label>
              <input id="lt-resize-h" inputMode="decimal" value={height} disabled={busy} autoComplete="off"
                onChange={(e) => setHeight(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void change(); }} />
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
                <span className="page-hint lbb-new-inches">{fmtInches(w)}&quot; x {fmtInches(h)}&quot;</span>
              )}
            </div>
            {tooSmall && (
              <p className="full pf-error" role="alert">
                At least {fmtInches(cur.w)}&quot; wide and {fmtInches(cur.h)}&quot; tall: a size can only grow.
              </p>
            )}
            {same && <p className="full page-hint">That&apos;s the size it is now.</p>}
          </>
        )}
      </div>
    </ListDialog>
  );
}

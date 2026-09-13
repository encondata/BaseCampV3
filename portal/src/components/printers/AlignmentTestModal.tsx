/**
 * Printers › Test label alignment — the same concentric-boxes test as
 * Print Labels' settings modal (`alignmentTestZpl`), with the offsets
 * editable here and saved to the shared `labels.print.settings` store so
 * Print Labels prints with them. DPI preselects from the printer's `~HI`.
 */
import { useEffect, useMemo, useState } from 'react';

import type { LabelVocab } from '../../lib/api';
import { dpiDots, sizeMeta, vocabOfKind } from '../../lib/labels';
import {
  alignmentTestZpl, applyPrintSettings, clampSetting, readPrintSettings, writePrintSettings,
} from '../../lib/printLabels';
import ComboBox from '../ComboBox';

const DEFAULT_SIZE = '4x2';

/** The inner-box insets V2's routine draws (outer box at 5, then every 25
 *  dots while both sides stay ≥ 50) — mirrored here for the preview. */
export function alignmentInsets(widthDots: number, heightDots: number): number[] {
  const insets = [5];
  for (let inset = 30; widthDots - 2 * inset >= 50 && heightDots - 2 * inset >= 50; inset += 25) insets.push(inset);
  return insets;
}

export default function AlignmentTestModal({ vocab, printerDpi, onPrint, onClose }: {
  vocab: LabelVocab[]; printerDpi: number | null; onPrint: (zpl: string) => Promise<void>; onClose: () => void;
}) {
  const sizes = useMemo(() => vocabOfKind(vocab, 'size'), [vocab]);
  const dpis = useMemo(() => vocabOfKind(vocab, 'dpi'), [vocab]);
  const [sizeKey, setSizeKey] = useState(DEFAULT_SIZE);
  const [dpiKey, setDpiKey] = useState(() =>
    (printerDpi && dpis.some((d) => d.key === String(printerDpi))) ? String(printerDpi) : (dpis.some((d) => d.key === '300') ? '300' : (dpis[0]?.key ?? '300')));
  const [stored] = useState(() => readPrintSettings());
  const [vText, setVText] = useState(String(stored.verticalOffset));
  const [hText, setHText] = useState(String(stored.horizontalOffset));
  const [saved, setSaved] = useState({ v: stored.verticalOffset, h: stored.horizontalOffset });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const size = sizes.find((s) => s.key === sizeKey) ?? sizes[0] ?? null;
  const dots = dpiDots(vocab, dpiKey);
  const vertical = clampSetting('verticalOffset', vText);
  const horizontal = clampSetting('horizontalOffset', hText);
  const dirty = vertical !== saved.v || horizontal !== saved.h;
  const dims = size ? { w: Math.round(sizeMeta(size).width_in * dots), h: Math.round(sizeMeta(size).height_in * dots) } : null;

  const print = async () => {
    if (!size || !dims) return;
    setNotice(null);
    setBusy(true);
    try {
      const zpl = applyPrintSettings(alignmentTestZpl(dims.w, dims.h, size.key, dots),
        { ...stored, verticalOffset: vertical, horizontalOffset: horizontal }, { singleCopy: true });
      await onPrint(zpl);
      setNotice({ type: 'success', message: `Alignment test label (${size.key}) sent to printer` });
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error && err.message ? err.message : 'Failed to print alignment test label' });
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    writePrintSettings({ ...readPrintSettings(), verticalOffset: vertical, horizontalOffset: horizontal });
    setSaved({ v: vertical, h: horizontal });
    setNotice({ type: 'success', message: 'Offsets saved — Print Labels will use them.' });
  };

  const field = (id: string, label: string, hint: string, value: string, set: (v: string) => void, commit: () => void) => (
    <div>
      <label htmlFor={id}>{label} (dots)</label>
      <input id={id} type="number" aria-label={label} aria-describedby={`${id}-hint`} value={value}
             onChange={(e) => set(e.target.value)} onBlur={commit}
             onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
      <p id={`${id}-hint`} className="page-hint field-hint">{hint}</p>
    </div>
  );

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card zp-align-card" role="dialog" aria-label="Test label alignment">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Printers</div>
            <h3>Test label alignment</h3>
            <p className="page-hint">Prints concentric boxes 25 dots apart so you can dial in the offsets. The same offsets are used by Print Labels.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="zp-two-col">
            <section className="zp-col" aria-label="Label and offsets">
              <div className="modal-section">Label</div>
              <ComboBox options={sizes.map((s) => ({ value: s.key, label: s.label }))} value={size?.key ?? ''} onChange={setSizeKey} placeholder="Label size…" />
              <div className="segmented" role="tablist" aria-label="Printer DPI">
                {dpis.map((d) => (
                  <button key={d.key} type="button" role="tab" aria-selected={dpiKey === d.key} className={dpiKey === d.key ? 'on' : ''} onClick={() => setDpiKey(d.key)}>{d.label}</button>
                ))}
              </div>
              <div className="modal-section">Offsets</div>
              <div className="pf-form zp-form">
                {field('at-vertical', 'Vertical offset', 'Offset in dots (+ moves down)', vText, setVText, () => setVText(String(vertical)))}
                {field('at-horizontal', 'Horizontal offset', 'Offset in dots (+ moves right)', hText, setHText, () => setHText(String(horizontal)))}
              </div>
            </section>
            <section className="zp-col" aria-label="Preview">
              <div className="modal-section">Preview</div>
              <div className="zp-preview">
                {dims && (
                  <svg viewBox={`0 0 ${dims.w} ${dims.h}`} role="img" aria-label={`${size?.label ?? ''} alignment boxes`}>
                    <rect x="0" y="0" width={dims.w} height={dims.h} fill="#fff" stroke="#c9ced6" strokeWidth={Math.max(1, dims.w / 400)} />
                    {alignmentInsets(dims.w, dims.h).map((i, idx) => (
                      <rect key={i} x={i} y={i} width={dims.w - 2 * i} height={dims.h - 2 * i} fill="none" stroke="#1a1d21" strokeWidth={idx === 0 ? 4 : 2} />
                    ))}
                  </svg>
                )}
              </div>
              <p className="page-hint">{dims ? `${dims.w} × ${dims.h} dots at ${dots} DPI` : 'Pick a label size.'}</p>
            </section>
          </div>
          {notice && <div className={`zp-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}><p className="page-hint">{notice.message}</p></div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" disabled={busy || !size} onClick={() => void print()}>{busy ? 'Sending…' : 'Print test label'}</button>
          <button type="button" className="mini-btn" disabled={!dirty} onClick={save}>Save offsets</button>
          <button type="button" className="mini-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

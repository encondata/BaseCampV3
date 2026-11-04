/**
 * Printers › Test labels. Two choices, as on the kiosk's Label Station:
 * - an alignment label — the same concentric-boxes test as Print Labels'
 *   settings modal (`alignmentTestZpl`), at the size you pick. DPI
 *   preselects from the printer's `~HI`;
 * - a mock-data label — a template you pick (one per family and label
 *   type, `mockTemplateOptions`), its row at the printer's DPI, filled with
 *   the portal's fixed sample values by the API (`POST /labels/test-render`).
 *   The DPI control shows only when `~HI` couldn't be read. The template
 *   list loads on the first switch to this choice (and again on the next
 *   switch if that load failed), and a rendered label is kept per template
 *   row, so a reprint only re-shifts it.
 *
 * The offsets are editable here for both, and saved to the shared
 * `labels.print.settings` store so Print Labels prints with them. Neither
 * label sets a print mode (`^MM`): it prints in the mode saved on the
 * printer, the way Print Labels does.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { mockTemplateOptions, noVersionText, versionAt } from '../../labels/testLabelTemplates';
import { ApiError, type LabelTemplateTreeNode, type LabelVocab } from '../../lib/api';
import { dpiDots, isPersonLabelType, sizeMeta, vocabOfKind } from '../../lib/labels';
import {
  alignmentTestZpl, applyPrintSettings, clampSetting, readPrintSettings, writePrintSettings,
  type PrintSettings,
} from '../../lib/printLabels';
import ComboBox from '../ComboBox';
import { ChoiceCard } from '../reports/ReportOptionsLayout';

const DEFAULT_SIZE = '4x2';

type Choice = 'alignment' | 'mock';
type Rendered = { zpl: string; template_name: string };
/** The template tree as the mock-data choice sees it: untouched until that
 *  choice is first made. */
type TreeLoad =
  | { state: 'idle' | 'loading' }
  | { state: 'failed'; code: string }
  | { state: 'ready'; tree: LabelTemplateTreeNode[] };

/** What went wrong, for a notice's parentheses: an `ApiError`'s code, else
 *  the message without its closing period (the sentence's own follows the
 *  parenthesis). */
const errorCode = (err: unknown): string =>
  err instanceof ApiError ? err.code : ((err instanceof Error && err.message) || 'unknown_error').replace(/\.$/, '');

/** The inner-box insets V2's routine draws (outer box at 5, then every 25
 *  dots while both sides stay ≥ 50) — mirrored here for the preview. */
export function alignmentInsets(widthDots: number, heightDots: number): number[] {
  const insets = [5];
  for (let inset = 30; widthDots - 2 * inset >= 50 && heightDots - 2 * inset >= 50; inset += 25) insets.push(inset);
  return insets;
}

/** The alignment label for `size` at `dots` DPI with `settings`' offsets
 *  applied, one copy: what Print test label sends, and the label builder's
 *  Printer dialog too. */
export function alignmentLabelZpl(size: LabelVocab, dots: number, settings: PrintSettings): string {
  const meta = sizeMeta(size);
  const w = Math.round(meta.width_in * dots);
  const h = Math.round(meta.height_in * dots);
  return applyPrintSettings(alignmentTestZpl(w, h, size.key, dots), settings, { singleCopy: true });
}

export default function AlignmentTestModal({ vocab, printerDpi, onPrint, loadTemplates, renderLabel, onClose }: {
  vocab: LabelVocab[]; printerDpi: number | null; onPrint: (zpl: string) => Promise<void>;
  loadTemplates: () => Promise<LabelTemplateTreeNode[]>;
  renderLabel: (templateId: string, dpiKey: string) => Promise<Rendered>;
  onClose: () => void;
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
  const [choice, setChoice] = useState<Choice>('alignment');
  const [load, setLoad] = useState<TreeLoad>({ state: 'idle' });
  const [pickKey, setPickKey] = useState('');
  // The rendered mock label, by template row id: a reprint only re-shifts it.
  // A failed render caches nothing.
  const rendered = useRef(new Map<string, Rendered>());
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

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

  // Mock-data label: the picked template's row at the printer's DPI, or at
  // the DPI picked here when `~HI` couldn't be read.
  const typeLabels = useMemo(
    () => Object.fromEntries(vocabOfKind(vocab, 'type', { activeOnly: false }).map((v) => [v.key, v.label])),
    [vocab]);
  const templates = useMemo(
    () => (load.state === 'ready' ? mockTemplateOptions(load.tree, typeLabels) : []),
    [load, typeLabels]);
  const template = templates.find((t) => t.key === pickKey) ?? null;
  const mockDpiKey = printerDpi ? String(printerDpi) : dpiKey;
  const mockRow = template ? versionAt(template, mockDpiKey) : null;
  const canPrint = choice === 'alignment' ? !!size : !!mockRow;

  const choose = (next: Choice) => {
    if (next === choice) return;
    setChoice(next);
    setNotice(null);
    if (next === 'mock' && (load.state === 'idle' || load.state === 'failed')) {
      setLoad({ state: 'loading' });
      loadTemplates()
        .then((tree) => { if (aliveRef.current) setLoad({ state: 'ready', tree }); })
        .catch((err: unknown) => { if (aliveRef.current) setLoad({ state: 'failed', code: errorCode(err) }); });
    }
  };

  const printAlignment = async () => {
    if (!size || !dims) return;
    setNotice(null);
    setBusy(true);
    try {
      await onPrint(alignmentLabelZpl(size, dots, { ...stored, verticalOffset: vertical, horizontalOffset: horizontal }));
      setNotice({ type: 'success', message: `Alignment test label (${size.key}) sent to printer` });
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error && err.message ? err.message : 'Failed to print alignment test label' });
    } finally {
      setBusy(false);
    }
  };

  const printMock = async () => {
    if (!mockRow) return;
    setNotice(null);
    setBusy(true);
    try {
      let label = rendered.current.get(mockRow.id);
      if (!label) {
        label = await renderLabel(mockRow.id, mockRow.dpi_key);
        rendered.current.set(mockRow.id, label);
      }
      await onPrint(applyPrintSettings(label.zpl, { ...stored, verticalOffset: vertical, horizontalOffset: horizontal }, { singleCopy: true }));
      setNotice({ type: 'success', message: `Mock-data label (${label.template_name}) sent to the printer.` });
    } catch (err) {
      setNotice({ type: 'error', message: `Couldn't print the test label (${errorCode(err)}).` });
    } finally {
      setBusy(false);
    }
  };

  const print = () => (choice === 'alignment' ? printAlignment() : printMock());

  /** The preview column's one line in mock mode. */
  const mockPreview = (): ReactNode => {
    if (load.state === 'loading') return <p className="page-hint" role="status">Loading templates…</p>;
    if (load.state === 'failed') return <p className="page-hint" role="alert">{`Couldn't load the templates (${load.code}).`}</p>;
    if (templates.length === 0) return <p className="page-hint">No active templates to print.</p>;
    if (!template) return <p className="page-hint">Pick a template to print.</p>;
    if (!mockRow) return <p className="page-hint">{noVersionText(template, mockDpiKey)}</p>;
    const badge = isPersonLabelType(template.labelType) ? ' Photos and logos print blank.' : '';
    return <p className="page-hint">{`Prints ${template.family} at ${mockDpiKey} DPI with sample values, filled in by the portal.${badge}`}</p>;
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
      <div className="modal-card reports-modal-card rgm-card zp-align-card" role="dialog" aria-label="Test labels">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Printers</div>
            <h3>Test labels</h3>
            <p className="page-hint">
              Print an alignment label or a label with sample data, then adjust the offsets and reprint
              until it lines up. The same offsets are used by Print Labels.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="zp-two-col">
            <section className="zp-col" aria-label="Label and offsets">
              <div className="modal-section">Label</div>
              <div className="rgm-choice-cards ts-choice-grid" role="radiogroup" aria-label="Test label">
                <ChoiceCard title="Alignment label" description="Concentric boxes filling the whole label."
                            selected={choice === 'alignment'} onSelect={() => choose('alignment')} />
                <ChoiceCard title="Mock-data label" description="A real template filled with sample values."
                            selected={choice === 'mock'} onSelect={() => choose('mock')} />
              </div>
              {choice === 'alignment' ? (
                <ComboBox options={sizes.map((s) => ({ value: s.key, label: s.label }))} value={size?.key ?? ''} onChange={setSizeKey} placeholder="Label size…" />
              ) : (
                <ComboBox options={templates.map((t) => ({ value: t.key, label: t.label }))} value={template?.key ?? ''} onChange={setPickKey}
                          placeholder="Template…" ariaLabel="Template" disabled={templates.length === 0} />
              )}
              {(choice === 'alignment' || !printerDpi) && (
                <div className="segmented" role="tablist" aria-label="Printer DPI">
                  {dpis.map((d) => (
                    <button key={d.key} type="button" role="tab" aria-selected={dpiKey === d.key} className={dpiKey === d.key ? 'on' : ''} onClick={() => setDpiKey(d.key)}>{d.label}</button>
                  ))}
                </div>
              )}
              <div className="modal-section">Offsets</div>
              <div className="pf-form zp-form">
                {field('at-vertical', 'Vertical offset', 'Offset in dots (+ moves down)', vText, setVText, () => setVText(String(vertical)))}
                {field('at-horizontal', 'Horizontal offset', 'Offset in dots (+ moves right)', hText, setHText, () => setHText(String(horizontal)))}
              </div>
            </section>
            <section className="zp-col" aria-label="Preview">
              <div className="modal-section">Preview</div>
              {choice === 'alignment' ? (
                <>
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
                </>
              ) : mockPreview()}
            </section>
          </div>
          {notice && <div className={`zp-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}><p className="page-hint">{notice.message}</p></div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" disabled={busy || !canPrint} onClick={() => void print()}>{busy ? 'Sending…' : 'Print test label'}</button>
          <button type="button" className="mini-btn" disabled={!dirty} onClick={save}>Save offsets</button>
          <button type="button" className="mini-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

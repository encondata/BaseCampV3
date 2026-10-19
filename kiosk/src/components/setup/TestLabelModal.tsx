/**
 * Label Station setup's test labels (step 5). Two choices:
 * - an alignment label: Printer tools' concentric boxes
 *   (`alignmentTestZpl`, previewed with `alignmentInsets`) at 4x2 or 2x1
 *   (4x2 for a Top station, 2x1 for Front) at the printer's DPI;
 * - a mock-data label: "Generic Rack and RU" for Top, the Front template
 *   for Front, at the printer's DPI, filled with sample values by the
 *   portal's own renderer (`POST /kiosk/labels/test-render`). The kiosk
 *   never fills placeholders itself. A template only at another DPI is
 *   skipped with a note.
 *
 * Every print goes through `applyPrintSettings` with the station's
 * offsets (the same `^LS`/`^LT` shift Printer tools uses), then
 * `withPrintMode`: `^MMP` (peel off) when step 5 found a peeler, else
 * `^MMT`, on that label only. After a print,
 * the horizontal and vertical offsets (dots, may be negative) show with
 * Reprint; offsets carried over from the station's saved settings show from
 * the start. The parent keeps them and saves them with the station.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  alignmentTestZpl, applyPrintSettings, clampSetting, DEFAULT_PRINT_SETTINGS,
} from '@portal/lib/printLabels';

import { ApiError, postTestRender, type KioskLabelTemplate, type LabelKind } from '../../lib/api';
import { mockTemplateFor, withPrintMode, type StationPrinter } from '../../lib/stationPrinter';
import { ChoiceCard } from '../printers/ChoiceCard';
import { alignmentInsets } from '../printers/AlignmentTestModal';

export interface Offsets { x: number; y: number }

type Choice = 'alignment' | 'mock';
type SizeKey = '4x2' | '2x1';

const SIZES: Record<SizeKey, { w: number; h: number }> = { '4x2': { w: 4, h: 2 }, '2x1': { w: 2, h: 1 } };

interface Props {
  printer: StationPrinter;
  dpi: number;
  labelKind: LabelKind;
  templates: KioskLabelTemplate[];
  initiativeId: string;
  offsets: Offsets;
  /** Print peel-off (`^MMP`): step 5 found a peeler. Otherwise tear-off. */
  peel: boolean;
  onOffsets: (offsets: Offsets) => void;
  onClose: () => void;
}

export default function TestLabelModal({
  printer, dpi, labelKind, templates, initiativeId, offsets, peel, onOffsets, onClose,
}: Props) {
  const [choice, setChoice] = useState<Choice>('alignment');
  const [sizeKey, setSizeKey] = useState<SizeKey>(labelKind === 'front' ? '2x1' : '4x2');
  const [hText, setHText] = useState(String(offsets.x));
  const [vText, setVText] = useState(String(offsets.y));
  const [printed, setPrinted] = useState(false);
  // Carried-over (non-zero) offsets show before the first print too.
  const [carried] = useState(offsets.x !== 0 || offsets.y !== 0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  // The rendered mock label, by template id: a reprint only re-shifts it.
  const rendered = useRef(new Map<string, string>());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const mock = useMemo(() => mockTemplateFor(templates, labelKind, dpi), [templates, labelKind, dpi]);
  const size = SIZES[sizeKey];
  const dims = { w: Math.round(size.w * dpi), h: Math.round(size.h * dpi) };
  const x = clampSetting('horizontalOffset', hText);
  const y = clampSetting('verticalOffset', vText);
  const canPrint = choice === 'alignment' || mock.template !== null;

  const setOffset = (axis: 'x' | 'y', text: string) => {
    if (axis === 'x') setHText(text); else setVText(text);
    onOffsets({
      x: axis === 'x' ? clampSetting('horizontalOffset', text) : x,
      y: axis === 'y' ? clampSetting('verticalOffset', text) : y,
    });
  };

  const labelZpl = async (): Promise<string> => {
    if (choice === 'alignment') return alignmentTestZpl(dims.w, dims.h, sizeKey, dpi);
    const template = mock.template!;
    const cached = rendered.current.get(template.id);
    if (cached !== undefined) return cached;
    const { zpl } = await postTestRender({
      initiative_id: initiativeId, template_id: template.id, dpi_key: String(dpi),
    });
    rendered.current.set(template.id, zpl);
    return zpl;
  };

  const print = async () => {
    if (!canPrint) return;
    setBusy(true);
    setNotice(null);
    try {
      const zpl = withPrintMode(applyPrintSettings(await labelZpl(),
        { ...DEFAULT_PRINT_SETTINGS, horizontalOffset: x, verticalOffset: y }, { singleCopy: true }), peel);
      await printer.send(zpl);
      setPrinted(true);
      setNotice({
        type: 'success',
        message: choice === 'alignment'
          ? `Alignment label (${sizeKey}) sent to the printer.`
          : `Mock-data label (${mock.template!.name}) sent to the printer.`,
      });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : (err instanceof Error && err.message) || 'unknown_error';
      setNotice({ type: 'error', message: `Couldn't print the test label (${code}).` });
    } finally {
      setBusy(false);
    }
  };

  // The offsets shift what is printed, not the label stock; dots per mm
  // at this printer's DPI makes the numbers meaningful (203 → 8, 300 → 12).
  const perMm = `${Math.round(dpi / 25.4)} dots ≈ 1 mm at ${dpi} DPI.`;

  const offsetField = (id: string, label: string, hint: string, value: string, axis: 'x' | 'y') => (
    <div>
      <label htmlFor={id}>{label} (dots)</label>
      <input id={id} type="number" aria-label={label} aria-describedby={`${id}-hint`} value={value}
             onChange={(e) => setOffset(axis, e.target.value)}
             onBlur={() => (axis === 'x' ? setHText(String(x)) : setVText(String(y)))} />
      <p id={`${id}-hint`} className="page-hint field-hint">{hint}</p>
    </div>
  );

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card zp-align-card" role="dialog" aria-label="Test labels">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Label Station</div>
            <h3>Test labels</h3>
            <p className="page-hint">
              Print an alignment label or a label with sample data, then adjust the offsets and reprint
              until it lines up. The offsets are saved with the station.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="zp-two-col">
            <section className="zp-col" aria-label="Test label">
              <div className="modal-section">Label</div>
              <div className="rgm-choice-cards ts-choice-grid" role="radiogroup" aria-label="Test label">
                <ChoiceCard title="Alignment label" description="Concentric boxes filling the whole label."
                            selected={choice === 'alignment'} onSelect={() => setChoice('alignment')} />
                <ChoiceCard title="Mock-data label" description="A real template filled with sample values."
                            selected={choice === 'mock'} onSelect={() => setChoice('mock')} />
              </div>
              {choice === 'alignment' && (
                <div className="segmented" role="tablist" aria-label="Label size">
                  {(Object.keys(SIZES) as SizeKey[]).map((k) => (
                    <button key={k} type="button" role="tab" aria-selected={sizeKey === k}
                            className={sizeKey === k ? 'on' : ''} onClick={() => setSizeKey(k)}>{k}</button>
                  ))}
                </div>
              )}
              {(printed || carried) && (
                <>
                  <div className="modal-section">Offsets</div>
                  <div className="pf-form zp-form">
                    {offsetField('tl-horizontal', 'Horizontal offset', `+ moves the printing right on the label, − moves it left. ${perMm}`, hText, 'x')}
                    {offsetField('tl-vertical', 'Vertical offset', `+ moves the printing down on the label, − moves it up. ${perMm}`, vText, 'y')}
                  </div>
                </>
              )}
            </section>
            <section className="zp-col" aria-label="Preview">
              <div className="modal-section">Preview</div>
              {choice === 'alignment' ? (
                <>
                  <div className="zp-preview">
                    <svg viewBox={`0 0 ${dims.w} ${dims.h}`} role="img" aria-label={`${sizeKey} alignment boxes`}>
                      <rect x="0" y="0" width={dims.w} height={dims.h} fill="#fff" stroke="#c9ced6" strokeWidth={Math.max(1, dims.w / 400)} />
                      {alignmentInsets(dims.w, dims.h).map((i, idx) => (
                        <rect key={i} x={i} y={i} width={dims.w - 2 * i} height={dims.h - 2 * i} fill="none" stroke="#1a1d21" strokeWidth={idx === 0 ? 4 : 2} />
                      ))}
                    </svg>
                  </div>
                  <p className="page-hint">{dims.w} × {dims.h} dots at {dpi} DPI</p>
                </>
              ) : mock.template ? (
                <p className="page-hint">
                  Prints {mock.template.name} at {dpi} DPI with sample values, filled in by the portal.
                </p>
              ) : (
                <p className="page-hint">{mock.note}</p>
              )}
            </section>
          </div>
          {notice && (
            <div className={`zp-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
              <p className="page-hint">{notice.message}</p>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" disabled={busy || !canPrint} onClick={() => void print()}>
            {busy ? 'Sending…' : printed ? 'Reprint' : 'Print test label'}
          </button>
          <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

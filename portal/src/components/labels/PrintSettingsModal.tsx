/**
 * Print Labels › Print settings — V2's settings dialog (offsets, copies,
 * batch size, Print by rack + blanks, alignment test) in the roomy
 * report-modal shape, sized to its two columns. Changes apply
 * immediately through `onChange` (the page persists them); numeric
 * fields keep free text while editing and clamp on blur, like
 * BulkContainersModal's Count field. The alignment test takes any
 * active size at 203 or 300 DPI (V2's fixed 1×2 / 2×4 buttons were
 * 2"×1" and 4"×2" at 300).
 */
import { useEffect, useMemo, useState } from 'react';

import type { LabelVocab } from '../../lib/api';
import { dpiDots, sizeMeta, vocabOfKind } from '../../lib/labels';
import {
  DEFAULT_PRINT_SETTINGS, alignmentTestZpl, clampSetting, settingsModified,
  type NumericSetting, type PrintSettings,
} from '../../lib/printLabels';
import ComboBox from '../ComboBox';
import { Switch } from '../Switch';

const DEFAULT_SIZE = '4x2';
const DEFAULT_DPI = '300';

interface Props {
  settings: PrintSettings;
  onChange: (next: PrintSettings) => void;
  vocab: LabelVocab[];
  printerConnected: boolean;
  onPrintAlignmentTest: (zpl: string, sizeLabel: string) => Promise<void>;
  onClose: () => void;
}

const NUMERIC_FIELDS: { key: NumericSetting; label: string; hint: string; suffix?: string }[] = [
  { key: 'verticalOffset', label: 'Vertical offset', hint: 'Offset in dots (+ moves down)', suffix: 'dots' },
  { key: 'horizontalOffset', label: 'Horizontal offset', hint: 'Offset in dots (+ moves right)', suffix: 'dots' },
  { key: 'copies', label: 'Copies', hint: 'Number of copies per label' },
  { key: 'batchSize', label: 'Batch size', hint: 'Labels per batch before pausing' },
];

export default function PrintSettingsModal({
  settings, onChange, vocab, printerConnected, onPrintAlignmentTest, onClose,
}: Props) {
  // Free text per numeric field so a value can be emptied/retyped; the
  // clamped number lands in `settings` on blur.
  const [text, setText] = useState<Record<NumericSetting, string>>({
    verticalOffset: String(settings.verticalOffset),
    horizontalOffset: String(settings.horizontalOffset),
    copies: String(settings.copies),
    batchSize: String(settings.batchSize),
    blanksBetweenRacks: String(settings.blanksBetweenRacks),
  });
  const [sizeKey, setSizeKey] = useState(DEFAULT_SIZE);
  const [dpiKey, setDpiKey] = useState(DEFAULT_DPI);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sizes = useMemo(() => vocabOfKind(vocab, 'size'), [vocab]);
  const dpis = useMemo(() => vocabOfKind(vocab, 'dpi'), [vocab]);
  const sizeOptions = sizes.map((s) => ({ value: s.key, label: s.label }));
  const effectiveSize = sizes.find((s) => s.key === sizeKey) ?? sizes[0] ?? null;
  const effectiveDpi = dpis.some((d) => d.key === dpiKey) ? dpiKey : (dpis[0]?.key ?? DEFAULT_DPI);

  const commit = (key: NumericSetting) => {
    const value = clampSetting(key, text[key]);
    setText((t) => ({ ...t, [key]: String(value) }));
    if (value !== settings[key]) onChange({ ...settings, [key]: value });
  };

  const reset = () => {
    setText({
      verticalOffset: '0', horizontalOffset: '0', copies: '1',
      batchSize: String(DEFAULT_PRINT_SETTINGS.batchSize),
      blanksBetweenRacks: String(DEFAULT_PRINT_SETTINGS.blanksBetweenRacks),
    });
    onChange({ ...DEFAULT_PRINT_SETTINGS });
  };

  const printTest = async () => {
    if (!effectiveSize) return;
    const dots = dpiDots(vocab, effectiveDpi);
    const { width_in, height_in } = sizeMeta(effectiveSize);
    const zpl = alignmentTestZpl(Math.round(width_in * dots), Math.round(height_in * dots), effectiveSize.key, dots);
    setTesting(true);
    try {
      await onPrintAlignmentTest(zpl, effectiveSize.key);
    } finally {
      setTesting(false);
    }
  };

  const numberField = (f: { key: NumericSetting; label: string; hint: string; suffix?: string }, disabled = false) => (
    <div key={f.key}>
      <label htmlFor={`ps-${f.key}`}>{f.label}{f.suffix ? ` (${f.suffix})` : ''}</label>
      <input id={`ps-${f.key}`} type="number" aria-label={f.label} disabled={disabled}
             value={text[f.key]} onChange={(e) => setText((t) => ({ ...t, [f.key]: e.target.value }))}
             onBlur={() => commit(f.key)}
             onKeyDown={(e) => { if (e.key === 'Enter') commit(f.key); }} />
      <p className="page-hint field-hint">{f.hint}</p>
    </div>
  );

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card plabels-settings-card" role="dialog" aria-label="Print settings">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Print Labels</div>
            <h3>Print settings</h3>
            <p className="page-hint">
              Offsets and copies apply to every label sent from this page. Settings are kept on this computer.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="plabels-settings-grid">
            <section className="plabels-settings-col" aria-label="Placement and copies">
              <div className="modal-section">Placement &amp; copies</div>
              <div className="pf-form plabels-settings-form">
                {NUMERIC_FIELDS.map((f) => numberField(f))}
              </div>
            </section>
            <section className="plabels-settings-col" aria-label="Rack order and alignment">
              <div className="modal-section">Rack order</div>
              <label className="mini-row report-section-row" aria-label="Print by rack">
                <Switch checked={settings.printByRack}
                        onChange={(v) => onChange({ ...settings, printByRack: v })} />
                <span className="report-section-text">
                  <span className="cell-top">Print by rack</span>
                  <span className="cell-sub">
                    Prints in rack order (RU top-down within each rack) and feeds blank labels between racks.
                  </span>
                </span>
              </label>
              <div className="pf-form plabels-settings-form">
                {numberField({ key: 'blanksBetweenRacks', label: 'Blanks between racks', hint: 'Blank labels fed when the rack changes' }, !settings.printByRack)}
              </div>
              <div className="modal-section">Alignment test</div>
              <div className="plabels-align">
                <p className="page-hint">
                  Prints concentric boxes 25 dots apart so you can dial in the offsets above.
                  Current offsets apply; copies are ignored.
                </p>
                <div className="plabels-align-controls">
                  <ComboBox options={sizeOptions} value={effectiveSize?.key ?? ''} onChange={setSizeKey}
                            placeholder="Label size…" />
                  <div className="segmented" role="tablist" aria-label="Printer DPI">
                    {dpis.map((d) => (
                      <button key={d.key} type="button" role="tab" aria-selected={effectiveDpi === d.key}
                              className={effectiveDpi === d.key ? 'on' : ''} onClick={() => setDpiKey(d.key)}>
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="plabels-align-actions">
                  <button type="button" className="mini-btn" disabled={!printerConnected || testing || !effectiveSize}
                          onClick={() => void printTest()}>
                    {testing ? 'Sending…' : 'Print test label'}
                  </button>
                  {!printerConnected && <span className="cell-sub">Connect a printer first</span>}
                </div>
              </div>
            </section>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="mini-btn" onClick={reset} disabled={!settingsModified(settings)}>Reset</button>
          <button type="button" className="btn-solid" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Bulk Print › Print settings — the portal's settings window trimmed to
 * what the kiosk page owns: copies, batch size, Print by rack and blanks.
 * Offsets (and the alignment test) belong to Printer Setup. Numeric fields
 * keep free text while editing and clamp on blur or Enter.
 */
import { useEffect, useState } from 'react';

import { clampSetting, type NumericSetting, type PrintSettings } from '@portal/lib/printLabels';

import { bulkSettingsModified, resetBulkSettings } from '../../lib/bulkPrintSettings';
import { Switch } from '../Switch';

interface Props {
  settings: PrintSettings;
  onChange: (next: PrintSettings) => void;
  onClose: () => void;
}

type BulkKey = Extract<NumericSetting, 'copies' | 'batchSize' | 'blanksBetweenRacks'>;

const textFrom = (s: PrintSettings): Record<BulkKey, string> => ({
  copies: String(s.copies),
  batchSize: String(s.batchSize),
  blanksBetweenRacks: String(s.blanksBetweenRacks),
});

export default function BulkPrintSettingsModal({ settings, onChange, onClose }: Props) {
  const [text, setText] = useState<Record<BulkKey, string>>(textFrom(settings));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const commit = (key: BulkKey) => {
    const value = clampSetting(key, text[key]);
    setText((t) => ({ ...t, [key]: String(value) }));
    if (value !== settings[key]) onChange({ ...settings, [key]: value });
  };

  const reset = () => {
    const next = resetBulkSettings(settings);
    setText(textFrom(next));
    onChange(next);
  };

  const numberField = (key: BulkKey, label: string, hint: string, disabled = false) => (
    <div key={key}>
      <label htmlFor={`ps-${key}`}>{label}</label>
      <input id={`ps-${key}`} type="number" aria-label={label} disabled={disabled}
             aria-describedby={`ps-${key}-hint`}
             value={text[key]} onChange={(e) => setText((t) => ({ ...t, [key]: e.target.value }))}
             onBlur={() => commit(key)}
             onKeyDown={(e) => { if (e.key === 'Enter') commit(key); }} />
      <p id={`ps-${key}-hint`} className="page-hint field-hint">{hint}</p>
    </div>
  );

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card plabels-settings-card" role="dialog" aria-label="Print settings">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Bulk Print</div>
            <h3>Print settings</h3>
            <p className="page-hint">
              Copies apply to every label sent from this page. Settings are kept on this kiosk. Offsets come from Printer Setup.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="plabels-settings-grid">
            <section className="plabels-settings-col" aria-label="Copy settings">
              <div className="modal-section">Copies</div>
              <div className="pf-form plabels-settings-form">
                {numberField('copies', 'Copies', 'Number of copies per label')}
                {numberField('batchSize', 'Batch size', 'Labels per batch before pausing')}
              </div>
            </section>
            <section className="plabels-settings-col" aria-label="Rack order">
              <div className="modal-section">Rack order</div>
              <label className="mini-row report-section-row">
                <Switch on={settings.printByRack} aria-label="Print by rack"
                        onChange={(v) => onChange({ ...settings, printByRack: v })} />
                <span className="report-section-text">
                  <span className="cell-top">Print by rack</span>
                  <span className="cell-sub">
                    Prints in rack order (RU top-down within each rack) and feeds blank labels between racks.
                    Front labels also get them before the first rack, printed with the source rack name.
                  </span>
                </span>
              </label>
              <div className="pf-form plabels-settings-form">
                {numberField('blanksBetweenRacks', 'Blanks between racks', 'Labels fed at each rack change', !settings.printByRack)}
              </div>
            </section>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="mini-btn" onClick={reset} disabled={!bulkSettingsModified(settings)}>Reset</button>
          <button type="button" className="btn-solid" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

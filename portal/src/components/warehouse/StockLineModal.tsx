/**
 * StockLineModal — the only place a stock line is created or edited.
 * `line === null` opens in create mode. The site is fixed to the
 * currently selected warehouse (shown read-only in the header) — the
 * page never lets a stock line move sites from here (StockMoveModal only
 * changes the container within the same site).
 */

import { useMemo, useState, type FormEvent } from 'react';

import {
  ApiError, createStockLine, listAssetModels, updateStockLine,
  type AssetModelItem, type StockLine, type WarehouseContainer,
} from '../../lib/api';
import {
  formFromStockLine, modelLabel, stockPayload, STOCK_ERRORS, UNIT_SUGGESTIONS,
  type StockFormState,
} from '../../lib/warehouse';
import ComboBox from '../ComboBox';

interface Props {
  siteId: string;
  siteName: string;
  containers: WarehouseContainer[];
  line: StockLine | null;   // null = create mode
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

const OTHER_UNIT = '__other__';

function mapError(err: unknown): string {
  if (err instanceof ApiError) return STOCK_ERRORS[err.code] ?? err.message;
  return 'Network error.';
}

export default function StockLineModal({ siteId, siteName, containers, line, onClose, onSaved }: Props) {
  const isCreateMode = line === null;
  const [form, setForm] = useState<StockFormState>(() => formFromStockLine(line));
  const [unitMode, setUnitMode] = useState<'combo' | 'other'>(
    () => (UNIT_SUGGESTIONS.includes(form.unit) ? 'combo' : 'other'),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [models, setModels] = useState<AssetModelItem[] | null>(null);

  const loadModels = () => {
    if (models !== null) return;
    void listAssetModels().then(setModels).catch(() => {});
  };

  const setField = <K extends keyof StockFormState>(key: K, value: StockFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const unitOptions = useMemo(() => [
    ...UNIT_SUGGESTIONS.map((u) => ({ value: u, label: u })),
    { value: OTHER_UNIT, label: 'Other…' },
  ], []);

  const onUnitChange = (v: string) => {
    if (v === OTHER_UNIT) {
      setUnitMode('other');
      setField('unit', '');
    } else {
      setUnitMode('combo');
      setField('unit', v);
    }
  };

  const modelOptions = useMemo(() => (models ?? []).map((m) => ({
    value: m.id, label: modelLabel(m), sub: m.category_label,
  })), [models]);

  const onModelChange = (v: string) => {
    setField('model_id', v);
    if (!v) return;
    const chosen = (models ?? []).find((m) => m.id === v);
    if (chosen && !form.description.trim()) {
      setField('description', modelLabel(chosen));
    }
  };

  const containerOptions = useMemo(() => [
    { value: '', label: 'Loose at site' },
    ...containers.map((c) => ({ value: c.id, label: c.name })),
  ], [containers]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.description.trim()) {
      setError(STOCK_ERRORS.description_required);
      return;
    }
    const qty = Number(form.quantity);
    if (Number.isNaN(qty) || qty < 0) {
      setError('Enter a quantity of 0 or more.');
      return;
    }
    setSaving(true);
    try {
      const payload = stockPayload(form, siteId);
      if (line) {
        await updateStockLine(line.id, payload);
      } else {
        await createStockLine(payload);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err));
    } finally {
      setSaving(false);
    }
  };

  const title = line ? `Edit — ${line.description}` : `Add stock · ${siteName}`;

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card wh-modal">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)} noValidate>
          <div className="modal-body">
            <div className="pf-form">
              <div style={{ gridColumn: '1 / -1' }}>
                <label>Description</label>
                <input value={form.description} disabled={saving} required
                       onChange={(e) => setField('description', e.target.value)} />
              </div>
              <div><label>Quantity</label>
                <input type="number" min={0} step={1} value={form.quantity} disabled={saving}
                       onChange={(e) => setField('quantity', e.target.value)} /></div>
              <div><label>Unit</label>
                {unitMode === 'other' ? (
                  <input value={form.unit} disabled={saving} placeholder="e.g. spool"
                         onChange={(e) => setField('unit', e.target.value)} />
                ) : (
                  <ComboBox
                    placeholder="Select unit…"
                    value={form.unit}
                    disabled={saving}
                    onChange={onUnitChange}
                    options={unitOptions}
                  />
                )}
                {unitMode === 'other' && (
                  <button type="button" className="mini-btn" disabled={saving}
                          onClick={() => { setUnitMode('combo'); setField('unit', 'each'); }}>
                    Choose from list
                  </button>
                )}
              </div>
              <div><label>Model</label>
                <ComboBox
                  placeholder="Type to search models…"
                  value={form.model_id}
                  clearable
                  disabled={saving}
                  onOpen={loadModels}
                  onChange={onModelChange}
                  options={modelOptions}
                /></div>
              <div><label>Container</label>
                <ComboBox
                  placeholder="Type to search containers…"
                  value={form.container_id}
                  disabled={saving}
                  onChange={(v) => setField('container_id', v)}
                  options={containerOptions}
                /></div>
              <div><label>Location detail</label>
                <input value={form.location_detail} disabled={saving}
                       onChange={(e) => setField('location_detail', e.target.value)} /></div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label>Notes</label>
                <input value={form.notes} disabled={saving}
                       onChange={(e) => setField('notes', e.target.value)} /></div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : (isCreateMode ? 'Add stock' : 'Save')}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}

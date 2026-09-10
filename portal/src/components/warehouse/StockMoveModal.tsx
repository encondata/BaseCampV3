/**
 * StockMoveModal — a small, single-field modal for relocating a stock
 * line within its own warehouse: "Loose at site" or one of the site's
 * containers. Site itself never changes here (StockLineModal owns full
 * edits, including any cross-site correction).
 */

import { useMemo, useState, type FormEvent } from 'react';

import {
  ApiError, updateStockLine, type StockLine, type WarehouseContainer,
} from '../../lib/api';
import { STOCK_ERRORS } from '../../lib/warehouse';
import ComboBox from '../ComboBox';

interface Props {
  line: StockLine;
  containers: WarehouseContainer[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

function mapError(err: unknown): string {
  if (err instanceof ApiError) return STOCK_ERRORS[err.code] ?? err.message;
  return 'Network error.';
}

export default function StockMoveModal({ line, containers, onClose, onSaved }: Props) {
  const [containerId, setContainerId] = useState(line.container_id ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const containerOptions = useMemo(() => [
    { value: '', label: 'Loose at site' },
    ...containers.map((c) => ({ value: c.id, label: c.name })),
  ], [containers]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await updateStockLine(line.id, { container_id: containerId.trim() || null });
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card wh-modal">
        <div className="modal-head">
          <h3>Move — {line.description}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)} noValidate>
          <div className="modal-body">
            <div className="pf-form">
              <div style={{ gridColumn: '1 / -1' }}>
                <label>Container</label>
                <ComboBox
                  placeholder="Type to search containers…"
                  value={containerId}
                  disabled={saving}
                  onChange={setContainerId}
                  options={containerOptions}
                /></div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Move'}
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

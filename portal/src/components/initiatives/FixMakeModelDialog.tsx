/**
 * FixMakeModelDialog — the review-row fix surface opened from the import
 * report (per-row "Fix…" and the missing-make-models card): "Create model"
 * hands off to ModelEditModal — the only place a catalog record is ever
 * mutated — prefilled via its `initial` prop with the suggested make/model
 * split, then appends the original CSV string as an alias on the record it
 * just created (only when that string doesn't already read like the saved
 * "make model", case-insensitively — the field split otherwise duplicates
 * the real name as a no-op alias). "Map to existing" picks a model via
 * ComboBox and does the same alias append.
 *
 * Alias writes here are read-modify-write, same rule as ModelEditModal:
 * there's no append-one endpoint, so every write takes the target's
 * current aliases, dedupes the new one in case-insensitively, and PUTs
 * the whole list.
 */

import { useEffect, useState } from 'react';

import {
  ApiError, listAssetCategories, listAssetModels, setAssetModelAliases,
  type AssetCategoryOut, type AssetModelItem,
} from '../../lib/api';
import { MODEL_ERRORS } from '../../lib/assets';
import ModelEditModal from '../assets/ModelEditModal';
import ComboBox from '../ComboBox';

interface Props {
  text: string;
  make: string;
  model: string;
  onClose: () => void;
  onFixed: (text: string) => void;
}

type Mode = 'choose' | 'create' | 'map';

function mapError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (MODEL_ERRORS[err.code] ?? fallback) : 'Network error.';
}

/** Case-insensitive dedupe append — the shared alias-write rule. */
function withAlias(current: string[], text: string): string[] {
  return current.some((a) => a.toLowerCase() === text.toLowerCase())
    ? current
    : [...current, text];
}

export default function FixMakeModelDialog({ text, make, model, onClose, onFixed }: Props) {
  const [mode, setMode] = useState<Mode>('choose');
  const [categories, setCategories] = useState<AssetCategoryOut[]>([]);
  const [models, setModels] = useState<AssetModelItem[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Categories are needed either way ModelEditModal might end up rendering,
  // so fetch them up front rather than only once "Create model" is picked.
  useEffect(() => {
    void listAssetCategories().then(setCategories).catch(() => {});
  }, []);

  useEffect(() => {
    if (mode !== 'map') return;
    void listAssetModels().then(setModels)
      .catch(() => setError('Could not load the catalog — try again.'));
  }, [mode]);

  if (mode === 'create') {
    return (
      <ModelEditModal
        model={null}
        categories={categories}
        canChange
        initial={{ make, model }}
        onClose={onClose}
        onSaved={async (saved) => {
          if (saved && text.toLowerCase() !== `${saved.make} ${saved.model}`.toLowerCase()) {
            try {
              await setAssetModelAliases(saved.id, withAlias(saved.aliases ?? [], text));
            } catch {
              // Best effort: the model itself already saved successfully —
              // the alias can be added later from the catalog if this fails.
            }
          }
          onFixed(text);
        }}
      />
    );
  }

  const confirmMap = async () => {
    const target = models.find((m) => m.id === selectedId);
    if (!target) return;
    setSaving(true);
    setError('');
    try {
      await setAssetModelAliases(target.id, withAlias(target.aliases ?? [], text));
      onFixed(text);
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>Fix make/model</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <p className="page-hint">
            <span className="mono">{text}</span> didn&apos;t match anything in the catalog.
          </p>

          {mode === 'choose' && (
            <div className="imp-fix-choices">
              <button className="btn-solid" type="button" onClick={() => setMode('create')}>
                Create model
              </button>
              <button className="mini-btn" type="button" onClick={() => setMode('map')}>
                Map to existing
              </button>
            </div>
          )}

          {mode === 'map' && (
            <>
              <ComboBox
                placeholder="Type to search models…"
                value={selectedId}
                onChange={setSelectedId}
                disabled={saving}
                options={models.map((m) => ({ value: m.id, label: `${m.make} ${m.model}` }))}
              />
              {error && <span className="pf-error">{error}</span>}
            </>
          )}
        </div>
        {mode === 'map' && (
          <div className="modal-foot">
            <button className="btn-solid" type="button" disabled={!selectedId || saving}
                    onClick={() => void confirmMap()}>
              {saving ? 'Saving…' : 'Add alias & map'}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

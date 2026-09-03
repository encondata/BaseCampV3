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
 *
 * Which modes are offered is permission-gated on top of the caller's outer
 * either-perm gating: "Create model" needs asset_models:add, "Map to
 * existing" needs asset_models:change. When only one is available the
 * chooser is skipped and that mode is entered directly.
 *
 * The model itself is the thing that matters for the import row — once
 * createAssetModel succeeds the row's suggested text has a home in the
 * catalog even if the alias write that follows fails, so a failed alias
 * append must not silently report success (onFixed) and hide the retry
 * entry point. Instead the dialog stays open on an error screen with a
 * "Retry alias" action that re-attempts only the alias write against the
 * already-created model.
 */

import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
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
  const { can } = useAuth();
  const canCreate = can('asset_models', 'add');
  const canMap = can('asset_models', 'change');
  // When only one mode is available there's nothing to choose between —
  // skip straight to it. When neither is (shouldn't happen given the
  // caller's outer either-perm gating, but don't crash if it does) fall
  // back to the chooser, which then simply has nothing to offer.
  const availableModes: Mode[] =
    [canCreate ? 'create' as const : null, canMap ? 'map' as const : null]
      .filter((m): m is 'create' | 'map' => m !== null);
  const [mode, setMode] = useState<Mode>(
    () => (availableModes.length === 1 ? availableModes[0] : 'choose'));
  const [categories, setCategories] = useState<AssetCategoryOut[]>([]);
  const [models, setModels] = useState<AssetModelItem[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Set when a model was successfully created but the follow-up alias
  // append failed — keeps the dialog open on a retry screen instead of
  // reporting the row fixed. skipCreateCloseRef blocks ModelEditModal's
  // own post-save onClose() call in that case (see the onSaved handler
  // below): it always calls onClose() once onSaved settles, but here that
  // would tear down this whole dialog before the retry UI ever shows.
  const [aliasFailure, setAliasFailure] = useState<AssetModelItem | null>(null);
  const [retrying, setRetrying] = useState(false);
  const skipCreateCloseRef = useRef(false);

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

  const retryAlias = async () => {
    if (!aliasFailure) return;
    setRetrying(true);
    try {
      await setAssetModelAliases(aliasFailure.id, withAlias(aliasFailure.aliases ?? [], text));
      onFixed(text);
    } catch {
      setRetrying(false);
      // Stay on the retry screen — aliasFailure is unchanged, so another
      // click tries again.
    }
  };

  if (mode === 'create' && aliasFailure) {
    return (
      <div className="modal-scrim" onMouseDown={(e) => {
        if (e.target === e.currentTarget && !retrying) onClose();
      }}>
        <div className="modal-card">
          <div className="modal-head">
            <h3>Fix make/model</h3>
            <button className="modal-close" aria-label="Close" onClick={onClose} disabled={retrying}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </div>
          <div className="modal-body">
            <span className="pf-error">
              Model created, but adding the alias failed — retry or reprocess may still flag
              this text.
            </span>
          </div>
          <div className="modal-foot">
            <button className="mini-btn" type="button" disabled={retrying}
                    onClick={() => void retryAlias()}>
              {retrying ? 'Retrying…' : 'Retry alias'}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={retrying}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'create') {
    return (
      <ModelEditModal
        model={null}
        categories={categories}
        canChange={canMap}
        initial={{ make, model }}
        onClose={() => {
          if (skipCreateCloseRef.current) return;
          onClose();
        }}
        onSaved={async (saved) => {
          if (saved && text.toLowerCase() !== `${saved.make} ${saved.model}`.toLowerCase()) {
            try {
              await setAssetModelAliases(saved.id, withAlias(saved.aliases ?? [], text));
            } catch {
              // The model itself already saved successfully — don't report
              // this row fixed while the alias write is still outstanding.
              // Block ModelEditModal's own post-onSaved onClose() call (it
              // runs unconditionally right after this handler resolves) so
              // the retry screen below actually gets a chance to render.
              skipCreateCloseRef.current = true;
              setAliasFailure(saved);
              return;
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
              {canCreate && (
                <button className="btn-solid" type="button" onClick={() => setMode('create')}>
                  Create model
                </button>
              )}
              {canMap && (
                <button className="mini-btn" type="button" onClick={() => setMode('map')}>
                  Map to existing
                </button>
              )}
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

/**
 * Shared god-edit mechanism: a descriptor-driven inline-edit cell for
 * developers in god mode to patch a table value directly, bypassing the
 * normal edit-modal flow. Every list page wires the same three pieces:
 *
 *   - a `GodField<Row>[]` describing which columns are editable, how to
 *     read/write them, and how to map an input string to a PATCH value;
 *   - `useGodEdit()` for the page's own "is god-edit on" toggle state;
 *   - `<GodCell>` to render one editable cell, given the row, the field
 *     descriptor, the page's patch function, and a save-callback.
 *
 * God mode itself (whether the toggle is even offered) comes from
 * AuthContext's `godMode` — this module only handles the editing UI once
 * that gate is open.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from './api';
import ComboBox, { type ComboOption } from '../components/ComboBox';
import './../styles/god-edit.css';

export interface GodField<T> {
  column: string;                        // ColumnDef key; 'primary' | 'primary2' for the name cell
  field: string;                         // API field name sent in the PATCH body
  kind: 'text' | 'number' | 'combo' | 'select' | 'bool';
  fromRow: (row: T) => string;           // row -> input value ('' for null)
  toPatch?: (raw: string) => unknown;    // default: trimmed string, '' -> null
  options?: () => ComboOption[];         // combo/select sources (page lookups, lazily read)
}

export function defaultToPatch(raw: string): unknown {
  const v = raw.trim();
  return v === '' ? null : v;
}

export function numberToPatch(raw: string): unknown {
  const v = raw.trim();
  if (v === '') return null;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error('not_a_number');
  return n;
}

export function boolTriToPatch(raw: string): unknown {
  return raw === '' ? null : raw === 'yes';
}

export function useGodEdit() {
  const { godMode } = useAuth();
  const [editing, setEditing] = useState(false);
  return {
    // Exiting god mode doesn't unmount the page, so `editing` alone can go
    // stale (stuck true) after the toggle that gates it disappears. Derive
    // the visible value from the current godMode instead of trusting the
    // raw flag on its own.
    editing: editing && godMode,
    toggle: () => {
      if (!godMode) return;
      setEditing((e) => !e);
    },
  };
}

export function GodEditToggle({ editing, onToggle, visible }: {
  editing: boolean; onToggle: () => void; visible: boolean;
}) {
  if (!visible) return null;
  return (
    <button className={`btn-ghost god-edit-toggle ${editing ? 'on' : ''}`}
            aria-pressed={editing} title="God mode: edit table directly"
            onClick={onToggle}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
        <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      </svg>
      Edit table
    </button>
  );
}

/** Try `toPatch`, returning either the mapped value or the raw Error thrown
 *  (never throws itself) so callers can branch without a try/catch. */
function tryToPatch(
  raw: string, toPatch: (raw: string) => unknown,
): { ok: true; value: unknown } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: toPatch(raw) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export function GodCell<T extends { id: string }>(props: {
  row: T;
  gf: GodField<T>;
  patch: (id: string, body: Record<string, unknown>) => Promise<T>;
  onRowSaved: (updated: T) => void;
  errorMap: Record<string, string>;
  disabled?: boolean;
  idOf?: (row: T) => string;
}): ReactNode;
export function GodCell<T>(props: {
  row: T;
  gf: GodField<T>;
  patch: (id: string, body: Record<string, unknown>) => Promise<T>;
  onRowSaved: (updated: T) => void;
  errorMap: Record<string, string>;
  disabled?: boolean;
  idOf: (row: T) => string;
}): ReactNode;
export function GodCell<T>({ row, gf, patch, onRowSaved, errorMap, disabled, idOf }: {
  row: T;
  gf: GodField<T>;
  patch: (id: string, body: Record<string, unknown>) => Promise<T>;
  onRowSaved: (updated: T) => void;
  errorMap: Record<string, string>;
  disabled?: boolean;
  // Almost every page's row keys off `id` — that's the default. Workers.tsx
  // is the exception (its rows key off `person_id`, the worker role's
  // person, not a row of its own), so it passes idOf explicitly. The two
  // overloads above keep every other call site's `T extends { id: string }`
  // inference (and the freedom to omit idOf) exactly as it was.
  idOf?: (row: T) => string;
}) {
  const rowId = idOf ? idOf(row) : (row as { id: string }).id;
  const seed = gf.fromRow(row);
  const [value, setValue] = useState(seed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not state: state updates are async and Enter-then-blur fires
  // commit() twice before either setSaving(true) has committed, so a
  // state-based guard would still let the second call through.
  const inFlight = useRef(false);

  // Re-seed whenever the row's underlying value changes — e.g. after
  // onRowSaved swaps in the freshly-patched row, or another editor's
  // change lands via a refetch.
  useEffect(() => {
    setValue(seed);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  const toPatch = gf.toPatch ?? defaultToPatch;

  async function commit(raw: string) {
    if (inFlight.current) return;

    const mapped = tryToPatch(raw, toPatch);
    if (!mapped.ok) {
      const msg = mapped.error instanceof Error && mapped.error.message === 'not_a_number'
        ? 'Not a number'
        : 'Invalid value';
      setError(msg);
      return;
    }

    const seedMapped = tryToPatch(seed, toPatch);
    const unchanged = seedMapped.ok
      && JSON.stringify(mapped.value) === JSON.stringify(seedMapped.value);
    if (unchanged) {
      setError(null);
      return;
    }

    setError(null);
    setSaving(true);
    inFlight.current = true;
    try {
      const updated = await patch(rowId, { [gf.field]: mapped.value });
      onRowSaved(updated);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      setError((code && errorMap[code]) ?? 'Could not save.');
    } finally {
      setSaving(false);
      inFlight.current = false;
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit(value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setValue(seed);
      setError(null);
    }
  };

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  let control: ReactNode;
  if (disabled) {
    control = <span className="god-cell-display">{value === '' ? '—' : value}</span>;
  } else if (gf.kind === 'combo') {
    control = (
      <ComboBox
        options={gf.options?.() ?? []}
        value={value}
        onChange={(v) => { setValue(v); void commit(v); }}
        disabled={saving}
        clearable
      />
    );
  } else if (gf.kind === 'bool') {
    control = (
      <select
        value={value}
        disabled={saving}
        onChange={(e) => { const v = e.target.value; setValue(v); void commit(v); }}
        onClick={stop}
      >
        <option value="">Unknown</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  } else if (gf.kind === 'select') {
    control = (
      <select
        value={value}
        disabled={saving}
        onChange={(e) => { const v = e.target.value; setValue(v); void commit(v); }}
        onClick={stop}
      >
        <option value="">—</option>
        {(gf.options?.() ?? []).map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        type={gf.kind === 'number' ? 'number' : 'text'}
        value={value}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void commit(value)}
        onClick={stop}
      />
    );
  }

  return (
    <span className={`god-cell ${saving ? 'saving' : ''} ${error ? 'error' : ''}`} onClick={stop}>
      {control}
      {error && <span className="god-cell-msg">{error}</span>}
    </span>
  );
}

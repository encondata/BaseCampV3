/**
 * The builder's Load from person… on an ID badge (spec 2026-10-20-badge-
 * templates §4.7, §4.11): search staff and workers (GET /labels/sample-
 * people, as you type, in the natural order the server sends), pick one,
 * and the badge's samples become theirs (GET /labels/sample-person). The
 * page applies them with `personSamples`: EVERY person key is replaced,
 * "" for the person's blanks, so nothing of the last person stays, and the
 * person is named under the reserved key `person:id`, so the canvas, the
 * preview and Test print draw their photo and logo. `clearPersonSamples`
 * (Clear sample person) takes every person key and `person:id` away.
 *
 * The report-generate header and the initiative picker's list (reports.css
 * `ini-picker`), sized to its content. The page turns the canvas keyboard
 * off while it is open.
 */

import { useEffect, useRef, useState } from 'react';

import {
  ApiError, loadSamplePerson, searchSamplePeople, type SamplePerson, type SamplePersonValues,
} from '../../../lib/api';
import { ROLE_CLS } from '../../../lib/users';
import { PERSON_SAMPLE_KEY } from '../../../labels/builder/image';
import '../../../styles/directory.css';
import '../../../styles/profile.css';   /* .btn-solid, .pf-error */
import '../../../styles/reports.css';
import '../../../styles/labelBuilder.css';

/** How many people one search lists (the API allows 100). */
export const PERSON_SEARCH_LIMIT = 50;
/** The quiet after typing before the search goes out. */
export const PERSON_SEARCH_DEBOUNCE_MS = 250;

export interface LoadFromPersonModalProps {
  /** The template's name, for the header. */
  templateName: string;
  /** The person's badge values; the page applies them (personSamples). */
  onLoad: (loaded: SamplePersonValues) => void;
  onClose: () => void;
}

/** `samples` with `loaded` as the sample person: every person key (the
 *  catalog's `personKeys` and every key the person came with) takes the
 *  person's value, "" for a blank, and `person:id` names them. Any other
 *  sample stays. */
export function personSamples(samples: Readonly<Record<string, string>>,
  loaded: Pick<SamplePersonValues, 'person_id' | 'values'>, personKeys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = { ...samples };
  for (const key of new Set([...personKeys, ...Object.keys(loaded.values)])) {
    const value = Object.hasOwn(loaded.values, key) ? loaded.values[key] : '';
    out[key] = typeof value === 'string' ? value : '';
  }
  out[PERSON_SAMPLE_KEY] = loaded.person_id;
  return out;
}

/** `samples` with no sample person: no person key and no `person:id`. */
export function clearPersonSamples(samples: Readonly<Record<string, string>>,
  personKeys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = { ...samples };
  for (const key of personKeys) delete out[key];
  delete out[PERSON_SAMPLE_KEY];
  return out;
}

/** What pictures the person's badge gets. */
function pictures(p: SamplePerson): string {
  if (p.has_photo && p.has_logo) return 'Photo · Logo';
  if (p.has_photo) return 'Photo';
  if (p.has_logo) return 'Logo';
  return 'No photo or logo';
}

function errorText(err: unknown): string {
  if (err instanceof ApiError && err.code === 'person_not_found') return 'That person is no longer on file.';
  return 'Couldn’t load that person’s values.';
}

const SEARCH_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
  </svg>
);

export default function LoadFromPersonModal({ templateName, onLoad, onClose }: LoadFromPersonModalProps) {
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<SamplePerson[] | null>(null);
  const [searchError, setSearchError] = useState(false);
  const [picked, setPicked] = useState<SamplePerson | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the first search goes out at once; one after typing waits for quiet
  const searched = useRef(false);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      searched.current = true;
      searchSamplePeople(query.trim(), PERSON_SEARCH_LIMIT)
        .then((rows) => {
          if (!live) return;
          setPeople(rows);
          setSearchError(false);
          // a pick the new list doesn't show is no pick
          setPicked((p) => (p && rows.some((r) => r.person_id === p.person_id) ? p : null));
        })
        .catch(() => {
          if (!live) return;
          setPeople([]);
          setSearchError(true);
        });
    }, searched.current ? PERSON_SEARCH_DEBOUNCE_MS : 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const load = async () => {
    if (!picked || busy) return;
    setBusy(true);
    setError(null);
    try {
      onLoad(await loadSamplePerson(picked.person_id));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const full = people !== null && people.length >= PERSON_SEARCH_LIMIT;

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card lbp-load-card" role="dialog" aria-modal="true"
        aria-label="Load samples from a person">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">{templateName} · Load from person</div>
            <h3>Load samples from a person</h3>
            <p className="page-hint">
              Pick a staff member or worker: every person field&apos;s sample, the photo and the logo become theirs,
              and what they don&apos;t have prints blank.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="ini-picker">
            <div className="ini-picker-tools">
              <div className="dir-search">
                {SEARCH_ICON}
                <input type="search" aria-label="Search people" placeholder="Search staff and workers by name…"
                  value={query} autoFocus autoComplete="off" spellCheck={false}
                  onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>
            <div className="mini-list ini-picker-list" role="radiogroup" aria-label="People">
              {people === null && <div className="ini-picker-empty">Loading…</div>}
              {people !== null && !searchError && people.length === 0 && (
                <div className="ini-picker-empty">No staff or workers match.</div>
              )}
              {searchError && <div className="ini-picker-empty">Couldn’t search people.</div>}
              {(people ?? []).map((p) => (
                <label key={p.person_id} className={`mini-row ini-picker-row ${picked?.person_id === p.person_id ? 'on' : ''}`}>
                  <input type="radio" name="lbp-load-person"
                    aria-label={`${p.name}, ${p.company ?? 'no company'}, ${p.person_type}, ${pictures(p)}`}
                    checked={picked?.person_id === p.person_id} onChange={() => { setPicked(p); setError(null); }} />
                  <span className="cell-primary"><span className="pn"><b>{p.name}</b></span></span>
                  <span className="cell-sub">{p.company ?? '—'}</span>
                  <span className={`chip ${ROLE_CLS[p.person_type.toLowerCase()] ?? 'tag'}`}>{p.person_type}</span>
                  <span className="cell-sub">{pictures(p)}</span>
                </label>
              ))}
            </div>
            {full && (
              <p className="page-hint">The first {PERSON_SEARCH_LIMIT} by name: type more of a name to narrow them.</p>
            )}
          </div>
          {error && <div className="pf-error" role="alert">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-solid" disabled={!picked || busy} onClick={() => void load()}>
            {busy ? 'Loading…' : 'Load samples'}
          </button>
        </div>
      </div>
    </div>
  );
}

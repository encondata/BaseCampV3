/**
 * Pick whose personal phone a kiosk is (biometric sign-in, spec
 * 2026-10-23-kiosk-biometric-sign-in §Portal). The list is GET
 * /devices/{id}/personal-candidates: only people the server would accept (a
 * portal login that is not disabled, kiosk access, not archived, never a
 * move's hidden kiosk identity), searched on the server as you type. A
 * `not_eligible` refusal (someone changed in the meantime) still shows its
 * reason here and the modal stays open.
 *
 * The report-generate header and the initiative picker's list (reports.css
 * `ini-picker`), sized to its content.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  PERSONAL_CANDIDATE_LIMIT, listPersonalCandidates, setDevicePersonal, type DeviceDetail,
  type PersonalCandidate,
} from '../../../lib/api';
import { personalErrorMessage } from '../../../lib/biometric';

/** How long typing pauses before the search goes to the server. */
export const PERSONAL_SEARCH_DEBOUNCE_MS = 250;

const SEARCH_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
  </svg>
);

export default function PersonalDeviceModal({ detail, onSaved, onClose }: {
  detail: DeviceDetail;
  onSaved: (next: DeviceDetail) => void;
  onClose: () => void;
}) {
  const [people, setPeople] = useState<PersonalCandidate[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // the first list straight away, then each search once typing pauses; a
  // late answer for an older search never replaces a newer one
  const term = query.trim();
  const firstLoad = useRef(true);
  useEffect(() => {
    let live = true;
    const delay = firstLoad.current ? 0 : PERSONAL_SEARCH_DEBOUNCE_MS;
    firstLoad.current = false;
    const timer = setTimeout(() => {
      listPersonalCandidates(detail.id, term)
        .then((rows) => { if (live) { setPeople(rows); setLoadError(false); } })
        .catch(() => { if (live) { setPeople([]); setLoadError(true); } });
    }, delay);
    return () => { live = false; clearTimeout(timer); };
  }, [detail.id, term]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const current = detail.personal_person?.id ?? null;
  const shown = useMemo(
    () => (people ?? []).filter((p) => p.person_id !== current), [people, current]);

  // a pick the filter hides is no pick
  useEffect(() => {
    if (picked && !shown.some((p) => p.person_id === picked)) setPicked(null);
  }, [picked, shown]);

  const save = async () => {
    if (!picked || busy) return;
    setBusy(true);
    setError('');
    try {
      onSaved(await setDevicePersonal(detail.id, picked));
    } catch (err) {
      setError(personalErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card kd-personal-card" role="dialog" aria-modal="true"
           aria-label="Whose phone is this?">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">{detail.name} · Personal device</div>
            <h3>Whose phone is this?</h3>
            <p className="page-hint">
              Pick the person who carries this phone. After a password sign-in on it, they can turn on
              fingerprint or face sign-in. Only people with a portal login and kiosk access are listed.
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
                <input type="search" aria-label="Search people" placeholder="Search people by name or email…"
                  value={query} autoFocus autoComplete="off" spellCheck={false}
                  onChange={(e) => { setQuery(e.target.value); setError(''); }} />
              </div>
            </div>
            <div className="mini-list ini-picker-list" role="radiogroup" aria-label="People">
              {people === null && <div className="ini-picker-empty">Loading…</div>}
              {people !== null && !loadError && shown.length === 0 && (
                <div className="ini-picker-empty">No people match.</div>
              )}
              {loadError && <div className="ini-picker-empty">Couldn’t load people.</div>}
              {shown.map((p) => (
                <label key={p.person_id} className={`mini-row ini-picker-row ${picked === p.person_id ? 'on' : ''}`}>
                  <input type="radio" name="kd-personal-person"
                    aria-label={`${p.display_name}, ${p.login_email}`}
                    checked={picked === p.person_id} onChange={() => { setPicked(p.person_id); setError(''); }} />
                  <span className="cell-primary"><span className="pn"><b>{p.display_name}</b></span></span>
                  <span className="cell-sub">{p.login_email}</span>
                </label>
              ))}
            </div>
            {(people?.length ?? 0) >= PERSONAL_CANDIDATE_LIMIT && (
              <p className="page-hint">The first {PERSONAL_CANDIDATE_LIMIT} by name: type more of a name to narrow them.</p>
            )}
          </div>
          {error && <div className="pf-error" role="alert">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-solid" disabled={!picked || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

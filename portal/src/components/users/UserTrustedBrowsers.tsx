/**
 * UserTrustedBrowsers — the admin view of a person's remembered browsers
 * (the ones that skip the two-factor code), under Active sessions on the user
 * page. Forget per row needs no confirm (the person just remembers it again);
 * Forget all uses the page's confirm-modal pattern.
 *
 * Rendered only when the page's `sessions` block is non-null: the API gates
 * GET /users/{id}/trusted-browsers exactly like that block (users:change,
 * global actor, touchable rank or self), so we never fire a request that
 * would 403. The buttons additionally need `canManage` (users:change on
 * someone else; self manages their own on /me).
 */
import { useEffect, useRef, useState } from 'react';

import {
  forgetAllUserTrustedBrowsers, forgetUserTrustedBrowser, listUserTrustedBrowsers,
  type TrustedBrowsers,
} from '../../lib/api';
import { describeUserAgent, relativeTime } from '../../lib/format';
import { forgetErrorMessage } from '../../lib/trustedBrowsers';

export default function UserTrustedBrowsers({
  personId, personName, canManage, reloadKey = 0,
}: {
  personId: string;
  personName: string;
  canManage: boolean;
  /** Bumped by the page after each load, so Sign out everywhere / Reset 2FA
   *  (which change what is remembered) refresh this block too. */
  reloadKey?: number;
}) {
  const [data, setData] = useState<TrustedBrowsers | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [rowError, setRowError] = useState('');
  const [modalError, setModalError] = useState('');

  // Another person starts from nothing; a reload of the same person keeps the
  // current list on screen until the fresh one arrives.
  const shownFor = useRef(personId);
  useEffect(() => {
    let live = true;
    if (shownFor.current !== personId) {
      shownFor.current = personId;
      setData(null);
    }
    void listUserTrustedBrowsers(personId).then((d) => { if (live) setData(d); }).catch(() => {});
    return () => { live = false; };
  }, [personId, reloadKey]);

  if (!data) return null;

  const forgetOne = async (id: string) => {
    setRowError('');
    try {
      await forgetUserTrustedBrowser(personId, id);
    } catch (err) {
      setRowError(forgetErrorMessage(err, 'one'));
      return;
    }
    setData((prev) => prev && { ...prev, browsers: prev.browsers.filter((b) => b.id !== id) });
  };

  const forgetAll = async () => {
    setForgetting(true);
    setModalError('');
    try {
      await forgetAllUserTrustedBrowsers(personId);
      setData((prev) => prev && { ...prev, browsers: [] });
      setRowError('');
      setConfirmOpen(false);
    } catch (err) {
      setModalError(forgetErrorMessage(err));
    } finally {
      setForgetting(false);
    }
  };

  return (
    <>
      <div className="profile-full">
        <div className="panel">
          <div className="panel-head">
            <h3>Remembered browsers</h3>
            <span className="activity-tools">
              <span className="result-count">{data.browsers.length} remembered</span>
              {canManage && data.browsers.length > 0 && (
                <button className="mini-btn danger" onClick={() => { setModalError(''); setConfirmOpen(true); }}>Forget all</button>
              )}
            </span>
          </div>
          <div className="panel-body">
            <p className="page-hint" style={{ marginTop: 0 }}>
              A remembered browser skips the two-factor code for {data.trust_days} days.
              Forget one to ask for the code again.
            </p>
            {data.browsers.map((b) => (
              <div className="session-item" key={b.id}>
                <div className="session-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                       strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="4" width="20" height="13" rx="2" />
                    <path d="M8 21h8M12 17v4" />
                  </svg>
                </div>
                <div className="session-main cell">
                  <div className="cell-top"><b>{describeUserAgent(b.user_agent)}</b></div>
                  <div className="mono">
                    remembered {relativeTime(b.created_at)} ·{' '}
                    {b.last_used_at ? `last used ${relativeTime(b.last_used_at)}` : 'never used'} ·
                    expires {relativeTime(b.expires_at)}
                  </div>
                </div>
                {canManage && (
                  <button className="mini-btn" onClick={() => void forgetOne(b.id)}>Forget</button>
                )}
              </div>
            ))}
            {data.browsers.length === 0 && (
              <p className="set-note" style={{ padding: 0 }}>No remembered browsers.</p>
            )}
            {rowError && <p className="pf-error" role="alert" style={{ margin: '8px 0 0' }}>{rowError}</p>}
          </div>
        </div>
      </div>

      {confirmOpen && (
        <div className="modal-scrim"
             onMouseDown={(e) => { if (e.target === e.currentTarget && !forgetting) setConfirmOpen(false); }}>
          <div className="modal-card reports-modal-card rgm-card ud-confirm-card" role="dialog"
               aria-label="Forget all remembered browsers">
            <div className="modal-head">
              <div className="rgm-head-text">
                <div className="eyebrow">Two-factor</div>
                <h3>Forget all remembered browsers</h3>
                <p className="page-hint">
                  Every remembered browser for {personName} is forgotten immediately, so each one asks for the
                  two-factor code at its next sign-in. Their account and live sessions are not affected.
                </p>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn-solid" onClick={() => void forgetAll()} disabled={forgetting}>
                {forgetting ? 'Forgetting…' : 'Forget all browsers'}
              </button>
              <button className="mini-btn" onClick={() => setConfirmOpen(false)} disabled={forgetting}>Cancel</button>
              {modalError && <span className="pf-error" role="alert">{modalError}</span>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

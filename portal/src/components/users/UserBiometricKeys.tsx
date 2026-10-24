/**
 * UserBiometricKeys — the Biometric sign-in panel: a person's live
 * fingerprint/face keys on their personal kiosk phones (spec
 * 2026-10-23-kiosk-biometric-sign-in §Portal). Modeled on
 * UserTrustedBrowsers and gated the same way.
 *
 * `personId` set: the admin view on the user page, rendered only when the
 * page's `sessions` block is non-null (GET /users/{id}/biometric-keys is gated
 * like that block), so we never fire a request that would 403. The buttons
 * additionally need `canManage` (users:change on someone else). The API
 * refuses an admin's forget of their own keys (`cannot_target_self`), so on
 * your own user page the panel has no buttons and points to /me.
 *
 * `personId` null: /me, the signed-in person's own keys, Forget per row (no
 * Forget all on that route). Hidden until there is a key to show.
 *
 * Forget per row needs no confirm (the person turns it on again at their next
 * password sign-in); Forget all uses the page's confirm-modal pattern.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  forgetAllUserBiometricKeys, forgetMyBiometricKey, forgetUserBiometricKey, listMyBiometricKeys,
  listUserBiometricKeys, type BiometricKey,
} from '../../lib/api';
import { keyForgetErrorMessage, renewsText } from '../../lib/biometric';
import { relativeTime } from '../../lib/format';

type Props =
  | { personId: string; personName: string; canManage: boolean; ownPage: boolean; reloadKey?: number }
  | { personId: null; personName?: undefined; canManage?: undefined; ownPage?: undefined; reloadKey?: number };

function keyLine(k: BiometricKey): string {
  return `added ${relativeTime(k.created_at)} · `
    + `${k.last_used_at ? `last used ${relativeTime(k.last_used_at)}` : 'never used'} · ${renewsText(k.renews_at)}`;
}

export default function UserBiometricKeys(props: Props) {
  const { personId, reloadKey = 0 } = props;
  const self = personId === null;
  const canForget = self || (props.canManage === true && !props.ownPage);
  const [keys, setKeys] = useState<BiometricKey[] | null>(null);
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
      setKeys(null);
    }
    const load = personId === null ? listMyBiometricKeys() : listUserBiometricKeys(personId);
    void load.then((d) => { if (live) setKeys(d); }).catch(() => {});
    return () => { live = false; };
  }, [personId, reloadKey]);

  // /me shows the panel once there is something to show, and keeps it (with
  // the empty note) after the last Forget.
  const [everHad, setEverHad] = useState(false);
  useEffect(() => { if (keys && keys.length > 0) setEverHad(true); }, [keys]);

  if (!keys) return null;
  if (self && keys.length === 0 && !everHad) return null;

  const forgetOne = async (id: string) => {
    setRowError('');
    try {
      if (personId === null) await forgetMyBiometricKey(id);
      else await forgetUserBiometricKey(personId, id);
    } catch (err) {
      setRowError(keyForgetErrorMessage(err, 'one'));
      return;
    }
    setKeys((prev) => prev && prev.filter((k) => k.id !== id));
  };

  const forgetAll = async () => {
    if (personId === null) return;
    setForgetting(true);
    setModalError('');
    try {
      await forgetAllUserBiometricKeys(personId);
      setKeys([]);
      setRowError('');
      setConfirmOpen(false);
    } catch (err) {
      setModalError(keyForgetErrorMessage(err));
    } finally {
      setForgetting(false);
    }
  };

  return (
    <>
      <div className="profile-full">
        <div className="panel">
          <div className="panel-head">
            <h3>Biometric sign-in</h3>
            <span className="activity-tools">
              <span className="result-count">{keys.length} {keys.length === 1 ? 'device' : 'devices'}</span>
              {!self && canForget && keys.length > 0 && (
                <button className="mini-btn danger" onClick={() => { setModalError(''); setConfirmOpen(true); }}>Forget all</button>
              )}
            </span>
          </div>
          <div className="panel-body">
            <p className="page-hint" style={{ marginTop: 0 }}>
              {self
                ? 'Your personal phone signs you in with fingerprint or face for 30 days after each password sign-in. '
                : 'A personal phone signs in with fingerprint or face for 30 days after each password sign-in. '}
              Forget one to turn it off on that phone.
            </p>
            {keys.map((k) => (
              <div className="session-item" key={k.id}>
                <div className="session-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                       strokeLinecap="round" strokeLinejoin="round">
                    <rect x="6" y="2" width="12" height="20" rx="2.5" />
                    <path d="M11 18h2" />
                  </svg>
                </div>
                <div className="session-main cell">
                  <div className="cell-top"><b>{k.device_name}</b></div>
                  <div className="mono">{keyLine(k)}</div>
                </div>
                {canForget && (
                  <button className="mini-btn" onClick={() => void forgetOne(k.id)}>Forget</button>
                )}
              </div>
            ))}
            {keys.length === 0 && (
              <p className="set-note" style={{ padding: 0 }}>No fingerprint sign-in on any device.</p>
            )}
            {!self && props.ownPage && (
              <p className="set-note" style={{ padding: 0, marginTop: 8 }}>
                Manage your own on <Link to="/me">My account</Link>
              </p>
            )}
            {rowError && <p className="pf-error" role="alert" style={{ margin: '8px 0 0' }}>{rowError}</p>}
          </div>
        </div>
      </div>

      {confirmOpen && (
        <div className="modal-scrim"
             onMouseDown={(e) => { if (e.target === e.currentTarget && !forgetting) setConfirmOpen(false); }}>
          <div className="modal-card reports-modal-card rgm-card ud-confirm-card" role="dialog"
               aria-label="Forget all fingerprint sign-ins">
            <div className="modal-head">
              <div className="rgm-head-text">
                <div className="eyebrow">Biometric sign-in</div>
                <h3>Forget all fingerprint sign-ins</h3>
                <p className="page-hint">
                  Fingerprint sign-in is turned off on every phone {props.personName} uses, immediately, so each one
                  asks for their password at its next sign-in. They can turn it on again after that.
                </p>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn-solid" onClick={() => void forgetAll()} disabled={forgetting}>
                {forgetting ? 'Forgetting…' : 'Forget all fingerprints'}
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

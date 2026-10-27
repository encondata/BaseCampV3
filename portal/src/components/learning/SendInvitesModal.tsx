/**
 * Send invites now: says who will get an invite (from the roster the tab
 * already has), then sends and shows what the server did — sent, no email,
 * already complete, already invited. Needs learning:change.
 */

import { useState } from 'react';

import {
  sendInitiativeInvites, type RosterRow, type SendInvitesResult,
} from '../../lib/learning';
import { tabErrorText, plural } from './initiativeLearning';
import LearningModal from './LearningModal';

/** Who a full send reaches, by the roster: people with email who still
 *  have training to do (the server also leaves anyone with a working,
 *  emailed code alone). */
export function inviteCounts(roster: RosterRow[]) {
  const complete = roster.filter((r) => r.status === 'complete').length;
  const noEmail = roster.filter((r) => r.status === 'no_email').length;
  return { complete, noEmail, toInvite: roster.length - complete - noEmail };
}

export default function SendInvitesModal({ initiativeId, roster, onClose, onSent }: {
  initiativeId: string;
  /** Everyone on the initiative; null while it loads. */
  roster: RosterRow[] | null;
  onClose: () => void;
  /** Called once the send went through (the tab reloads behind the dialog). */
  onSent: (result: SendInvitesResult) => void;
}) {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendInvitesResult | null>(null);
  const [error, setError] = useState('');

  const counts = roster ? inviteCounts(roster) : null;

  const send = async () => {
    setSending(true);
    setError('');
    try {
      const out = await sendInitiativeInvites(initiativeId);
      setResult(out);
      onSent(out);
    } catch (e) {
      setError(tabErrorText(e));
    } finally {
      setSending(false);
    }
  };

  const tiles: [string, number, string][] = result ? [
    ['Invites sent', result.sent, 'lrn-green'],
    ['No email', result.no_email, 'lrn-amber'],
    ['Already complete', result.skipped_complete, ''],
    ['Already invited', result.already_invited, ''],
  ] : [];

  return (
    <LearningModal eyebrow="Learning" title="Send invites now"
                   label="Send invites"
                   description="Everyone on this initiative with training to do gets an email with their code and link."
                   onClose={onClose} busy={sending}
                   footer={result ? (
                     <button type="button" className="btn-solid" onClick={onClose}>Close</button>
                   ) : (
                     <>
                       <button type="button" className="btn-solid" onClick={() => void send()}
                               disabled={sending || counts === null}>
                         {sending ? 'Sending…' : 'Send invites'}
                       </button>
                       <button type="button" className="mini-btn" onClick={onClose} disabled={sending}>Cancel</button>
                       {error && <span className="pf-error" role="alert">{error}</span>}
                     </>
                   )}>
      {!result && counts === null && <p className="page-hint">Counting…</p>}
      {!result && counts !== null && (
        <ul className="lrn-send-counts">
          <li>{`${plural(counts.toInvite, 'person', 'people')} will get an invite.`}</li>
          {counts.noEmail > 0 && (
            <li>{`${counts.noEmail} ${counts.noEmail === 1 ? 'has' : 'have'} no email: print them a code sheet.`}</li>
          )}
          {counts.complete > 0 && (
            <li>{`${counts.complete} ${counts.complete === 1 ? 'is' : 'are'} already complete and will be skipped.`}</li>
          )}
          <li className="lrn-hint">People who already have a working, emailed code are left alone.</li>
        </ul>
      )}
      {result && (
        <div className="lrn-tiles" role="status" aria-label="Send result">
          {tiles.map(([label, value, tone]) => (
            <div key={label} className="lrn-tile">
              <div className={`lrn-tile-v ${tone}`}>{value.toLocaleString()}</div>
              <div className="lrn-tile-k">{label}</div>
            </div>
          ))}
        </div>
      )}
    </LearningModal>
  );
}

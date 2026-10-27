/** The soft gate before a clock-in: the person card, what they have not
 *  signed yet, and the three ways on: email themselves the link to finish
 *  on their phone (only when the portal has an address for them), cancel
 *  the punch, or have an admin override. Nothing here punches; the flow
 *  decides what Admin override does. */

import { useState } from 'react';

import type { KioskLearningBlock, KioskTimeclockPerson } from '../../lib/api';
import { formatClock } from '../format';
import { IconAlert, IconClose, IconMail, IconShield } from '../icons';
import { initialsOf } from './ConfirmPerson';
import PunchError from './PunchError';

const KIND_LABEL = { required: 'Required for this move', extra: 'Extra' } as const;

export function headingText(count: number): string {
  return count === 1 ? "1 required item isn't signed yet" : `${count} required items aren't signed yet`;
}

export interface LearningWarningProps {
  person: KioskTimeclockPerson;
  learning: KioskLearningBlock;
  /** A punch is in flight (the clock-in after an override). */
  busy: boolean;
  /** The clock-in after an override failed; Try again repeats it. */
  error: string | null;
  /** "Email me the link" went out. */
  linkSent: boolean;
  linkSending: boolean;
  linkError: string | null;
  onEmail(): void;
  onCancel(): void;
  onOverride(): void;
  onRetry(): void;
}

export default function LearningWarning({
  person, learning, busy, error, linkSent, linkSending, linkError,
  onEmail, onCancel, onOverride, onRetry,
}: LearningWarningProps) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const items = learning.outstanding;
  return (
    <section className="tcx-screen tcx-learning">
      <div className="tcx-learning-person">
        {person.avatar_url && !photoFailed ? (
          <img className="tcx-avatar" src={person.avatar_url} alt="" onError={() => setPhotoFailed(true)} />
        ) : (
          <div className="tcx-avatar tcx-initials" aria-hidden="true">{initialsOf(person.display_name)}</div>
        )}
        <div className="tcx-learning-who">
          <p className="tcx-person-name">{person.display_name}</p>
          <p className="tcx-person-meta">Clocking in · {formatClock(new Date().toISOString())}</p>
        </div>
      </div>
      <div className="tcx-warnbox">
        <h1 className="tcx-warn-head"><IconAlert className="tcx-warn-icon" />{headingText(items.length)}</h1>
        <ul className="tcx-warn-list">
          {items.map((item, i) => (
            <li key={`${item.title}-${i}`}>
              <span className="tcx-warn-title">{item.title}</span>
              <span className={`tcx-warn-kind is-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="tcx-hint">You can finish them on your phone in a few minutes.</p>
      {error && <PunchError error={error} busy={busy} onRetry={onRetry} />}
      {linkError && <p className="tcx-error-text" role="alert">{linkError}</p>}
      <div className="tcx-buttons tcx-learning-buttons">
        {learning.link_email && (linkSent ? (
          <p className="tcx-link-sent" role="status">
            <IconMail className="tcx-btn-icon" /> Link sent to your email
          </p>
        ) : (
          <button type="button" className="tcx-btn is-ghost" disabled={busy || linkSending} onClick={onEmail}>
            <IconMail className="tcx-btn-icon" /> Email me the link
          </button>
        ))}
        <button type="button" className="tcx-btn is-ghost" disabled={busy} onClick={onCancel}>
          <IconClose className="tcx-btn-icon" /> Cancel punch
        </button>
        <button type="button" className="tcx-btn is-primary" disabled={busy} onClick={onOverride}>
          <IconShield className="tcx-btn-icon" /> Admin override
        </button>
      </div>
    </section>
  );
}

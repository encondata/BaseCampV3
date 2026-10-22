/** Is this you? The person's photo (initials when there is none), name,
 *  job title and employee ID. In landscape the photo sits left of the
 *  words and buttons. */

import { useState } from 'react';

import type { KioskTimeclockPerson } from '../../lib/api';
import { IconArrowRight } from '../icons';

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? words[words.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase();
}

export interface ConfirmPersonProps {
  person: KioskTimeclockPerson;
  onYes(): void;
  onNo(): void;
}

export default function ConfirmPerson({ person, onYes, onNo }: ConfirmPersonProps) {
  const [photoFailed, setPhotoFailed] = useState(false);
  return (
    <section className="tcx-screen tcx-confirm">
      {person.avatar_url && !photoFailed ? (
        <img className="tcx-avatar" src={person.avatar_url} alt="" onError={() => setPhotoFailed(true)} />
      ) : (
        <div className="tcx-avatar tcx-initials" aria-hidden="true">{initialsOf(person.display_name)}</div>
      )}
      <div className="tcx-confirm-body">
        <h1 className="tcx-ask">Is this you?</h1>
        <p className="tcx-person-name">{person.display_name}</p>
        {person.job_title && <p className="tcx-person-meta">{person.job_title}</p>}
        {person.external_id && <p className="tcx-person-meta">Employee ID {person.external_id}</p>}
        <div className="tcx-buttons">
          <button type="button" className="tcx-btn is-primary" onClick={onYes}>
            Yes, that&apos;s me <IconArrowRight className="tcx-btn-icon" />
          </button>
          <button type="button" className="tcx-btn is-ghost" onClick={onNo}>No, search again</button>
        </div>
      </div>
    </section>
  );
}

/** Enter Your Name: the search box (which a badge reader can type into as
 *  well), up to eight matching people to tap, and the on-screen keyboard.
 *  In landscape the results sit beside the keyboard. */

import type { ReactNode } from 'react';

import type { KioskPersonRow } from '../../lib/api';
import { IconChevron, IconSearch } from '../icons';

export interface EnterNameProps {
  /** The focused search box. */
  searchInput: ReactNode;
  keyboard: ReactNode;
  results: KioskPersonRow[];
  /** The box has text but nobody matches it. */
  noMatches: boolean;
  message: string | null;
  disabled: boolean;
  onPick(person: KioskPersonRow): void;
}

export default function EnterName({
  searchInput, keyboard, results, noMatches, message, disabled, onPick,
}: EnterNameProps) {
  return (
    <section className="tcx-screen tcx-name">
      <h1 className="tcx-title">Enter Your Name</h1>
      <p className="tcx-lead">Type your name below to find your account.</p>
      <label className="tcx-search">
        <IconSearch className="tcx-search-icon" />
        {searchInput}
      </label>
      {message && <p className="tcx-error-text" role="alert">{message}</p>}
      <div className="tcx-name-body">
        <div className="tcx-results" aria-live="polite">
          {results.map((person) => (
            <button
              type="button" key={person.id} className="tcx-result" disabled={disabled}
              onClick={() => onPick(person)}
            >
              <span className="tcx-result-name">{person.display_name}</span>
              {person.job_title && <span className="tcx-result-sub">{person.job_title}</span>}
              <IconChevron className="tcx-result-chev" />
            </button>
          ))}
          {noMatches && <p className="tcx-hint">No one matches that name yet. Keep typing or check the spelling.</p>}
        </div>
        {keyboard}
      </div>
    </section>
  );
}

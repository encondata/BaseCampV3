/** Enter Your Name: the search box (a physical keyboard and a badge reader
 *  both type into it), up to eight matching people to tap, and an
 *  on-screen keyboard that is hidden until the keyboard button in the box
 *  turns it on. With it shown in landscape the results sit beside it;
 *  hidden, the results list gets the room. */

import type { ReactNode } from 'react';

import type { KioskPersonRow } from '../../lib/api';
import { IconChevron, IconKeyboardToggle, IconSearch } from '../icons';

export interface EnterNameProps {
  /** The focused search box. */
  searchInput: ReactNode;
  /** The on-screen keyboard, rendered only while it is shown. */
  keyboard: ReactNode;
  keyboardShown: boolean;
  onToggleKeyboard(): void;
  results: KioskPersonRow[];
  /** The box has text but nobody matches it. */
  noMatches: boolean;
  message: string | null;
  disabled: boolean;
  onPick(person: KioskPersonRow): void;
}

export default function EnterName({
  searchInput, keyboard, keyboardShown, onToggleKeyboard, results, noMatches, message, disabled, onPick,
}: EnterNameProps) {
  return (
    <section className="tcx-screen tcx-name">
      <h1 className="tcx-title">Enter Your Name</h1>
      <p className="tcx-lead">Type your name below to find your account.</p>
      <div className="tcx-search">
        <IconSearch className="tcx-search-icon" />
        {searchInput}
        <button
          type="button"
          className="tcx-kb-toggle"
          aria-label={keyboardShown ? 'Hide on-screen keyboard' : 'Show on-screen keyboard'}
          aria-pressed={keyboardShown}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleKeyboard}
        >
          <IconKeyboardToggle />
        </button>
      </div>
      {message && <p className="tcx-error-text" role="alert">{message}</p>}
      <div className={`tcx-name-body${keyboardShown ? '' : ' is-bare'}`}>
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

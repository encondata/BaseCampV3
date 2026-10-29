/** The signed-in learner's training and history, loaded once by the shell
 *  (`LearnerDataProvider`) and shared with its pages and its nav (the
 *  time clock code item); a page rendered outside the provider (a test)
 *  loads its own. Leaving a document or its quiz loads both again: a
 *  sign-off there changes what is due and what is done. Also the name
 *  the shell and the greetings use. */
import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import type { PersonOut } from '@portal/lib/api';

import { getFirstName } from './session';
import { getHistory, getTraining, type HistoryItem, type Training } from './training';
import { useLoad, type UseLoad } from './useLoad';

export interface LearnerData {
  training: UseLoad<Training>;
  history: UseLoad<HistoryItem[]>;
}

const LearnerDataContext = createContext<LearnerData | null>(null);

// a document (`/training/:id`) or its quiz
const DOCUMENT = /^\/training\/[^/]+/;

export function LearnerDataProvider({ children }: { children: ReactNode }) {
  // a reload keeps what is on screen (the nav's time clock code, the lists)
  const training = useLoad(getTraining, [], { keepData: true });
  const history = useLoad(getHistory, [], { keepData: true });
  const { pathname } = useLocation();
  const previous = useRef(pathname);
  useEffect(() => {
    if (DOCUMENT.test(previous.current) && !DOCUMENT.test(pathname)) {
      training.reload();
      history.reload();
    }
    previous.current = pathname;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  return createElement(LearnerDataContext.Provider, { value: { training, history } }, children);
}

export function useLearnerData(): LearnerData {
  const shared = useContext(LearnerDataContext);
  const training = useLoad(getTraining, [], { enabled: !shared });
  const history = useLoad(getHistory, [], { enabled: !shared });
  return shared ?? { training, history };
}

/** An account's own names; a code session has only the first name its
 *  sign-in answered with, so that is both. */
export function learnerName(person: PersonOut | null): { first: string; full: string } {
  if (person) return { first: person.first_name, full: person.display_name };
  const first = getFirstName();
  return { first, full: first };
}

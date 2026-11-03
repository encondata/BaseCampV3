/** The signed-in learner's training and history, loaded once by the shell
 *  (`LearnerDataProvider`) and shared with its pages and its nav (the
 *  time clock code item); a page rendered outside the provider (a test)
 *  loads its own. Leaving a document or its quiz loads both again: a
 *  sign-off there changes what is due and what is done. The Reader marks
 *  its sign-off right away (`markSigned`), so the list never shows the
 *  document open while that load runs, or after it fails. Also the name
 *  the shell and the greetings use. */
import { createContext, createElement, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import type { PersonOut } from '@portal/lib/api';

import { getFirstName } from './session';
import { getHistory, getTraining, type HistoryItem, type Training } from './training';
import { useLoad, type UseLoad } from './useLoad';

export interface LearnerData {
  training: UseLoad<Training>;
  history: UseLoad<HistoryItem[]>;
  /** A document was just signed: its item reads signed, and `complete`
   *  takes the sign-off's answer. A no-op outside the provider. */
  markSigned: (assignmentId: string, signedAt: string, complete: boolean) => void;
}

const LearnerDataContext = createContext<LearnerData | null>(null);

// a document (`/training/:id`) or its quiz
const DOCUMENT = /^\/training\/[^/]+/;

/** A document or its quiz is on screen. */
export const isDocumentPath = (pathname: string) => DOCUMENT.test(pathname);

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
  const { patch } = training;
  const markSigned = useCallback((assignmentId: string, signedAt: string, complete: boolean) => {
    patch((data) => ({
      ...data,
      complete,
      groups: data.groups.map((g) => ({
        ...g,
        items: g.items.map((i) => (i.assignment_id === assignmentId
          ? { ...i, status: 'signed' as const, signed_at: signedAt } : i)),
      })),
    }));
  }, [patch]);
  return createElement(LearnerDataContext.Provider, { value: { training, history, markSigned } }, children);
}

const noop = () => {};

export function useLearnerData(): LearnerData {
  const shared = useContext(LearnerDataContext);
  const training = useLoad(getTraining, [], { enabled: !shared });
  const history = useLoad(getHistory, [], { enabled: !shared });
  return shared ?? { training, history, markSigned: noop };
}

/** `markSigned` alone, for a page that doesn't read the lists (and so
 *  loads nothing outside the provider). */
export function useMarkSigned(): LearnerData['markSigned'] {
  return useContext(LearnerDataContext)?.markSigned ?? noop;
}

/** An account's own names; a code session has only the first name its
 *  sign-in answered with, so that is both. */
export function learnerName(person: PersonOut | null): { first: string; full: string } {
  if (person) return { first: person.first_name, full: person.display_name };
  const first = getFirstName();
  return { first, full: first };
}

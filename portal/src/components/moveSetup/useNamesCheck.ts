/** The crate and truck steps' live clash check. Once the naming rule is
 *  happy (`body` is not null) the section saves itself, debounced, so the
 *  server can report names already held by non-archived records. Every
 *  save carries a sequence number: a newer save, `saveNow`, `settle`, or
 *  unmounting makes an older response stale, and a stale response is
 *  dropped. */
import { useEffect, useRef, useState } from 'react';

import {
  patchMoveSetup, type MoveSetupCrates, type MoveSetupDraft, type MoveSetupTrucks,
} from '../../lib/api';
import { moveSetupError } from '../../lib/moveSetup';

export const SAVE_MS = 400;

type Section = 'crates' | 'trucks';
type Body<S extends Section> = S extends 'crates' ? MoveSetupCrates : MoveSetupTrucks;

export function useNamesCheck<S extends Section>(
  draftId: string, section: S, body: Body<S> | null,
  onDraft: (draft: MoveSetupDraft) => void, setError: (message: string) => void,
) {
  const [clashes, setClashes] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef<Promise<unknown> | null>(null);
  // held in refs so a caller's inline callbacks never re-trigger the save
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const setErrorRef = useRef(setError);
  setErrorRef.current = setError;
  const bodyKey = body === null ? null : JSON.stringify(body);

  const send = (next: Body<S>) => {
    const request = patchMoveSetup(draftId, { [section]: next });
    inFlight.current = request;
    void request.catch(() => undefined).finally(() => {
      if (inFlight.current === request) inFlight.current = null;
    });
    return request;
  };

  useEffect(() => {
    if (bodyKey === null) { setChecking(false); setClashes([]); return undefined; }
    const mine = ++seq.current;
    setChecking(true);
    timer.current = setTimeout(() => {
      send(JSON.parse(bodyKey) as Body<S>).then((saved) => {
        if (mine !== seq.current) return;
        onDraftRef.current(saved);
        setClashes(saved.previews?.[section]?.clashes ?? []);
        setChecking(false);
      }).catch((err: unknown) => {
        if (mine !== seq.current) return;
        setChecking(false);
        setErrorRef.current(moveSetupError(err));
      });
    }, SAVE_MS);
    return () => clearTimeout(timer.current);
  }, [bodyKey, draftId, section]);   // eslint-disable-line react-hooks/exhaustive-deps

  // a response landing after the step is gone must not overwrite the page's draft
  useEffect(() => () => { seq.current += 1; }, []);

  /** Next: save now, superseding any debounced save; resolves to the clashes. */
  const saveNow = async (next: Body<S>): Promise<string[]> => {
    clearTimeout(timer.current);
    const mine = ++seq.current;
    const saved = await send(next);
    onDraftRef.current(saved);
    const found = saved.previews?.[section]?.clashes ?? [];
    if (mine === seq.current) { setClashes(found); setChecking(false); }
    return found;
  };

  /** Skip: drop any pending save and wait out one already sent, so the
   *  skip can't reach the server ahead of it and be undone. */
  const settle = async () => {
    clearTimeout(timer.current);
    seq.current += 1;
    setChecking(false);
    await inFlight.current?.catch(() => undefined);
  };

  return { clashes, checking, saveNow, settle };
}

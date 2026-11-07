/** The ready snapshots, and the one picked, opened in the scratch database
 *  for browsing: polled every OPEN_POLL_MS while it restores, and opened
 *  again when the status (or a browse call, through reopen) finds the
 *  scratch copy gone. Shared by the Seed Data pages. */
import { useCallback, useEffect, useRef, useState } from 'react';

import { listSnapshots, type Snapshot } from '../../lib/sirdarApi';

import { openSnapshot, seedErrorText, snapshotStatus, type ScratchStatus } from './seedApi';

/** While the snapshot restores into the scratch database, its status is polled this often. */
export const OPEN_POLL_MS = 2000;

export type Phase = 'idle' | 'opening' | 'ready' | 'failed';

export function useScratchSnapshot(setError: (msg: string) => void) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapId, setSnapId] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [pollTick, setPollTick] = useState(0);

  const errRef = useRef(setError);
  errRef.current = setError;

  useEffect(() => {
    listSnapshots()
      .then((r) => setSnapshots(r.snapshots.filter((s) => s.status === 'ready')))
      .catch((e) => errRef.current(seedErrorText(e, "Couldn't load snapshots.")));
  }, []);

  const snapRef = useRef(snapId);
  snapRef.current = snapId;
  const landStatus = useCallback((id: string, status: ScratchStatus) => {
    if (id !== snapRef.current) return;
    if (status === 'ready') setPhase('ready');
    else if (status === 'failed') {
      setPhase('failed');
      errRef.current("This snapshot's database couldn't be opened for browsing.");
    } else {
      // restoring, or absent (not started yet): poll again
      setPhase('opening');
      setPollTick((t) => t + 1);
    }
  }, []);
  const fail = useCallback((id: string, e: unknown) => {
    if (id !== snapRef.current) return;
    setPhase('failed');
    errRef.current(seedErrorText(e, "Couldn't open that snapshot."));
  }, []);
  const open = useCallback((id: string) => {
    setPhase('opening');
    openSnapshot(id).then((r) => landStatus(id, r.status)).catch((e) => fail(id, e));
  }, [landStatus, fail]);
  /** A browse call found the scratch copy gone: open it again. */
  const reopen = useCallback(() => { if (snapRef.current) open(snapRef.current); }, [open]);

  useEffect(() => {
    if (phase !== 'opening' || !snapId) return undefined;
    const id = snapId;
    const timer = setTimeout(() => {
      snapshotStatus(id)
        .then((r) => {
          // absent (Sirdar restarted mid-restore, or the copy was dropped): open
          // it again; open() lands its answer, which schedules the next poll
          if (r.status === 'absent') { open(id); return; }
          landStatus(id, r.status);
        })
        .catch((e) => fail(id, e));
    }, OPEN_POLL_MS);
    return () => clearTimeout(timer);
  }, [phase, snapId, pollTick, open, landStatus, fail]);

  /** Pick a snapshot ('' for none) and start opening it. */
  const pickSnapshot = useCallback((id: string) => {
    setSnapId(id);
    snapRef.current = id;
    if (id) open(id); else setPhase('idle');
  }, [open]);

  /** Whether `id` is still the snapshot picked (for late answers). */
  const isCurrent = useCallback((id: string) => id === snapRef.current, []);

  return { snapshots, snapId, phase, pickSnapshot, reopen, isCurrent };
}

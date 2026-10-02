/**
 * While someone is signed in, tell the API this kiosk is alive: an
 * immediate beat, then one every minute. Each beat upserts the kiosk's
 * Device row and returns the registration state for the shell chip.
 * Failures (offline, read-only mode's 423, a 403) keep the last state
 * and are retried on the next tick. A reply's `clear_setup` id is applied
 * once via setupClear.ts and acknowledged on an immediate re-beat.
 */

import { heartbeatRequest, type RegistrationState } from './api';
import { kioskVersion } from './config';
import { getIdentity } from './identity';
import { platform } from './platform';
import { applySetupClear, pendingAck, settleAck } from './setupClear';

export const HEARTBEAT_MS = 60_000;

export interface HeartbeatHandle {
  stop(): void;
  /** Beat right now (after a rename). Resolves after the attempt. */
  now(): Promise<void>;
}

export function startHeartbeat(
  onState: (state: RegistrationState) => void,
  intervalMs: number = HEARTBEAT_MS,
  signIn?: { method: 'password' | 'link' },
  onClearSetup?: (id: string) => void,
): HeartbeatHandle {
  let stopped = false;
  // Seeded from the sign-in that started this heartbeat; every beat sends
  // sign_in while this is set, and it's cleared only once a beat carrying
  // it RESOLVES successfully — a failed beat leaves it set so the next
  // tick (or now()) retries until the server has recorded the sign-in.
  let pendingSignIn = signIn;
  const beat = async () => {
    if (stopped) return;
    const { serial, name } = getIdentity();
    const asSignIn = pendingSignIn;
    const ack = pendingAck();
    try {
      const result = await heartbeatRequest({
        serial, name, mode: platform().mode, version: kioskVersion(),
        ...(asSignIn ? { sign_in: true, login_method: asSignIn.method } : {}),
        ...(ack ? { setup_cleared: ack } : {}),
      });
      if (asSignIn) pendingSignIn = undefined;
      // Settle and apply before onState, so a throwing onState can't defer
      // the clear. The clear is applied even when stopped (the admin asked
      // for it; the ack goes out on the next session's beats), but the
      // callback and the immediate re-beat only run while we're live.
      const asked = result.clear_setup ?? null;
      settleAck(ack, asked);
      if (asked !== null && applySetupClear(asked) && !stopped) {
        onClearSetup?.(asked);
        void beat();                        // acknowledge right away
      }
      if (!stopped) onState(result.registration);
    } catch {
      /* keep the last known state (and any pending sign-in); next tick retries */
    }
  };
  void beat();
  const timer = setInterval(() => void beat(), intervalMs);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    now: () => beat(),
  };
}

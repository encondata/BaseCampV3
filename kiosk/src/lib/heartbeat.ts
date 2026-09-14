/**
 * While someone is signed in, tell the API this kiosk is alive: an
 * immediate beat, then one every minute. Each beat upserts the kiosk's
 * Device row and returns the registration state for the shell chip.
 * Failures (offline, read-only mode's 423, a 403) keep the last state
 * and are retried on the next tick.
 */

import { heartbeatRequest, type RegistrationState } from './api';
import { kioskVersion } from './config';
import { getIdentity } from './identity';
import { platform } from './platform';

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
): HeartbeatHandle {
  let stopped = false;
  const beat = async (asSignIn?: { method: 'password' | 'link' }) => {
    if (stopped) return;
    const { serial, name } = getIdentity();
    try {
      const result = await heartbeatRequest({
        serial, name, mode: platform().mode, version: kioskVersion(),
        ...(asSignIn ? { sign_in: true, login_method: asSignIn.method } : {}),
      });
      if (!stopped) onState(result.registration);
    } catch {
      /* keep the last known state; next tick retries */
    }
  };
  void beat(signIn);
  const timer = setInterval(() => void beat(), intervalMs);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    now: () => beat(),
  };
}

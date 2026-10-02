/**
 * Kiosk session state. Mirrors the portal's AuthContext without its
 * god-mode/preferences plumbing: restore from the refresh cookie on
 * mount, login (password) or completePair (link with phone), logout,
 * and the heartbeat that runs while signed in.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';

import { ADMIN_RANK, computeCan, type Action, type PermMap } from '@portal/lib/access';

import {
  installVisibilityRefresh, loginRequest, logoutRequest, moveLoginRequest, onSessionEnded, refreshSession,
  signOutRequest,
  type PersonOut, type RegistrationState, type SessionData, type UiPreferences,
} from '../lib/api';
import { HEARTBEAT_MS, startHeartbeat, type HeartbeatHandle } from '../lib/heartbeat';
import { getIdentity } from '../lib/identity';
import { clearKioskSetup, readKioskSetup } from '../lib/kioskSetup';
import { writeSetupState } from '../lib/setupState';

export type KioskAuthStatus = 'loading' | 'authed' | 'anon';

interface State {
  status: KioskAuthStatus;
  person: PersonOut | null;
  perms: PermMap | null;
  preferences: UiPreferences | null;
  mustChangePassword: boolean;
  mustChangeReason: 'temporary' | 'expired' | null;
  sessionExpiresAt: string | null;
  roles: string[];
  maxRank: number;
  /** The move a move-password session is locked to; null for a person sign-in. */
  kioskMove: { initiative_id: string; name: string } | null;
}

export interface KioskAuthValue extends State {
  registration: RegistrationState | null;
  isAdmin: boolean;
  isDeveloper: boolean;
  login: (email: string, password: string) => Promise<SessionData>;
  loginWithMovePassword: (password: string) => Promise<SessionData>;
  completePair: (session: SessionData) => void;
  logout: () => Promise<void>;
  can: (resource: string, action: Action) => boolean;
  heartbeatNow: () => Promise<void>;
  /** True from the moment a Clear Setup is applied until the shell has
   *  redirected to Kiosk Setup and called consumeSetupRedirect(). One-shot,
   *  so a shell remount never re-sends the person. */
  setupRedirectPending: boolean;
  consumeSetupRedirect: () => void;
}

const ANON: State = {
  status: 'anon', person: null, perms: null, preferences: null,
  mustChangePassword: false, mustChangeReason: null, sessionExpiresAt: null, roles: [], maxRank: 0,
  kioskMove: null,
};
const LOADING: State = { ...ANON, status: 'loading' };

function stateFrom(s: SessionData): State {
  return {
    status: 'authed', person: s.person, perms: s.perms, preferences: s.preferences,
    mustChangePassword: s.must_change_password, mustChangeReason: s.must_change_reason ?? null,
    sessionExpiresAt: s.session_expires_at, roles: s.roles, maxRank: s.max_rank,
    kioskMove: s.kiosk_move ?? null,
  };
}

const Ctx = createContext<KioskAuthValue | null>(null);

export function KioskAuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(LOADING);
  const [registration, setRegistration] = useState<RegistrationState | null>(null);
  const [setupRedirectPending, setSetupRedirectPending] = useState(false);
  const heartbeat = useRef<HeartbeatHandle | null>(null);
  // Set only for the beat right after login()/completePair() — never for a
  // cookie restore — so the API can auto-register the kiosk on sign-in and
  // record how the person signed in.
  const signInRef = useRef<{ method: 'password' | 'link' } | undefined>(undefined);

  // Hard reload within the session window: the cookie restores it silently.
  useEffect(() => {
    let cancelled = false;
    void refreshSession().then((data) => {
      if (!cancelled) setState(data ? stateFrom(data) : ANON);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => onSessionEnded(() => setState(ANON)), []);

  // A move-password session works only on its own move. A setup saved for
  // another move (an earlier sign-in) would otherwise keep driving the
  // screens and the footer, and every call naming it would be refused
  // (move_locked) — so drop it and send the crew back to Kiosk Setup.
  // Keyed on the move, so it runs once per sign-in (and on a cookie restore).
  const lockedMove = state.kioskMove?.initiative_id ?? null;
  useEffect(() => {
    if (lockedMove === null) return;
    const saved = readKioskSetup();
    if (saved !== null && saved.initiativeId !== lockedMove) {
      clearKioskSetup();
      writeSetupState('incomplete');
    }
  }, [lockedMove]);
  useEffect(() => installVisibilityRefresh(), []);

  // Heartbeat only while a usable session exists.
  useEffect(() => {
    if (state.status !== 'authed' || state.mustChangePassword) {
      heartbeat.current = null;
      setRegistration(null);
      setSetupRedirectPending(false);   // never carry a redirect into the next sign-in
      return;
    }
    const handle = startHeartbeat(setRegistration, HEARTBEAT_MS, signInRef.current,
      () => setSetupRedirectPending(true));
    signInRef.current = undefined;
    heartbeat.current = handle;
    return () => {
      handle.stop();
      if (heartbeat.current === handle) heartbeat.current = null;
    };
  }, [state.status, state.mustChangePassword]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await loginRequest(email, password);
    signInRef.current = { method: 'password' };
    setState(stateFrom(data));
    return data;
  }, []);

  const loginWithMovePassword = useCallback(async (password: string) => {
    const data = await moveLoginRequest(password);
    // The heartbeat's login_method only knows password | link; a move-password
    // sign-in is a password sign-in as far as device registration goes.
    signInRef.current = { method: 'password' };
    setState(stateFrom(data));
    return data;
  }, []);

  const completePair = useCallback((data: SessionData) => {
    signInRef.current = { method: 'link' };
    setState(stateFrom(data));
  }, []);

  const logout = useCallback(async () => {
    heartbeat.current?.stop();
    await signOutRequest(getIdentity().serial);
    await logoutRequest();
    setState(ANON);
  }, []);

  const can = useCallback(
    (resource: string, action: Action) => computeCan(state.perms, resource, action),
    [state.perms],
  );

  const consumeSetupRedirect = useCallback(() => setSetupRedirectPending(false), []);

  const heartbeatNow = useCallback(() => heartbeat.current?.now() ?? Promise.resolve(), []);

  const isAdmin = state.maxRank >= ADMIN_RANK;
  const isDeveloper = state.roles.includes('developer');

  const value = useMemo<KioskAuthValue>(
    () => ({ ...state, registration, isAdmin, isDeveloper, login, loginWithMovePassword, completePair, logout, can, heartbeatNow, setupRedirectPending, consumeSetupRedirect }),
    [state, registration, isAdmin, isDeveloper, login, loginWithMovePassword, completePair, logout, can, heartbeatNow,
      setupRedirectPending, consumeSetupRedirect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useKioskAuth(): KioskAuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useKioskAuth must be used inside KioskAuthProvider');
  return v;
}

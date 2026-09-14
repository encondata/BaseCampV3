/**
 * Kiosk session state. Mirrors the portal's AuthContext without its
 * god-mode/preferences plumbing: restore from the refresh cookie on
 * mount, login (password) or completePair (link with phone), logout,
 * and the heartbeat that runs while signed in.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';

import { computeCan, type Action, type PermMap } from '@portal/lib/access';

import {
  installVisibilityRefresh, loginRequest, logoutRequest, onSessionEnded, refreshSession,
  type PersonOut, type RegistrationState, type SessionData, type UiPreferences,
} from '../lib/api';
import { HEARTBEAT_MS, startHeartbeat, type HeartbeatHandle } from '../lib/heartbeat';

export type KioskAuthStatus = 'loading' | 'authed' | 'anon';

interface State {
  status: KioskAuthStatus;
  person: PersonOut | null;
  perms: PermMap | null;
  preferences: UiPreferences | null;
  mustChangePassword: boolean;
  sessionExpiresAt: string | null;
}

export interface KioskAuthValue extends State {
  registration: RegistrationState | null;
  login: (email: string, password: string) => Promise<SessionData>;
  completePair: (session: SessionData) => void;
  logout: () => Promise<void>;
  can: (resource: string, action: Action) => boolean;
  heartbeatNow: () => Promise<void>;
}

const ANON: State = {
  status: 'anon', person: null, perms: null, preferences: null,
  mustChangePassword: false, sessionExpiresAt: null,
};
const LOADING: State = { ...ANON, status: 'loading' };

function stateFrom(s: SessionData): State {
  return {
    status: 'authed', person: s.person, perms: s.perms, preferences: s.preferences,
    mustChangePassword: s.must_change_password, sessionExpiresAt: s.session_expires_at,
  };
}

const Ctx = createContext<KioskAuthValue | null>(null);

export function KioskAuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(LOADING);
  const [registration, setRegistration] = useState<RegistrationState | null>(null);
  const heartbeat = useRef<HeartbeatHandle | null>(null);
  // True only for the beat right after login()/completePair() — never for a
  // cookie restore — so the API can auto-register the kiosk on sign-in.
  const signInRef = useRef(false);

  // Hard reload within the session window: the cookie restores it silently.
  useEffect(() => {
    let cancelled = false;
    void refreshSession().then((data) => {
      if (!cancelled) setState(data ? stateFrom(data) : ANON);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => onSessionEnded(() => setState(ANON)), []);
  useEffect(() => installVisibilityRefresh(), []);

  // Heartbeat only while a usable session exists.
  useEffect(() => {
    if (state.status !== 'authed' || state.mustChangePassword) {
      heartbeat.current = null;
      setRegistration(null);
      return;
    }
    const handle = startHeartbeat(setRegistration, HEARTBEAT_MS, signInRef.current);
    signInRef.current = false;
    heartbeat.current = handle;
    return () => {
      handle.stop();
      if (heartbeat.current === handle) heartbeat.current = null;
    };
  }, [state.status, state.mustChangePassword]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await loginRequest(email, password);
    signInRef.current = true;
    setState(stateFrom(data));
    return data;
  }, []);

  const completePair = useCallback((data: SessionData) => {
    signInRef.current = true;
    setState(stateFrom(data));
  }, []);

  const logout = useCallback(async () => {
    heartbeat.current?.stop();
    await logoutRequest();
    setState(ANON);
  }, []);

  const can = useCallback(
    (resource: string, action: Action) => computeCan(state.perms, resource, action),
    [state.perms],
  );

  const heartbeatNow = useCallback(() => heartbeat.current?.now() ?? Promise.resolve(), []);

  const value = useMemo<KioskAuthValue>(
    () => ({ ...state, registration, login, completePair, logout, can, heartbeatNow }),
    [state, registration, login, completePair, logout, can, heartbeatNow],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useKioskAuth(): KioskAuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useKioskAuth must be used inside KioskAuthProvider');
  return v;
}

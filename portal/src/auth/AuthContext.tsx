import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

import {
  installVisibilityRefresh,
  loginRequest,
  logoutRequest,
  onSessionEnded,
  refreshSession,
  savePreferencesRequest,
  type PersonDetail,
  type PersonOut,
  type SessionData,
  type UiPreferences,
} from '../lib/api';
import { computeCan, type Action, type PermMap, type ScopeInfo } from '../lib/access';
import { DEFAULT_PREFERENCES } from '../lib/settings';

type AuthStatus = 'loading' | 'authed' | 'anon';

interface AuthState {
  status: AuthStatus;
  person: PersonOut | null;
  roles: string[];
  mustChangePassword: boolean;
  sessionExpiresAt: string | null;
  preferences: UiPreferences;
  perms: PermMap | null;
  maxRank: number;
  scope: ScopeInfo | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<SessionData>;
  logout: () => Promise<void>;
  hasRole: (...names: string[]) => boolean;
  /** Resource/action permission check, backed by the session's perms matrix. */
  can: (resource: string, action?: Action) => boolean;
  /** Optimistically applies, then persists to the account. Resolves false
   *  if the server save failed (the UI change still sticks locally). */
  updatePreferences: (prefs: UiPreferences) => Promise<boolean>;
  /** Sync the in-context person after a profile edit (name in the nav chip). */
  applyProfile: (detail: PersonDetail) => void;
  /** Called after a successful password change (forced-change gate). */
  clearMustChange: () => void;
  /** God mode is a VISIBILITY toggle only — the server still enforces the
   *  `devtools` permission on every request regardless of this flag. */
  godMode: boolean;
  godNavColor: string | null;
  enableGodMode: (color: string) => void;
  exitGodMode: () => void;
}

const ANON: AuthState = {
  status: 'anon',
  person: null,
  roles: [],
  mustChangePassword: false,
  sessionExpiresAt: null,
  preferences: DEFAULT_PREFERENCES,
  perms: null,
  maxRank: 0,
  scope: null,
};

const AuthContext = createContext<AuthContextValue | null>(null);

function stateFrom(data: SessionData): AuthState {
  return {
    status: 'authed',
    person: data.person,
    roles: data.roles,
    mustChangePassword: data.must_change_password,
    sessionExpiresAt: data.session_expires_at,
    preferences: data.preferences,
    perms: data.perms,
    maxRank: data.max_rank,
    scope: data.scope,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ ...ANON, status: 'loading' });

  // God mode is deliberately in-memory only: a reload drops it, and nothing
  // in storage advertises that the mode exists.
  const [godMode, setGodMode] = useState(false);
  const [godNavColor, setGodNavColor] = useState<string | null>(null);

  const enableGodMode = useCallback((color: string) => {
    setGodNavColor(color);
    setGodMode(true);
  }, []);

  const exitGodMode = useCallback(() => {
    setGodMode(false);
    setGodNavColor(null);
  }, []);

  // On first load, try the refresh cookie: a hard reload (or reopened
  // browser) within the 24h window restores the session silently.
  useEffect(() => {
    let cancelled = false;
    void refreshSession().then((data) => {
      if (!cancelled) setState(data ? stateFrom(data) : ANON);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Graceful end-of-session: flip to anon; ProtectedRoute preserves location.
  useEffect(() => onSessionEnded(() => setState(ANON)), []);

  // Tab re-focus after idle: refresh before any data request fires.
  useEffect(() => installVisibilityRefresh(), []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await loginRequest(email, password);
    setState(stateFrom(data));
    return data;
  }, []);

  const logout = useCallback(async () => {
    await logoutRequest();
    setState(ANON);
    exitGodMode();
  }, [exitGodMode]);

  const hasRole = useCallback(
    (...names: string[]) => names.some((n) => state.roles.includes(n)),
    [state.roles],
  );

  const can = useCallback(
    (resource: string, action: Action = 'view') =>
      computeCan(state.perms, resource, action),
    [state.perms],
  );

  const updatePreferences = useCallback(async (prefs: UiPreferences) => {
    setState((prev) => ({ ...prev, preferences: prefs }));
    try {
      await savePreferencesRequest(prefs);
      return true;
    } catch {
      return false;
    }
  }, []);

  const applyProfile = useCallback((detail: PersonDetail) => {
    setState((prev) => ({
      ...prev,
      person: prev.person && {
        ...prev.person,
        first_name: detail.first_name,
        last_name: detail.last_name,
        preferred_name: detail.preferred_name,
        display_name: detail.display_name,
        email: detail.email,
        job_title: detail.job_title,
        avatar_key: detail.avatar_key,
        avatar_url: detail.avatar_url,
      },
    }));
  }, []);

  const clearMustChange = useCallback(() => {
    setState((prev) => ({ ...prev, mustChangePassword: false }));
  }, []);

  return (
    <AuthContext.Provider
      value={{
        ...state, login, logout, hasRole, can, updatePreferences, applyProfile, clearMustChange,
        godMode, godNavColor, enableGodMode, exitGodMode,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

// @vitest-environment jsdom
/**
 * lib/listPrefs.tsx: the list-settings context the shared list modules read
 * instead of useAuth(), so the kiosk can provide its own. The default is
 * inert; the account hook saves onto the latest preferences with one stable
 * save function, so one change makes exactly one save.
 */
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UiPreferences } from './api';

const api = vi.hoisted(() => ({
  loginRequest: vi.fn(),
  refreshSession: vi.fn(async () => null),
  logoutRequest: vi.fn(),
  onSessionEnded: vi.fn(() => () => {}),
  installVisibilityRefresh: vi.fn(() => () => {}),
  savePreferencesRequest: vi.fn(async () => undefined),
  isTotpChallenge: (r: { status: string }) => r.status !== 'ok',
}));
vi.mock('./api', () => api);

const { ListPrefsContext, NO_LIST_PREFS, useAccountListPrefs, useListPrefs } = await import('./listPrefs');
const { usePersistentListState } = await import('./columnMenu');
const { AuthProvider } = await import('../auth/AuthContext');

const PREFS: UiPreferences = {
  accent: 'amber', theme: 'light', density: 'comfortable', list_size: 'default', motion: true,
  nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default', list_view: 'expanded',
  notif: { sound: 'chime', switches: {}, schedule: { timezone: null, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], quiet_start: null, quiet_end: null } },
  list_prefs: {},
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('listPrefs', () => {
  it('the default value renders with no provider', () => {
    const { result } = renderHook(useListPrefs);
    expect(result.current.listPrefs).toEqual({});
    expect(result.current.listSize).toBeUndefined();
    expect(() => result.current.saveListPrefs({ a: 1 })).not.toThrow();
  });

  it('account prefs save onto the latest preferences', () => {
    const updatePreferences = vi.fn();
    const start: UiPreferences = { ...PREFS, list_size: 'large', list_prefs: { a: 1 } };
    const { result, rerender } = renderHook(
      ({ prefs }) => useAccountListPrefs(prefs, updatePreferences),
      { initialProps: { prefs: start } },
    );
    const firstSave = result.current.saveListPrefs;
    rerender({ prefs: { ...start, accent: 'pink' } });
    expect(result.current.saveListPrefs).toBe(firstSave); // one identity for the hook's lifetime

    result.current.saveListPrefs({ b: 2 });
    expect(updatePreferences).toHaveBeenCalledTimes(1);
    const saved = updatePreferences.mock.calls[0][0] as UiPreferences;
    expect(saved.list_prefs).toEqual({ b: 2 });
    expect(saved.accent).toBe('pink');
    expect(saved.list_size).toBe('large');
    expect(result.current.listSize).toBe('large');
    expect(result.current.listPrefs).toEqual({ a: 1 });
  });

  it('one change saves once', () => {
    vi.useFakeTimers();
    const updatePreferences = vi.fn();
    function Holder({ children }: { children: ReactNode }) {
      const [prefs, setPrefs] = useState<UiPreferences>(PREFS);
      // A fresh function every render, like an unmemoized provider: the
      // stable saveListPrefs must still keep the save effect from re-running.
      const update = (next: UiPreferences) => {
        updatePreferences(next);
        setPrefs(next);
        return Promise.resolve(true);
      };
      const value = useAccountListPrefs(prefs, update);
      return <ListPrefsContext.Provider value={value}>{children}</ListPrefsContext.Provider>;
    }
    const { result } = renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'status']), sortKey: 'name', sortDir: 1,
    }), { wrapper: Holder });

    act(() => { result.current.setSort('name', -1); });
    act(() => { vi.advanceTimersByTime(600); });
    act(() => { vi.advanceTimersByTime(5000); });

    expect(updatePreferences).toHaveBeenCalledTimes(1);
    const saved = updatePreferences.mock.calls[0][0] as UiPreferences;
    expect(saved.list_prefs.sites).toEqual({
      visible: ['name', 'status'], sortKey: 'name', sortDir: -1, filters: {}, order: [], seen: ['name', 'status'],
    });
  });

  it('AuthProvider provides account list prefs', async () => {
    let seen: ReturnType<typeof useListPrefs> | null = null;
    function Probe() { seen = useListPrefs(); return null; }
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => {});
    expect(seen).not.toBeNull();
    expect(seen).not.toBe(NO_LIST_PREFS);
  });
});

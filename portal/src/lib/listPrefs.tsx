/**
 * List settings (column state per page, list text size) for the shared list
 * modules — lib/columnMenu's usePersistentListState and the Print Labels
 * lists — through a context instead of useAuth(), so an app without the
 * portal's AuthProvider (the kiosk) can provide its own store.
 *
 * In the portal, AuthProvider provides `useAccountListPrefs`: the account's
 * `preferences.list_prefs` / `list_size`, saved through the existing
 * preferences PATCH. With no provider the value is NO_LIST_PREFS: defaults,
 * nothing saved.
 *
 * React only: this module must not import auth/AuthContext or any runtime
 * module, so the kiosk can import it.
 */
import { createContext, useCallback, useContext, useMemo, useRef } from 'react';

import type { UiPreferences } from './api';

export interface ListPrefsValue {
  /** Per-page list state, keyed by page (`list_prefs` in the portal). */
  listPrefs: Record<string, unknown>;
  listSize: UiPreferences['list_size'] | undefined;
  /** Replaces the whole per-page map; callers merge onto `listPrefs`. */
  saveListPrefs(next: Record<string, unknown>): void;
}

export const NO_LIST_PREFS: ListPrefsValue = {
  listPrefs: {},
  listSize: undefined,
  saveListPrefs: () => {},
};

export const ListPrefsContext = createContext<ListPrefsValue>(NO_LIST_PREFS);

export function useListPrefs(): ListPrefsValue {
  return useContext(ListPrefsContext);
}

/** List settings from the account preferences. `saveListPrefs` keeps one
 *  identity for the hook's lifetime (refs hold the latest preferences and
 *  update function): a changing identity would re-run a consumer's save
 *  effect, whose save changes the preferences, and loop. */
export function useAccountListPrefs(
  preferences: UiPreferences,
  updatePreferences: (prefs: UiPreferences) => unknown,
): ListPrefsValue {
  const prefsRef = useRef(preferences);
  prefsRef.current = preferences;
  const updateRef = useRef(updatePreferences);
  updateRef.current = updatePreferences;

  const saveListPrefs = useCallback((next: Record<string, unknown>) => {
    void updateRef.current({ ...prefsRef.current, list_prefs: next });
  }, []);

  // The value changes only when the list settings do, not on every other
  // preference change. (`?.`: a mocked or partial session may carry none.)
  const stored = preferences?.list_prefs;
  const listSize = preferences?.list_size;
  return useMemo(
    () => ({ listPrefs: stored ?? {}, listSize, saveListPrefs }),
    [stored, listSize, saveListPrefs],
  );
}

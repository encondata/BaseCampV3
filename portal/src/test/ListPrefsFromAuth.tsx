/**
 * Test-only: provides ListPrefsContext from useAuth() (usually the test's
 * mock), as AuthProvider does for real. Tests that seed or assert list
 * settings through a mocked useAuth wrap their render in it:
 * `render(ui, { wrapper: ListPrefsFromAuth })`.
 */
import type { ReactNode } from 'react';

import { useAuth } from '../auth/AuthContext';
import { ListPrefsContext, useAccountListPrefs } from '../lib/listPrefs';

export function ListPrefsFromAuth({ children }: { children: ReactNode }) {
  const { preferences, updatePreferences } = useAuth();
  const value = useAccountListPrefs(preferences, updatePreferences);
  return <ListPrefsContext.Provider value={value}>{children}</ListPrefsContext.Provider>;
}

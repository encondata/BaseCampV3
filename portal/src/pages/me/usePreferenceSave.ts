/**
 * usePreferenceSave — the one way /me tabs write preferences: merge the
 * patch into the FULL preferences object (the PUT takes the whole thing,
 * so a partial would clobber other keys), save via AuthContext, and
 * report a transient save state for the tab's hint line.
 */

import { useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import type { UiPreferences } from '../../lib/api';

export type SaveState = 'idle' | 'saved' | 'error';

export function usePreferenceSave() {
  const { preferences, updatePreferences } = useAuth();
  const [saveState, setSaveState] = useState<SaveState>('idle');

  const update = async (patch: Partial<UiPreferences>) => {
    const next: UiPreferences = {
      ...preferences,
      ...patch,
      notif: { ...preferences.notif, ...(patch.notif ?? {}) },
    };
    const ok = await updatePreferences(next);
    setSaveState(ok ? 'saved' : 'error');
  };

  return { preferences, update, saveState };
}

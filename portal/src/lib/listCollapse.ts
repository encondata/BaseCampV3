/**
 * useListCollapse — open/closed state for a collapsible list, driven by
 * the account's `list_view` preference (expanded / collapsed / last).
 * Every toggle is recorded in list_prefs.open_state[listKey] so "Remember
 * last" can restore it; the save merges onto the latest preferences.
 * A new list opts in with its own stable key — see the List view spec
 * (docs/superpowers/specs/2026-10-05-list-view-and-people-edit-design.md).
 */
import { useCallback, useRef, useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import type { UiPreferences } from './api';

export const LIST_OPEN_STATE_KEY = 'open_state';

function openStateMap(prefs: UiPreferences): Record<string, unknown> {
  const map = prefs.list_prefs?.[LIST_OPEN_STATE_KEY];
  return map && typeof map === 'object' && !Array.isArray(map)
    ? (map as Record<string, unknown>) : {};
}

export function initialListOpen(prefs: UiPreferences, listKey: string): boolean {
  const mode = prefs.list_view ?? 'expanded';
  if (mode === 'collapsed') return false;
  if (mode === 'last') {
    const stored = openStateMap(prefs)[listKey];
    return typeof stored === 'boolean' ? stored : true;
  }
  return true;
}

export function useListCollapse(listKey: string): {
  open: boolean; setOpen: (next: boolean) => void;
} {
  const { preferences, updatePreferences } = useAuth();
  const [open, setOpenState] = useState(() => initialListOpen(preferences, listKey));
  const prefsRef = useRef(preferences);
  prefsRef.current = preferences;
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    const current = prefsRef.current;
    void updatePreferences({
      ...current,
      list_prefs: {
        ...current.list_prefs,
        [LIST_OPEN_STATE_KEY]: { ...openStateMap(current), [listKey]: next },
      },
    });
  }, [listKey, updatePreferences]);
  return { open, setOpen };
}

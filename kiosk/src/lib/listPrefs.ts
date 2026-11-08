/**
 * List settings for the portal's shared lists (sort, filters, columns per
 * page), kept on the kiosk in localStorage and handed to them through the
 * portal's ListPrefsContext. List size comes from the caller. The key is not
 * in Clear Setup's KEEP_KEYS, so Clear Setup resets it.
 */
import { createElement, useCallback, useMemo, useState, type ReactElement, type ReactNode } from 'react';

import { ListPrefsContext, type ListPrefsValue } from '@portal/lib/listPrefs';
import type { UiPreferences } from '@portal/lib/api';

export const KIOSK_LIST_PREFS_KEY = 'ss.kiosk.listPrefs';

export function readKioskListPrefs(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(KIOSK_LIST_PREFS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeKioskListPrefs(next: Record<string, unknown>): void {
  try {
    localStorage.setItem(KIOSK_LIST_PREFS_KEY, JSON.stringify(next));
  } catch {
    // best effort: a full or blocked store just means settings aren't kept
  }
}

export function KioskListPrefsProvider({ listSize, children }: {
  listSize: UiPreferences['list_size'] | undefined;
  children: ReactNode;
}): ReactElement {
  const [listPrefs, setListPrefs] = useState<Record<string, unknown>>(readKioskListPrefs);
  const saveListPrefs = useCallback((next: Record<string, unknown>) => {
    writeKioskListPrefs(next);
    setListPrefs(next);
  }, []);
  const value = useMemo<ListPrefsValue>(
    () => ({ listPrefs, listSize, saveListPrefs }),
    [listPrefs, listSize, saveListPrefs],
  );
  return createElement(ListPrefsContext.Provider, { value }, children);
}

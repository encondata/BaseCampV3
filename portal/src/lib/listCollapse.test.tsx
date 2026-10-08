// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import type { UiPreferences } from './api';

const auth = vi.hoisted(() => ({
  preferences: {} as UiPreferences,
  updatePreferences: vi.fn(async () => true),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    preferences: auth.preferences,
    updatePreferences: auth.updatePreferences,
  }),
}));

const { initialListOpen, useListCollapse } = await import('./listCollapse');

const base = (over: Partial<UiPreferences> = {}): UiPreferences => ({
  accent: 'amber', theme: 'light', density: 'comfortable', list_size: 'default',
  motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
  list_view: 'expanded',
  notif: { sound: 'chime', categories: { approvals: 'email', reports: 'email', wiki: 'email', security: 'email' } },
  list_prefs: {},
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.preferences = base();
});

it('initialListOpen: expanded is open', () => {
  expect(initialListOpen(base({ list_view: 'expanded' }), 'k')).toBe(true);
});

it('initialListOpen: collapsed is closed even when a saved state says open', () => {
  expect(initialListOpen(
    base({ list_view: 'collapsed', list_prefs: { open_state: { k: true } } }), 'k',
  )).toBe(false);
});

it('initialListOpen: last restores a saved boolean, else starts open', () => {
  expect(initialListOpen(
    base({ list_view: 'last', list_prefs: { open_state: { k: false } } }), 'k',
  )).toBe(false);
  expect(initialListOpen(base({ list_view: 'last' }), 'k')).toBe(true);
  expect(initialListOpen(
    base({ list_view: 'last', list_prefs: { open_state: { k: 'no' } } }), 'k',
  )).toBe(true);
});

it('initialListOpen: a missing list_view behaves as expanded', () => {
  const prefs = base();
  delete (prefs as Partial<UiPreferences>).list_view;
  expect(initialListOpen(prefs, 'k')).toBe(true);
});

it('useListCollapse: setOpen flips state and merges the save onto the latest prefs', () => {
  auth.preferences = base({
    list_prefs: { initiative_assets: { visible: ['a'] }, open_state: { other: true } },
  });
  const { result } = renderHook(() => useListCollapse('initiative-assets'));
  expect(result.current.open).toBe(true);
  act(() => result.current.setOpen(false));
  expect(result.current.open).toBe(false);
  expect(auth.updatePreferences).toHaveBeenCalledTimes(1);
  expect(auth.updatePreferences).toHaveBeenCalledWith({
    ...auth.preferences,
    list_prefs: {
      initiative_assets: { visible: ['a'] },
      open_state: { other: true, 'initiative-assets': false },
    },
  });
});

it('useListCollapse: the click is saved with list_view expanded too', () => {
  auth.preferences = base({ list_view: 'expanded' });
  const { result } = renderHook(() => useListCollapse('x'));
  act(() => result.current.setOpen(false));
  expect(auth.updatePreferences).toHaveBeenCalledWith(expect.objectContaining({
    list_prefs: { open_state: { x: false } },
  }));
});

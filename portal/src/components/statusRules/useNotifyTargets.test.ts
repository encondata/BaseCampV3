// @vitest-environment jsdom
/**
 * useNotifyTargets — the people and groups a Send a notification action can name. Each list is
 * asked for once, once `enabled`, and only by a viewer who may have it: the people need
 * notifications:change and the groups notifications:view. A list the viewer may not ask for is
 * not asked for and comes back 'unavailable' (no options), the other still loading; a list that
 * was asked for and failed is 'failed'. The returned object is the same one until a list changes.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import type { NotificationGroup, NotificationRecipient } from '../../lib/api';

const api = vi.hoisted(() => ({
  listNotificationRecipients: vi.fn(),
  listNotificationGroups: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

/** What the signed-in viewer may do. */
const auth = vi.hoisted(() => ({
  can: (_resource: string, _action?: string): boolean => true,
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can }),
}));

const { useNotifyTargets } = await import('./useNotifyTargets');

const PEOPLE = [{
  person_id: 'p1', display_name: 'Person A', job_title: 'Engineer', avatar_url: null, email: null,
  phone: null, has_account: true, can_email: true, can_text: false, can_push: true, can_web: true,
}] satisfies NotificationRecipient[];
const GROUPS = [{
  id: 'g1', name: 'Group A', description: '', enabled: true, member_count: 2,
  created_at: '2026-01-01T00:00:00Z',
}] satisfies NotificationGroup[];

const PEOPLE_READY = {
  options: [{ value: 'p1', label: 'Person A', sub: 'Engineer' }], status: 'ready',
};
const GROUPS_READY = { options: [{ value: 'g1', label: 'Group A' }], status: 'ready' };
/** A list the viewer may not ask for: never asked for. */
const UNAVAILABLE = { options: [], status: 'unavailable' };
/** A list that was asked for and did not come. */
const FAILED = { options: [], status: 'failed' };

/** The viewer holds exactly these permissions, as "resource:action". */
const holds = (...granted: string[]) => {
  auth.can = (resource, action) => granted.includes(`${resource}:${action}`);
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.listNotificationRecipients.mockResolvedValue(PEOPLE);
  api.listNotificationGroups.mockResolvedValue(GROUPS);
});

it('asks for both lists when the viewer may have both, and offers them as options', async () => {
  holds('notifications:change', 'notifications:view');
  const { result } = renderHook(() => useNotifyTargets(true));
  expect(result.current.people.status).toBe('loading');
  expect(result.current.groups.status).toBe('loading');

  await waitFor(() => expect(result.current.groups.status).toBe('ready'));
  await waitFor(() => expect(result.current.people.status).toBe('ready'));
  expect(result.current.people).toEqual(PEOPLE_READY);
  expect(result.current.groups).toEqual(GROUPS_READY);
  expect(api.listNotificationRecipients).toHaveBeenCalledTimes(1);
  expect(api.listNotificationGroups).toHaveBeenCalledTimes(1);
});

it('asks for no list at all of a viewer with no notification permissions: both are unavailable', async () => {
  holds('status_rules:view');
  const { result } = renderHook(() => useNotifyTargets(true));

  // a tick for an effect that would have asked
  await waitFor(() => expect(result.current).toEqual({ people: UNAVAILABLE, groups: UNAVAILABLE }));
  expect(api.listNotificationRecipients).not.toHaveBeenCalled();
  expect(api.listNotificationGroups).not.toHaveBeenCalled();
});

it('without notifications:view the groups are unavailable and not asked for, and the people still load', async () => {
  holds('notifications:change');
  const { result } = renderHook(() => useNotifyTargets(true));

  await waitFor(() => expect(result.current.people.status).toBe('ready'));
  expect(result.current).toEqual({ people: PEOPLE_READY, groups: UNAVAILABLE });
  expect(api.listNotificationRecipients).toHaveBeenCalledTimes(1);
  expect(api.listNotificationGroups).not.toHaveBeenCalled();
});

it('without notifications:change the people are unavailable and not asked for, and the groups still load', async () => {
  holds('notifications:view');
  const { result } = renderHook(() => useNotifyTargets(true));

  await waitFor(() => expect(result.current.groups.status).toBe('ready'));
  expect(result.current).toEqual({ people: UNAVAILABLE, groups: GROUPS_READY });
  expect(api.listNotificationGroups).toHaveBeenCalledTimes(1);
  expect(api.listNotificationRecipients).not.toHaveBeenCalled();
});

it('asks nothing until enabled, then once', async () => {
  const { result, rerender } = renderHook(({ enabled }) => useNotifyTargets(enabled), {
    initialProps: { enabled: false },
  });
  expect(result.current.people.status).toBe('loading');
  expect(api.listNotificationRecipients).not.toHaveBeenCalled();
  expect(api.listNotificationGroups).not.toHaveBeenCalled();

  rerender({ enabled: true });
  await waitFor(() => expect(result.current.people.status).toBe('ready'));
  await waitFor(() => expect(result.current.groups.status).toBe('ready'));
  rerender({ enabled: false });
  rerender({ enabled: true });
  expect(api.listNotificationRecipients).toHaveBeenCalledTimes(1);
  expect(api.listNotificationGroups).toHaveBeenCalledTimes(1);
});

it('a list that fails to load is failed, not unavailable, with no options, and the other stays', async () => {
  api.listNotificationRecipients.mockRejectedValue(new Error('403'));
  const { result } = renderHook(() => useNotifyTargets(true));

  await waitFor(() => expect(result.current.groups.status).toBe('ready'));
  await waitFor(() => expect(result.current.people).toEqual(FAILED));
  expect(result.current.groups).toEqual(GROUPS_READY);
  expect(api.listNotificationRecipients).toHaveBeenCalledTimes(1);   // it was asked for
});

it('returns the same object until a list changes, so a memo keyed on it holds', async () => {
  const { result, rerender } = renderHook(() => useNotifyTargets(true));
  const loading = result.current;
  rerender();
  expect(result.current).toBe(loading);

  await waitFor(() => expect(result.current.people.status).toBe('ready'));
  await waitFor(() => expect(result.current.groups.status).toBe('ready'));
  const settled = result.current;
  expect(settled).not.toBe(loading);
  rerender();
  rerender();
  expect(result.current).toBe(settled);
});

it('returns the same object, always, for a viewer who may have neither list', () => {
  holds();
  const { result, rerender } = renderHook(() => useNotifyTargets(true));
  const first = result.current;
  rerender();
  rerender();

  expect(result.current).toBe(first);
});

it('a permission that arrives later gets its list then, once', async () => {
  holds();
  const { result, rerender } = renderHook(() => useNotifyTargets(true));
  expect(result.current).toEqual({ people: UNAVAILABLE, groups: UNAVAILABLE });
  expect(api.listNotificationRecipients).not.toHaveBeenCalled();

  holds('notifications:change');
  rerender();
  await waitFor(() => expect(result.current.people).toEqual(PEOPLE_READY));
  expect(result.current.groups).toEqual(UNAVAILABLE);
  rerender();
  expect(api.listNotificationRecipients).toHaveBeenCalledTimes(1);
  expect(api.listNotificationGroups).not.toHaveBeenCalled();
});

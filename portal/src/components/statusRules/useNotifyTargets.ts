/**
 * useNotifyTargets — the people and the notification groups a Send a notification action can
 * name, as ComboBox options. Asked for once, the first time `enabled` is true: the rule editor
 * asks once its rule has (or gets) such an action, the rules list once any rule has one, so a
 * rule without one never asks. Each list stands alone: the people need notifications:change and
 * the groups notifications:view. A list the viewer may not ask for is not asked for (staff with
 * only status_rules:view would make two calls that answer 403 on every visit), and counts as one
 * that can't be had, like one that fails to load: no options, status 'failed' (a name then falls
 * back to its id, and the picker says so), and it leaves the other usable. The returned object
 * changes only when a list does, so a consumer can key a memo on it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { listNotificationGroups, listNotificationRecipients } from '../../lib/api';
import type { ComboOption } from '../ComboBox';

export type TargetStatus = 'loading' | 'ready' | 'failed';

export interface TargetList {
  options: ComboOption[];
  status: TargetStatus;
}

export interface NotifyTargets {
  people: TargetList;
  groups: TargetList;
}

const LOADING: TargetList = { options: [], status: 'loading' };

/** A list that was never asked for (no permission): nothing to offer, as if it had failed. */
const UNAVAILABLE: TargetList = { options: [], status: 'failed' };

export function useNotifyTargets(enabled: boolean): NotifyTargets {
  const { can } = useAuth();
  const mayListPeople = can('notifications', 'change');
  const mayListGroups = can('notifications', 'view');
  const [people, setPeople] = useState<TargetList>(LOADING);
  const [groups, setGroups] = useState<TargetList>(LOADING);
  const askedPeople = useRef(false);
  const askedGroups = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const load = async (
      fetchOptions: () => Promise<ComboOption[]>, set: (list: TargetList) => void,
    ) => {
      try {
        set({ options: await fetchOptions(), status: 'ready' });
      } catch {
        set({ options: [], status: 'failed' });
      }
    };
    if (mayListPeople && !askedPeople.current) {
      askedPeople.current = true;
      void load(
        async () => (await listNotificationRecipients()).map((r) => (
          { value: r.person_id, label: r.display_name, sub: r.job_title }
        )),
        setPeople,
      );
    }
    if (mayListGroups && !askedGroups.current) {
      askedGroups.current = true;
      void load(
        async () => (await listNotificationGroups()).map((g) => ({ value: g.id, label: g.name })),
        setGroups,
      );
    }
  }, [enabled, mayListPeople, mayListGroups]);

  return useMemo(() => ({
    people: mayListPeople ? people : UNAVAILABLE,
    groups: mayListGroups ? groups : UNAVAILABLE,
  }), [people, groups, mayListPeople, mayListGroups]);
}

/**
 * useNotifyTargets — the people and the notification groups a Send a notification action can
 * name, as ComboBox options. Asked for once, the first time `enabled` is true: the rule editor
 * asks once its rule has (or gets) such an action, the rules list once any rule has one, so a
 * rule without one never asks. Each list stands alone: the people need notifications:change and
 * the groups notifications:view, and one that can't be had leaves the other usable, with no
 * options (a name then falls back to its id).
 */

import { useEffect, useRef, useState } from 'react';

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

export function useNotifyTargets(enabled: boolean): NotifyTargets {
  const [people, setPeople] = useState<TargetList>(LOADING);
  const [groups, setGroups] = useState<TargetList>(LOADING);
  const asked = useRef(false);

  useEffect(() => {
    if (!enabled || asked.current) return;
    asked.current = true;
    const load = async (
      fetchOptions: () => Promise<ComboOption[]>, set: (list: TargetList) => void,
    ) => {
      try {
        set({ options: await fetchOptions(), status: 'ready' });
      } catch {
        set({ options: [], status: 'failed' });
      }
    };
    void load(
      async () => (await listNotificationRecipients()).map((r) => (
        { value: r.person_id, label: r.display_name, sub: r.job_title }
      )),
      setPeople,
    );
    void load(
      async () => (await listNotificationGroups()).map((g) => ({ value: g.id, label: g.name })),
      setGroups,
    );
  }, [enabled]);

  return { people, groups };
}

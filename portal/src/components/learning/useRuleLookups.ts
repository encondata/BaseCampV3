import { useCallback, useRef, useState } from 'react';

import {
  listClients, listInitiatives, listInitiativeWorkTypes, listPartners, listSites, listWorkers,
  type SiteItem,
} from '../../lib/api';
import { naturalCompare } from '../../lib/naturalSort';
import type { RuleField } from '../../lib/learningRules';
import type { ComboOption } from '../ComboBox';

/** The rule fields that pick from a list. */
export type LookupKind = Exclude<RuleField, 'everyone'>;
export type LookupStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** What the Rules page and the rule editor share: the lists behind the
 *  condition values, each loaded the first time something asks for it. */
export interface RuleLookups {
  options: (kind: LookupKind) => ComboOption[];
  status: (kind: LookupKind) => LookupStatus;
  load: (kind: LookupKind) => void;
  retry: (kind: LookupKind) => void;
  /** The name for a stored value; the value itself until its list loads. */
  label: (kind: LookupKind, value: string) => string;
}

const byLabel = (a: ComboOption, b: ComboOption) => naturalCompare(a.label, b.label);
const archivedSub = (archived: string | null | undefined) => (archived ? 'Archived' : null);

/** Distinct countries across the sites. Country is free text on a site, so
 *  values are the upper-cased text (what a rule stores) and the label is the
 *  first spelling seen. */
export function countryOptions(sites: SiteItem[]): ComboOption[] {
  const seen = new Map<string, string>();
  sites.forEach((s) => {
    const text = (s.country ?? '').trim();
    if (text && !seen.has(text.toUpperCase())) seen.set(text.toUpperCase(), text);
  });
  return Array.from(seen, ([value, label]) => ({ value, label })).sort(byLabel);
}

export function useRuleLookups(): RuleLookups {
  const [lists, setLists] = useState<Partial<Record<LookupKind, { status: LookupStatus; options: ComboOption[] }>>>({});
  const started = useRef(new Set<LookupKind>());
  // site and site_country come from one fetch
  const sites = useRef<Promise<SiteItem[]> | null>(null);

  const fetchKind = useCallback(async (kind: LookupKind): Promise<ComboOption[]> => {
    switch (kind) {
      case 'initiative':
        return (await listInitiatives()).map((i) => ({
          value: i.id.toLowerCase(), label: i.name, sub: i.code ?? archivedSub(i.archived_at),
        })).sort(byLabel);
      case 'client':
        return (await listClients()).map((c) => ({
          value: c.id.toLowerCase(), label: c.name, sub: archivedSub(c.archived_at),
        })).sort(byLabel);
      case 'partner':
        return (await listPartners()).map((p) => ({
          value: p.id.toLowerCase(), label: p.name, sub: archivedSub(p.archived_at),
        })).sort(byLabel);
      case 'site':
      case 'site_country': {
        sites.current ??= listSites();
        let list: SiteItem[];
        try { list = await sites.current; } catch (e) { sites.current = null; throw e; }
        return kind === 'site'
          ? list.map((s) => ({
            value: s.id.toLowerCase(), label: s.name,
            sub: [s.code, s.country].filter(Boolean).join(' · ') || null,
          })).sort(byLabel)
          : countryOptions(list);
      }
      case 'worker_role':
        return (await listInitiativeWorkTypes()).map((w) => ({
          value: w.key, label: w.label, sub: w.is_active ? null : 'Inactive',
        })).sort(byLabel);
      case 'person':
        return (await listWorkers()).map((w) => ({
          value: w.person_id.toLowerCase(), label: w.display_name, sub: w.contact_email,
        })).sort(byLabel);
    }
  }, []);

  const start = useCallback((kind: LookupKind) => {
    started.current.add(kind);
    setLists((l) => ({ ...l, [kind]: { status: 'loading', options: l[kind]?.options ?? [] } }));
    fetchKind(kind)
      .then((options) => setLists((l) => ({ ...l, [kind]: { status: 'ready', options } })))
      .catch(() => {
        started.current.delete(kind);
        setLists((l) => ({ ...l, [kind]: { status: 'failed', options: [] } }));
      });
  }, [fetchKind]);

  const load = useCallback((kind: LookupKind) => {
    if (!started.current.has(kind)) start(kind);
  }, [start]);

  return {
    options: (kind) => lists[kind]?.options ?? [],
    status: (kind) => lists[kind]?.status ?? 'idle',
    load,
    retry: (kind) => start(kind),
    label: (kind, value) => lists[kind]?.options.find((o) => o.value === value)?.label ?? value,
  };
}

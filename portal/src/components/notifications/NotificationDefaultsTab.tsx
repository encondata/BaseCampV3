/**
 * NotificationDefaultsTab — System › Notifications › Defaults (admin and
 * above): what everyone gets until they change it, and which notifications
 * can't wait. Two System settings cards (components/settings/BrandingControls
 * is the model), each with its own Save, disabled until that card differs from
 * what the server last answered:
 *
 *  - "What people get by default": the Inbox / Email grid (SwitchGrid in
 *    defaults mode) on a draft. Save sends `{defaults}` and nothing else.
 *    Admins set the defaults whether or not the server can send email right
 *    now, so Email is never switched off here for that.
 *  - "Critical notifications": every kind that can be emailed, with a Critical
 *    switch. The two account security kinds say "Always" instead of a switch:
 *    they are critical in code and never stored. Save sends `{critical_kinds}`
 *    (registry order) and nothing else.
 *
 * A save answers the whole settings; the saved card's draft resets from the
 * answer, and the other card keeps whatever is being edited in it. While a
 * save is on its way nothing can be changed. Without `notifications:change`
 * everything is read-only. Errors are sentences, never raw API codes
 * (read-only maintenance says its own).
 */

import { useEffect, useId, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  ApiError, getNotificationSettings, updateNotificationSettings,
  type NotificationKindSetting, type SwitchPair,
} from '../../lib/api';
import { categoryLabel } from '../../lib/notificationKinds';
import DataTable, { type DataTableColumn, type DataTableRow } from '../DataTable';
import { Switch } from '../Switch';
import SwitchGrid from './SwitchGrid';
import '../../styles/directory.css';      // .chip, .cell-top, the data table
import '../../styles/profile.css';        // .btn-solid, .pf-error
import '../../styles/settings.css';       // .set-stack, .set-section, .set-head
import '../../styles/notifications.css';  // .nd-*

type Card = 'defaults' | 'critical';

/** What each card was last loaded or saved as, and the registry's kinds. */
interface Saved {
  defaults: Record<string, SwitchPair>;
  critical: string[];
  kinds: NotificationKindSetting[];
}

/** What is being edited. */
interface Draft {
  defaults: Record<string, SwitchPair>;
  critical: ReadonlySet<string>;
}

const CRITICAL_COLUMNS: DataTableColumn[] = [
  { key: 'notification', label: 'Notification' },
  { key: 'category', label: 'Category' },
  { key: 'critical', label: 'Critical', align: 'center', width: '104px' },
];

/** The "Always" pill that stands where a switch would (as in the grid above). */
const ALWAYS = <span className="chip c-slate">Always</span>;

const ERRORS: Record<string, string> = {
  invalid_category: "That change isn't allowed.",
  invalid_kind: "That change isn't allowed.",
};

/** A known code's sentence; read-only maintenance says its own; any other
 *  failure (an unknown code, no connection) is the generic one. */
function message(err: unknown): string {
  if (err instanceof ApiError) {
    if (ERRORS[err.code]) return ERRORS[err.code];
    if (err.code === 'read_only_mode' && err.message) return err.message;
  }
  return "Couldn't save. Try again.";
}

const samePair = (a: SwitchPair | undefined, b: SwitchPair | undefined): boolean =>
  a?.inbox === b?.inbox && a?.email === b?.email;

function sameDefaults(a: Record<string, SwitchPair>, b: Record<string, SwitchPair>): boolean {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => samePair(a[key], b[key]));
}

function sameKinds(draft: ReadonlySet<string>, saved: readonly string[]): boolean {
  const kept = new Set(saved);
  return draft.size === kept.size && [...draft].every((kind) => kept.has(kind));
}

export default function NotificationDefaultsTab() {
  const { can } = useAuth();
  const canChange = can('notifications', 'change');
  const defaultsTitle = useId();
  const criticalTitle = useId();

  // Both null until the settings load (or fail to).
  const [saved, setSaved] = useState<Saved | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState<Card | null>(null);
  const [error, setError] = useState<{ card: Card; text: string } | null>(null);

  useEffect(() => {
    let ignore = false;   // the tab went away before the answer did
    getNotificationSettings()
      .then((settings) => {
        if (ignore) return;
        setSaved({ defaults: settings.defaults, critical: settings.critical_kinds, kinds: settings.kinds });
        setDraft({ defaults: settings.defaults, critical: new Set(settings.critical_kinds) });
      })
      .catch(() => { if (!ignore) setLoadFailed(true); });
    return () => { ignore = true; };
  }, []);

  if (!saved || !draft) {
    return (
      <div className="set-stack nd-one">
        {loadFailed
          ? <p className="pf-error" role="alert">Could not load notification settings.</p>
          : <p className="page-hint">Loading…</p>}
      </div>
    );
  }

  const locked = saving !== null || !canChange;
  const defaultsDirty = !sameDefaults(draft.defaults, saved.defaults);
  const criticalDirty = !sameKinds(draft.critical, saved.critical);

  /** An edit in a card drops that card's old error. */
  const clearError = (card: Card) => setError((e) => (e?.card === card ? null : e));

  const setPair = (category: string, pair: SwitchPair) => {
    clearError('defaults');
    setDraft((d) => d && { ...d, defaults: { ...d.defaults, [category]: pair } });
  };

  const setCritical = (kind: string, on: boolean) => {
    clearError('critical');
    setDraft((d) => {
      if (!d) return d;
      const critical = new Set(d.critical);
      if (on) critical.add(kind); else critical.delete(kind);
      return { ...d, critical };
    });
  };

  const save = async (card: Card) => {
    if (locked) return;
    setSaving(card);
    setError(null);
    try {
      if (card === 'defaults') {
        const next = await updateNotificationSettings({ defaults: draft.defaults });
        setSaved((s) => s && { ...s, defaults: next.defaults, kinds: next.kinds });
        setDraft((d) => d && { ...d, defaults: next.defaults });
      } else {
        // The marked kinds in registry order; account security is never sent.
        const marked = saved.kinds
          .filter((k) => !k.locked && draft.critical.has(k.kind)).map((k) => k.kind);
        const next = await updateNotificationSettings({ critical_kinds: marked });
        setSaved((s) => s && { ...s, critical: next.critical_kinds, kinds: next.kinds });
        setDraft((d) => d && { ...d, critical: new Set(next.critical_kinds) });
      }
    } catch (err) {
      setError({ card, text: message(err) });
    } finally {
      setSaving(null);
    }
  };

  const criticalRows: DataTableRow[] = saved.kinds.filter((k) => k.email).map((k) => {
    const category = categoryLabel(k.category);
    return {
      key: k.kind,
      cells: [
        <b className="cell-top">{k.label}</b>,
        <span className="chip tag" title={category}>{category}</span>,
        k.locked ? ALWAYS : (
          <Switch label={`Critical: ${k.label}`} checked={draft.critical.has(k.kind)} disabled={locked}
                  onChange={(on) => setCritical(k.kind, on)} />
        ),
      ],
    };
  });

  const foot = (card: Card, dirty: boolean) => (
    <div className="nd-foot">
      <button type="button" className="btn-solid" disabled={locked || !dirty}
              onClick={() => void save(card)}>
        Save
      </button>
      {error?.card === card && <span className="pf-error" role="alert">{error.text}</span>}
    </div>
  );

  return (
    <div className="set-stack nd-one">
      <section className="set-section" aria-labelledby={defaultsTitle}>
        <div className="set-head">
          <h3 id={defaultsTitle}>What people get by default</h3>
          <p>
            Everyone starts with these switches. A change reaches everyone who hasn't changed
            that switch themselves.
          </p>
        </div>
        <SwitchGrid mode="defaults" defaults={draft.defaults} emailEnabled disabled={locked}
                    onChange={setPair} />
        {foot('defaults', defaultsDirty)}
      </section>

      <section className="set-section" aria-labelledby={criticalTitle}>
        <div className="set-head">
          <h3 id={criticalTitle}>Critical notifications</h3>
          <p>
            Critical notifications skip quiet hours, days off and the summary email. They still
            follow each person's switches.
          </p>
        </div>
        <div className="nd-crit">
          <DataTable ariaLabel="Critical notifications" columns={CRITICAL_COLUMNS} rows={criticalRows} />
        </div>
        <p className="nd-note">
          Password reset requests and Quiz locked are never emailed, so they aren't listed.
        </p>
        {foot('critical', criticalDirty)}
      </section>
    </div>
  );
}

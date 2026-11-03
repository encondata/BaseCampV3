/**
 * WatchEventsEditor — which events a watch hears about. It is the body of
 * "Choose events…" (WatchEventsModal) and, on the group page, of "Add watch".
 *
 * A watch names its events, or names none and hears every event that applies to
 * its thing. "All events" and "nothing picked yet" are different states, so they
 * are separate props, and the kinds to save are `all ? [] : picked`. The editor
 * keeps no state: it shows what it is given and hands every change over as the
 * next `{ all, picked }`.
 *
 * Unless the watch is on Everything, an "All events" switch comes first. Turning it
 * off starts from no picks (and turning it on drops them: All means none are
 * named). With it off, and always for Everything (which has no "all": it has to
 * name some events), the events the thing can name are listed, one Switch each,
 * under their category's label in the categories' own order. Picks are handed over
 * in registry order, whatever order they were made in.
 */

import type { NotificationKindSetting, WatchTarget } from '../../lib/api';
import { NOTIFICATION_CATEGORIES } from '../../lib/notificationKinds';
import { kindsFor } from '../../lib/watches';
import { OptionGroup } from '../reports/ReportOptionsLayout';
import { Switch } from '../Switch';
import '../../styles/directory.css';      // .mini-row, .cell-top, .cell-sub
import '../../styles/reports.css';        // .report-section-row, .rgm-group
import '../../styles/settings.css';       // .switch
import '../../styles/notifications.css';  // .watch-editor

/** The events a watch names: none picked yet (`all` off), or every event (`all` on). */
export interface WatchEvents {
  all: boolean;
  picked: string[];
}

export default function WatchEventsEditor({ thing, kinds, all, picked, onChange }: {
  thing: WatchTarget;
  /** Every registered kind (GET /notifications/settings); the editor picks out the ones that apply. */
  kinds: NotificationKindSetting[];
  all: boolean;
  picked: string[];
  onChange: (next: WatchEvents) => void;
}) {
  const everything = thing === 'everything';
  const applicable = kindsFor(thing, kinds);
  const groups = NOTIFICATION_CATEGORIES
    .map(({ key, label }) => ({ key, label, kinds: applicable.filter((k) => k.category === key) }))
    .filter((group) => group.kinds.length > 0);

  const toggle = (kind: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(kind);
    else next.delete(kind);
    onChange({ all: false, picked: applicable.filter((k) => next.has(k.kind)).map((k) => k.kind) });
  };

  return (
    <div className="watch-editor">
      {!everything && (
        <div className="mini-list report-sections">
          <label className="mini-row report-section-row">
            <Switch label="All events" checked={all}
                    onChange={(on) => onChange({ all: on, picked: [] })} />
            <span className="report-section-text">
              <span className="cell-top">All events</span>
              <span className="cell-sub">Every event that applies to this.</span>
            </span>
          </label>
        </div>
      )}

      {(everything || !all) && groups.map((group) => (
        <div key={group.key} role="group" aria-label={group.label}>
          <OptionGroup title={group.label}>
            <div className="mini-list report-sections">
              {group.kinds.map((k) => (
                <label key={k.kind} className="mini-row report-section-row">
                  <Switch label={k.label} checked={picked.includes(k.kind)}
                          onChange={(on) => toggle(k.kind, on)} />
                  <span className="report-section-text">
                    <span className="cell-top">{k.label}</span>
                  </span>
                </label>
              ))}
            </div>
          </OptionGroup>
        </div>
      ))}
    </div>
  );
}

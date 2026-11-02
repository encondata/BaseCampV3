/**
 * SwitchGrid — the category × Inbox / Email grid. One DataTable row per
 * category, and two house Switches per row.
 *
 * Person mode (/me › Notifications) shows what the person gets and where each
 * row stands: "Company default" while they follow it, "Your choice" with a
 * "Use company default" link once they have changed a switch. `onChange`
 * hands over the person's own values for the category — or `undefined` to
 * clear them, as flipping a switch back to the default's value does — and
 * only those are ever saved.
 *
 * Defaults mode (System › Notifications › Defaults) edits the company default
 * itself: `defaults` is the draft being edited, there is no state line, and
 * `onChange` hands over the category's whole pair.
 *
 * Email needs Inbox in both: with Inbox off the Email switch reads off and is
 * disabled, "Turn on Inbox to get email". The Email value behind it is kept,
 * so turning Inbox back on gives it back. Account security has no switch: it
 * is always on, and shows "Always". The grid keeps no state of its own.
 *
 * Nothing can change while the defaults are still loading (`defaults` null),
 * and Email is off limits while the server can't send email.
 */

import type { ReactNode } from 'react';

import type { NotifSwitches, NotificationCategory, SwitchPair } from '../../lib/api';
import { NOTIFICATION_CATEGORIES } from '../../lib/notificationKinds';
import {
  CATEGORY_DESCRIPTIONS, CONFIGURABLE, effective, flip, isChanged,
  type SwitchChannel, type SwitchValues,
} from '../../lib/notificationSwitches';
import DataTable, { type DataTableRow } from '../DataTable';
import { Switch } from '../Switch';
import '../../styles/directory.css';      // .data-table, .chip, .cell-top, .cell-sub
import '../../styles/settings.css';       // .switch
import '../../styles/notifications.css';  // .swgrid-*

const NO_SERVER_EMAIL = "Email isn't set up on this server";
const NEEDS_INBOX = 'Turn on Inbox to get email';

interface CommonProps {
  /** The company defaults by category (in defaults mode, the draft being
   *  edited), or null while they load. */
  defaults: Record<string, SwitchPair> | null;
  /** The person's own values (person mode only). */
  own?: NotifSwitches;
  /** Whether the server can send email at all, or null until that is known. */
  emailEnabled: boolean | null;
  /** The whole grid inert, e.g. while a save is on its way. */
  disabled?: boolean;
}

type Props = CommonProps & (
  | {
    mode: 'person';
    /** The person's own values for the category after the change, or
     *  undefined when nothing of theirs is left (it follows the default). */
    onChange: (category: NotificationCategory, next: SwitchValues | undefined) => void;
  }
  | {
    mode: 'defaults';
    /** The category's whole default pair after the change. */
    onChange: (category: NotificationCategory, next: SwitchPair) => void;
  }
);

/** The "Always" pill that stands where a switch would. */
const ALWAYS = <span className="chip c-slate">Always</span>;

export default function SwitchGrid(props: Props) {
  const { defaults, emailEnabled, disabled = false } = props;

  /** Set one switch of `category`, from the pair the grid is showing. */
  const change = (category: NotificationCategory, def: SwitchPair, channel: SwitchChannel, next: boolean) => {
    if (props.mode === 'person') props.onChange(category, flip(props.own?.[category], def, channel, next));
    else props.onChange(category, { ...def, [channel]: next });
  };

  /** "Use company default": clear the person's values for `category`. */
  const reset = (category: NotificationCategory) => {
    if (props.mode === 'person') props.onChange(category, undefined);
  };

  const rows: DataTableRow[] = NOTIFICATION_CATEGORIES.map(({ key, label }) => {
    const describe = (state: ReactNode) => (
      <div>
        <b className="cell-top">{label}</b>
        <div className="cell-sub">{CATEGORY_DESCRIPTIONS[key]}</div>
        {state}
      </div>
    );

    if (!CONFIGURABLE.includes(key)) return { key, cells: [describe(null), ALWAYS, ALWAYS] };

    const own = props.mode === 'person' ? props.own?.[key] : undefined;
    const def: SwitchPair | undefined = defaults?.[key];
    const shown = def ? effective(own, def) : { inbox: false, email: false };
    // Nothing to flip against until the default is known.
    const inert = disabled || def === undefined;
    const emailReason = emailEnabled === false ? NO_SERVER_EMAIL
      : def !== undefined && !shown.inbox ? NEEDS_INBOX : null;

    let state: ReactNode = null;
    if (props.mode === 'person') {
      state = isChanged(own) ? (
        <div className="swgrid-state">
          <span className="chip c-amber">Your choice</span>
          <span className="swgrid-sep" aria-hidden="true">·</span>
          <button type="button" className="swgrid-reset" disabled={inert} onClick={() => reset(key)}>
            Use company default
          </button>
        </div>
      ) : (
        <div className="swgrid-state"><span className="chip tag">Company default</span></div>
      );
    }

    return {
      key,
      cells: [
        describe(state),
        <Switch label={`Inbox for ${label}`} checked={shown.inbox} disabled={inert}
                onChange={(next) => { if (def) change(key, def, 'inbox', next); }} />,
        // A disabled input shows no tooltip of its own, so the reason sits on what wraps it.
        <span title={emailReason ?? undefined}>
          <Switch label={`Email for ${label}`} checked={shown.email}
                  disabled={inert || emailReason !== null}
                  onChange={(next) => { if (def) change(key, def, 'email', next); }} />
        </span>,
      ],
    };
  });

  return (
    <DataTable ariaLabel="Notification switches"
               columns={[
                 { key: 'category', label: 'Category' },
                 { key: 'inbox', label: 'Inbox', align: 'center', width: '104px' },
                 { key: 'email', label: 'Email', align: 'center', width: '104px' },
               ]}
               rows={rows} />
  );
}

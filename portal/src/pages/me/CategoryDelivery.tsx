/**
 * CategoryDelivery — the /me › Notifications delivery table: one row per
 * notification category with the person's own choice (Inbox + Email /
 * Inbox only / Off, the house `segmented` control) and which of their
 * groups can email them that category.
 *
 * The control shows what will really happen. When email can't happen for a
 * category — the server can't send email, or none of the person's groups
 * email it — "Inbox + Email" is disabled (its tooltip says why) and "Inbox
 * only" shows as selected. The saved choice is never rewritten by that, so
 * joining a group later turns email back on with no extra click. Until the
 * groups have loaded the saved choice shows as is.
 *
 * Account security is fixed — it is always emailed, as long as the server can
 * send email — so its row carries text instead of a control. Groups decide
 * what may email a person and when; this only turns it down.
 */

import DataTable from '../../components/DataTable';
import type { MyNotificationGroup, NotifPrefs } from '../../lib/api';
import {
  DELIVERY_CHOICES, NOTIFICATION_CATEGORIES, emailGroupsFor,
  type DeliveryChoice, type EmailSource, type NotificationCategory,
} from '../../lib/notificationKinds';

const NO_SERVER_EMAIL = "Email isn't set up on this server";
const NO_EMAIL_GROUP = 'None of your groups email this category';

/** Why email can't happen for a category, or null when it can. `emailFrom`
 *  is the groups that can email it, or null while the groups load — then
 *  nothing is known, so nothing is blocked. */
function whyNoEmail(
  emailSource: EmailSource, emailFrom: MyNotificationGroup[] | null, emailEnabled: boolean,
): string | null {
  if (emailFrom === null) return null;
  if (!emailEnabled) return NO_SERVER_EMAIL;
  if (emailSource !== 'direct' && emailFrom.length === 0) return NO_EMAIL_GROUP;
  return null;
}

/** The "Email from" cell: the groups as chips, or the reason there are none. */
function EmailFromCell({ emailSource, emailFrom, emailEnabled }: {
  emailSource: EmailSource;
  emailFrom: MyNotificationGroup[] | null;
  emailEnabled: boolean;
}) {
  if (emailFrom === null) return <span className="cell-sub">—</span>;
  if (!emailEnabled) return <span className="cell-sub">Email isn't set up</span>;
  if (emailSource === 'direct') return <span className="cell-sub">—</span>;   // no group is involved
  if (emailFrom.length === 0) return <span className="cell-sub">No group — inbox only</span>;
  return (
    <div className="chips">
      {emailFrom.map((g) => <span key={g.id} className="chip tag">{g.name}</span>)}
    </div>
  );
}

export default function CategoryDelivery({
  categories, groups, emailEnabled, categoryList = NOTIFICATION_CATEGORIES, onChange,
}: {
  categories: NotifPrefs['categories'];
  /** The person's notification groups, or null while they load. */
  groups: MyNotificationGroup[] | null;
  /** Whether the server can send email at all (the public system status). */
  emailEnabled: boolean;
  /** The categories to list: the registry, unless a test brings its own. */
  categoryList?: typeof NOTIFICATION_CATEGORIES;
  onChange: (category: NotificationCategory, choice: DeliveryChoice) => void;
}) {
  const rows = categoryList.map(({ key, label, emailSource }) => {
    const name = <b key="c" className="cell-top">{label}</b>;

    if (emailSource === 'always') {
      return {
        key,
        cells: [
          name,
          <span key="d" className="cell-sub">
            {emailEnabled ? 'Always emailed' : "Inbox only — email isn't set up"}
          </span>,
          <span key="f" className="cell-sub">—</span>,
        ],
      };
    }

    const saved: DeliveryChoice = categories?.[key] ?? 'email';
    const emailFrom = groups === null ? null : emailGroupsFor(key, groups);
    const noEmailBecause = whyNoEmail(emailSource, emailFrom, emailEnabled);
    // The saved choice is what the person picked; this is what will happen.
    const shown: DeliveryChoice = saved === 'email' && noEmailBecause ? 'inbox' : saved;

    return {
      key,
      cells: [
        name,
        <div key="d" className="segmented delivery-seg" role="group" aria-label={`${label} delivery`}>
          {DELIVERY_CHOICES.map((o) => {
            const reason = o.key === 'email' ? noEmailBecause : null;
            return (
              <button key={o.key} type="button" aria-pressed={shown === o.key}
                      className={shown === o.key ? 'on' : ''}
                      disabled={reason !== null} title={reason ?? undefined}
                      onClick={() => { if (shown !== o.key) onChange(key, o.key); }}>
                {o.label}
              </button>
            );
          })}
        </div>,
        <EmailFromCell key="f" emailSource={emailSource} emailFrom={emailFrom} emailEnabled={emailEnabled} />,
      ],
    };
  });

  return (
    <DataTable ariaLabel="Notification delivery"
               columns={[
                 { key: 'category', label: 'Category', width: '28%' },
                 { key: 'delivery', label: 'Delivery' },
                 { key: 'from', label: 'Email from', width: '30%' },
               ]}
               rows={rows} />
  );
}

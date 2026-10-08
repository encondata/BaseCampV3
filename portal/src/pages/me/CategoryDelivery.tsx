/**
 * CategoryDelivery — the /me › Notifications delivery table: one row per
 * notification category with the person's own choice (Inbox + Email /
 * Inbox only / Off, the house `segmented` control) and which of their
 * groups can email them that category. Account security is fixed — it is
 * always emailed — so its row carries text instead of a control. Groups
 * decide what may email a person and when; this only turns it down.
 */

import DataTable from '../../components/DataTable';
import type { MyNotificationGroup, NotifPrefs } from '../../lib/api';
import {
  DELIVERY_CHOICES, NOTIFICATION_CATEGORIES, emailGroupsFor,
  type DeliveryChoice, type NotificationCategory,
} from '../../lib/notificationKinds';

export default function CategoryDelivery({ categories, groups, onChange }: {
  categories: NotifPrefs['categories'];
  /** The person's notification groups, or null while they load. */
  groups: MyNotificationGroup[] | null;
  onChange: (category: NotificationCategory, choice: DeliveryChoice) => void;
}) {
  const rows = NOTIFICATION_CATEGORIES.map(({ key, label }) => {
    const current: DeliveryChoice = categories?.[key] ?? 'email';
    const emailFrom = groups === null ? null : emailGroupsFor(key, groups);
    return {
      key,
      cells: [
        <b key="c" className="cell-top">{label}</b>,
        key === 'security'
          ? <span key="d" className="cell-sub">Always emailed</span>
          : (
            <div key="d" className="segmented" role="group" aria-label={`${label} delivery`}>
              {DELIVERY_CHOICES.map((o) => (
                <button key={o.key} type="button" aria-pressed={current === o.key}
                        className={current === o.key ? 'on' : ''}
                        onClick={() => { if (current !== o.key) onChange(key, o.key); }}>
                  {o.label}
                </button>
              ))}
            </div>
          ),
        key === 'security'
          ? <span key="f" className="cell-sub">—</span>
          : emailFrom === null
            ? <span key="f" className="cell-sub">—</span>
            : emailFrom.length === 0
              ? <span key="f" className="cell-sub">No group — inbox only</span>
              : (
                <div key="f" className="chips">
                  {emailFrom.map((g) => <span key={g.id} className="chip tag">{g.name}</span>)}
                </div>
              ),
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

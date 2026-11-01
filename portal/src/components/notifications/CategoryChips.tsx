/**
 * CategoryChips — the notification categories a group covers, one chip per
 * category in registry order (lib/notificationKinds.ts), so a list shows at a
 * glance what a group sends. A group that covers none gets a slate "None —
 * inbox only" chip instead of a blank cell. Each chip carries its full label
 * as a title: a chip cut short at a narrow width still names its category.
 */

import { categoryLabels } from '../../lib/notificationKinds';

/** What a group with no categories reads as in a list cell and the admin
 *  list's column menu. Search leaves it out on purpose (groupSearchText in
 *  pages/Notifications.tsx). */
export const NO_CATEGORIES = 'None — inbox only';

export default function CategoryChips({ categories }: { categories: readonly string[] }) {
  const labels = categoryLabels(categories);
  return (
    <div className="chips">
      {labels.length === 0
        ? <span className="chip c-slate" title={NO_CATEGORIES}>{NO_CATEGORIES}</span>
        : labels.map((label) => <span key={label} className="chip tag" title={label}>{label}</span>)}
    </div>
  );
}

/** One settings section on the Settings tab (layout A): a panel whose head
 *  carries the section title, its source line ("changed on the portal by
 *  Jimmy · 2 hours ago") and, for super admins, Edit. */

import type { ReactNode } from 'react';

export default function SettingsCard({
  title, source, onEdit, actions, children,
}: {
  title: string;
  source: string | null;
  /** Absent when the viewer can't edit (below rank 80, no change permission). */
  onEdit?: () => void;
  /** Extra head buttons (the Sound card's Upload sound). */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="kd-card-title">
          <h3>{title}</h3>
          {source && <span className="set-note">{source}</span>}
        </div>
        {(actions || onEdit) && (
          <div className="kd-card-actions">
            {actions}
            {onEdit && (
              <button type="button" className="mini-btn" aria-label={`Edit ${title.toLowerCase()}`}
                      onClick={onEdit}>Edit</button>
            )}
          </div>
        )}
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

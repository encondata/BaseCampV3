/** Stacked toasts (max 3) for new inbox items + local messages. Generic:
 *  the only kind-specific bit is the action mapping below. */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { getReportRunDownloadUrl } from '../lib/api';
import { useLocalToasts, useNotifications } from '../lib/notificationsContext';
import { openPresigned } from '../lib/reports';
import '../styles/toast.css';

/** Inbox toasts fade themselves out; the item stays unread in the bell. */
export const INBOX_TOAST_MS = 10_000;

export default function ToastHost() {
  const { newItems, dismissNew, markRead } = useNotifications();
  const { toasts, dismiss } = useLocalToasts();
  const navigate = useNavigate();

  const shown = newItems.slice(0, 3);
  const shownIds = shown.map((i) => i.id).join(',');
  useEffect(() => {
    if (!shownIds) return;
    const timers = shownIds.split(',').map(
      (id) => setTimeout(() => dismissNew(id), INBOX_TOAST_MS));
    return () => timers.forEach(clearTimeout);
  }, [shownIds, dismissNew]);

  const act = async (item: (typeof newItems)[number]) => {
    if (item.kind === 'report_ready' && typeof item.payload.run_id === 'string') {
      const runId = item.payload.run_id;
      try { await openPresigned(() => getReportRunDownloadUrl(runId)); } catch { return; /* leave the toast in place */ }
    } else if (item.link) {
      navigate(item.link);
    }
    void markRead(item.id);
    dismissNew(item.id);
  };

  return (
    <div className="toast-host">
      {shown.map((item) => (
        <div key={item.id} className="toast" role="status">
          <div className="toast-text">
            <div className="toast-title">{item.title}</div>
            {item.body && <div className="toast-body">{item.body}</div>}
          </div>
          <button className="toast-action" onClick={() => void act(item)}>
            {item.kind === 'report_ready' ? 'Download' : 'Open'}
          </button>
          <button className="toast-dismiss" aria-label="Dismiss" onClick={() => dismissNew(item.id)}>×</button>
        </div>
      ))}
      {toasts.map((t) => (
        <div key={t.id} className="toast toast-local" role="status">
          <div className="toast-text">{t.message}</div>
          <button className="toast-dismiss" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

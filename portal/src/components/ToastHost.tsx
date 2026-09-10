/** Stacked toasts (max 3) for new inbox items + local messages. Generic:
 *  the only kind-specific bit is the action mapping below. */
import { useNavigate } from 'react-router-dom';

import { getReportRunDownloadUrl } from '../lib/api';
import { useLocalToasts, useNotifications } from '../lib/notificationsContext';
import '../styles/toast.css';

export default function ToastHost() {
  const { newItems, dismissNew, markRead } = useNotifications();
  const { toasts, dismiss } = useLocalToasts();
  const navigate = useNavigate();

  const act = async (item: (typeof newItems)[number]) => {
    if (item.kind === 'report_ready' && typeof item.payload.run_id === 'string') {
      try { window.open(await getReportRunDownloadUrl(item.payload.run_id), '_blank'); } catch { return; /* leave the toast in place */ }
    } else if (item.link) {
      navigate(item.link);
    }
    void markRead(item.id);
    dismissNew(item.id);
  };

  return (
    <div className="toast-host">
      {newItems.slice(0, 3).map((item) => (
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

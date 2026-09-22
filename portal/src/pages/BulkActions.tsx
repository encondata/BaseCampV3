/**
 * Bulk Actions — the launcher for jobs that touch many records at once.
 * Admin rank and up (the route and the nav item are both gated on
 * ADMIN_RANK). Tools are added as BULK_TOOLS entries; each renders a card
 * whose action either navigates to an existing page or opens an existing
 * dialog in place.
 */
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import '../styles/bulk.css';

export interface BulkTool {
  key: string;
  title: string;
  description: string;
  /** Hides the card when the viewer lacks this resource:action. */
  resource?: string;
  action?: 'view' | 'add' | 'change' | 'delete';
  /** Either navigate somewhere or run something in place. */
  to?: string;
  run?: () => void;
  button: string;
}

export const BULK_TOOLS: BulkTool[] = [
  {
    key: 'sites', title: 'Add or update sites in bulk',
    description: 'Download a template or the current list, fill it in, upload it, and review adds and updates before applying.',
    resource: 'sites', action: 'add', to: '/bulk/sites', button: 'Open',
  },
];

export default function BulkActions() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const tools = BULK_TOOLS.filter((t) => !t.resource || can(t.resource, t.action ?? 'view'));

  return (
    <div className="portal-page">
      <div className="eyebrow">Admin</div>
      <h1 className="page-title">Bulk Actions</h1>
      <p className="page-hint">One place for the jobs that touch many records at once.</p>

      {tools.length === 0 ? (
        <div className="dir-empty"><b>Nothing here yet</b>Bulk tools will appear here as they are added.</div>
      ) : (
        <div className="bulk-grid">
          {tools.map((t) => (
            <div key={t.key} className="bulk-card">
              <b>{t.title}</b>
              <p className="page-hint">{t.description}</p>
              <button className="btn-solid" onClick={() => (t.to ? navigate(t.to) : t.run?.())}>
                {t.button}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

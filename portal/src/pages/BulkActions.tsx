/**
 * Bulk Actions — the launcher for jobs that touch many records at once.
 * Admin rank and up (the route and the nav item are both gated on
 * ADMIN_RANK). Tools are added as BULK_TOOLS entries; each renders a card
 * whose action either navigates to an existing page or opens an existing
 * dialog in place.
 */
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import type { Action } from '../lib/access';
import { MOVE_SETUP_PERMISSIONS } from '../lib/moveSetup';
import '../styles/bulk.css';

export interface BulkTool {
  key: string;
  title: string;
  description: string;
  /** Hides the card when the viewer lacks this resource:action. */
  resource?: string;
  action?: Action;
  /** More resource:action pairs the viewer also needs (a tool whose routes
   *  write several kinds of record). */
  also?: readonly (readonly [string, Action])[];
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
  {
    key: 'workers', title: 'Add or update workers in bulk',
    description: 'Load a crew list from a spreadsheet. Existing people match by email, phone, or name; update or skip each one.',
    resource: 'workers', action: 'add', to: '/bulk/workers', button: 'Open',
  },
  {
    key: 'trucks', title: 'Add or update trucks in bulk',
    description: 'Load a fleet list from a spreadsheet. Existing trucks match by name; update or skip each one.',
    resource: 'trucks', action: 'add', to: '/bulk/trucks', button: 'Open',
  },
  {
    key: 'initiative-people', title: 'Add or update a job\'s team in bulk',
    description: 'Load a job\'s team from a spreadsheet. People already on the job match by worker name; update or skip each one.',
    resource: 'initiatives', action: 'change', to: '/bulk/initiative-people', button: 'Open',
  },
  {
    key: 'assets', title: 'Update assets in bulk',
    description: 'Load changes from a spreadsheet. Rows match existing assets by Asset ID or serial; review every change before applying.',
    resource: 'assets', action: 'change', to: '/bulk/assets', button: 'Open',
  },
  {
    key: 'time', title: 'Add time punches in bulk',
    description: 'Load shifts from a spreadsheet or another timekeeping system. Workers, jobs, and sites are matched by name; review every shift before adding.',
    resource: 'time', action: 'add', to: '/bulk/time', button: 'Open',
  },
  {
    key: 'new-move', title: 'Create a move in steps',
    description: 'The move, its From-To assets, crates, and trucks — reviewed, then created together.',
    resource: 'initiatives', action: 'add', also: MOVE_SETUP_PERMISSIONS,
    to: '/bulk/new-move', button: 'Open',
  },
];

export default function BulkActions() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const tools = BULK_TOOLS.filter((t) => (!t.resource || can(t.resource, t.action ?? 'view'))
    && (t.also ?? []).every(([resource, action]) => can(resource, action)));

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

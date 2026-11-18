/** An app's page: its name, platform and package or bundle ID, and every
 *  version as a list. Each row's Actions ▾ offers Install (on a phone of
 *  the app's platform) and, by permission, Make current, Edit notes and
 *  Delete; Make current and Delete show a review first. */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable, { type DataTableColumn } from '@portal/components/DataTable';
import { formatBytes } from '@portal/components/FileDropzone';
import StandardModal from '@portal/components/StandardModal';
import { RowActionsMenu, type RowAction } from '@portal/components/hardware/RowActionsMenu';

import {
  deleteVersion, editNotes, errorText, getApp, installApp, makeCurrent, PLATFORM_LABEL, versionLabel,
  type AppDetail, type VersionOut,
} from '../lib/appsApi';
import { dayTime } from '../lib/dates';
import { readDeviceRef } from '../lib/deviceRef';
import { goTo } from '../lib/goTo';
import { viewerPlatform } from '../lib/platform';

const COLUMNS: DataTableColumn[] = [
  { key: 'version', label: 'Version', mono: true },
  { key: 'build', label: 'Build', mono: true },
  { key: 'uploaded', label: 'Uploaded', mono: true },
  { key: 'by', label: 'By' },
  { key: 'size', label: 'Size', mono: true, align: 'right' },
  { key: 'notes', label: 'Notes' },
  { key: 'current', label: 'Current' },
  { key: 'actions', label: '', align: 'right' },
];

type Dialog =
  | { kind: 'make-current'; version: VersionOut }
  | { kind: 'delete'; version: VersionOut }
  | { kind: 'notes'; version: VersionOut };

export default function AppDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const load = useCallback(async () => {
    try {
      setApp(await getApp(id));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const install = async (version: VersionOut) => {
    if (!app) return;
    setNotice(null);
    setError(null);
    try {
      const result = await installApp(app.id, {
        versionId: version.id, deviceRef: app.platform === 'ios' ? readDeviceRef() : null,
      });
      if ('url' in result) goTo(result.url);
      else setNotice(result.message);   // iOS: re-signing this version for the iPhone
    } catch (err) {
      setError(errorText(err));
    }
  };

  const actionsFor = (v: VersionOut): RowAction[] => {
    const actions: RowAction[] = [];
    if (app && viewerPlatform() === app.platform) {
      actions.push({ key: 'install', label: 'Install', onSelect: () => void install(v) });
    }
    if (can('app_distribution', 'change')) {
      if (!v.is_current) {
        actions.push({ key: 'make-current', label: 'Make current', onSelect: () => setDialog({ kind: 'make-current', version: v }) });
      }
      actions.push({ key: 'notes', label: 'Edit notes', onSelect: () => setDialog({ kind: 'notes', version: v }) });
    }
    if (can('app_distribution', 'delete')) {
      actions.push({
        key: 'delete', label: 'Delete', destructive: true, onSelect: () => setDialog({ kind: 'delete', version: v }),
        disabled: v.is_current, hint: v.is_current ? 'Make another version current first' : undefined,
      });
    }
    return actions;
  };

  if (!app) {
    return (
      <div className="portal-page">
        <div className="eyebrow">Apps</div>
        {error ? <p className="pf-error">{error}</p> : <p className="page-hint">Loading…</p>}
      </div>
    );
  }

  const rows = app.versions.map((v) => ({
    key: v.id,
    cells: [
      <b className="cell-top">{v.version_name}</b>,
      v.build,
      dayTime(v.uploaded_at),
      v.uploaded_by_name,
      formatBytes(v.size),
      v.notes ? <span className="cell-sub">{v.notes}</span> : null,
      v.is_current ? <span className="chip c-green">Current</span> : null,
      <RowActionsMenu actions={actionsFor(v)} />,
    ],
  }));

  const done = () => { setDialog(null); void load(); };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Apps</div>
          <h1 className="page-title">{app.name}</h1>
          <p className="page-hint">{`${PLATFORM_LABEL[app.platform]} · ${app.identifier}`}</p>
        </div>
      </div>
      {notice && <p className="page-hint devices-status-line" role="status">{notice}</p>}
      {error && <p className="pf-error">{error}</p>}
      <DataTable columns={COLUMNS} rows={rows} ariaLabel="Versions" emptyText="No versions yet." />

      {dialog?.kind === 'make-current' && (
        <ConfirmDialog
          title={`Make ${versionLabel(dialog.version)} current?`}
          description="New installs get this version. Phones that already have a newer version keep it."
          action="Make current"
          run={() => makeCurrent(dialog.version.id)}
          onClose={() => setDialog(null)} onDone={done}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${versionLabel(dialog.version)}?`}
          description="It can't be installed from Devices after this. Phones that already have it keep it."
          action="Delete" destructive
          run={() => deleteVersion(dialog.version.id)}
          onClose={() => setDialog(null)} onDone={done}
        />
      )}
      {dialog?.kind === 'notes' && (
        <NotesDialog version={dialog.version} onClose={() => setDialog(null)} onDone={done} />
      )}
    </div>
  );
}

/** The review before a version action: what will happen, then the action. */
function ConfirmDialog({ title, description, action, destructive = false, run, onClose, onDone }: {
  title: string; description: string; action: string; destructive?: boolean;
  run: () => Promise<unknown>; onClose: () => void; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await run();
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <StandardModal
      eyebrow="Devices" title={title} description={description} onClose={onClose} busy={busy}
      cardClass="devices-modal devices-modal-narrow"
      footer={(
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={`btn-solid${destructive ? ' btn-danger' : ''}`} disabled={busy}
                  onClick={() => void go()}>{action}</button>
        </>
      )}
    >
      {error && <p className="pf-error">{error}</p>}
    </StandardModal>
  );
}

function NotesDialog({ version, onClose, onDone }: {
  version: VersionOut; onClose: () => void; onDone: () => void;
}) {
  const [notes, setNotes] = useState(version.notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await editNotes(version.id, notes);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <StandardModal
      eyebrow="Devices" title={`Edit notes for ${versionLabel(version)}`} onClose={onClose} busy={busy}
      cardClass="devices-modal"
      footer={(
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-solid" disabled={busy} onClick={() => void save()}>Save</button>
        </>
      )}
    >
      <div className="pf-form devices-form">
        <div className="full">
          <label htmlFor="devices-version-notes">Release notes</label>
          <textarea id="devices-version-notes" rows={5} value={notes} maxLength={5000} disabled={busy}
                    autoFocus onChange={(e) => setNotes(e.target.value)} />
        </div>
        {error && <p className="full pf-error">{error}</p>}
      </div>
    </StandardModal>
  );
}

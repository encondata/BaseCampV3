/**
 * NotificationGroupDetail — the Full Details page for one notification
 * group (/system/notifications/:groupId). Hero mirrors InitiativeDetail's
 * idet-header (back-link, title row with status/summary chips, header
 * actions). A group is a name, a description, Active/Paused and its members:
 * it decides nothing about what anyone gets, so the page has no delivery
 * settings, only the hero and the Members panel. Renaming is delegated to
 * components/notifications/EditGroupModal to keep this file under the house
 * ~500-line split threshold. The Members panel (add/remove) is similarly
 * delegated to components/notifications/MembersPanel.tsx, which reuses this
 * page's `load()` as its `reload()` contract.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import EditGroupModal from '../components/notifications/EditGroupModal';
import MembersPanel from '../components/notifications/MembersPanel';
import {
  ApiError, deleteNotificationGroup, getNotificationGroup, updateNotificationGroup,
  type NotificationGroupDetail as NotificationGroupDetailOut,
} from '../lib/api';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/initiatives.css';
import '../styles/settings.css';
import '../styles/notifications.css';

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? `Request failed (${err.code}).`
    : 'Network error — nothing was saved.';

export default function NotificationGroupDetailPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canChange = can('notifications', 'change');
  const canDelete = can('notifications', 'delete');

  const [group, setGroup] = useState<NotificationGroupDetailOut | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState('');

  const [confirmDel, setConfirmDel] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const [editingGroup, setEditingGroup] = useState(false);

  const load = useCallback(async () => {
    if (!groupId) return;
    try {
      const g = await getNotificationGroup(groupId);
      setGroup(g);
      setNotFound(false);
      setLoadError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setLoadError('Failed to load notification group.');
    }
  }, [groupId]);

  useEffect(() => { void load(); }, [load]);

  const togglePause = async () => {
    if (!group) return;
    setPauseBusy(true);
    setPauseError('');
    try {
      await updateNotificationGroup(group.id, { enabled: !group.enabled });
      await load();
    } catch (err) {
      setPauseError(msgFor(err));
    } finally {
      setPauseBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!group) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await deleteNotificationGroup(group.id);
      navigate('/system/notifications');
    } catch (err) {
      setDeleteError(msgFor(err));
      setConfirmDel(false);
    } finally {
      setDeleteBusy(false);
    }
  };

  if (notFound) {
    return (
      <div className="portal-page">
        <Link to="/system/notifications" className="idet-back">← Notifications</Link>
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Group not found</b>
          It may have been deleted, or you may not have access.
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="portal-page">
        <Link to="/system/notifications" className="idet-back">← Notifications</Link>
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Cannot load group</b>{loadError}
        </div>
      </div>
    );
  }

  if (!group) {
    return (
      <div className="portal-page">
        <Link to="/system/notifications" className="idet-back">← Notifications</Link>
        <p className="page-hint" style={{ marginTop: 16 }}>Loading…</p>
      </div>
    );
  }

  return (
    <div className="portal-page">
      <Link to="/system/notifications" className="idet-back">← Notifications</Link>

      <div className="idet-header">
        <div className="idet-heading">
          <p className="eyebrow">System · Notifications</p>
          <div className="idet-title-row">
            <h1 className="page-title">{group.name}</h1>
            <span className={`chip ${group.enabled ? 'c-green' : 'tag'}`}>
              <span className="dot" />{group.enabled ? 'Enabled' : 'Paused'}
            </span>
            <span className="chip tag">
              {group.member_count} member{group.member_count === 1 ? '' : 's'}
            </span>
          </div>
          {group.description && <p className="page-hint idet-desc">{group.description}</p>}
          {pauseError && <span className="pf-error">{pauseError}</span>}
          {deleteError && <span className="pf-error">{deleteError}</span>}
        </div>
        <div className="idet-header-actions">
          {canChange && (
            <button className="mini-btn" disabled={pauseBusy} onClick={() => void togglePause()}>
              {pauseBusy ? 'Working…' : (group.enabled ? 'Pause' : 'Resume')}
            </button>
          )}
          {canChange && (
            <button className="btn-solid" onClick={() => setEditingGroup(true)}>Edit</button>
          )}
          {canDelete && (
            confirmDel ? (
              <>
                <button className="mini-btn danger" disabled={deleteBusy}
                        onClick={() => void handleDelete()}>
                  {deleteBusy ? 'Deleting…' : 'Really delete?'}
                </button>
                <button className="mini-btn" disabled={deleteBusy}
                        onClick={() => setConfirmDel(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="mini-btn danger" onClick={() => setConfirmDel(true)}>
                Delete
              </button>
            )
          )}
        </div>
      </div>

      <MembersPanel group={group} canChange={canChange} reload={load} />

      {editingGroup && (
        <EditGroupModal
          group={group}
          onClose={() => setEditingGroup(false)}
          onSaved={() => { setEditingGroup(false); void load(); }}
        />
      )}
    </div>
  );
}

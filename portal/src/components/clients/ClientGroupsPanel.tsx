/**
 * ClientGroupsPanel — the Groups section on a client's Full Details page
 * (staff only; the page decides who sees it). An All | Review switch like
 * the catalog's: All lists the client's groups with Actions ▾ (Edit, Merge
 * into…, Delete) and an Add group button; Review lists unmatched From-To
 * Owner values (GroupReviewPanel). The panel owns both payloads, because
 * the Review tab's badge needs the count while All is showing.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  deleteClientGroup, listClientGroups, listGroupReview, type ClientGroup, type ReviewValue,
} from '../../lib/api';
import { groupMsgFor } from '../../lib/clientGroups';
import { ACTIONS_TRACK, ColHead, listGridStyle, type ColumnDef } from '../../lib/listTools';
import { RowActionsMenu } from '../hardware/RowActionsMenu';
import StandardModal from '../StandardModal';
import GroupEditModal from './GroupEditModal';
import GroupMatchModal from './GroupMatchModal';
import GroupMergeModal from './GroupMergeModal';
import GroupReviewPanel from './GroupReviewPanel';
import '../../styles/directory.css';

const GROUP_COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '1fr', default: true, min: 140 },
  { key: 'aliases', label: 'Aliases', width: '2fr', default: true, min: 160 },
  { key: 'assets', label: 'Assets', width: '80px', default: true },
  { key: 'people', label: 'People', width: '80px', default: true },
];

type Modal =
  | { kind: 'edit'; group?: ClientGroup; seedValue?: string }
  | { kind: 'merge'; group: ClientGroup }
  | { kind: 'delete'; group: ClientGroup }
  | { kind: 'match'; value: string };

export default function ClientGroupsPanel({ clientId }: { clientId: string }) {
  const [view, setView] = useState<'all' | 'review'>('all');
  const [groups, setGroups] = useState<ClientGroup[] | null>(null);
  const [groupsError, setGroupsError] = useState('');
  const [review, setReview] = useState<ReviewValue[] | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [showDismissed, setShowDismissed] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);

  const loadGroups = useCallback(async () => {
    try { setGroups(await listClientGroups(clientId)); setGroupsError(''); }
    catch (e) { setGroupsError(groupMsgFor(e)); }
  }, [clientId]);
  const loadReview = useCallback(async () => {
    try { setReview(await listGroupReview(clientId, true)); setReviewError(''); }
    catch (e) { setReviewError(groupMsgFor(e)); }
  }, [clientId]);

  useEffect(() => { void loadGroups(); void loadReview(); }, [loadGroups, loadReview]);

  const changed = () => { setModal(null); void loadGroups(); void loadReview(); };
  const reviewCount = review ? review.filter((v) => !v.dismissed).length : null;

  const grid = listGridStyle(GROUP_COLUMNS, [ACTIONS_TRACK]);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  return (
    <div className="init-panel" style={{ marginTop: 18 }}>
      <p className="eyebrow-sm">Groups</p>
      <div className="dir-toolbar idet-people-toolbar">
        <div className="segmented" role="tablist" aria-label="Groups view">
          <button role="tab" aria-selected={view === 'all'} className={view === 'all' ? 'on' : ''}
                  onClick={() => setView('all')}>All</button>
          <button role="tab" aria-selected={view === 'review'} className={view === 'review' ? 'on' : ''}
                  onClick={() => setView('review')}>
            {/* the space is load-bearing: without it the tab's accessible
                name is "Review3" */}
            Review{reviewCount !== null && <>{' '}<span className="badge-count">{reviewCount}</span></>}
          </button>
        </div>
        {view === 'all' && (
          <div className="toolbar-right">
            <button type="button" className="mini-btn accent" onClick={() => setModal({ kind: 'edit' })}>Add group</button>
          </div>
        )}
      </div>

      {view === 'all' && (
        <>
          {groupsError && !groups && <div className="dir-empty"><b>Cannot load groups</b>{groupsError}</div>}
          {!groups && !groupsError && <p className="page-hint">Loading…</p>}
          {groups && (
            <div className="dir-list list-scroll">
              <div className="list-head" style={rowStyle}>
                {GROUP_COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
                <span className="col-head" aria-hidden="true" />
              </div>
              {groups.length === 0 && (
                <div className="dir-empty"><b>No groups yet</b>Add a group to match From-To Owner values to it.</div>
              )}
              {groups.map((g) => (
                <div key={g.id} className="dir-row" style={{ minWidth: rowStyle.minWidth }}>
                  <div className="row-main" style={{ ...rowStyle, cursor: 'default' }}>
                    <div className="cell"><span className="cell-line" title={g.name}>{g.name}</span></div>
                    <div className="cell">
                      <div className="chips">
                        {g.aliases.map((a) => <span key={a} className="chip tag">{a}</span>)}
                      </div>
                    </div>
                    <div className="cell mono">{g.asset_count}</div>
                    <div className="cell mono">{g.people_count}</div>
                    <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <RowActionsMenu actions={[
                        { key: 'edit', label: 'Edit', onSelect: () => setModal({ kind: 'edit', group: g }) },
                        { key: 'merge', label: 'Merge into…', onSelect: () => setModal({ kind: 'merge', group: g }),
                          disabled: groups.length < 2 },
                        { key: 'delete', label: 'Delete', destructive: true,
                          onSelect: () => setModal({ kind: 'delete', group: g }) },
                      ]} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {view === 'review' && (
        <GroupReviewPanel clientId={clientId} data={review} loadError={reviewError}
                          showDismissed={showDismissed} onToggleDismissed={setShowDismissed}
                          onMatch={(value) => setModal({ kind: 'match', value })}
                          onCreate={(value) => setModal({ kind: 'edit', seedValue: value })}
                          onChanged={() => void loadReview()} />
      )}

      {modal?.kind === 'edit' && (
        <GroupEditModal clientId={clientId} group={modal.group} seedValue={modal.seedValue}
                        onClose={() => setModal(null)} onSaved={changed} />
      )}
      {modal?.kind === 'merge' && groups && (
        <GroupMergeModal clientId={clientId} source={modal.group} groups={groups}
                         onClose={() => setModal(null)} onMerged={changed} />
      )}
      {modal?.kind === 'match' && groups && (
        <GroupMatchModal clientId={clientId} value={modal.value} groups={groups}
                         onClose={() => setModal(null)} onMatched={changed}
                         onCreate={() => setModal({ kind: 'edit', seedValue: modal.value })} />
      )}
      {modal?.kind === 'delete' && (
        <DeleteGroupModal clientId={clientId} group={modal.group}
                          onClose={() => setModal(null)} onDeleted={changed} />
      )}
    </div>
  );
}

function DeleteGroupModal({ clientId, group, onClose, onDeleted }: {
  clientId: string; group: ClientGroup; onClose: () => void; onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try { await deleteClientGroup(clientId, group.id); onDeleted(); }
    catch (e) { setError(groupMsgFor(e)); setBusy(false); }
  };
  return (
    <StandardModal eyebrow="Client groups" title="Delete group" busy={busy} onClose={onClose}
      cardClass="group-modal-card"
      description={`Delete “${group.name}”? Its rows become unmatched and the group comes off everyone who has it.`}
      footer={<>
        <button className="btn-solid" disabled={busy} onClick={() => void run()}>
          {busy ? 'Deleting…' : 'Delete'}
        </button>
        <button className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
      </>}>
      {error ? <p className="pf-error">{error}</p> : <p className="set-note">This cannot be undone.</p>}
    </StandardModal>
  );
}

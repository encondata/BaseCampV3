/**
 * The packet editor (a dialog): name, description, the ordered documents
 * (Move up / Move down, or drag a row), whether workers must finish them in
 * order, and when they are due (the initiative's schedule, or a number of
 * days before it starts). Save creates a packet (learning:add) or sends only
 * what changed (learning:change); Copy needs add, Archive needs delete. A
 * manager without the action sees the same values and no control for it.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  archiveLearningPacket, copyLearningPacket, createLearningPacket, getLearningPacket,
  listLearningDocuments, patchLearningPacket,
  type LearningDocumentListItem, type LearningPacket, type PacketItem, type PacketPatch,
} from '../../lib/learning';
import { apiErrorText } from '../../lib/learningDoc';
import { PACKET_ERRORS } from '../../lib/learningRules';
import { moveKey, useReorderDrag } from '../../lib/listTools';
import { naturalCompare } from '../../lib/sites';
import ComboBox from '../ComboBox';
import { Switch } from '../Switch';
import LearningModal from './LearningModal';
import { useLearningAccess } from './useLearningAccess';

type DueMode = 'schedule' | 'days';

export default function PacketEditor({ packetId, onClose, onSaved, onChanged }: {
  /** The packet to edit; null starts a new one. */
  packetId: string | null;
  onClose: () => void;
  onSaved: (packet: LearningPacket) => void;
  /** Copy or Archive happened: a message for a toast. */
  onChanged: (message: string) => void;
}) {
  const can = useLearningAccess();
  const isNew = packetId === null;
  const canEdit = isNew ? can('add') : can('change');

  const [packet, setPacket] = useState<LearningPacket | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<PacketItem[]>([]);
  const [enforce, setEnforce] = useState(false);
  const [dueMode, setDueMode] = useState<DueMode>('schedule');
  const [dueText, setDueText] = useState('');
  const [docs, setDocs] = useState<LearningDocumentListItem[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fill = (p: LearningPacket) => {
    setPacket(p);
    setName(p.name);
    setDescription(p.description ?? '');
    setItems(p.items);
    setEnforce(p.enforce_order);
    setDueMode(p.due_offset_days === null ? 'schedule' : 'days');
    setDueText(p.due_offset_days === null ? '' : String(p.due_offset_days));
  };

  const load = () => {
    if (packetId === null) return;
    setLoadFailed(false);
    getLearningPacket(packetId).then(fill).catch(() => setLoadFailed(true));
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [packetId]);

  useEffect(() => {
    if (!canEdit) return;
    let alive = true;
    listLearningDocuments()
      .then((d) => { if (alive) setDocs(d); })
      .catch(() => { if (alive) { setDocs([]); setError('Couldn’t load the documents.'); } });
    return () => { alive = false; };
  }, [canEdit]);

  const addable = useMemo(() => {
    const inPacket = new Set(items.map((i) => i.document_id));
    return (docs ?? []).filter((d) => !inPacket.has(d.id) && !d.archived_at)
      .sort((a, b) => naturalCompare(a.title, b.title))
      .map((d) => ({
        value: d.id, label: d.title,
        sub: d.current_version_no === null ? 'Not published' : `v${d.current_version_no}`,
      }));
  }, [docs, items]);

  const drag = useReorderDrag(
    (src, dst, before) => {
      const ids = moveKey(items.map((i) => i.document_id), src, dst, before);
      setItems((list) => ids.map((id) => list.find((i) => i.document_id === id)!));
    },
    'y', { ignoreFrom: 'button, input' });

  const move = (at: number, by: -1 | 1) => setItems((list) => {
    const to = at + by;
    if (to < 0 || to >= list.length) return list;
    const next = [...list];
    [next[at], next[to]] = [next[to], next[at]];
    return next;
  });

  const dueDays = dueMode === 'days' && /^\d+$/.test(dueText.trim()) ? Number(dueText.trim()) : null;
  const dueValid = dueMode === 'schedule' || dueDays !== null;
  const dueValue = dueMode === 'schedule' ? null : dueDays;

  // what differs from the saved packet (everything, for a new one)
  const changes: PacketPatch = {};
  const trimmedDescription = description.trim() || null;
  if (isNew || name.trim() !== packet?.name) changes.name = name.trim();
  if (isNew || trimmedDescription !== (packet?.description ?? null)) changes.description = trimmedDescription;
  if (isNew || enforce !== packet?.enforce_order) changes.enforce_order = enforce;
  if (isNew || dueValue !== packet?.due_offset_days) changes.due_offset_days = dueValue;
  const itemIds = items.map((i) => i.document_id);
  if (isNew || itemIds.join() !== (packet?.items ?? []).map((i) => i.document_id).join()) changes.items = itemIds;
  const dirty = isNew || Object.keys(changes).length > 0;
  const canSubmit = canEdit && name.trim() !== '' && dueValid && dirty && !saving && (isNew || packet !== null);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const saved = isNew
        ? await createLearningPacket({ ...changes, name: name.trim() })
        : await patchLearningPacket(packetId, changes);
      onSaved(saved);
    } catch (e) {
      setError(apiErrorText(e, PACKET_ERRORS));
      setSaving(false);
    }
  };

  const copy = async () => {
    if (packetId === null) return;
    setSaving(true);
    setError('');
    try {
      const made = await copyLearningPacket(packetId);
      onChanged(`Copied as ${made.name}`);
    } catch (e) {
      setError(apiErrorText(e, PACKET_ERRORS));
      setSaving(false);
    }
  };

  const archive = async () => {
    if (packetId === null || !packet) return;
    if (!window.confirm(`Archive “${packet.name}”? Rules that use it stop assigning it; workers keep what they were assigned.`)) return;
    setSaving(true);
    setError('');
    try {
      await archiveLearningPacket(packetId);
      onChanged(`Archived ${packet.name}`);
    } catch (e) {
      setError(apiErrorText(e, PACKET_ERRORS));
      setSaving(false);
    }
  };

  const ready = isNew || packet !== null;

  return (
    <LearningModal eyebrow={isNew ? 'Learning packets' : packet?.name ?? 'Learning packets'} wide
                   title={isNew ? 'New packet' : 'Edit packet'}
                   description="A packet is an ordered set of documents that rules hand out together."
                   onClose={onClose} busy={saving}
                   footer={ready ? (
                     <>
                       {canEdit && (
                         <button type="button" className="btn-solid" onClick={() => void save()} disabled={!canSubmit}>
                           {saving ? 'Saving…' : isNew ? 'Create packet' : 'Save changes'}
                         </button>
                       )}
                       <button type="button" className="mini-btn" onClick={onClose} disabled={saving}>
                         {canEdit ? 'Cancel' : 'Close'}
                       </button>
                       {!isNew && can('add') && (
                         <button type="button" className="mini-btn" onClick={() => void copy()} disabled={saving}>Copy</button>
                       )}
                       {!isNew && can('delete') && (
                         <button type="button" className="mini-btn" onClick={() => void archive()} disabled={saving}>Archive</button>
                       )}
                       {error && <span className="pf-error">{error}</span>}
                     </>
                   ) : undefined}>
      {loadFailed && (
        <p className="pf-error" role="alert">
          Couldn’t load the packet. <button type="button" className="mini-btn" onClick={load}>Try again</button>
        </p>
      )}
      {!ready && !loadFailed && <p className="page-hint">Loading…</p>}
      {ready && (
        <>
          <div className="pf-form">
            <div className="full">
              <label htmlFor="lrn-pk-name">Name</label>
              <input id="lrn-pk-name" value={name} maxLength={200} disabled={!canEdit || saving}
                     placeholder="e.g. Standard onboarding" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="full">
              <label htmlFor="lrn-pk-desc">Description</label>
              <textarea id="lrn-pk-desc" rows={2} maxLength={1000} value={description}
                        disabled={!canEdit || saving} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>

          <div className="lrn-pk-section">
            <p className="lrn-kicker">
              Documents<span className="badge-count">{items.length}</span>
            </p>
            {items.length === 0 && <p className="lrn-hint">No documents yet. Add the first one below.</p>}
            {items.length > 0 && (
              <ul className="lrn-items" role="list" aria-label="Documents in this packet">
                {items.map((it, at) => (
                  <li key={it.document_id} role="listitem"
                      className={`lrn-item ${canEdit ? drag.dropClass(it.document_id) : ''}`}
                      {...(canEdit ? drag.dragProps(it.document_id) : {})}>
                    <span className="lrn-grip" aria-hidden="true">{canEdit ? '⋮⋮' : ''}</span>
                    <span className="lrn-item-n">{at + 1}</span>
                    <span className="lrn-item-title cell-top cell-line" title={it.title}>{it.title}</span>
                    {it.archived
                      ? <span className="chip c-slate">Archived</span>
                      : it.current_version_no === null
                        ? <span className="chip c-amber">Not published</span>
                        : <span className="chip c-slate">v{it.current_version_no}</span>}
                    {canEdit && (
                      <span className="lrn-actions">
                        <button type="button" className="mini-btn" disabled={saving || at === 0}
                                aria-label={`Move up ${it.title}`} onClick={() => move(at, -1)}>Up</button>
                        <button type="button" className="mini-btn" disabled={saving || at === items.length - 1}
                                aria-label={`Move down ${it.title}`} onClick={() => move(at, 1)}>Down</button>
                        <button type="button" className="mini-btn" disabled={saving}
                                aria-label={`Remove ${it.title}`}
                                onClick={() => setItems((l) => l.filter((x) => x.document_id !== it.document_id))}>Remove</button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <div className="lrn-pk-add">
                <ComboBox options={addable} value="" ariaLabel="Add a document" disabled={saving}
                          placeholder={docs === null ? 'Loading…' : 'Add a document…'}
                          onChange={(id) => {
                            const doc = (docs ?? []).find((d) => d.id === id);
                            if (!doc) return;
                            setItems((l) => [...l, {
                              document_id: doc.id, title: doc.title,
                              current_version_no: doc.current_version_no, archived: false,
                            }]);
                          }} />
              </div>
            )}
          </div>

          <div className="lrn-pk-section">
            <div className="lrn-toggle">
              <span>Workers must finish the documents in order</span>
              <Switch checked={enforce} onChange={setEnforce} disabled={!canEdit || saving}
                      label="Workers must finish the documents in order" />
            </div>
            <div className="lrn-set">
              <span className="lrn-lbl">Due</span>
              <div className="lrn-validity">
                <div className="segmented" role="group" aria-label="Due">
                  <button type="button" aria-pressed={dueMode === 'schedule'} disabled={!canEdit || saving}
                          className={dueMode === 'schedule' ? 'on' : ''}
                          onClick={() => setDueMode('schedule')}>Initiative schedule</button>
                  <button type="button" aria-pressed={dueMode === 'days'} disabled={!canEdit || saving}
                          className={dueMode === 'days' ? 'on' : ''}
                          onClick={() => setDueMode('days')}>Days before start</button>
                </div>
                {dueMode === 'days' && (
                  <>
                    <input className="lrn-num" inputMode="numeric" value={dueText}
                           aria-label="Days before the initiative starts" disabled={!canEdit || saving}
                           onChange={(e) => setDueText(e.target.value)} />
                    <span className="lrn-unit">days before the initiative starts</span>
                  </>
                )}
              </div>
              {dueMode === 'schedule' && (
                <p className="lrn-hint">Workers get the due date set on each initiative’s Learning tab.</p>
              )}
            </div>
          </div>
        </>
      )}
    </LearningModal>
  );
}

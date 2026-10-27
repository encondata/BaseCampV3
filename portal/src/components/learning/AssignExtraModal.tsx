/**
 * Assign an extra: hand a packet, or a few documents, to chosen people on
 * this initiative (an assignment the rules don't make). People come from
 * the initiative's roster. Ends with a per-person summary of what each got
 * and what was skipped. Needs learning:add.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  assignLearning, listLearningDocuments, listLearningPackets,
  type AssignSummary, type AssignSummaryRow, type LearningDocumentListItem,
  type PacketListItem, type RosterRow,
} from '../../lib/learning';
import { naturalCompare } from '../../lib/sites';
import ChipPicker from '../ChipPicker';
import ComboBox from '../ComboBox';
import { plural, tabErrorText } from './initiativeLearning';
import LearningList, { type LearningColumn } from './LearningList';
import LearningModal from './LearningModal';

const COLUMNS = {
  worker: { key: 'worker', label: 'Worker', width: '1fr', default: true, min: 140 },
  gets: { key: 'gets', label: 'Assigned', width: '1.4fr', default: true, min: 150 },
  skipped: { key: 'skipped', label: 'Skipped', width: '1.4fr', default: true, min: 150 },
};

const skippedText = (r: AssignSummaryRow) => r.skipped.map((s) => `${s.title}: ${s.reason}`).join('; ');

type Kind = 'packet' | 'documents';

export default function AssignExtraModal({ initiativeId, people, onClose, onAssigned }: {
  initiativeId: string;
  /** Everyone on the initiative. */
  people: RosterRow[];
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [kind, setKind] = useState<Kind>('packet');
  const [personIds, setPersonIds] = useState<string[]>([]);
  const [packetId, setPacketId] = useState('');
  const [docIds, setDocIds] = useState<string[]>([]);
  const [packets, setPackets] = useState<PacketListItem[] | null>(null);
  const [docs, setDocs] = useState<LearningDocumentListItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<AssignSummary | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([listLearningPackets(), listLearningDocuments()])
      .then(([p, d]) => { if (alive) { setPackets(p); setDocs(d); } })
      .catch(() => { if (alive) { setPackets([]); setDocs([]); setLoadFailed(true); } });
    return () => { alive = false; };
  }, []);

  const peopleOptions = useMemo(() => people
    .map((p) => ({ value: p.person_id, label: p.name, sub: p.partner }))
    .sort((a, b) => naturalCompare(a.label, b.label)), [people]);
  const packetOptions = useMemo(() => (packets ?? []).map((p) => ({
    value: p.id, label: p.name, sub: plural(p.item_count, 'document'),
  })).sort((a, b) => naturalCompare(a.label, b.label)), [packets]);
  // a document with no published version can't be signed yet
  const docOptions = useMemo(() => (docs ?? [])
    .filter((d) => d.current_version_no !== null && !d.archived_at)
    .map((d) => ({ value: d.id, label: d.title })), [docs]);

  const ready = personIds.length > 0 && (kind === 'packet' ? packetId !== '' : docIds.length > 0);

  const assign = async () => {
    setSaving(true);
    setError('');
    try {
      const out = await assignLearning({
        person_ids: personIds, initiative_id: initiativeId,
        packet_id: kind === 'packet' ? packetId : null,
        document_ids: kind === 'documents' ? docIds : [],
      });
      setDone(out);
      onAssigned();
    } catch (e) {
      setError(tabErrorText(e));
    } finally {
      setSaving(false);
    }
  };

  const columns: LearningColumn<AssignSummaryRow>[] = [
    { def: COLUMNS.worker, cell: (r) => <span className="cell-top cell-line" title={r.name}>{r.name}</span> },
    {
      def: COLUMNS.gets,
      cell: (r) => {
        const text = r.will_get.length ? r.will_get.join(', ') : 'Nothing new';
        return <span className="cell-sub cell-line" title={text}>{text}</span>;
      },
    },
    {
      def: COLUMNS.skipped,
      cell: (r) => <span className="cell-sub cell-line" title={skippedText(r)}>{skippedText(r) || 'None'}</span>,
    },
  ];

  return (
    <LearningModal eyebrow="Learning" title="Assign an extra" wide={done !== null}
                   description="Hand a packet or documents to people on this initiative, on top of what the rules assign."
                   onClose={onClose} busy={saving}
                   footer={done ? (
                     <button type="button" className="btn-solid" onClick={onClose}>Close</button>
                   ) : (
                     <>
                       <button type="button" className="btn-solid" onClick={() => void assign()}
                               disabled={!ready || saving}>
                         {saving ? 'Assigning…' : 'Assign'}
                       </button>
                       <button type="button" className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
                       {error && <span className="pf-error" role="alert">{error}</span>}
                     </>
                   )}>
      {!done && (
        <div className="lrn-sched">
          <div className="lrn-set">
            <span className="lrn-lbl">People</span>
            <ChipPicker options={peopleOptions} selected={personIds} onChange={setPersonIds}
                        disabled={saving} clearAll ariaLabel="People to assign" placeholder="Type to search people…" />
          </div>
          <div className="lrn-set">
            <span className="lrn-lbl">What to assign</span>
            <div className="segmented" role="group" aria-label="What to assign">
              <button type="button" aria-pressed={kind === 'packet'} className={kind === 'packet' ? 'on' : ''}
                      disabled={saving} onClick={() => setKind('packet')}>A packet</button>
              <button type="button" aria-pressed={kind === 'documents'} className={kind === 'documents' ? 'on' : ''}
                      disabled={saving} onClick={() => setKind('documents')}>Documents</button>
            </div>
            {kind === 'packet' ? (
              <ComboBox options={packetOptions} value={packetId} onChange={setPacketId} ariaLabel="Packet"
                        disabled={saving} placeholder={packets === null ? 'Loading…' : 'Type to search packets…'} />
            ) : (
              <ChipPicker options={docOptions} selected={docIds} onChange={setDocIds} disabled={saving}
                          ariaLabel="Documents" placeholder={docs === null ? 'Loading…' : 'Type to search documents…'} />
            )}
            {loadFailed && <p className="pf-error" role="alert">Couldn’t load the packets and documents.</p>}
          </div>
        </div>
      )}
      {done && (
        <>
          <p className="lrn-done" role="status">
            {`Assigned ${plural(done.totals.to_assign, 'document')} to ${plural(done.rows.filter((r) => r.will_get.length > 0).length, 'worker')}.`}
          </p>
          <LearningList columns={columns} rows={done.rows} rowKey={(r) => r.person_id}
                        ariaLabel="Assignment results"
                        empty={<><b>Nothing new</b>Everyone picked already has these.</>} />
        </>
      )}
    </LearningModal>
  );
}

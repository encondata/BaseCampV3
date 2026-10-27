/**
 * /learning/packets — every packet (an ordered set of documents that rules
 * hand out together) as a standard list: documents, the rules using it,
 * whether workers must finish in order, and when it is due. A row opens the
 * packet editor; New packet (learning:add) opens it empty.
 */

import { useCallback, useEffect, useState } from 'react';

import LearningList, { type LearningColumn } from '../../components/learning/LearningList';
import PacketEditor from '../../components/learning/PacketEditor';
import { useLearningAccess } from '../../components/learning/useLearningAccess';
import { listLearningPackets, type PacketListItem } from '../../lib/learning';
import { useToast } from '../../lib/notificationsContext';
import '../../styles/directory.css';
import '../../styles/learning.css';

export const PACKET_COLUMNS = {
  name: { key: 'name', label: 'Packet', width: '2fr', default: true, min: 200 },
  documents: { key: 'documents', label: 'Documents', short: 'Docs', width: '1fr', default: true, min: 110 },
  rules: { key: 'rules', label: 'Rules using it', short: 'Rules', width: '1fr', default: true, min: 100 },
  order: { key: 'order', label: 'Order', width: '1fr', default: true, min: 110 },
  due: { key: 'due', label: 'Due', width: '1.4fr', default: true, min: 160 },
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export default function LearningPackets() {
  const toast = useToast();
  const canAdd = useLearningAccess()('add');
  const [packets, setPackets] = useState<PacketListItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  /** The editor: a packet id, or null for a new packet. */
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    listLearningPackets()
      .then(setPackets)
      .catch(() => { setFailed(true); setPackets((p) => p ?? []); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const done = (message: string) => {
    setEditing(null);
    toast(message);
    load();
  };

  const columns: LearningColumn<PacketListItem>[] = [
    {
      def: PACKET_COLUMNS.name,
      cell: (p) => (
        <>
          <span className="cell-top cell-line" title={p.name}>{p.name}</span>
          {p.description && <span className="cell-sub cell-line" title={p.description}>{p.description}</span>}
        </>
      ),
    },
    { def: PACKET_COLUMNS.documents, cell: (p) => <span className="cell-top cell-line">{plural(p.item_count, 'document')}</span> },
    { def: PACKET_COLUMNS.rules, cell: (p) => <span className="cell-top cell-line">{plural(p.rule_count, 'rule')}</span> },
    {
      def: PACKET_COLUMNS.order,
      cell: (p) => <span className="cell-top cell-line">{p.enforce_order ? 'In order' : 'Any order'}</span>,
    },
    {
      def: PACKET_COLUMNS.due,
      cell: (p) => (
        <span className="cell-top cell-line">
          {p.due_offset_days === null ? 'Initiative schedule' : `${plural(p.due_offset_days, 'day')} before start`}
        </span>
      ),
    },
  ];

  const loadFailed = failed && (packets ?? []).length === 0;

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Learning</div>
          <h1 className="page-title">
            Packets
            {packets !== null && !loadFailed && <span className="badge-count">{packets.length}</span>}
          </h1>
          <p className="page-hint">
            Ordered sets of documents that rules hand out together. Open a packet to change its
            documents, order and due date.
          </p>
        </div>
        {canAdd && (
          <button type="button" className="btn-solid" onClick={() => setEditing({ id: null })}>New packet</button>
        )}
      </div>

      {loadFailed && (
        <div className="dir-empty" role="alert">
          <b>Couldn’t load the packets.</b>
          <div className="audit-more">
            <button type="button" className="mini-btn" onClick={load}>Try again</button>
          </div>
        </div>
      )}
      {packets === null && <p className="page-hint">Loading…</p>}
      {packets !== null && !loadFailed && (
        <LearningList columns={columns} rows={packets} rowKey={(p) => p.id} ariaLabel="Packets"
                      onRowClick={(p) => setEditing({ id: p.id })}
                      empty={(
                        <>
                          <b>No packets yet</b>
                          {canAdd ? 'Create one, then point a rule at it.' : 'Packets appear here once a manager adds them.'}
                        </>
                      )} />
      )}

      {editing && (
        <PacketEditor packetId={editing.id} onClose={() => setEditing(null)}
                      onSaved={() => done('Packet saved')} onChanged={done} />
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';

import ComboBox from '@portal/components/ComboBox';
import DataTable from '@portal/components/DataTable';

import { errorText, getAuditFacets, listAudit, type AuditItem } from '../lib/sirdarApi';

const PAGE = 100;

export default function Audit() {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [facets, setFacets] = useState<{ entity_types: string[]; actions: string[] }>({ entity_types: [], actions: [] });
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  const load = useCallback((offset: number) => {
    const id = ++reqId.current;
    setError('');
    setLoading(true);
    if (offset === 0) { setItems([]); setMore(false); }
    listAudit({ entity_type: entityType, action, offset, limit: PAGE })
      .then((rows) => {
        if (id !== reqId.current) return;
        setItems((cur) => (offset === 0 ? rows : [...cur, ...rows]));
        setMore(rows.length === PAGE);
      })
      .catch((e) => { if (id === reqId.current) setError(errorText(e, "Couldn't load the audit log.")); })
      .finally(() => { if (id === reqId.current) setLoading(false); });
  }, [entityType, action]);

  useEffect(() => { load(0); }, [load]);
  useEffect(() => { getAuditFacets().then(setFacets).catch(() => {}); }, []);

  return (
    <div className="portal-page">
      <div className="eyebrow">Administration</div>
      <div className="dir-head">
        <h1>Audit log</h1>
        <p>Every sign-in, import and permission change in Sirdar, newest first.</p>
      </div>
      <div className="dir-toolbar">
        <ComboBox ariaLabel="Record type" placeholder="All record types" clearable value={entityType}
                  onChange={setEntityType}
                  options={facets.entity_types.map((t) => ({ value: t, label: t }))} />
        <ComboBox ariaLabel="Action" placeholder="All actions" clearable value={action}
                  onChange={setAction}
                  options={facets.actions.map((a) => ({ value: a, label: a }))} />
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <DataTable
        ariaLabel="Audit log"
        columns={[{ key: 'at', label: 'When' }, { key: 'actor', label: 'Who' },
                  { key: 'action', label: 'Action', mono: true }, { key: 'entity', label: 'Record' },
                  { key: 'ip', label: 'IP', mono: true }]}
        rows={items.map((i) => ({
          key: String(i.id),
          cells: [new Date(i.at).toLocaleString(), i.actor_name ?? '—', i.action,
                  `${i.entity_type}${i.entity_id ? ` · ${i.entity_id}` : ''}`, i.ip ?? '—'],
        }))}
        emptyText="Nothing recorded yet."
      />
      {more && (
        <button type="button" className="btn-ghost" disabled={loading} onClick={() => load(items.length)}>Load more</button>
      )}
    </div>
  );
}

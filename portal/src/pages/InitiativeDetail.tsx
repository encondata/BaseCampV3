/**
 * InitiativeDetail — the Full Details page for one initiative
 * (/initiatives/:id), in the spirit of BaseCampV2's ProjectDetail/
 * MoveDetail: header with every top-level field, then section cards.
 * Field edits still route through InitiativeEditModal — this page only
 * owns its own data load plus the read-only sections below the header.
 * People/Links/Notes land in a follow-up slice.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import InitiativeEditModal from '../components/initiatives/InitiativeEditModal';
import {
  ApiError,
  getInitiative,
  listClients,
  listInitiativeStatuses,
  listInitiativeSubTypes,
  listInitiativeTypes,
  listPartners,
  listShippingTypes,
  listSites,
  type InitiativeDetail as InitiativeDetailOut,
  type OrgRef,
  type SiteItem,
  type StatusValue,
} from '../lib/api';
import { ADMIN_RANK } from '../lib/access';
import { initiativeCellText } from '../lib/initiatives';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/profile.css';

/** real_start_at/real_end_at are date-only fields stored as midnight UTC
 *  — slicing the ISO string (rather than toLocaleDateString) avoids the
 *  day-west-of-UTC shift documented on lib/initiatives.ts's dateOnly. */
const dateOnly = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

export default function InitiativeDetail() {
  const { id } = useParams<{ id: string }>();
  const { can, maxRank } = useAuth();
  const canChange = can('initiatives', 'change');
  const canViewSites = can('sites', 'view');
  const canViewClients = can('clients', 'view');
  const canViewPartners = can('partners', 'view');
  const isAdmin = maxRank >= ADMIN_RANK;

  const [initiative, setInitiative] = useState<InitiativeDetailOut | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [types, setTypes] = useState<StatusValue[]>([]);
  const [subTypes, setSubTypes] = useState<StatusValue[]>([]);
  const [shippingTypes, setShippingTypes] = useState<StatusValue[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [clients, setClients] = useState<OrgRef[]>([]);
  const [partners, setPartners] = useState<OrgRef[]>([]);
  const [editing, setEditing] = useState(false);

  const load = () => {
    if (!id) return;
    void getInitiative(id).then((data) => {
      setInitiative(data);
      setNotFound(false);
      setError('');
    }).catch((err) => {
      setNotFound(err instanceof ApiError
        && (err.status === 403 || err.status === 404));
      setError(err instanceof ApiError && (err.status === 403 || err.status === 404)
        ? '' : 'Failed to load initiative.');
    });
  };
  useEffect(load, [id]);

  useEffect(() => {
    void listInitiativeStatuses().then(setStatuses).catch(() => {});
    void listInitiativeTypes().then(setTypes).catch(() => {});
    void listInitiativeSubTypes().then(setSubTypes).catch(() => {});
    void listShippingTypes().then(setShippingTypes).catch(() => {});
    if (canViewSites) void listSites().then(setSites).catch(() => {});
    if (canViewClients) void listClients().then(setClients).catch(() => {});
    if (canViewPartners) void listPartners().then(setPartners).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const kv = (label: string, value: string | null | undefined) => (
    <><dt>{label}</dt><dd>{value || '—'}</dd></>
  );

  const chip = (label: string | null | undefined, color: string | null | undefined) =>
    label && color
      ? (
        <span className="chip custom" style={{ '--chip': color } as CSSProperties}>
          <span className="dot" />{label}
        </span>
      )
      : null;

  const partnerName = (partnerId: string | null) => {
    if (!partnerId || !canViewPartners) return null;
    return partners.find((p) => p.id === partnerId)?.name ?? null;
  };

  if (notFound) {
    return (
      <div className="portal-page">
        <Link to="/initiatives" className="idet-back">← Initiatives</Link>
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Initiative not found</b>
          It may have been deleted, or you may not have access.
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="portal-page">
        <Link to="/initiatives" className="idet-back">← Initiatives</Link>
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Cannot load initiative</b>
          {error}
        </div>
      </div>
    );
  }

  if (!initiative) {
    return (
      <div className="portal-page">
        <Link to="/initiatives" className="idet-back">← Initiatives</Link>
        <p className="page-hint" style={{ marginTop: 16 }}>Loading…</p>
      </div>
    );
  }

  const isMove = initiative.initiative_type === 'move';

  return (
    <div className="portal-page">
      <Link to="/initiatives" className="idet-back">← Initiatives</Link>

      <div className="idet-header">
        <div className="idet-heading">
          <div className="idet-title-row">
            <h1 className="page-title">{initiative.name}</h1>
            {chip(initiative.type_label, initiative.type_color)}
            {initiative.sub_type_label
              && chip(initiative.sub_type_label, initiative.sub_type_color)}
            {chip(initiative.status_label, initiative.status_color)}
            {initiative.archived_at && <span className="chip tag">Archived</span>}
          </div>
          {initiative.description && (
            <p className="page-hint idet-desc">{initiative.description}</p>
          )}
        </div>
        {canChange && (
          <button className="btn-solid" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>

      <div className="detail-grid idet-grid">
        <div className="init-panel"
             style={!isMove ? { gridColumn: '1 / -1' } : undefined}>
          <p className="eyebrow-sm">Overview</p>
          <dl className="kv">
            {kv('Type', initiative.type_label)}
            {kv('Sub-type', initiative.sub_type_label)}
            {kv('Status', initiative.status_label)}
            {kv('Client', initiative.client_name)}
            {!isMove && kv('Site', initiative.site_name)}
            {kv('Location', initiative.location)}
            {kv('Scheduled', [initiativeCellText(initiative, 'start'),
                              initiativeCellText(initiative, 'end')]
              .filter((s) => s !== '—').join(' → ') || '—')}
            {kv('Actual', [dateOnly(initiative.real_start_at),
                           dateOnly(initiative.real_end_at)]
              .filter((s): s is string => !!s).join(' → ') || '—')}
            {initiative.initiative_type === 'project'
              && kv('Sky Command ID', initiative.sky_command_project_id)}
            {kv('Created', initiativeCellText(initiative, 'created'))}
          </dl>
        </div>

        {isMove && (
          <div className="init-panel">
            <p className="eyebrow-sm">Move</p>
            <dl className="kv">
              {kv('Origin → Destination', [initiative.origin_site_name,
                                           initiative.destination_site_name]
                .filter(Boolean).join(' → ') || '—')}
              {kv('Shipping types', initiative.shipping_types.join(', '))}
              {kv('Shipping partner', initiative.shipping_partner_name)}
              {kv('Priority devices',
                  initiative.priority_devices == null ? null
                    : initiative.priority_devices ? 'Yes' : 'No')}
              {kv('Origin vendor involved',
                  initiative.origin_vendor_involved == null ? null
                    : initiative.origin_vendor_involved ? 'Yes' : 'No')}
              {kv('Destination vendor involved',
                  initiative.destination_vendor_involved == null ? null
                    : initiative.destination_vendor_involved ? 'Yes' : 'No')}
              {kv('Origin tech partner',
                  partnerName(initiative.origin_tech_partner_id))}
              {kv('Origin cable partner',
                  partnerName(initiative.origin_cable_partner_id))}
              {kv('Origin logistics partner',
                  partnerName(initiative.origin_logistics_partner_id))}
              {kv('Destination tech partner',
                  partnerName(initiative.destination_tech_partner_id))}
              {kv('Destination cable partner',
                  partnerName(initiative.destination_cable_partner_id))}
              {kv('Destination logistics partner',
                  partnerName(initiative.destination_logistics_partner_id))}
            </dl>
          </div>
        )}

        <div className="init-panel" style={{ gridColumn: '1 / -1' }}>
          <p className="eyebrow-sm">Assets</p>
          <p className="page-hint">Asset tracking lands here next.</p>
        </div>
      </div>

      {editing && (
        <InitiativeEditModal
          initiative={initiative}
          statuses={statuses} types={types} subTypes={subTypes}
          shippingTypes={shippingTypes}
          sites={sites} clients={clients} partners={partners}
          isAdmin={isAdmin} canChange={canChange}
          onClose={() => setEditing(false)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}

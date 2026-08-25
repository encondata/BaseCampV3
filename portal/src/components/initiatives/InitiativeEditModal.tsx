/**
 * InitiativeEditModal — the only place an initiative's fields are
 * mutated: field edits + archive/unarchive. `initiative === null` opens
 * in create mode. The type picker drives conditional sections
 * (sectionsForType); after creation only admins may change the type —
 * the server enforces this too (403 type_change_forbidden). Follows
 * ContainerEditModal's modal conventions.
 */

import { useState, type FormEvent } from 'react';

import {
  ApiError,
  archiveInitiative,
  createInitiative,
  updateInitiative,
  type InitiativeItem,
  type OrgRef,
  type SiteItem,
  type StatusValue,
} from '../../lib/api';
import {
  formFromInitiative, INITIATIVE_ERRORS, initiativePayload, sectionsForType,
  type InitiativeFormState,
} from '../../lib/initiatives';
import ComboBox from '../ComboBox';

interface Props {
  initiative: InitiativeItem | null;   // null = create mode
  statuses: StatusValue[];
  types: StatusValue[];
  subTypes: StatusValue[];
  shippingTypes: StatusValue[];
  sites: SiteItem[];
  clients: OrgRef[];
  partners: OrgRef[];
  isAdmin: boolean;
  canChange: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

function mapError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return INITIATIVE_ERRORS[err.code] ?? fallback;
  return 'Network error.';
}

export default function InitiativeEditModal({
  initiative, statuses, types, subTypes, shippingTypes, sites, clients,
  partners, isAdmin, canChange, onClose, onSaved,
}: Props) {
  const isCreateMode = initiative === null;
  const [form, setForm] = useState<InitiativeFormState>(
    () => formFromInitiative(initiative));
  const [archived, setArchived] = useState<boolean>(!!initiative?.archived_at);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const locked = saving || (!isCreateMode && !canChange);
  // type is picked freely on create; edits are admin-only (server-enforced)
  const typeLocked = locked || (!isCreateMode && !isAdmin);
  const sections = sectionsForType(form.initiative_type);

  const setField = (key: keyof InitiativeFormState, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setFlag = (key: keyof InitiativeFormState, value: boolean) =>
    setForm((f) => ({ ...f, [key]: value }));
  const toggleShipping = (key: string) =>
    setForm((f) => ({
      ...f,
      shipping_types: f.shipping_types.includes(key)
        ? f.shipping_types.filter((s) => s !== key)
        : [...f.shipping_types, key],
    }));

  // a row sitting on a retired vocab value isn't in the is_active list —
  // seed the option back from the row (the ContainerEditModal trap/fix)
  const seedOption = (
    list: StatusValue[], key: string | null | undefined,
    label: string | null | undefined,
  ) => (key && !list.some((s) => s.key === key)
    ? [...list, { key, label: label ?? key } as StatusValue] : list);

  const statusOptions = seedOption(statuses, initiative?.status,
    initiative?.status_label).map((s) => ({ value: s.key, label: s.label }));
  const typeOptions = seedOption(types, initiative?.initiative_type,
    initiative?.type_label).map((t) => ({ value: t.key, label: t.label }));
  const subTypeOptions = seedOption(subTypes, initiative?.sub_type,
    initiative?.sub_type_label).map((t) => ({ value: t.key, label: t.label }));
  const siteOptions = (exclude?: string) => sites
    .filter((s) => !s.archived_at || s.id === exclude)
    .map((s) => ({ value: s.id, label: s.name }));
  const orgOptions = (orgs: OrgRef[]) =>
    orgs.filter((o) => !o.archived_at)
      .map((o) => ({ value: o.id, label: o.name }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = initiativePayload(form);
      if (isCreateMode) {
        await createInitiative(payload);
      } else {
        await updateInitiative(initiative.id, payload);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async () => {
    if (!initiative) return;
    setSaving(true);
    setError('');
    try {
      await archiveInitiative(initiative.id, !archived);
      setArchived((v) => !v);
      await onSaved();
    } catch (err) {
      setError(mapError(err, 'Could not change the archive state — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const partnerCombo = (
    label: string, key: keyof InitiativeFormState,
  ) => (
    <div><label>{label}</label>
      <ComboBox
        placeholder="Type to search partners…"
        value={form[key] as string}
        clearable
        disabled={locked}
        onChange={(v) => setField(key, v)}
        options={orgOptions(partners)}
      /></div>
  );

  const title = initiative
    ? `Edit — ${form.name || 'Initiative'}` : 'New initiative';

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}
                  disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.2" strokeLinecap="round">
              <path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            <div className="modal-section">Identity</div>
            <div className="pf-form">
              <div><label>Name</label>
                <input value={form.name} disabled={locked} required
                       onChange={(e) => setField('name', e.target.value)} /></div>
              <div><label>Type</label>
                <ComboBox
                  placeholder="Type to search types…"
                  value={form.initiative_type}
                  disabled={typeLocked}
                  onChange={(v) => setField('initiative_type', v)}
                  options={typeOptions}
                />
                {!isCreateMode && !isAdmin && (
                  <span className="page-hint">Only admins can change the type.</span>
                )}</div>
              <div><label>Sub-type</label>
                <ComboBox
                  placeholder="Type to search sub-types…"
                  value={form.sub_type}
                  clearable
                  disabled={locked}
                  onChange={(v) => setField('sub_type', v)}
                  options={subTypeOptions}
                /></div>
              <div><label>Status</label>
                <ComboBox
                  placeholder="Type to search statuses…"
                  value={form.status}
                  disabled={locked}
                  onChange={(v) => setField('status', v)}
                  options={statusOptions}
                /></div>
              <div style={{ gridColumn: '1 / -1' }}><label>Description</label>
                <input value={form.description} disabled={locked}
                       onChange={(e) => setField('description', e.target.value)} /></div>
            </div>

            <div className="modal-section">Where &amp; when</div>
            <div className="pf-form">
              <div><label>Client</label>
                <ComboBox
                  placeholder="Type to search clients…"
                  value={form.client_id}
                  clearable
                  disabled={locked}
                  onChange={(v) => setField('client_id', v)}
                  options={orgOptions(clients)}
                /></div>
              <div><label>Site</label>
                <ComboBox
                  placeholder="Type to search sites…"
                  value={form.site_id}
                  clearable
                  disabled={locked}
                  onChange={(v) => setField('site_id', v)}
                  options={siteOptions(form.site_id)}
                /></div>
              <div><label>Location (free text)</label>
                <input value={form.location} disabled={locked}
                       onChange={(e) => setField('location', e.target.value)} /></div>
              <div><label>Scheduled start</label>
                <input type="date" value={form.scheduled_start} disabled={locked}
                       onChange={(e) => setField('scheduled_start', e.target.value)} /></div>
              <div><label>Scheduled end</label>
                <input type="date" value={form.scheduled_end} disabled={locked}
                       onChange={(e) => setField('scheduled_end', e.target.value)} /></div>
            </div>

            {sections.project && (
              <>
                <div className="modal-section">Project</div>
                <div className="pf-form">
                  <div><label>Sky Command project ID</label>
                    <input value={form.sky_command_project_id} disabled={locked}
                           onChange={(e) =>
                             setField('sky_command_project_id', e.target.value)} /></div>
                </div>
              </>
            )}

            {sections.move && (
              <>
                <div className="modal-section">Move</div>
                <div className="pf-form">
                  <div><label>Origin site</label>
                    <ComboBox
                      placeholder="Type to search sites…"
                      value={form.origin_site_id}
                      clearable
                      disabled={locked}
                      onChange={(v) => setField('origin_site_id', v)}
                      options={siteOptions(form.origin_site_id)}
                    /></div>
                  <div><label>Destination site</label>
                    <ComboBox
                      placeholder="Type to search sites…"
                      value={form.destination_site_id}
                      clearable
                      disabled={locked}
                      onChange={(v) => setField('destination_site_id', v)}
                      options={siteOptions(form.destination_site_id)}
                    /></div>
                  <div><label>Actual start</label>
                    <input type="date" value={form.real_start_at} disabled={locked}
                           onChange={(e) => setField('real_start_at', e.target.value)} /></div>
                  <div><label>Actual end</label>
                    <input type="date" value={form.real_end_at} disabled={locked}
                           onChange={(e) => setField('real_end_at', e.target.value)} /></div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label>Shipping types</label>
                    <div className="chips">
                      {shippingTypes.map((s) => (
                        <label key={s.key} className="chip tag"
                               style={{ cursor: 'pointer' }}>
                          <input type="checkbox"
                                 checked={form.shipping_types.includes(s.key)}
                                 disabled={locked}
                                 onChange={() => toggleShipping(s.key)} />
                          {s.label}
                        </label>
                      ))}
                    </div></div>
                  {partnerCombo('Shipping partner', 'shipping_partner_id')}
                  <div><label>Priority devices</label>
                    <input type="checkbox" checked={form.priority_devices}
                           disabled={locked}
                           onChange={(e) =>
                             setFlag('priority_devices', e.target.checked)} /></div>
                  {partnerCombo('Origin tech partner', 'origin_tech_partner_id')}
                  {partnerCombo('Origin cable partner', 'origin_cable_partner_id')}
                  {partnerCombo('Origin logistics partner',
                                'origin_logistics_partner_id')}
                  <div><label>Origin vendor involved</label>
                    <input type="checkbox" checked={form.origin_vendor_involved}
                           disabled={locked}
                           onChange={(e) =>
                             setFlag('origin_vendor_involved', e.target.checked)} /></div>
                  {partnerCombo('Destination tech partner',
                                'destination_tech_partner_id')}
                  {partnerCombo('Destination cable partner',
                                'destination_cable_partner_id')}
                  {partnerCombo('Destination logistics partner',
                                'destination_logistics_partner_id')}
                  <div><label>Destination vendor involved</label>
                    <input type="checkbox"
                           checked={form.destination_vendor_involved}
                           disabled={locked}
                           onChange={(e) =>
                             setFlag('destination_vendor_involved',
                                     e.target.checked)} /></div>
                </div>
              </>
            )}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : (isCreateMode ? 'Create initiative' : 'Save')}
            </button>
            <button className="mini-btn" type="button" onClick={onClose}
                    disabled={saving}>
              Cancel
            </button>
            {initiative && canChange && (
              <button className="mini-btn danger" type="button" disabled={saving}
                      onClick={() => void toggleArchive()}>
                {archived ? 'Unarchive' : 'Archive'}
              </button>
            )}
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}

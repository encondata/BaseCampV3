/**
 * InitiativeFields — every "New initiative" field, shared by
 * InitiativeEditModal and Create a move in steps' first screen. Renders the
 * modal-section headings and pf-form grids only (no modal chrome, no
 * buttons); the caller owns the form state and the save.
 */
import { useEffect, type Dispatch, type SetStateAction } from 'react';

import {
  getNextInitiativeColor, type InitiativeItem, type OrgRef, type SiteItem, type StatusValue,
} from '../../lib/api';
import {
  partnerOptionsForRole, sectionsForType, siteOptionsForClient, type InitiativeFormState,
} from '../../lib/initiatives';
import ColorWheel from '../ColorWheel';
import ComboBox from '../ComboBox';

/** What the wheel opens on when there is nothing else to open on: the
 *  first palette color, used only while the next-color lookup is in
 *  flight or after it failed. A failed lookup must not block the form —
 *  the server assigns a color on create anyway. */
export const FALLBACK_COLOR = '#1668a7';

/** Create mode opens the wheel on the color a create would assign, so
 *  "auto-selected, changeable" is visible before saving. A user who spins
 *  the wheel before the answer arrives keeps their own choice. */
export function useNextColorSeed(
  active: boolean, setForm: Dispatch<SetStateAction<InitiativeFormState>>,
): void {
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    const seed = (hex: string) =>
      alive && setForm((f) => (f.color ? f : { ...f, color: hex }));
    void getNextInitiativeColor()
      .then(seed)
      .catch(() => seed(FALLBACK_COLOR));
    return () => { alive = false; };
  }, [active, setForm]);
}

export interface InitiativeFieldsProps {
  form: InitiativeFormState;
  setForm: Dispatch<SetStateAction<InitiativeFormState>>;
  /** The row being edited, or null — seeds retired vocab values back in. */
  initiative: InitiativeItem | null;
  statuses: StatusValue[]; types: StatusValue[]; subTypes: StatusValue[];
  shippingTypes: StatusValue[];
  sites: SiteItem[]; clients: OrgRef[]; partners: OrgRef[];
  locked: boolean;
  typeLocked: boolean;
  /** One line under the Type picker, e.g. "Only admins can change the type." */
  typeHint?: string;
  /** One line under the color wheel. */
  colorHint?: string;
  wheelColor: string;
}

export default function InitiativeFields({
  form, setForm, initiative, statuses, types, subTypes, shippingTypes, sites, clients,
  partners, locked, typeLocked, typeHint, colorHint, wheelColor,
}: InitiativeFieldsProps) {
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
  // client-aware: the selected client's assigned sites list first, but any
  // site remains typeable/selectable
  const siteOptions = (keepId?: string) =>
    siteOptionsForClient(sites, form.client_id, keepId);
  const orgOptions = (orgs: OrgRef[]) =>
    orgs.filter((o) => !o.archived_at)
      .map((o) => ({ value: o.id, label: o.name }));

  // role-aware: partners tagged with a matching function list first, but
  // any partner remains typeable/selectable
  const partnerCombo = (
    label: string, key: keyof InitiativeFormState, roleKeywords: string[],
  ) => (
    <div><label>{label}</label>
      <ComboBox
        placeholder="Type to search partners…"
        value={form[key] as string}
        clearable
        disabled={locked}
        onChange={(v) => setField(key, v)}
        options={partnerOptionsForRole(partners, roleKeywords,
                                       form[key] as string)}
      /></div>
  );

  return (
    <>
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
          {typeHint && <span className="page-hint">{typeHint}</span>}</div>
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
        <div style={{ gridColumn: '1 / -1' }}><label>Color</label>
          <ColorWheel
            value={wheelColor}
            disabled={locked}
            onChange={(hex) => setField('color', hex)}
          />
          {colorHint && <span className="page-hint">{colorHint}</span>}</div>
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
        {/* moves carry origin/destination instead — a third generic
            site dropdown would be a duplicate */}
        {!sections.move && (
          <div><label>Site</label>
            <ComboBox
              placeholder="Type to search sites…"
              value={form.site_id}
              clearable
              disabled={locked}
              onChange={(v) => setField('site_id', v)}
              options={siteOptions(form.site_id)}
            /></div>
        )}
        <div><label>Location (free text)</label>
          <input value={form.location} disabled={locked}
                 onChange={(e) => setField('location', e.target.value)} /></div>
      </div>

      <div className="modal-section">Schedule</div>
      <div className="pf-form init-dates">
        <div><label>Scheduled start</label>
          <input type="date" value={form.scheduled_start} disabled={locked}
                 onChange={(e) => setField('scheduled_start', e.target.value)} /></div>
        <div><label>Scheduled end</label>
          <input type="date" value={form.scheduled_end} disabled={locked}
                 onChange={(e) => setField('scheduled_end', e.target.value)} /></div>
        {sections.move && (
          <>
            <div><label>Actual start</label>
              <input type="date" value={form.real_start_at} disabled={locked}
                     onChange={(e) => setField('real_start_at', e.target.value)} /></div>
            <div><label>Actual end</label>
              <input type="date" value={form.real_end_at} disabled={locked}
                     onChange={(e) => setField('real_end_at', e.target.value)} /></div>
          </>
        )}
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
          <div className="modal-section">Origin</div>
          <div className="pf-form">
            <div><label>Site</label>
              <ComboBox
                placeholder="Type to search sites…"
                value={form.origin_site_id}
                clearable
                disabled={locked}
                onChange={(v) => setField('origin_site_id', v)}
                options={siteOptions(form.origin_site_id)}
              /></div>
            <div style={{ alignSelf: 'end' }}>
              <label className="init-check">
                <input type="checkbox" checked={form.origin_vendor_involved}
                       disabled={locked}
                       onChange={(e) =>
                         setFlag('origin_vendor_involved', e.target.checked)} />
                Vendor involved
              </label></div>
            <div className="init-partner-row">
              {partnerCombo('Tech partner', 'origin_tech_partner_id', ['tech'])}
              {partnerCombo('Cable partner', 'origin_cable_partner_id', ['cable'])}
              {partnerCombo('Logistics partner',
                            'origin_logistics_partner_id',
                            ['logistics'])}
            </div>
          </div>

          <div className="modal-section">Destination</div>
          <div className="pf-form">
            <div><label>Site</label>
              <ComboBox
                placeholder="Type to search sites…"
                value={form.destination_site_id}
                clearable
                disabled={locked}
                onChange={(v) => setField('destination_site_id', v)}
                options={siteOptions(form.destination_site_id)}
              /></div>
            <div style={{ alignSelf: 'end' }}>
              <label className="init-check">
                <input type="checkbox"
                       checked={form.destination_vendor_involved}
                       disabled={locked}
                       onChange={(e) =>
                         setFlag('destination_vendor_involved',
                                 e.target.checked)} />
                Vendor involved
              </label></div>
            <div className="init-partner-row">
              {partnerCombo('Tech partner', 'destination_tech_partner_id', ['tech'])}
              {partnerCombo('Cable partner', 'destination_cable_partner_id',
                            ['cable'])}
              {partnerCombo('Logistics partner',
                            'destination_logistics_partner_id',
                            ['logistics'])}
            </div>
          </div>

          <div className="modal-section">Shipping</div>
          <div className="pf-form">
            <div style={{ gridColumn: '1 / -1' }}>
              <label>Shipping types</label>
              <div className="init-checks">
                {shippingTypes.map((s) => (
                  <label key={s.key} className="init-check">
                    <input type="checkbox"
                           checked={form.shipping_types.includes(s.key)}
                           disabled={locked}
                           onChange={() => toggleShipping(s.key)} />
                    {s.label}
                  </label>
                ))}
              </div></div>
            {partnerCombo('Shipping partner', 'shipping_partner_id',
                          ['shipping', 'logistics'])}
            <div style={{ alignSelf: 'end' }}>
              <label className="init-check">
                <input type="checkbox" checked={form.priority_devices}
                       disabled={locked}
                       onChange={(e) =>
                         setFlag('priority_devices', e.target.checked)} />
                Priority devices
              </label></div>
          </div>
        </>
      )}
    </>
  );
}

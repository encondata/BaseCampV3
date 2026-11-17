/**
 * InitiativeEditModal — field edits + archive/unarchive from the
 * /initiatives list (the full details page edits in its Edit tab,
 * InitiativeEditTab; both save through useInitiativeEditor).
 * `initiative === null` opens in create mode. The type picker drives
 * conditional sections (sectionsForType); after creation only admins may
 * change the type — the server enforces this too (403
 * type_change_forbidden). Follows ContainerEditModal's modal conventions.
 */

import { type FormEvent } from 'react';

import type { InitiativeItem, OrgRef, SiteItem, StatusValue } from '../../lib/api';
import InitiativeFields from './InitiativeFields';
import { useInitiativeEditor } from './useInitiativeEditor';

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

export default function InitiativeEditModal({
  initiative, statuses, types, subTypes, shippingTypes, sites, clients,
  partners, isAdmin, canChange, onClose, onSaved,
}: Props) {
  const ed = useInitiativeEditor({ initiative, isAdmin, canChange, onSaved });
  const { isCreateMode, form, setForm, archived, saving, error, locked } = ed;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await ed.save()) onClose();
  };

  const title = initiative
    ? `Edit — ${form.name || 'Initiative'}` : 'New initiative';

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card init-modal-card">
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
            <InitiativeFields
              form={form} setForm={setForm} initiative={initiative}
              statuses={statuses} types={types} subTypes={subTypes}
              shippingTypes={shippingTypes} sites={sites} clients={clients} partners={partners}
              locked={locked} typeLocked={ed.typeLocked} wheelColor={ed.wheelColor}
              kioskPassword={!isCreateMode && isAdmin}
              typeHint={!isCreateMode && !isAdmin ? 'Only admins can change the type.' : undefined}
              colorHint={isCreateMode
                ? 'Assigned automatically — spin the wheel to choose your own.' : undefined}
            />
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={locked}>
              {saving ? 'Saving…' : (isCreateMode ? 'Create initiative' : 'Save')}
            </button>
            <button className="mini-btn" type="button" onClick={onClose}
                    disabled={saving}>
              Cancel
            </button>
            {initiative && canChange && (
              <button className="mini-btn danger" type="button" disabled={saving}
                      onClick={() => void ed.toggleArchive()}>
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

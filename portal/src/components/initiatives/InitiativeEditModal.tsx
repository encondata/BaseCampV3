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
  formFromInitiative, INITIATIVE_ERRORS, initiativePayload,
  type InitiativeFormState,
} from '../../lib/initiatives';
import InitiativeFields, { FALLBACK_COLOR, useNextColorSeed } from './InitiativeFields';

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

  // Create mode opens the wheel on the color a create would assign, so
  // "auto-selected, changeable" is visible before saving.
  useNextColorSeed(isCreateMode, setForm);

  const locked = saving || (!isCreateMode && !canChange);
  // An initiative that has never been colored shows its status color —
  // the same color the calendar paints it today — without that fallback
  // being written back to the row unless the user actually spins.
  const wheelColor =
    form.color || initiative?.status_color || FALLBACK_COLOR;
  // type is picked freely on create; edits are admin-only (server-enforced)
  const typeLocked = locked || (!isCreateMode && !isAdmin);

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
              locked={locked} typeLocked={typeLocked} wheelColor={wheelColor}
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

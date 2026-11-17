/**
 * The edit state behind an initiative's fields: the form, the archive
 * state, saving and the error, plus save and archive. Shared by
 * InitiativeEditModal (the /initiatives list's Edit and New) and the
 * Edit tab on the initiative's full details page, so the two save the
 * same way. `initiative === null` is create mode.
 */

import { useState } from 'react';

import {
  ApiError, archiveInitiative, createInitiative, updateInitiative, type InitiativeItem,
} from '../../lib/api';
import {
  formFromInitiative, INITIATIVE_ERRORS, initiativePayload, type InitiativeFormState,
} from '../../lib/initiatives';
import { FALLBACK_COLOR, useNextColorSeed } from './InitiativeFields';

function mapError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return INITIATIVE_ERRORS[err.code] ?? fallback;
  return 'Network error.';
}

export function useInitiativeEditor({ initiative, isAdmin, canChange, onSaved }: {
  initiative: InitiativeItem | null;
  isAdmin: boolean;
  canChange: boolean;
  onSaved: () => Promise<void> | void;   // parent refetches
}) {
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
  const wheelColor = form.color || initiative?.status_color || FALLBACK_COLOR;
  // type is picked freely on create; edits are admin-only (server-enforced)
  const typeLocked = locked || (!isCreateMode && !isAdmin);

  /** True when saved; the error is set when not. */
  const save = async (): Promise<boolean> => {
    setSaving(true);
    setError('');
    try {
      const payload = initiativePayload(form);
      if (initiative === null) await createInitiative(payload);
      else await updateInitiative(initiative.id, payload);
      await onSaved();
      return true;
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
      return false;
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

  /** The form differs from the saved initiative. */
  const dirty = JSON.stringify(initiativePayload(form))
    !== JSON.stringify(initiativePayload(formFromInitiative(initiative)));

  const discard = () => {
    setForm(formFromInitiative(initiative));
    setArchived(!!initiative?.archived_at);
    setError('');
  };

  return {
    isCreateMode, form, setForm, archived, saving, error, locked, typeLocked, wheelColor,
    dirty, save, toggleArchive, discard,
  };
}

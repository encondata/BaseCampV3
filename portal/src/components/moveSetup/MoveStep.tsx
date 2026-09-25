/** Step 1 — the full "New initiative" form for a move (type fixed). Next
 *  validates name + both sites, then creates the draft (or updates it after
 *  Back). Nothing else is written. */
import { useState, type Dispatch, type SetStateAction } from 'react';

import { createMoveSetup, patchMoveSetup, type MoveSetupDraft } from '../../lib/api';
import type { InitiativeFormState } from '../../lib/initiatives';
import {
  missingMoveFields, moveSetupError, movePayload, type MoveSetupLookups,
} from '../../lib/moveSetup';
import WizardFooter from '../common/WizardFooter';
import InitiativeFields, { FALLBACK_COLOR, useNextColorSeed } from '../initiatives/InitiativeFields';

interface Props {
  form: InitiativeFormState;
  setForm: Dispatch<SetStateAction<InitiativeFormState>>;
  lookups: MoveSetupLookups;
  draft: MoveSetupDraft | null;
  onDraft: (draft: MoveSetupDraft) => void;
  onNext: () => void;
}

export default function MoveStep({ form, setForm, lookups, draft, onDraft, onNext }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useNextColorSeed(true, setForm);

  const next = async () => {
    const missing = missingMoveFields(form);
    if (missing) { setError(missing); return; }
    setBusy(true);
    setError('');
    try {
      const body = movePayload(form);
      onDraft(draft ? await patchMoveSetup(draft.id, { move: body }) : await createMoveSetup(body));
      onNext();
    } catch (err) {
      setError(moveSetupError(err));
      setBusy(false);
    }
  };

  return (
    <>
      <section className="bulk-section">
        <InitiativeFields
          form={form} setForm={setForm} initiative={null}
          statuses={lookups.statuses} types={lookups.types} subTypes={lookups.subTypes}
          shippingTypes={lookups.shippingTypes} sites={lookups.sites}
          clients={lookups.clients} partners={lookups.partners}
          locked={busy} typeLocked typeHint="This tool always creates a move."
          colorHint="Assigned automatically — spin the wheel to choose your own."
          wheelColor={form.color || FALLBACK_COLOR}
        />
      </section>
      <WizardFooter onNext={() => void next()} busy={busy} error={error}
                    nextLabel={busy ? 'Saving…' : 'Next'} />
    </>
  );
}

/** Step 5 — review and create. A stub with the final Props; Task 6 replaces it. */
import type { ImportJobOut, MoveSetupDraft } from '../../lib/api';
import type { InitiativeFormState } from '../../lib/initiatives';
import type { MoveSetupLookups } from '../../lib/moveSetup';
import WizardFooter from '../common/WizardFooter';

interface Props {
  draft: MoveSetupDraft;
  onDraft: (draft: MoveSetupDraft) => void;
  form: InitiativeFormState;
  lookups: MoveSetupLookups;
  assetJob: ImportJobOut | null;
  onBack: () => void;
  onFinished: () => void;
}

export default function ReviewStep({ onBack }: Props) {
  return <WizardFooter onBack={onBack} onNext={() => undefined} nextLabel="Create move" />;
}

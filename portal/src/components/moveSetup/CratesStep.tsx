/** Step 3 — crates. A stub with the final Props; Task 6 replaces it. */
import type { MoveSetupDraft, StatusValue } from '../../lib/api';
import type { CratesValue } from '../../lib/moveSetup';
import WizardFooter from '../common/WizardFooter';

interface Props {
  draft: MoveSetupDraft;
  value: CratesValue;
  setValue: (value: CratesValue) => void;
  containerTypes: StatusValue[];
  onDraft: (draft: MoveSetupDraft) => void;
  onBack: () => void;
  onSkip: () => Promise<void>;
  onNext: () => void;
}

export default function CratesStep({ value, onBack, onSkip, onNext }: Props) {
  return (
    <>
      <section className="bulk-section">
        <label htmlFor="crates-convention">Naming convention</label>
        <input id="crates-convention" value={value.convention} readOnly />
      </section>
      <WizardFooter onBack={onBack} onSkip={() => void onSkip()} onNext={onNext} />
    </>
  );
}

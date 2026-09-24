/** Step 4 — trucks. A stub with the final Props; Task 6 replaces it. */
import type { MoveSetupDraft, SiteItem } from '../../lib/api';
import type { TrucksValue } from '../../lib/moveSetup';
import WizardFooter from '../common/WizardFooter';

interface Props {
  draft: MoveSetupDraft;
  value: TrucksValue;
  setValue: (value: TrucksValue) => void;
  origin: SiteItem | null;
  destination: SiteItem | null;
  onDraft: (draft: MoveSetupDraft) => void;
  onBack: () => void;
  onSkip: () => Promise<void>;
  onNext: () => void;
}

export default function TrucksStep({ value, onBack, onSkip, onNext }: Props) {
  return (
    <>
      <section className="bulk-section">
        <label htmlFor="trucks-convention">Naming convention</label>
        <input id="trucks-convention" value={value.convention} readOnly />
      </section>
      <WizardFooter onBack={onBack} onSkip={() => void onSkip()} onNext={onNext} />
    </>
  );
}

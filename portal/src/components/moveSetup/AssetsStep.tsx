/** Step 2 — From-To assets. A stub with the final Props; Task 5 replaces it. */
import type { ImportJobOut, MoveSetupDraft } from '../../lib/api';
import WizardFooter from '../common/WizardFooter';

interface Props {
  draft: MoveSetupDraft;
  job: ImportJobOut | null;
  setJob: (job: ImportJobOut | null) => void;
  onBack: () => void;
  onSkip: () => Promise<void>;
  onNext: () => void;
}

export default function AssetsStep({ onBack, onSkip, onNext }: Props) {
  return <WizardFooter onBack={onBack} onSkip={() => void onSkip()} onNext={onNext} />;
}

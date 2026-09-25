/** Step 4 — trucks: the convention (prefilled), count 0–100, start, preview
 *  and clashes against non-archived trucks. Every truck is attached to the
 *  move and runs origin → destination; other truck fields come later. */
import { useMemo, useState } from 'react';

import type { MoveSetupDraft, SiteItem } from '../../lib/api';
import { moveSetupError, trucksBody, type TrucksValue } from '../../lib/moveSetup';
import { namingResult, TRUCK_MAX } from '../../lib/namingConvention';
import WizardFooter from '../common/WizardFooter';
import NamingConvention from './NamingConvention';
import { useNamesCheck } from './useNamesCheck';
import { useSkip } from './useSkip';

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

export default function TrucksStep({
  draft, value, setValue, origin, destination, onDraft, onBack, onSkip, onNext,
}: Props) {
  const { names, error: namingError } = useMemo(() => namingResult(value, TRUCK_MAX), [value]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { clashes, checking, saveNow, settle } = useNamesCheck(
    draft.id, 'trucks', namingError ? null : trucksBody(value), onDraft, setError);
  const { skipping, skip } = useSkip(async () => { await settle(); await onSkip(); }, setError);

  const next = async () => {
    if (namingError) return;
    setBusy(true);
    setError('');
    try {
      const found = await saveNow(trucksBody(value));
      if (found.length === 0) onNext();
    } catch (err) {
      setError(moveSetupError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="bulk-section">
        <p className="eyebrow-sm">Naming</p>
        <NamingConvention idPrefix="trucks" noun="truck" max={TRUCK_MAX} value={value}
                          onChange={setValue} names={names} error={namingError}
                          clashes={clashes} checking={checking} disabled={busy} />
        <p className="set-note">
          Every truck is attached to this move and runs from {origin?.name ?? 'the origin'} to{' '}
          {destination?.name ?? 'the destination'}. Drivers, loads, and tracking are filled in on each truck later.
        </p>
      </section>
      <WizardFooter onBack={onBack} onSkip={skip} onNext={() => void next()}
                    nextDisabled={!!namingError || clashes.length > 0 || checking}
                    busy={busy || skipping} error={error} />
    </>
  );
}

/** Step 3 — crates: the convention (prefilled from the site codes), count
 *  0–500, start, crate type (required above 0), and label-tag counts as in
 *  "Add in bulk". Once the rule is happy the step saves itself (debounced)
 *  so the server can flag names already held by non-archived crates; Next
 *  is blocked while any clash. */
import { useMemo, useState } from 'react';

import type { MoveSetupDraft, StatusValue } from '../../lib/api';
import { clampTags, tagTotal, TAG_ASSIGNMENT_ORDER, type TagCounts } from '../../lib/bulkContainers';
import { TAG_TYPES } from '../../labels/tagTypes';
import { cratesBody, moveSetupError, SKIPPED_NOTE, type CratesValue } from '../../lib/moveSetup';
import { CRATE_MAX, namingResult } from '../../lib/namingConvention';
import ComboBox from '../ComboBox';
import WizardFooter from '../common/WizardFooter';
import LabelTagCounts from '../containers/LabelTagCounts';
import NamingConvention from './NamingConvention';
import { useNamesCheck } from './useNamesCheck';
import { useSkip } from './useSkip';

interface Props {
  draft: MoveSetupDraft;
  value: CratesValue;
  setValue: (value: CratesValue) => void;
  containerTypes: StatusValue[];
  onDraft: (draft: MoveSetupDraft) => void;
  onBack: () => void;
  onSkip: () => Promise<void>;
  onNext: () => void;
  /** Skipped earlier and not edited since: no save on mount, and Next moves
   *  on without saving. Only an edit (the page's setValue) includes it again. */
  skipped?: boolean;
}

function trimmedNotice(trimmed: TagCounts): string {
  const parts = TAG_ASSIGNMENT_ORDER.filter((k) => (trimmed[k] ?? 0) > 0)
    .map((k) => `${trimmed[k]} ${TAG_TYPES[k].label}`);
  return `Count dropped below the tag total — trimmed ${parts.join(', ')} to fit.`;
}

export default function CratesStep({
  draft, value, setValue, containerTypes, onDraft, onBack, onSkip, onNext, skipped = false,
}: Props) {
  const { names, error: namingError } = useMemo(() => namingResult(value, CRATE_MAX), [value]);
  const count = names.length;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const typeMissing = count > 0 && !value.container_type;
  const tagsFit = tagTotal(value.tags) <= count;
  // live clash check once the rule is happy (tags over the count would be refused)
  const { clashes, checking, saveNow, settle } = useNamesCheck(
    draft.id, 'crates', namingError || !tagsFit ? null : cratesBody(value), onDraft, setError,
    skipped);
  const { skipping, skip } = useSkip(async () => { await settle(); await onSkip(); }, setError);

  // never against a count the rule rejects (a cleared field reads as 0 names)
  const clampToCount = (): CratesValue => {
    if (namingError) return value;
    const { tags, trimmed } = clampTags(value.tags, count);
    if (Object.keys(trimmed).length === 0) return value;
    const next = { ...value, tags };
    setValue(next);
    setNotice(trimmedNotice(trimmed));
    return next;
  };

  const next = async () => {
    if (skipped) { onNext(); return; }         // still skipped: nothing to save
    if (namingError || typeMissing) return;
    const safe = clampToCount();
    setBusy(true);
    setError('');
    try {
      const found = await saveNow(cratesBody(safe));
      if (found.length === 0) onNext();
    } catch (err) {
      setError(moveSetupError(err));
    } finally {
      setBusy(false);
    }
  };

  const typeOptions = useMemo(
    () => containerTypes.map((t) => ({ value: t.key, label: t.label })), [containerTypes]);

  return (
    <>
      <section className="bulk-section">
        {skipped && <p className="set-note">{SKIPPED_NOTE}</p>}
        <p className="eyebrow-sm">Naming</p>
        <NamingConvention idPrefix="crates" noun="crate" max={CRATE_MAX} value={value}
                          onChange={(v) => setValue({ ...value, ...v })}
                          onCountBlur={() => void clampToCount()}
                          names={names} error={namingError} clashes={clashes}
                          checking={checking} disabled={busy || skipping} />
      </section>
      <section className="bulk-section">
        <p className="eyebrow-sm">Crate type and label tags</p>
        <div className="pf-form ms-type">
          <div><label htmlFor="crates-type">Crate type</label>
            <ComboBox inputId="crates-type" placeholder="Type to search types…"
                      value={value.container_type} disabled={busy || skipping} options={typeOptions}
                      onChange={(t) => setValue({ ...value, container_type: t })} /></div>
        </div>
        {typeMissing && <p className="set-note">Pick a crate type to create crates.</p>}
        <p className="page-hint">
          Assigned in order — the first crates get Priority, then Vendor, Accessories, Warehouse, and E-Waste.
        </p>
        <LabelTagCounts count={count} tags={value.tags} disabled={busy || skipping} notice={notice}
                        noun="crate"
                        onChange={(tags) => { setNotice(''); setValue({ ...value, tags }); }} />
      </section>
      <WizardFooter onBack={onBack} onSkip={skip} onNext={() => void next()}
                    nextDisabled={!skipped && (!!namingError || typeMissing || clashes.length > 0 || checking)}
                    busy={busy || skipping} error={error} />
    </>
  );
}

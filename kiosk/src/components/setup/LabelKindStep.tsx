/** Label Station step 4: what does this station print? Top labels come
 *  first and are the default; the choice decides which templates the
 *  printer step checks against. Tap a card to choose it, then Continue. */

import type { LabelKind } from '../../lib/api';

const CHOICES: { kind: LabelKind; title: string; meta: string }[] = [
  { kind: 'top', title: 'Top labels', meta: "4x2 today; the template's size decides" },
  { kind: 'front', title: 'Front labels', meta: '2x1' },
];

interface Props {
  selected: LabelKind;
  onSelect: (kind: LabelKind) => void;
  onContinue: () => void;
  onBack: () => void;
}

export default function LabelKindStep({ selected, onSelect, onContinue, onBack }: Props) {
  return (
    <>
      <h2>What does this station print?</h2>
      <div className="setup-cards" role="listbox" aria-label="Label types">
        {CHOICES.map((c) => (
          <button key={c.kind} type="button" role="option" aria-selected={selected === c.kind}
                  className="setup-card" onClick={() => onSelect(c.kind)}>
            <div className="setup-card-title">{c.title}</div>
            <div className="setup-card-meta">{c.meta}</div>
          </button>
        ))}
      </div>
      <div className="pf-form-actions">
        <button type="button" className="mini-btn" onClick={onBack}>Back</button>
        <button type="button" className="btn-solid" onClick={onContinue}>Continue</button>
      </div>
    </>
  );
}

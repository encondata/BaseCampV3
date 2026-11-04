/** Label Station step 4: what does this station print? Top labels come
 *  first and are the default; the choice decides which templates the
 *  printer step checks against. Tapping a card chooses it and moves on,
 *  like the Move and Site steps; the default is shown selected.
 *
 *  A web kiosk's setup ends on the same step, but a web kiosk is no Label
 *  Station: `device="kiosk"` asks what this kiosk prints. */

import type { LabelKind } from '../../lib/api';

const CHOICES: { kind: LabelKind; title: string; meta: string }[] = [
  { kind: 'top', title: 'Top labels', meta: "4x2 today; the template's size decides" },
  { kind: 'front', title: 'Front labels', meta: '2x1' },
];

interface Props {
  selected: LabelKind;
  onChoose: (kind: LabelKind) => void;
  onBack: () => void;
  /** What the question calls this device (default a laptop's "station"). */
  device?: 'station' | 'kiosk';
}

export default function LabelKindStep({ selected, onChoose, onBack, device = 'station' }: Props) {
  return (
    <>
      <h2>What does this {device} print?</h2>
      <div className="setup-cards" role="listbox" aria-label="Label types">
        {CHOICES.map((c) => (
          <button key={c.kind} type="button" role="option" aria-selected={selected === c.kind}
                  className="setup-card" onClick={() => onChoose(c.kind)}>
            <div className="setup-card-title">{c.title}</div>
            <div className="setup-card-meta">{c.meta}</div>
          </button>
        ))}
      </div>
      <div className="pf-form-actions">
        <button type="button" className="mini-btn" onClick={onBack}>Back</button>
      </div>
    </>
  );
}

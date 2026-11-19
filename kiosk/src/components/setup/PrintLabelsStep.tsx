/** A web kiosk's step 4, first question: will this kiosk print labels?
 *  Yes goes on to what it prints (LabelKindStep); No finishes the setup
 *  and hides Label Printing on this kiosk. Tapping a card chooses it, like
 *  the other steps; the kiosk's current answer is shown selected. */

interface Props {
  /** The current answer: true until a No is saved. */
  selected: boolean;
  onChoose: (prints: boolean) => void;
  onBack: () => void;
}

const CHOICES: { prints: boolean; title: string; meta: string }[] = [
  { prints: true, title: 'Yes', meta: 'Next, choose what it prints' },
  { prints: false, title: 'No', meta: 'Label Printing is hidden on this kiosk' },
];

export default function PrintLabelsStep({ selected, onChoose, onBack }: Props) {
  return (
    <>
      <h2>Will this kiosk print labels?</h2>
      <div className="setup-cards" role="listbox" aria-label="Label printing">
        {CHOICES.map((c) => (
          <button key={c.title} type="button" role="option" aria-selected={selected === c.prints}
                  className="setup-card" onClick={() => onChoose(c.prints)}>
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

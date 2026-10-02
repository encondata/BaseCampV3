/** Kiosk Setup's first step on a laptop: what is this station? */

import type { StationType } from '../../lib/kioskSetup';

const CHOICES: { type: StationType; title: string; meta: string }[] = [
  {
    type: 'label',
    title: 'Label Station',
    meta: 'Prints and scans labels. Next: Move → Site → Scan type.',
  },
  {
    type: 'rfid',
    title: 'RFID Station',
    meta: 'Pairs a Zebra FX reader on this network. Next: Select reader → Connect → Pair, then the move.',
  },
];

interface Props {
  selected: StationType | '';
  onSelect: (type: StationType) => void;
}

export default function StationTypeStep({ selected, onSelect }: Props) {
  return (
    <>
      <h2>What is this station?</h2>
      <div className="setup-cards" role="listbox" aria-label="Station types">
        {CHOICES.map((c) => (
          <button key={c.type} type="button" role="option" aria-selected={selected === c.type}
                  className="setup-card" onClick={() => onSelect(c.type)}>
            <div className="setup-card-title">{c.title}</div>
            <div className="setup-card-meta">{c.meta}</div>
          </button>
        ))}
      </div>
    </>
  );
}

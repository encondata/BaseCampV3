/** RFID settings — a placeholder until tag data handling exists. */

interface Props {
  onContinue: () => void;
  onBack: () => void;
}

export default function RfidPlaceholderStep({ onContinue, onBack }: Props) {
  return (
    <>
      <h2>RFID settings — coming soon</h2>
      <p className="page-hint">Reader settings will live here. Continue to choose the move.</p>
      <div className="pf-form-actions">
        <button type="button" className="mini-btn" onClick={onBack}>Back</button>
        <button type="button" className="btn-solid" onClick={onContinue}>Continue</button>
      </div>
    </>
  );
}

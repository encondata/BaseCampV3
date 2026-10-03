/** A write-only secret: a plain input when adding, otherwise "set / not set"
 *  with Replace / Clear / Add, and Keep / Undo to back out. `disabled` (a
 *  view-only reader) shows the state alone. */
export type SecretAction = 'keep' | 'clear' | 'set';

export default function SecretField({ id, label, isSet, adding, action, value, error, disabled = false, onAction, onValue }: {
  id: string; label: string; isSet: boolean; adding: boolean; action: SecretAction; value: string;
  error?: string; disabled?: boolean; onAction: (a: SecretAction) => void; onValue: (v: string) => void;
}) {
  const showInput = !disabled && (adding || action === 'set');
  return (
    <div className="sirdar-secret">
      {showInput ? (
        <>
          <label className="field-label" htmlFor={id}>{label}</label>
          <div className="sirdar-secret-row">
            <input id={id} type="password" value={value} autoComplete="new-password" spellCheck={false}
                   aria-invalid={!!error} onChange={(e) => onValue(e.target.value)} />
            {!adding && <button type="button" className="mini-btn" onClick={() => { onValue(''); onAction('keep'); }}>Keep</button>}
          </div>
        </>
      ) : (
        <>
          <span className="field-label">{label}</span>
          <div className="sirdar-secret-row">
            <span>{action === 'clear' && !disabled ? `${label}: will be cleared` : `${label}: ${isSet ? 'set' : 'not set'}`}</span>
            {!disabled && (action === 'clear'
              ? <button type="button" className="mini-btn" onClick={() => onAction('keep')}>Undo</button>
              : isSet
                ? <>
                    <button type="button" className="mini-btn" onClick={() => onAction('set')}>Replace</button>
                    <button type="button" className="mini-btn" onClick={() => onAction('clear')}>Clear</button>
                  </>
                : <button type="button" className="mini-btn" onClick={() => onAction('set')}>Add</button>)}
          </div>
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

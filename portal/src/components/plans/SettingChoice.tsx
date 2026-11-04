/**
 * A setting picked from a few words, as a `.segmented` group (`aria-pressed`,
 * class `on`): Plan settings (PlanSettingsModal) and System settings ›
 * Project plans. `OnOff` is the two-word kind.
 */
export function Choice<T extends string>({ label, options, value, disabled, onChange }: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T;
  disabled: boolean;
  onChange(v: T): void;
}) {
  return (
    <div className="segmented pln-set-choice" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} className={value === v ? 'on' : ''}
                disabled={disabled} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

const ON_OFF = [['on', 'On'], ['off', 'Off']] as const;

export function OnOff({ label, value, disabled, onChange }: {
  label: string; value: boolean; disabled: boolean; onChange(v: boolean): void;
}) {
  return <Choice label={label} options={ON_OFF} value={value ? 'on' : 'off'} disabled={disabled}
                 onChange={(v) => onChange(v === 'on')} />;
}

/** A Record of value → words as Choice's options, in the Record's order. */
export const choiceOptions = <T extends string>(words: Record<T, string>): [T, string][] =>
  Object.entries(words) as [T, string][];

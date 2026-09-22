/**
 * PersonChipPicker — pick many people one at a time: the house ComboBox
 * adds a removable chip per pick and drops picked people from its menu.
 * No native multi-select anywhere in the portal; this is the reusable shape.
 */
import ComboBox, { type ComboOption } from '../ComboBox';

interface Props {
  options: ComboOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

export default function PersonChipPicker({ options, selected, onChange, disabled, placeholder }: Props) {
  const byId = new Map(options.map((o) => [o.value, o]));
  const remaining = options.filter((o) => !selected.includes(o.value));
  return (
    <div className="chip-picker">
      {selected.length > 0 && (
        <div className="chip-picker-list">
          {selected.map((id) => (
            <span key={id} className="chip c-slate">
              {byId.get(id)?.label ?? id}
              <button type="button" className="chip-x" disabled={disabled}
                      aria-label={`Remove ${byId.get(id)?.label ?? id}`}
                      onClick={() => onChange(selected.filter((s) => s !== id))}>×</button>
            </span>
          ))}
        </div>
      )}
      <ComboBox options={remaining} value="" disabled={disabled}
                placeholder={placeholder ?? 'Add person…'}
                onChange={(v) => { if (v) onChange([...selected, v]); }} />
    </div>
  );
}

/**
 * PersonChipPicker — pick many people one at a time: the shared ChipPicker
 * (a removable chip per pick, picked people dropped from the ComboBox's
 * menu) with "Add person…" as its placeholder.
 */
import ChipPicker from '../ChipPicker';
import type { ComboOption } from '../ComboBox';

interface Props {
  options: ComboOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

export default function PersonChipPicker({ options, selected, onChange, disabled, placeholder }: Props) {
  return (
    <ChipPicker options={options} selected={selected} onChange={onChange} disabled={disabled}
      placeholder={placeholder ?? 'Add person…'} />
  );
}

/**
 * ChipPicker — pick many of a list one at a time: each pick is a chip with
 * a × to take it off, and the house ComboBox below offers only what isn't
 * picked yet, in natural order. No native multi-select anywhere in the
 * portal; this is the reusable shape (PersonChipPicker is it for people).
 *
 * - Chips show in `selected` order (sort it, if the caller wants them
 *   sorted); a picked id with no option shows the id itself.
 * - Picking adds a chip and clears the box, which keeps focus (its list
 *   closed until typing, ↓ or a click). Backspace in the empty box
 *   takes the last chip off. Every × is a button, so Tab reaches it; after
 *   one removes its chip, focus goes to the next chip's ×, else the
 *   previous one's, else the box — without opening its menu (that waits
 *   for a click, typing or ↓; Clear all does the same).
 * - `clearAll` adds a "Clear all" text button once there are two or more
 *   chips; `note` is a one-line state under the chips.
 * - Inside a modal the ComboBox menu portals by itself (ComboBox /
 *   useMenuPlacement), and its Escape closes the menu, not the dialog;
 *   `portal` makes it portal anywhere (inside an overflow-hidden panel).
 * - Options with a `group` stay under their group's heading, the groups in
 *   the order they first appear in `options`.
 */

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import ComboBox, { type ComboBoxHandle, type ComboOption } from './ComboBox';
import { naturalCompare } from '../lib/naturalSort';
import '../styles/chipPicker.css';

export interface ChipPickerProps {
  options: ComboOption[];
  /** The picked values, in chip order. */
  selected: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  /** A "Clear all" text button once there are two or more chips. */
  clearAll?: boolean;
  /** One line under the chips (what the selection means). */
  note?: ReactNode;
  /** The ComboBox's accessible name. */
  ariaLabel?: string;
  /** Always portal the menu (ComboBox `portal`). */
  portal?: boolean;
  /** aria-invalid on the box (a form's error is about the picks). */
  invalid?: boolean;
}

/** Where focus goes after a chip is removed: a value's ×, or the box. */
type FocusTarget = { kind: 'chip'; value: string } | { kind: 'box' };

export default function ChipPicker({
  options, selected, onChange, disabled = false, placeholder = 'Add…', clearAll = false, note, ariaLabel,
  portal = false, invalid = false,
}: ChipPickerProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const removeRefs = useRef(new Map<string, HTMLButtonElement>());
  const combo = useRef<ComboBoxHandle | null>(null);
  const [focusNext, setFocusNext] = useState<FocusTarget | null>(null);

  const byValue = new Map(options.map((o) => [o.value, o]));
  const labelOf = (v: string) => byValue.get(v)?.label ?? v;
  const picked = new Set(selected);
  // grouped options keep their groups, in the order the groups come
  const groupRank = new Map<string | undefined, number>();
  for (const o of options) if (!groupRank.has(o.group)) groupRank.set(o.group, groupRank.size);
  const remaining = options.filter((o) => !picked.has(o.value))
    .sort((a, b) => (groupRank.get(a.group)! - groupRank.get(b.group)!) || naturalCompare(a.label, b.label));

  useEffect(() => {
    if (!focusNext) return;
    setFocusNext(null);
    if (focusNext.kind === 'chip') removeRefs.current.get(focusNext.value)?.focus();
    else combo.current?.focusQuietly();   // the menu opens only when the person asks
  }, [focusNext]);

  const remove = (value: string) => {
    const i = selected.indexOf(value);
    const next = selected[i + 1] ?? selected[i - 1];
    onChange(selected.filter((v) => v !== value));
    setFocusNext(next !== undefined ? { kind: 'chip', value: next } : { kind: 'box' });
  };

  // Backspace in the empty box takes the last chip off (not one that edits
  // an IME composition; keyCode 229 is Safari's composition key)
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLInputElement;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key !== 'Backspace' || disabled || target.getAttribute('role') !== 'combobox') return;
    if (target.value === '' && selected.length > 0) onChange(selected.slice(0, -1));
  };

  return (
    <div className="chip-picker" ref={wrapRef} onKeyDownCapture={onKeyDownCapture}>
      {selected.length > 0 && (
        <div className="chip-picker-list">
          {selected.map((value) => (
            <span key={value} className="chip c-slate">
              <span>{labelOf(value)}</span>
              <button type="button" className="chip-x" disabled={disabled} aria-label={`Remove ${labelOf(value)}`}
                ref={(el) => { if (el) removeRefs.current.set(value, el); else removeRefs.current.delete(value); }}
                onClick={() => remove(value)}>×</button>
            </span>
          ))}
          {clearAll && selected.length >= 2 && (
            <button type="button" className="chip-picker-clear" disabled={disabled}
              onClick={() => { onChange([]); setFocusNext({ kind: 'box' }); }}>
              Clear all
            </button>
          )}
        </div>
      )}
      {note ? <p className="page-hint chip-picker-note">{note}</p> : null}
      <ComboBox options={remaining} value="" disabled={disabled} placeholder={placeholder} ariaLabel={ariaLabel}
        handle={combo} portal={portal} invalid={invalid}
        onChange={(v) => {
          if (!v) return;
          onChange([...selected, v]);
          setFocusNext({ kind: 'box' });   // the box keeps focus for the next pick, its list closed
        }} />
    </div>
  );
}

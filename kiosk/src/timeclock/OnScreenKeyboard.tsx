/**
 * The Enter Your Name keyboard: QWERTY rows, Shift and Backspace around
 * the bottom letter row, then 123 · Space · Search. 123 swaps the letters
 * for digits and the punctuation names carry (hyphen, apostrophe, period).
 *
 * Letters come out capitalized at the start of the box and after a space,
 * lower case otherwise; Shift capitalizes the next letter once. The caps
 * always read as capitals, like a physical keyboard's.
 *
 * Every key cancels its own mousedown, so tapping one never moves focus
 * off the search box: a badge reader is a keyboard too, and its
 * keystrokes must keep landing there.
 */

import { useState, type MouseEvent, type ReactNode } from 'react';

import { IconBackspace, IconShift } from './icons';

const LETTERS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
const SYMBOLS = ['1234567890', "-'.,&@"];

export interface OnScreenKeyboardProps {
  /** The box's current text (decides the automatic capital). */
  value: string;
  onKey(char: string): void;
  onBackspace(): void;
  onSearch(): void;
  disabled?: boolean;
}

const keepFocus = (e: MouseEvent) => e.preventDefault();

export default function OnScreenKeyboard({
  value, onKey, onBackspace, onSearch, disabled = false,
}: OnScreenKeyboardProps) {
  const [shift, setShift] = useState(false);
  const [symbols, setSymbols] = useState(false);
  const autoCap = value === '' || value.endsWith(' ');

  const key = (
    label: ReactNode, onPress: () => void,
    opts: { name?: string; className?: string; pressed?: boolean } = {},
  ) => (
    <button
      type="button"
      key={opts.name ?? String(label)}
      className={`tcx-key${opts.className ? ` ${opts.className}` : ''}`}
      aria-label={opts.name}
      aria-pressed={opts.pressed}
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={onPress}
    >
      {label}
    </button>
  );

  const letter = (ch: string) => key(ch, () => {
    onKey(shift || autoCap ? ch : ch.toLowerCase());
    setShift(false);
  });
  const plain = (ch: string) => key(ch, () => onKey(ch));

  return (
    <div className="tcx-kb" role="group" aria-label="On-screen keyboard">
      {symbols ? (
        <>
          <div className="tcx-kb-row">{[...SYMBOLS[0]].map(plain)}</div>
          <div className="tcx-kb-row">
            {[...SYMBOLS[1]].map(plain)}
            {key(<IconBackspace />, onBackspace, { name: 'Backspace', className: 'is-mod' })}
          </div>
        </>
      ) : (
        <>
          <div className="tcx-kb-row">{[...LETTERS[0]].map(letter)}</div>
          <div className="tcx-kb-row">{[...LETTERS[1]].map(letter)}</div>
          <div className="tcx-kb-row">
            {key(<IconShift />, () => setShift((s) => !s), { name: 'Shift', className: 'is-mod', pressed: shift })}
            {[...LETTERS[2]].map(letter)}
            {key(<IconBackspace />, onBackspace, { name: 'Backspace', className: 'is-mod' })}
          </div>
        </>
      )}
      <div className="tcx-kb-row">
        {symbols
          ? key('ABC', () => setSymbols(false), { name: 'Letters', className: 'is-mod is-wide' })
          : key('123', () => setSymbols(true), { name: 'Numbers', className: 'is-mod is-wide' })}
        {key('Space', () => onKey(' '), { name: 'Space', className: 'is-space' })}
        {key('Search', onSearch, { name: 'Search', className: 'is-search' })}
      </div>
    </div>
  );
}

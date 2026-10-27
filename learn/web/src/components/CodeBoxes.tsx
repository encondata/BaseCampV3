/** Six boxes for a learning code (the portal OtpInput's behavior, for
 *  Crockford base32 instead of digits): typing advances, Backspace on an
 *  empty box goes back, a paste anywhere fills the whole code, and every
 *  value is normalized (uppercase, look-alikes read as digits, anything
 *  else dropped). Codes are Latin, so the row stays left to right on a
 *  right-to-left page. */
import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react';

import { normalizeCode } from '../lib/api';
import { t, useLang } from '../lib/i18n';

export const CODE_LENGTH = 6;

export default function CodeBoxes({
  value, onChange, disabled = false, invalid = false, autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  useLang();
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const chars = normalizeCode(value).slice(0, CODE_LENGTH);
  const focus = (i: number) => refs.current[Math.max(0, Math.min(i, CODE_LENGTH - 1))]?.focus();

  /** One character normally; a burst (autofill, fast typing) or a paste is
   *  written from box i onward, keeping whatever sits past it. */
  const onInput = (i: number, raw: string) => {
    const typed = normalizeCode(raw);
    if (typed.length <= 1) {
      const arr = chars.padEnd(CODE_LENGTH, ' ').split('');
      arr[i] = typed;
      onChange(arr.join('').replace(/\s/g, '').slice(0, CODE_LENGTH));
      if (typed) focus(i + 1);
      return;
    }
    onChange((chars.slice(0, i) + typed + chars.slice(i + typed.length)).slice(0, CODE_LENGTH));
    focus(i + typed.length);
  };

  const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (chars[i]) {
        onChange(chars.slice(0, i) + chars.slice(i + 1));
      } else if (i > 0) {
        onChange(chars.slice(0, i - 1) + chars.slice(i));
        focus(i - 1);
      }
    } else if (e.key === 'ArrowLeft' && i > 0) {
      focus(i - 1);
    } else if (e.key === 'ArrowRight' && i < CODE_LENGTH - 1) {
      focus(i + 1);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = normalizeCode(e.clipboardData.getData('text')).slice(0, CODE_LENGTH);
    e.preventDefault();
    if (!text) return;
    onChange(text);
    focus(text.length);
  };

  return (
    <div className={`learn-code${invalid ? ' bad' : ''}`} role="group" aria-label={t('signin.code')} dir="ltr">
      {Array.from({ length: CODE_LENGTH }, (_, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          type="text"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus && i === 0}
          aria-label={t('signin.codeBox', { n: i + 1 })}
          className={chars[i] ? 'filled' : ''}
          value={chars[i] ?? ''}
          disabled={disabled}
          onChange={(e) => onInput(i, e.target.value)}
          onKeyDown={onKeyDown(i)}
          onPaste={onPaste}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}

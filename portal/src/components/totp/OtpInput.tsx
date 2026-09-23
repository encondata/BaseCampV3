/**
 * OtpInput — six single-digit boxes (V2's .otp-inputs styling). Typing
 * advances, Backspace on an empty box retreats, a paste anywhere fills
 * the whole code, and onComplete fires the moment six digits are present.
 */
import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';

const LENGTH = 6;

export default function OtpInput({
  value, onChange, onComplete, disabled = false, invalid = false, autoFocus = false, idPrefix = 'otp',
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  idPrefix?: string;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.replace(/\D/g, '').slice(0, LENGTH);

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  const commit = (next: string) => {
    onChange(next);
    if (next.length === LENGTH) onComplete?.(next);
  };

  const setAt = (i: number, ch: string) => {
    const arr = digits.padEnd(LENGTH, ' ').split('');
    arr[i] = ch;
    const next = arr.join('').replace(/\s/g, '').slice(0, LENGTH);
    commit(next);
    if (ch && i < LENGTH - 1) refs.current[i + 1]?.focus();
  };

  /** A box normally receives one digit, but a one-time-code autofill (or a
   *  burst of fast keystrokes before focus moves on) can land the whole code
   *  in one box — treat anything longer than a digit like a paste from that
   *  position. */
  const onInput = (i: number, raw: string) => {
    const typed = raw.replace(/\D/g, '');
    if (typed.length <= 1) {
      setAt(i, typed);
      return;
    }
    const next = (digits.slice(0, i) + typed).slice(0, LENGTH);
    commit(next);
    refs.current[Math.min(next.length, LENGTH - 1)]?.focus();
  };

  const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (digits[i]) {
        commit(digits.slice(0, i) + digits.slice(i + 1));
      } else if (i > 0) {
        commit(digits.slice(0, i - 1) + digits.slice(i));
        refs.current[i - 1]?.focus();
      }
    } else if (e.key === 'ArrowLeft' && i > 0) {
      refs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowRight' && i < LENGTH - 1) {
      refs.current[i + 1]?.focus();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, LENGTH);
    if (!text) return;
    e.preventDefault();
    commit(text);
    refs.current[Math.min(text.length, LENGTH - 1)]?.focus();
  };

  return (
    <div className={`otp-inputs ${invalid ? 'bad' : ''}`} role="group" aria-label="Verification code">
      {Array.from({ length: LENGTH }, (_, i) => (
        <input
          key={i}
          id={`${idPrefix}-${i}`}
          ref={(el) => { refs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          aria-label={`Digit ${i + 1}`}
          className={digits[i] ? 'filled' : ''}
          value={digits[i] ?? ''}
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

/**
 * The builder's number box (spec §4.5): a number, or arithmetic such as
 * `120-4` or `2*(3+4)`, where a leading `+ - * /` works on the current
 * value (`+5` adds five, `*2` doubles). ↑ and ↓ step by `step` (⇧ by ten
 * steps); Enter or leaving the box commits, Escape drops the edit, and
 * anything that isn't arithmetic puts the value back. A committed value is
 * kept inside `min` and `max` and rounded when `integer`.
 *
 * Over a selection, `onCommitEach` gets the edit as a function of each
 * element's own value, so `+15` or a step adds to each of them; `mixed`
 * (their values differ) shows "Mixed" in the box.
 *
 * It is a text input, so the canvas leaves its arrows, Delete and letters
 * alone (useBuilderShortcuts skips typing targets).
 */

import { useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';

type Token = number | '+' | '-' | '*' | '/' | '(' | ')';

function tokenize(text: string): Token[] | null {
  const out: Token[] = [];
  const re = /\s*(?:(\d+(?:\.\d*)?|\.\d+)|([-+*/()]))/y;
  let at = 0;
  while (at < text.length) {
    if (/^\s+$/.test(text.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) return null;
    out.push(m[1] !== undefined ? Number(m[1]) : (m[2] as Token));
    at = re.lastIndex;
  }
  return out;
}

/** `text` as a number: arithmetic with + - * / and parentheses, a leading
 *  operator applied to `current`. Null for anything else, or a result that
 *  isn't a finite number. */
export function evalNumber(text: string, current: number | null): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const relative = current !== null && /^[-+*/]/.test(trimmed);
  const tokens = tokenize(relative ? `${current}${trimmed}` : trimmed);
  if (!tokens || !tokens.length) return null;
  let i = 0;
  const peek = () => tokens[i];
  const expr = (): number | null => {
    let left = term();
    while (left !== null && (peek() === '+' || peek() === '-')) {
      const op = tokens[i++];
      const right = term();
      left = right === null ? null : op === '+' ? left + right : left - right;
    }
    return left;
  };
  const term = (): number | null => {
    let left = factor();
    while (left !== null && (peek() === '*' || peek() === '/')) {
      const op = tokens[i++];
      const right = factor();
      left = right === null ? null : op === '*' ? left * right : left / right;
    }
    return left;
  };
  const factor = (): number | null => {
    const t = tokens[i++];
    if (typeof t === 'number') return t;
    if (t === '+' || t === '-') {
      const v = factor();
      return v === null ? null : t === '-' ? -v : v;
    }
    if (t === '(') {
      const v = expr();
      return tokens[i++] === ')' ? v : null;
    }
    return null;
  };
  const value = expr();
  return value !== null && i === tokens.length && Number.isFinite(value) ? value : null;
}

/** An edit worked out from one element's own value. */
export type NumberApply = (current: number | null) => number | null;

export interface NumberBoxProps {
  /** The value shown (the last-picked element's). */
  value: number | null;
  /** One value for the box. */
  onCommit?: (value: number | null) => void;
  /** Instead of onCommit: the edit for each selected element. */
  onCommitEach?: (apply: NumberApply) => void;
  /** The selection's values differ: the box shows "Mixed". */
  mixed?: boolean;
  ariaLabel: string;
  id?: string;
  /** ↑ / ↓ step (default 1). */
  step?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  /** An empty box commits null (no value) instead of putting it back. */
  allowEmpty?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Decimals shown (default 2). */
  decimals?: number;
}

function show(value: number | null, decimals: number): string {
  if (value === null) return '';
  const f = 10 ** decimals;
  return String(Math.round(value * f) / f);
}

export default function NumberBox({
  value, onCommit, onCommitEach, mixed = false, ariaLabel, id, step = 1, min, max, integer = false,
  allowEmpty = false, disabled = false, placeholder, className, decimals = 2,
}: NumberBoxProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const settle = (v: number): number => {
    let out = integer ? Math.round(v) : v;
    if (min !== undefined) out = Math.max(min, out);
    if (max !== undefined) out = Math.min(max, out);
    return out;
  };

  const send = (v: number | null) => {
    if (v !== value) onCommit?.(v);
  };

  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    setDraft(null);
    if (onCommitEach) {
      if (!text) {
        // an empty box over differing values changes nothing
        if (allowEmpty && !mixed) onCommitEach(() => null);
        return;
      }
      if (evalNumber(text, value ?? 0) === null) return;
      onCommitEach((current) => {
        const v = evalNumber(text, current);
        return v === null ? current : settle(v);
      });
      return;
    }
    if (!text) {
      if (allowEmpty) send(null);
      return;
    }
    const v = evalNumber(text, value);
    if (v !== null) send(settle(v));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape' && draft !== null) {
      e.preventDefault();
      setDraft(null);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const by = step * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      const typed = draft;
      const from = (current: number | null) => (typed !== null ? evalNumber(typed, current) : null) ?? current ?? 0;
      setDraft(null);
      if (onCommitEach) onCommitEach((current) => settle(from(current) + by));
      else send(settle(from(value) + by));
    }
  };

  return (
    <input type="text" inputMode="decimal" id={id} aria-label={ariaLabel} className={className ?? 'lbp-num'}
      value={draft ?? (mixed ? '' : show(value, decimals))} placeholder={mixed ? 'Mixed' : placeholder}
      disabled={disabled} autoComplete="off"
      spellCheck={false}
      onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
      onBlur={commit} onKeyDown={onKeyDown} />
  );
}

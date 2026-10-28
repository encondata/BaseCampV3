/**
 * The task color popover: the one picker for a task's bar color, shared by
 * the toolbar's Properties › Task color, the sheet's Color cell and Task
 * Information's Color field (lib/plans/taskColor).
 *
 * - The palette's swatches by name (the one picked shows a check, drawn in
 *   the contrast color lib/color picks for it), "No color" for the default
 *   bar, and "Custom…": the initiative color's ColorWheel, with Apply.
 * - `value` is the color the task (or every selected task) has; null is
 *   none; undefined means the selection is mixed, so nothing shows picked.
 * - A pick calls `onPick` (a hex, or null for No color); the caller closes
 *   it. Escape (in Custom…, back to the swatches first), a press outside
 *   and focus moving outside call `onClose` without a pick. The Escape is
 *   marked handled (preventDefault), so neither full screen nor a dialog
 *   behind it (Task Information) takes that key too.
 * - It portals into the anchor's `.portal-shell` (the theme tokens live
 *   there) with fixed placement under the anchor, above it when the room
 *   below is short, following it when the page scrolls. It sits above
 *   full screen (60) and the dialogs (80), under the hover tips.
 */
import {
  useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { readableTextColor } from '../../lib/color';
import { TASK_COLORS } from '../../lib/plans/taskColor';
import ColorWheel from '../ColorWheel';

const GAP = 4;
/** The popover's widths: the swatches, and the color wheel (ColorWheel's 440px cap and padding). */
const WIDTH = { swatches: 292, custom: 472 } as const;
/** Room the popover wants below the anchor before it opens above instead. */
const NEEDED = { swatches: 140, custom: 300 } as const;
/** What Custom… opens on with no color yet: the palette's first. */
const START = TASK_COLORS[0].value;

interface Props {
  /** What the popover hangs from: the button or cell that opened it. */
  anchor: HTMLElement;
  /** The color now: a hex, null for none, undefined for a mixed selection. */
  value: string | null | undefined;
  onPick(color: string | null): void;
  onClose(): void;
  /** A commit in flight (the sheet's cell): picks wait. */
  pending?: boolean;
  /** A refusal to show under the swatches (the sheet's cell). */
  error?: string | null;
}

type Mode = keyof typeof WIDTH;

/** Fixed placement under the anchor, or above it when the room below is short. */
function placeUnder(anchor: HTMLElement, mode: Mode): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH[mode] - 8));
  const below = window.innerHeight - rect.bottom;
  return below < NEEDED[mode] && rect.top > below
    ? { left, bottom: window.innerHeight - rect.top + GAP }
    : { left, top: rect.bottom + GAP };
}

export default function TaskColorPicker({ anchor, value, onPick, onClose, pending = false, error = null }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>('swatches');
  // the wheel's color, read at Apply (a typed hex commits on the blur that comes first)
  const draft = useRef(value ?? START);
  const [wheel, setWheel] = useState(value ?? START);
  const [style, setStyle] = useState<CSSProperties>(() => placeUnder(anchor, 'swatches'));
  const host = anchor.closest<HTMLElement>('.portal-shell') ?? document.body;
  const current = value === undefined ? undefined : value?.toLowerCase() ?? null;

  // follows the anchor when the sheet or the page scrolls, or the window resizes
  useLayoutEffect(() => {
    const place = () => setStyle(placeUnder(anchor, mode));
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor, mode]);

  // focus in: on the color picked now (No color for none), else the first swatch;
  // on the wheel's handle in Custom…
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const target = mode === 'custom'
      ? box.querySelector<HTMLElement>('[role="slider"]')
      : box.querySelector<HTMLElement>('[aria-pressed="true"]') ?? box.querySelector<HTMLElement>('button');
    target?.focus({ preventScroll: true });
  }, [mode]);

  // a press anywhere else closes it, without a pick
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      close.current();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [anchor]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    if (mode === 'custom') setMode('swatches');
    else onClose();
  };

  // focus moving to something outside (Tab past the end) closes it too;
  // focus dropped to nowhere (Custom… swapping the view) does not
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && !ref.current?.contains(next) && !anchor.contains(next)) onClose();
  };

  const pick = (color: string | null) => {
    if (!pending) onPick(color);
  };

  return createPortal(
    <div ref={ref} className="pln-hues" role="dialog" aria-label="Task color" style={{ ...style, width: WIDTH[mode] }}
         tabIndex={-1} aria-busy={pending || undefined} onKeyDown={onKeyDown} onBlur={onBlur}>
      {mode === 'swatches' ? (
        <>
          <div className="pln-hues-set" role="group" aria-label="Colors">
            {TASK_COLORS.map((c) => {
              const on = current === c.value;
              return (
                <button key={c.value} type="button" className="pln-hue" aria-label={c.label} title={c.label}
                        aria-pressed={on} style={{ background: c.value, color: readableTextColor(c.value) }}
                        onClick={() => pick(c.value)}>
                  {on && <CheckIcon />}
                </button>
              );
            })}
          </div>
          <div className="pln-hues-foot">
            <button type="button" className="mini-btn" aria-pressed={current === null}
                    onClick={() => pick(null)}>No color</button>
            <button type="button" className="mini-btn" onClick={() => {
              const start = current ?? START;
              draft.current = start;
              setWheel(start);
              setMode('custom');
            }}>Custom…</button>
          </div>
        </>
      ) : (
        <>
          <ColorWheel value={wheel} onChange={(hex) => {
            draft.current = hex;
            setWheel(hex);
          }} />
          <div className="pln-hues-foot">
            <button type="button" className="mini-btn" onClick={() => setMode('swatches')}>Back</button>
            <button type="button" className="btn-solid" onClick={() => pick(draft.current)}>Apply</button>
          </div>
        </>
      )}
      {error && <p className="pf-error" role="alert">{error}</p>}
    </div>,
    host,
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
  );
}

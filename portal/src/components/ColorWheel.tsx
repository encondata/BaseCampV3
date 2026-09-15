/**
 * ColorWheel — the wheel-shaped color picker: a hue ring you can drag or
 * arrow around, a lightness slider under it, a hex readout, and a live
 * preview of the real `.chip custom` shape the calendar will paint.
 *
 * Sibling of components/variables/ColorField.tsx, which is the swatch-and-
 * native-picker variant used for vocabulary rows. This one exists because
 * an initiative's color is an identity, not a choice from seven presets:
 * the point is to spin to something distinct, so the control is a wheel
 * and there is no swatch grid. The text-field behaviors are deliberately
 * identical to ColorField's (local text state, committed on blur AND on
 * Enter with preventDefault so the enclosing modal form doesn't submit,
 * an inline hint on junk that does NOT call onChange).
 *
 * Value in and value out is always a `#rrggbb` hex. HSL exists only inside
 * this file (lib/variables.ts::hexToHsl/hslToHex), so nothing else in the
 * codebase has to learn a second color representation.
 */

import {
  useEffect, useId, useRef, useState,
  type ChangeEvent, type CSSProperties, type FocusEvent,
  type KeyboardEvent, type PointerEvent,
} from 'react';

import { hexToHsl, hslToHex, normalizeHex, type Hsl } from '../lib/variables';
import '../styles/color-wheel.css';

interface Props {
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
}

/** Where the handle rides, as a percentage of the ring box from its center. */
const TRACK_RADIUS = 41;
/** The slider's ends: pure black and pure white carry no hue, so a wheel
 *  that could reach them would look broken (spin the ring, nothing moves).
 *  This is a floor/ceiling on what the SLIDER may originate, not on what the
 *  control may hold — a hex typed into the field keeps the exact lightness
 *  the user asked for, and the thumb is drawn where that lightness really
 *  is (see `clampL` and the range input's 0-100 travel below). */
const L_MIN = 8;
const L_MAX = 92;
const clampL = (l: number) => Math.min(L_MAX, Math.max(L_MIN, l));
/** Moving the ring on a near-gray color would otherwise be a dead control —
 *  hue means nothing at zero saturation. Lift it just enough to show. */
const MIN_SATURATION = 18;
/** Only used when the parent hands us something unparseable. */
const FALLBACK: Hsl = { h: 205, s: 77, l: 37 };

const wrapHue = (h: number) => ((h % 360) + 360) % 360;

export default function ColorWheel({ value, onChange, disabled }: Props) {
  const hexId = useId();
  // HSL is the working state, not a derivation of `value` on every render:
  // hue and saturation survive a trip to the ends of the lightness slider
  // this way, where a hex round trip would have flattened them to gray.
  const [hsl, setHsl] = useState<Hsl>(() => hexToHsl(value) ?? FALLBACK);
  // Local, editable copy of the hex field — the source of truth while the
  // user is typing, pushed up only on commit. Same contract as ColorField.
  const [text, setText] = useState(() => normalizeHex(value) ?? value);
  const [invalid, setInvalid] = useState(false);
  // The last hex we emitted. `value` coming back as exactly that is our own
  // edit echoing through the parent, and re-seeding the HSL from it would
  // discard the hue/saturation we are deliberately holding on to.
  const lastEmitted = useRef<string | null>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const normalized = normalizeHex(value);
    if (!normalized || normalized === lastEmitted.current) return;
    const next = hexToHsl(normalized);
    if (next) setHsl(next);
    setText(normalized);
    setInvalid(false);
  }, [value]);

  const hex = hslToHex(hsl);

  const emit = (next: Hsl) => {
    setHsl(next);
    const nextHex = hslToHex(next);
    lastEmitted.current = nextHex;
    setText(nextHex);
    setInvalid(false);
    onChange(nextHex);
  };

  const commit = (raw: string) => {
    const normalized = normalizeHex(raw);
    if (!normalized) {
      setInvalid(true);   // junk: leave what the user typed, but say so
      return;
    }
    const next = hexToHsl(normalized);
    if (next) setHsl(next);
    setInvalid(false);
    setText(normalized);
    lastEmitted.current = normalized;
    onChange(normalized);
  };

  // Enter implicitly submits the enclosing form (the only `<button>` in
  // these modals is `type="submit"`), which never fires blur — without the
  // preventDefault the modal would save the OLD color and silently discard
  // the freshly typed one. Lifted verbatim from ColorField.
  const handleHexKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    commit(e.currentTarget.value);
  };

  /* ── the ring ─────────────────────────────────────────────────────── */

  // Angle from the ring's center, measured the way `conic-gradient` measures
  // it: 0deg at twelve o'clock, growing clockwise. Returns null when the
  // rect has no size — jsdom reports 0x0 for every element, and a zero-size
  // rect would otherwise hand back a confident hue computed from noise.
  const hueFromPoint = (clientX: number, clientY: number): number | null => {
    const el = ringRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    if (dx === 0 && dy === 0) return null;   // dead center has no angle
    return wrapHue((Math.atan2(dy, dx) * 180) / Math.PI + 90);
  };

  const applyPoint = (e: PointerEvent<HTMLDivElement>) => {
    const hue = hueFromPoint(e.clientX, e.clientY);
    if (hue === null) return;
    emit({ ...hsl, h: hue, s: Math.max(hsl.s, MIN_SATURATION) });
  };

  // Pointer events cover mouse, touch and pen in one path; capture keeps the
  // drag alive when the cursor leaves the ring, which is most of a drag.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    applyPoint(e);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || !dragging.current) return;
    applyPoint(e);
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onHandleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = e.shiftKey ? 10 : 1;
    let delta = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -step;
    else if (e.key === 'Home') delta = -hsl.h;
    else return;
    e.preventDefault();   // arrows would otherwise scroll the modal
    emit({ ...hsl, h: wrapHue(hsl.h + delta), s: Math.max(hsl.s, MIN_SATURATION) });
  };

  const radians = (wrapHue(hsl.h) * Math.PI) / 180;
  const handleStyle: CSSProperties = {
    left: `${50 + TRACK_RADIUS * Math.sin(radians)}%`,
    top: `${50 - TRACK_RADIUS * Math.cos(radians)}%`,
    background: hex,
  };
  // The slider shows what its own travel would do to THIS hue, end to end.
  const lightnessTrack: CSSProperties = {
    background: `linear-gradient(to right,
      ${hslToHex({ ...hsl, l: L_MIN })},
      ${hslToHex({ ...hsl, l: 50 })},
      ${hslToHex({ ...hsl, l: L_MAX })})`,
  };
  const degrees = Math.round(wrapHue(hsl.h));

  return (
    <div className={`cw${disabled ? ' cw-off' : ''}`}>
      <div
        ref={ringRef}
        className="cw-ring"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="cw-hole" style={{ background: hex }} />
        <div
          className="cw-handle"
          style={handleStyle}
          role="slider"
          aria-label="Hue"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={degrees}
          aria-valuetext={`${degrees} degrees`}
          aria-disabled={disabled || undefined}
          tabIndex={disabled ? -1 : 0}
          onKeyDown={onHandleKeyDown}
        />
      </div>

      <div className="cw-side">
        <div className="cw-slider" style={lightnessTrack}>
          {/* The travel is the full 0-100 so the thumb can sit where the
              current color actually is; the 8-92 floor/ceiling is applied in
              `onChange`, to values this slider itself originates. Clamping the
              rendered `value` instead (what this used to do) parked the thumb
              against an end while the real color was darker or lighter than
              that position implied. */}
          <input
            type="range"
            aria-label="Lightness"
            min={0}
            max={100}
            step={1}
            value={Math.round(hsl.l)}
            disabled={disabled}
            onChange={(e) => emit({ ...hsl, l: clampL(Number(e.target.value)) })}
          />
        </div>

        {/* cf-hex-wrap / cf-hex are directory.css's hex-field pair, reused
            verbatim so this readout looks and reads exactly like the one on
            the Variables page (and so its typography stays in the one
            stylesheet that owns typography). */}
        <div className="cf-hex-wrap">
          <label htmlFor={hexId}>Hex</label>
          <input
            id={hexId}
            className="cf-hex"
            type="text"
            value={text}
            disabled={disabled}
            aria-invalid={invalid}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setText(e.target.value);
              setInvalid(false);   // give the hint back once they correct it
            }}
            onBlur={(e: FocusEvent<HTMLInputElement>) => commit(e.target.value)}
            onKeyDown={handleHexKeyDown}
          />
          {invalid && <p className="pf-error" style={{ margin: '6px 0 0' }}>Not a valid hex color.</p>}
        </div>

        <div className="cw-preview">
          <span className="chip custom" style={{ '--chip': hex } as CSSProperties}>
            <span className="dot" />Preview
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * A task's bar color (Task Information, the sheet's Color column, the
 * toolbar's Properties › Task color): optional — null is the default bar
 * color — and any `#rrggbb`, which the API stores lower-case.
 *
 * The picker offers the portal's one named palette, PRESET_COLORS in
 * lib/variables (the seven the initiative palette was built on), and any
 * other color through the initiative color's ColorWheel. A palette color
 * reads by its name (the Color column, a copy); any other by its hex.
 */
import { PRESET_COLORS } from '../variables';
import { asciiTrim } from './durations';

/** The colors the picker offers, by name. */
export const TASK_COLORS: readonly { value: string; label: string }[] = PRESET_COLORS;

const HEX = /^#[0-9a-f]{6}$/i;

/** What a color can be typed or pasted as. */
export const COLOR_HINT = `Enter a color as #rrggbb, or one of: ${TASK_COLORS.map((c) => c.label).join(', ')}.`;

/** The palette color's name, else the hex; '' for none. */
export function colorLabel(color: string | null): string {
  if (!color) return '';
  const hex = color.toLowerCase();
  return TASK_COLORS.find((c) => c.value === hex)?.label ?? hex;
}

/** True when `color` is one of the palette's. */
export function isPaletteColor(color: string | null): boolean {
  return !!color && TASK_COLORS.some((c) => c.value === color.toLowerCase());
}

/**
 * Text as a color: `#rrggbb` in any case, or a palette name in any case,
 * as the lower-case hex; blank is none (null). Undefined when it's
 * neither, so the caller can refuse it (COLOR_HINT).
 */
export function parseColor(text: string): string | null | undefined {
  const typed = asciiTrim(text);
  if (!typed) return null;
  if (HEX.test(typed)) return typed.toLowerCase();
  const named = TASK_COLORS.find((c) => c.label.toLowerCase() === typed.toLowerCase());
  return named ? named.value : undefined;
}

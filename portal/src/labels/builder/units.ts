/**
 * Inches ↔ printer dots, rounded exactly as the API's ZPL compiler rounds
 * (labels/zpl.py `_dots`: Python's round(), ties to even), so the canvas
 * puts every edge on the dot the printer will.
 */

/** Python's round(): the nearest integer, a tie (exactly .5) to the even one. */
export function pyRound(x: number): number {
  if (Math.abs(x % 1) === 0.5) return 2 * Math.round(x / 2);
  return Math.round(x);
}

/** Inches to whole dots at `dpi` (the compiler's `_dots`). */
export function toDots(inches: number, dpi: number): number {
  return pyRound(inches * dpi);
}

export function toInches(dots: number, dpi: number): number {
  return dots / dpi;
}

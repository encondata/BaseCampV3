/** Formatting helpers for the punch clock / timesheet UI. */

/** Renders a minute count as "Nh Mm" (omitting either half when it's zero,
 *  except a true zero which renders as "0m"). */
export function formatMinutes(min: number): string {
  if (min <= 0) return '0m';
  const hours = Math.floor(min / 60);
  const minutes = min % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/** Whole minutes elapsed between `iso` and now, floored, never negative
 *  (a clock-in timestamp that is slightly ahead of this client's clock
 *  should read as "just now", not a negative duration). */
export function elapsedSince(iso: string): number {
  const diffMs = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(diffMs / 60000));
}

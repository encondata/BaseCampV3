/** "5m" under an hour, otherwise hours and two-digit minutes ("7h 24m",
 *  "8h 00m"). Minutes, because that is what the API counts in. */
export function formatWorked(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  if (hours === 0) return `${total}m`;
  return `${hours}h ${String(total % 60).padStart(2, '0')}m`;
}

/** A punch time as the locale's short clock time ("8:02 AM"). */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

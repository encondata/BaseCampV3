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

function localDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** A punch on Clock Out's table: its clock time, prefixed "yesterday" when
 *  it falls on the previous local day ("yesterday 10:00 PM"), or its short
 *  date when older ("Oct 18 10:00 PM"), so an overnight span reads right. */
export function formatPunch(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const time = formatClock(iso);
  const day = localDay(at);
  if (day >= localDay(now)) return time;
  const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  if (day === yesterday) return `yesterday ${time}`;
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/** The browser's own IANA zone ("America/Chicago"), sent with every status
 *  read and punch as `tz`: the portal reads "today" in it when the kiosk's
 *  site has no zone. Undefined when the browser can't say, so the portal
 *  falls back to UTC. */
export function kioskZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

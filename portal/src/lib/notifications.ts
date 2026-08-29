/**
 * Notification groups — pure display helpers + the channel/day constants
 * shared with the API's CHECK constraints (api/src/serversherpa/api/routes/
 * notifications.py). Kept dependency-free so both the list page and the
 * (Task 4/5) detail page can share them.
 */

export const CHANNELS = ['email', 'text', 'push', 'web'] as const;
export type Channel = typeof CHANNELS[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  email: 'Email', text: 'Text (SMS)', push: 'Push', web: 'Web',
};

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = typeof DAYS[number];

const DAY_LABELS: Record<Day, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

/** '21:00:00' -> '9:00 PM' (also accepts 'HH:MM'). */
function formatClock(hms: string): string {
  const [hStr, mStr] = hms.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/** Short timezone abbreviation for an IANA zone, via Intl's 'short'
 *  timeZoneName. Intl's abbreviation is DST-aware (e.g. 'CDT' in summer,
 *  'CST' in winter for America/Chicago) — collapsed here to the generic
 *  US form ('CT') a quiet-hours display should read year-round, by
 *  stripping the daylight/standard middle letter (CDT/CST -> CT, EDT/EST
 *  -> ET, etc.). Zones outside that 3-letter D/S pattern (UTC, IST, ...)
 *  pass through unchanged. Falls back to the raw zone name if Intl can't
 *  resolve one (e.g. an invalid zone in a test environment). */
function tzAbbrev(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'short',
    }).formatToParts(new Date());
    const abbrev = parts.find((p) => p.type === 'timeZoneName')?.value ?? tz;
    return abbrev.replace(/^([A-Z])[DS](T)$/, '$1$2');
  } catch {
    return tz;
  }
}

/** '21:00:00', '07:00:00', 'America/Chicago' -> '9:00 PM – 7:00 AM CT'.
 *  Either time null (both should be — group/member quiet hours are
 *  both-or-neither) -> '—'. */
export function formatQuietHours(
  start: string | null, end: string | null, tz: string,
): string {
  if (start === null || end === null) return '—';
  return `${formatClock(start)} – ${formatClock(end)} ${tzAbbrev(tz)}`;
}

/** All 7 -> 'Daily'; mon-fri -> 'Mon–Fri'; sat+sun -> 'Weekends'; other
 *  contiguous runs (in DAYS order) -> 'Wed–Sat'; else a comma list, e.g.
 *  'Mon, Wed, Fri'. Empty -> '—'. */
export function formatDays(days: string[]): string {
  if (days.length === 0) return '—';
  const set = new Set(days);
  if (DAYS.every((d) => set.has(d))) return 'Daily';
  if (set.size === 5 && ['mon', 'tue', 'wed', 'thu', 'fri'].every((d) => set.has(d))) {
    return 'Mon–Fri';
  }
  if (set.size === 2 && set.has('sat') && set.has('sun')) return 'Weekends';

  // Contiguous run in DAYS order, e.g. wed,thu,fri,sat -> 'Wed–Sat'.
  const idxs = DAYS
    .map((d, i) => (set.has(d) ? i : -1))
    .filter((i) => i >= 0);
  const isContiguous = idxs.length > 1
    && idxs.every((idx, i) => i === 0 || idx === idxs[i - 1] + 1);
  if (isContiguous) {
    return `${DAY_LABELS[DAYS[idxs[0]]]}–${DAY_LABELS[DAYS[idxs[idxs.length - 1]]]}`;
  }

  return DAYS.filter((d) => set.has(d)).map((d) => DAY_LABELS[d]).join(', ');
}

/** Can this member/recipient actually receive the given channel, per their
 *  capability flags (email on file, phone on file, has an account). */
export function canForChannel(
  m: { can_email: boolean; can_text: boolean; can_push: boolean; can_web: boolean },
  c: Channel,
): boolean {
  switch (c) {
    case 'email': return m.can_email;
    case 'text': return m.can_text;
    case 'push': return m.can_push;
    case 'web': return m.can_web;
    default: return false;
  }
}

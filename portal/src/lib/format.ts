/** Small display formatters shared by portal pages. */

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  const diffMins = Math.round((Date.now() - then) / 60_000);
  const past = diffMins >= 0;
  const mins = Math.abs(diffMins);
  const phrase = (n: number, unit: string) => (past ? `${n}${unit} ago` : `in ${n}${unit}`);
  if (mins < 1) return past ? 'just now' : 'now';
  if (mins < 60) return phrase(mins, 'm');
  const hours = Math.round(mins / 60);
  if (hours < 24) return phrase(hours, 'h');
  const days = Math.round(hours / 24);
  if (days < 30) return phrase(days, 'd');
  return new Date(iso).toLocaleDateString();
}

export function longDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

/** Deterministic gradient per name — fibertrace avatar contract. */
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#ffa12e,#ff7a1a)',
  'linear-gradient(135deg,#258bcd,#6d4fc4)',
  'linear-gradient(135deg,#178a4c,#35b06f)',
  'linear-gradient(135deg,#c03540,#ff7a1a)',
  'linear-gradient(135deg,#6d4fc4,#258bcd)',
  'linear-gradient(135deg,#a36207,#ffa12e)',
];

export function avatarGradient(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

export function initials(name: string): string {
  return name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}

/** "Chrome on macOS" from a raw user-agent string. Best-effort. */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser =
    /edg\//i.test(ua) ? 'Edge' :
    /firefox\//i.test(ua) ? 'Firefox' :
    /chrome\//i.test(ua) ? 'Chrome' :
    /safari\//i.test(ua) ? 'Safari' : 'Browser';
  const os =
    /iphone|ipad/i.test(ua) ? 'iOS' :
    /android/i.test(ua) ? 'Android' :
    /mac os x/i.test(ua) ? 'macOS' :
    /windows/i.test(ua) ? 'Windows' :
    /linux/i.test(ua) ? 'Linux' : 'unknown OS';
  return `${browser} on ${os}`;
}

/** Random temp password: 14 chars + symbol, unambiguous alphabet. */
export function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const buf = new Uint32Array(14);
  crypto.getRandomValues(buf);
  return Array.from(buf, (v) => chars[v % chars.length]).join('') + '!';
}

/** RFID tags arrive as zero-padded EPCs ("000000000000000000100418");
 *  every list and detail view shows the significant tail ("100418") and
 *  keeps the raw tag one hover away via a title attribute. Search, CSV
 *  export and edit forms keep the stored value. At least one character
 *  survives ("0000" -> "0"); a missing tag renders as the usual dash. */
export function displayRfid(tag: string | null | undefined): string {
  if (!tag) return '—';
  return tag.replace(/^0+(?=.)/, '');
}

/** Scan-inbox value column: trim only RFID reads — barcodes and manual
 *  entries are shown exactly as reported. */
export function displayScanValue(value: string, scanType: string | null | undefined): string {
  return scanType === 'rfid' ? displayRfid(value) : value;
}

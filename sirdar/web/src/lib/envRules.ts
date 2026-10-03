/** Client-side mirrors of the API's checks (sirdar_api/deploy/names.py,
 *  gitref.py and environments.py) so a form can answer before a round trip.
 *  The API stays the authority. Each returns an inline message, or ''. */
export const RESERVED_NAMES = ['blue', 'green', 'dev', 'beta', 'custom'];
export const NAME_HELP = 'Lowercase letters, numbers and hyphens; starts with a letter; 2–32 characters.';

/** '' for an empty name too: callers say "Enter a name." themselves. */
export function nameProblem(raw: string): string {
  const n = raw.trim();
  if (!n) return '';
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(n) || n.endsWith('-'))
    return 'Use lowercase letters, numbers and hyphens, starting with a letter (2–32 characters, no trailing hyphen).';
  if (RESERVED_NAMES.includes(n)) return 'That name is reserved. Choose a different one.';
  return '';
}

export function refProblem(raw: string): string {
  const r = raw.trim();
  if (!r) return 'Enter a branch, tag or commit.';
  if (!/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/.test(r) || r.endsWith('/') || r.endsWith('.lock'))
    return "That isn't a valid branch, tag or commit.";
  return '';
}

export function ipv4Problem(raw: string, label: string): string {
  const v = raw.trim();
  if (!v) return `Enter the ${label}.`;
  const parts = v.split('.');
  const ok = parts.length === 4
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && (p === '0' || !p.startsWith('0')));
  return ok ? '' : `The ${label} must be an IPv4 address.`;
}

export function portProblem(raw: string): string {
  const v = raw.trim();
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535) return 'Use a port from 1 to 65535.';
  return '';
}

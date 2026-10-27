/**
 * Plain wording for the assignment engine's reason codes (the dry run's
 * "Why" and "Skipped" columns and its CSV). The API sends codes such as
 * `never_signed` or `valid_until:2027-03-03`; people read these.
 */

import { dayLabelYear } from './initiativeLearning';

const REASONS: Record<string, string> = {
  never_signed: 'Never signed',
  expired: 'Signed version expired',
  new_version: 'New version published',
  every_initiative: 'Signs again every initiative',
  archived: 'Document is archived',
  not_published: 'Document isn’t published yet',
  already_assigned: 'Already assigned',
  already_signed: 'Already signed this version',
  not_on_initiative: 'Not on this initiative',
  manual: 'Assigned by hand',
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "never_signed" -> "Never signed" (the fallback for a code we have no copy for). */
export function humanizeCode(code: string): string {
  const text = code.replace(/[_:]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

/** One reason code in plain American English. */
export function reasonText(code: string): string {
  if (code in REASONS) return REASONS[code];
  if (code.startsWith('valid_until:')) {
    const until = code.slice('valid_until:'.length);
    if (until === 'never') return 'Valid, no end date';
    if (ISO_DAY.test(until)) return `Valid until ${dayLabelYear(until)}`;
  }
  return humanizeCode(code);
}

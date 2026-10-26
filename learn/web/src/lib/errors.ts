/** A failed call as the friendly line the worker reads. Anything the
 *  server says that isn't listed here is the generic "something went
 *  wrong"; a code the page needs more from (read_time's seconds_left) is
 *  handled by that page before it falls back to this. */
import { ApiError } from '@portal/lib/api';

import type { MessageKey } from '../i18n/en';

const ERRORS: Record<string, MessageKey> = {
  learn_code_invalid: 'error.learn_code_invalid',
  rate_limited: 'error.rate_limited',
  network: 'error.network',
  locked: 'error.locked',
  already_signed: 'error.already_signed',
  not_found: 'error.not_found',
  no_quiz: 'error.not_found',
  signature_invalid: 'sign.signatureInvalid',
};

export function errorKey(err: unknown): MessageKey {
  const code = err instanceof ApiError ? err.code : 'unknown';
  return ERRORS[code] ?? 'error.unknown';
}

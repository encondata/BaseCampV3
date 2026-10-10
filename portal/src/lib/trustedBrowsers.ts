/** Message for a failed forget: the API's own sentence where it has one
 *  (read-only mode), otherwise a plain retry line. */
export const FORGET_FAILED = 'Could not forget the browsers. Try again.';
export const FORGET_ONE_FAILED = 'Could not forget that browser. Try again.';

export function forgetErrorMessage(err: unknown, which: 'one' | 'all' = 'all'): string {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === 'read_only_mode' && e.message) return e.message;
  return which === 'one' ? FORGET_ONE_FAILED : FORGET_FAILED;
}

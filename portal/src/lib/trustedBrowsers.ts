/** Message for a failed forget: the API's own sentence where it has one
 *  (read-only mode), otherwise a plain retry line. */
export const FORGET_FAILED = 'Could not forget the browsers. Try again.';

export function forgetErrorMessage(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === 'read_only_mode' && e.message ? e.message : FORGET_FAILED;
}

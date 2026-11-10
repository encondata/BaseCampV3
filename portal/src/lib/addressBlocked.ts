/**
 * The sign-in message for an address the API has blocked after repeated
 * failed sign-ins (HTTP 429, detail { code: 'address_blocked', retry_after }).
 * React-free so the kiosk can import it as @portal/lib/addressBlocked.
 */

export const ADDRESS_BLOCKED_CODE = 'address_blocked';

const PERMANENT = 'This network is blocked from signing in. Contact your administrator.';

/** `detail` is the API error's raw detail object. A null or missing
 *  retry_after means the block is permanent until an admin clears it. */
export function addressBlockedMessage(detail: unknown): string {
  const retry = (detail as { retry_after?: unknown } | null | undefined)?.retry_after;
  if (typeof retry !== 'number' || !Number.isFinite(retry)) return PERMANENT;
  const minutes = Math.max(1, Math.ceil(retry / 60));
  return `Too many failed sign-in attempts from this network. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/** Duck-typed on `code`: the portal and the kiosk each have their own ApiError class. */
export function isAddressBlocked(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === ADDRESS_BLOCKED_CODE;
}

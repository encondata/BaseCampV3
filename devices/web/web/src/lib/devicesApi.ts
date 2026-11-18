/** Calls to the devices API. It shares this page's origin (the dev server
 *  proxies /api to it), and trusts the portal account session: every call
 *  carries the portal access token as a bearer. */
import { accessTokenForService, ApiError, errorFrom, refreshSession } from '@portal/lib/api';

/** A path on this origin under /api: never an absolute or
 *  protocol-relative URL, so the bearer can't leave the origin. */
const API_PATH = /^\/api(?:[/?#]|$)/;

async function send(path: string, init: RequestInit): Promise<Response> {
  const token = await accessTokenForService();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}

/** The devices API answers errors as {"detail": {"code", "message"}}: the
 *  portal's ApiError, carrying the API's own message when it sends one. */
async function devicesError(resp: Response): Promise<ApiError> {
  const err = await errorFrom(resp);
  const message = (err.detail as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' && message && err.message === err.code
    ? new ApiError(err.status, err.code, err.detail, message)
    : err;
}

/** fetch() for a same-origin devices path such as `/api/apps` (anything
 *  else throws before a request is made). An expired
 *  token gets one refresh and one retry. Resolves with the response when it
 *  is ok; otherwise rejects with an ApiError. */
export async function devicesFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!API_PATH.test(path)) throw new Error(`devicesFetch takes a same-origin /api path, not ${JSON.stringify(path)}`);
  let resp = await send(path, init);
  if (resp.status === 401 && (await refreshSession())) {
    resp = await send(path, init);
  }
  if (!resp.ok) throw await devicesError(resp);
  return resp;
}

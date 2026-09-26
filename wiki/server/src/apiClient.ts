/** The wiki server's only view of the data: the API's /wiki/internal/*
 *  routes (api/src/serversherpa/api/routes/wiki/internal.py). Every call
 *  presents the service token; authorize also passes the user's own
 *  bearer token through. The server holds no database connection and
 *  makes no permission decisions of its own. */
import type { ServerConfig } from './config.js';

export type Level = 'view' | 'edit' | 'manage';

export interface Authz {
  level: Level;
  person: { id: string; name: string };
  color: string;
}

export interface PageState {
  /** The stored Yjs update, or null for a page never opened live. */
  ydoc: Uint8Array | null;
  /** The ProseMirror JSON to seed a never-opened page from (an import, a copy). */
  draftJson: unknown | null;
}

/** A non-2xx answer from the API, with its `detail.code` when it sent one. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`API answered ${status}${code ? ` ${code}` : ''}`);
    this.name = 'ApiError';
  }
}

/** Whether a failed store is worth retrying: read-only mode (423), a
 *  server error, or the API being unreachable. Anything else — the page is
 *  in the trash (409), too large (413), a bad document (422), a wrong
 *  service token — won't fix itself. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 423 || error.status >= 500;
  return true;
}

const LEVELS: ReadonlySet<string> = new Set<Level>(['view', 'edit', 'manage']);

/** Long enough for a large document, short enough that a hung API doesn't
 *  stall a document's stores forever. */
const TIMEOUT_MS = 30_000;

async function errorFrom(res: Response): Promise<ApiError> {
  let code: string | null = null;
  try {
    const body = await res.json() as { detail?: { code?: unknown } };
    if (typeof body?.detail?.code === 'string') code = body.detail.code;
  } catch {
    // not JSON: the status says enough
  }
  return new ApiError(res.status, code);
}

function isAuthz(value: unknown): value is Authz {
  const v = value as Authz | null;
  return !!v && LEVELS.has(v.level) && typeof v.color === 'string'
    && typeof v.person?.id === 'string' && typeof v.person?.name === 'string';
}

export function makeApi(cfg: ServerConfig, fetchImpl: typeof fetch = fetch) {
  const base = `${cfg.apiUrl}/wiki/internal`;
  const call = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) =>
    fetchImpl(`${base}${path}`, {
      ...init,
      headers: { 'X-Wiki-Service-Token': cfg.serviceToken, ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  const pagePath = (nodeId: string) => `/pages/${encodeURIComponent(nodeId)}/state`;

  return {
    /** The user's level on a page, or null when they may not open it live
     *  (bad or expired token, not viewable, not a page). */
    async authorize(token: string, nodeId: string): Promise<Authz | null> {
      const res = await call(`/collab/authorize?node=${encodeURIComponent(nodeId)}`, {},
        { Authorization: `Bearer ${token}` });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) throw await errorFrom(res);
      const body: unknown = await res.json();
      return isAuthz(body) ? body : null;
    },

    /** A person's level on a page, by id and the service token alone —
     *  re-authorization of open connections, long after the access token
     *  they connected with expired. Null when they may no longer open it
     *  live (404: no active account, no view, not a live page); any other
     *  failure throws, since it says nothing about the person. */
    async level(nodeId: string, personId: string): Promise<Level | null> {
      const res = await call(
        `/collab/level?node=${encodeURIComponent(nodeId)}&person=${encodeURIComponent(personId)}`);
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) throw await errorFrom(res);
      const body = await res.json() as { level?: unknown };
      return typeof body?.level === 'string' && LEVELS.has(body.level) ? body.level as Level : null;
    },

    async loadState(nodeId: string): Promise<PageState> {
      const res = await call(pagePath(nodeId));
      if (!res.ok) throw await errorFrom(res);
      const body = await res.json() as { ydoc_b64: string | null; draft_json: unknown | null };
      return {
        ydoc: body.ydoc_b64 ? new Uint8Array(Buffer.from(body.ydoc_b64, 'base64')) : null,
        draftJson: body.draft_json ?? null,
      };
    },

    /** Store the live document; throws an ApiError for any non-2xx. */
    async storeState(nodeId: string, ydoc: Uint8Array, contentJson: unknown,
      editorIds: string[]): Promise<void> {
      const res = await call(pagePath(nodeId), {
        method: 'PUT',
        body: JSON.stringify({
          ydoc_b64: Buffer.from(ydoc).toString('base64'),
          content_json: contentJson,
          editor_ids: editorIds,
        }),
      }, { 'Content-Type': 'application/json' });
      if (!res.ok) throw await errorFrom(res);
      await res.body?.cancel();
    },
  };
}

export type WikiApi = ReturnType<typeof makeApi>;

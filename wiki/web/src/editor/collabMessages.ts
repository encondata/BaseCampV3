/** The stateless messages the editor and the wiki server exchange over a
 *  page's live-editing connection, beside the Yjs sync itself. Shared by
 *  both sides (the server imports this file), JSON on the wire. DOM-free.
 *
 *  - `flush` (editor → server): store the live document NOW, before the
 *    editor publishes (or otherwise snapshots) the draft. `client` is the
 *    editor's Yjs client id.
 *  - `flushed` (server → that editor): the answer. `clock` is how far the
 *    stored state covers `client`'s own changes — the editor checks it
 *    covers everything it typed.
 *  - `saved` (server → everyone on the page): a store landed; `clocks` is
 *    how far it covers each connected editor's changes, which is what
 *    "Saved" means.
 *  - `store_refused` (server → everyone on the page): the API refused the
 *    document for good (too large, not a valid document); the server made
 *    every connection read-only, and nothing typed from here on is kept. */

export type ClientMessage = { type: 'flush'; id: string; client: number };

export type ServerMessage =
  | { type: 'flushed'; id: string; ok: true; clock: number }
  | { type: 'flushed'; id: string; ok: false; code: string }
  | { type: 'saved'; clocks: Record<string, number> }
  | { type: 'store_refused'; code: string };

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

function parse(payload: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A message from an editor, or null for anything else. */
export function parseClientMessage(payload: string): ClientMessage | null {
  const m = parse(payload);
  if (m?.type === 'flush' && typeof m.id === 'string' && isNumber(m.client)) {
    return { type: 'flush', id: m.id, client: m.client };
  }
  return null;
}

/** A message from the server, or null for anything else. */
export function parseServerMessage(payload: string): ServerMessage | null {
  const m = parse(payload);
  if (!m) return null;
  if (m.type === 'flushed' && typeof m.id === 'string') {
    if (m.ok === true && isNumber(m.clock)) return { type: 'flushed', id: m.id, ok: true, clock: m.clock };
    if (m.ok === false && typeof m.code === 'string') return { type: 'flushed', id: m.id, ok: false, code: m.code };
    return null;
  }
  if (m.type === 'saved' && m.clocks && typeof m.clocks === 'object' && !Array.isArray(m.clocks)) {
    const clocks: Record<string, number> = {};
    for (const [client, clock] of Object.entries(m.clocks as Record<string, unknown>)) {
      if (isNumber(clock)) clocks[client] = clock;
    }
    return { type: 'saved', clocks };
  }
  if (m.type === 'store_refused' && typeof m.code === 'string') return { type: 'store_refused', code: m.code };
  return null;
}

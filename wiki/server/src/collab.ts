/** Live editing: one Hocuspocus document per page, named `page:<uuid>`.
 *  The API decides who may connect (and whether read-only), loads the
 *  document and stores it; this module only relays. See the wiki design
 *  spec, "Live editing flow".
 *
 *  Besides the Yjs sync, editors and this server exchange the stateless
 *  messages in `collabMessages.ts`: an editor asks for a `flush` (store
 *  now) before publishing, every store that lands announces what it
 *  `saved`, and a store the API refuses for good is announced
 *  (`store_refused`) with every connection made read-only. */
import {
  Hocuspocus,
  type Connection,
  type Document,
  type afterUnloadDocumentPayload,
  type beforeUnloadDocumentPayload,
  type connectedPayload,
  type onAuthenticatePayload,
  type onChangePayload,
  type onLoadDocumentPayload,
  type onStatelessPayload,
  type onStoreDocumentPayload,
} from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';

import { encodeMessage, parseClientMessage, type ServerMessage } from '../../web/src/editor/collabMessages.js';
import { wikiExtensions } from '../../web/src/editor/schema.js';
import { ApiError, isRetryable, type Level, type WikiApi } from './apiClient.js';
import type { ServerConfig } from './config.js';
import { describeError, log } from './log.js';

/** The Y.Doc field the editor's Collaboration extension syncs (its default). */
export const COLLAB_FIELD = 'default';

const PAGE_NAME = /^page:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The page id in a document name, or null when it isn't `page:<uuid>`. */
export function pageIdOf(documentName: string): string | null {
  return PAGE_NAME.exec(documentName)?.[1] ?? null;
}

/** What a connection carries once authenticated: who it is — for
 *  cursors, the editor list and re-authorization (by person id; the access
 *  token it connected with expires within minutes and isn't kept). */
export interface CollabContext {
  user: { id: string; name: string; color: string; level: Level };
}

const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/** The client id a seed is written under. Seeding the same draft always
 *  produces the same Yjs items, so a client still holding an earlier
 *  load's seed (it reconnected after the document was unloaded unstored)
 *  merges with the new one instead of doubling the page. That holds while
 *  the draft doesn't change between two unstored loads: every store
 *  writes a document, and the only other writer of an unopened page's
 *  draft is an import (`PUT /nodes/{id}/draft`, refused once the page has
 *  a stored document) — re-importing a page someone already opened, but
 *  whose document was never stored, is the one way to break it. */
const SEED_CLIENT_ID = 0;

/** A refused connection; Hocuspocus answers the client with permission-denied. */
class Denied extends Error {}

/** A per-document bookkeeping entry, dropped when the document unloads. */
interface DocState {
  /** People whose changes arrived since the last successful store. */
  editors: Set<string>;
  /** Stores run one at a time so an older state never lands after a newer one. */
  queue: Promise<unknown>;
  retryTimer: NodeJS.Timeout | null;
  retryDelay: number;
  /** Holding a direct-connection count so Hocuspocus keeps the document
   *  in memory while its store is being retried. */
  pinned: boolean;
  /** Why the API refused this document for good, once it has: every
   *  connection is then read-only until the document unloads. */
  refused: string | null;
}

type StoreOutcome = 'stored' | 'retry' | 'refused' | 'trashed';

interface StoreResult {
  outcome: StoreOutcome;
  /** For anything but `stored`: what to tell an editor waiting on a flush. */
  code?: string;
  /** For `stored`: the stored state vector (client id → clock). */
  clocks?: Map<number, number>;
}

export function createCollab(cfg: ServerConfig, api: WikiApi): Hocuspocus {
  const schema = getSchema(wikiExtensions());
  const states = new Map<string, DocState>();

  function stateOf(name: string): DocState {
    let state = states.get(name);
    if (!state) {
      state = {
        editors: new Set(),
        queue: Promise.resolve(),
        retryTimer: null,
        retryDelay: RETRY_FIRST_MS,
        pinned: false,
        refused: null,
      };
      states.set(name, state);
    }
    return state;
  }

  function seedDoc(draftJson: unknown): Y.Doc {
    const seed = new Y.Doc();
    seed.clientID = SEED_CLIENT_ID;
    prosemirrorJSONToYXmlFragment(schema, draftJson, seed.getXmlFragment(COLLAB_FIELD));
    return seed;
  }

  /** One PUT of the document's current state, queued behind any in flight. */
  function persist(name: string, nodeId: string, document: Y.Doc): Promise<StoreResult> {
    const state = stateOf(name);
    const attempt = state.queue.then(async (): Promise<StoreResult> => {
      const editors = [...state.editors];
      let update: Uint8Array;
      let clocks: Map<number, number>;
      let content: unknown;
      try {
        update = Y.encodeStateAsUpdate(document);
        clocks = Y.decodeStateVector(Y.encodeStateVector(document));
        content = TiptapTransformer.fromYdoc(document, COLLAB_FIELD);
      } catch (error) {
        log('error', 'could not encode a document to store', { document: name, error: describeError(error) });
        return { outcome: 'refused', code: 'unstorable' };
      }
      try {
        await api.storeState(nodeId, update, content, editors);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.code === 'deleted') {
          log('error', 'store refused: the page is in the trash; closing its connections',
            { document: name });
          return { outcome: 'trashed', code: 'deleted' };
        }
        const retry = isRetryable(error);
        log('error', retry ? 'store failed; will retry' : 'store refused; not retrying',
          { document: name, error: describeError(error) });
        if (retry) return { outcome: 'retry', code: 'unavailable' };
        return {
          outcome: 'refused',
          code: error instanceof ApiError ? error.code ?? `http_${error.status}` : 'refused',
        };
      }
      editors.forEach((id) => state.editors.delete(id));
      return { outcome: 'stored', clocks };
    });
    state.queue = attempt;
    return attempt;
  }

  function scheduleRetry(name: string, document: Document): void {
    const state = stateOf(name);
    const delay = state.retryDelay;
    state.retryDelay = Math.min(delay * 2, RETRY_MAX_MS);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      void store(name, document, true);
    }, delay);
  }

  function announce(document: Document, message: ServerMessage): void {
    document.broadcastStateless(encodeMessage(message));
  }

  /** A store landed: tell each editor connected now how far it covers
   *  their own changes (their awareness client id is their Yjs one) —
   *  what their "Saved" means. */
  function announceSaved(document: Document, clocks: Map<number, number>): void {
    const covered: Record<string, number> = {};
    for (const client of document.awareness.getStates().keys()) covered[client] = clocks.get(client) ?? 0;
    announce(document, { type: 'saved', clocks: covered });
  }

  /** The API refused the document for good: nothing typed from here on
   *  can be kept, so every connection goes read-only (Hocuspocus rejects
   *  their updates) and is told, so the editor can say so while the text
   *  is still on screen to copy. Connections arriving later get the same
   *  (`connected`). */
  function refuse(name: string, document: Document, code: string): void {
    stateOf(name).refused = code;
    document.getConnections().forEach((connection) => { connection.readOnly = true; });
    announce(document, { type: 'store_refused', code });
  }

  /** Store now; on a retryable failure keep the document loaded and try
   *  again (2 s doubling to 60 s) until a store lands or is refused. */
  async function store(name: string, document: Document, fromRetry: boolean): Promise<StoreResult> {
    const nodeId = pageIdOf(name);
    if (!nodeId) return { outcome: 'refused', code: 'not_a_page' };
    const state = stateOf(name);
    const result = await persist(name, nodeId, document);
    const { outcome } = result;
    if (outcome === 'stored') announceSaved(document, result.clocks!);
    if (outcome === 'refused') refuse(name, document, result.code ?? 'refused');
    if (outcome === 'retry') {
      if (!state.pinned) {
        document.addDirectConnection();
        state.pinned = true;
      }
      if (!state.retryTimer) scheduleRetry(name, document);
      return result;
    }
    // Editors of a trashed page would be typing into a document that can't
    // be stored: send them away (the page view shows the trash state).
    if (outcome === 'trashed') document.getConnections().forEach((connection) => connection.close());
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.retryDelay = RETRY_FIRST_MS;
    if (!state.pinned) return result;
    document.removeDirectConnection();
    state.pinned = false;
    // Hocuspocus unloads an idle document after its own stores; one our
    // retry kept loaded is ours to unload.
    if (fromRetry && document.getConnectionsCount() === 0) {
      hocuspocus.unloadDocument(document).catch((error: unknown) => {
        log('error', 'could not unload a document', { document: name, error: describeError(error) });
      });
    }
    return result;
  }

  async function recheck(connection: Connection, name: string, nodeId: string): Promise<void> {
    const user = (connection.context as Partial<CollabContext> | undefined)?.user;
    let level: Level | null;
    try {
      level = user?.id ? await api.level(nodeId, user.id) : null;
    } catch (error) {
      // an unreachable API doesn't cost anyone their session
      log('error', 're-authorization failed; keeping the connection',
        { document: name, error: describeError(error) });
      return;
    }
    if (!level) {
      log('info', 'closing a connection that lost access', { document: name, person: user?.id });
      connection.close();
      return;
    }
    // A client told read-write at sign-in doesn't learn it went read-only;
    // closing makes the provider reconnect and come back read-only.
    if (level === 'view' && !connection.readOnly) {
      log('info', 'closing a connection that lost edit', { document: name, person: user?.id });
      connection.close();
    }
  }

  let reauthorizing = false;
  /** Re-check every open connection's person against the API: close the
   *  ones that lost access or lost edit. */
  async function reauthorizeAll(): Promise<void> {
    if (reauthorizing) return;
    reauthorizing = true;
    try {
      const checks: Promise<void>[] = [];
      for (const [name, document] of hocuspocus.documents) {
        const nodeId = pageIdOf(name);
        if (!nodeId) continue;
        for (const connection of document.getConnections()) checks.push(recheck(connection, name, nodeId));
      }
      await Promise.all(checks);
    } finally {
      reauthorizing = false;
    }
  }

  const reauthTimer = setInterval(() => { void reauthorizeAll(); }, cfg.reauthMs);
  reauthTimer.unref();

  const hocuspocus: Hocuspocus = new Hocuspocus({
    name: 'serversherpa-wiki',
    quiet: true,
    debounce: 2_000,
    maxDebounce: 10_000,

    async onAuthenticate({ token, documentName, connection }: onAuthenticatePayload): Promise<CollabContext> {
      if (!cfg.serviceToken) throw new Denied('live editing is off (no service token)');
      const nodeId = pageIdOf(documentName);
      if (!nodeId) throw new Denied('not a page document');
      if (!token) throw new Denied('no token');
      const authz = await api.authorize(token, nodeId);
      if (!authz) throw new Denied('not authorized');
      if (authz.level === 'view') connection.readOnly = true;
      return {
        user: { id: authz.person.id, name: authz.person.name, color: authz.color, level: authz.level },
      };
    },

    async onLoadDocument({ documentName, document }: onLoadDocumentPayload): Promise<void> {
      const nodeId = pageIdOf(documentName);
      if (!nodeId) throw new Denied('not a page document');
      const { ydoc, draftJson } = await api.loadState(nodeId);
      if (ydoc) {
        Y.applyUpdate(document, ydoc);
      } else if (draftJson) {
        Y.applyUpdate(document, Y.encodeStateAsUpdate(seedDoc(draftJson)));
      }
    },

    async onChange({ documentName, context }: onChangePayload): Promise<void> {
      const id = (context as Partial<CollabContext> | undefined)?.user?.id;
      if (typeof id === 'string') stateOf(documentName).editors.add(id);
    },

    async onStoreDocument({ documentName, document }: onStoreDocumentPayload): Promise<void> {
      await store(documentName, document, false);
    },

    /** A newcomer to a document the API refused joins read-only, and is told. */
    async connected({ documentName, connectionInstance }: connectedPayload): Promise<void> {
      const refused = states.get(documentName)?.refused;
      if (!refused) return;
      connectionInstance.readOnly = true;
      connectionInstance.sendStateless(encodeMessage({ type: 'store_refused', code: refused }));
    },

    /** `flush`: store the document now — Hocuspocus's own store trails the
     *  last change by up to 10 s, and publishing snapshots the STORED
     *  draft — and answer how far the store covers the asking editor. */
    async onStateless({ documentName, document, connection, payload }: onStatelessPayload): Promise<void> {
      const message = parseClientMessage(payload);
      if (message?.type !== 'flush') return;
      const reply = (answer: ServerMessage) => connection.sendStateless(encodeMessage(answer));
      const refused = states.get(documentName)?.refused;
      if (refused) {
        reply({ type: 'flushed', id: message.id, ok: false, code: refused });
        return;
      }
      const result = await store(documentName, document, false);
      if (result.outcome === 'stored') {
        reply({ type: 'flushed', id: message.id, ok: true, clock: result.clocks!.get(message.client) ?? 0 });
      } else {
        reply({ type: 'flushed', id: message.id, ok: false, code: result.code ?? result.outcome });
      }
    },

    async afterUnloadDocument({ documentName }: afterUnloadDocumentPayload): Promise<void> {
      const state = states.get(documentName);
      if (state?.retryTimer) clearTimeout(state.retryTimer);
      states.delete(documentName);
    },

    async onDestroy(): Promise<void> {
      clearInterval(reauthTimer);
      for (const state of states.values()) {
        if (state.retryTimer) clearTimeout(state.retryTimer);
        state.retryTimer = null;
      }
    },

    // Hocuspocus only runs beforeUnloadDocument from extensions.
    extensions: [{
      /** A document leaving memory with a store still being retried gets
       *  one final attempt (a shutdown, or a failed load). */
      async beforeUnloadDocument({ documentName }: beforeUnloadDocumentPayload): Promise<void> {
        const state = states.get(documentName);
        if (!state) return;
        await state.queue;
        if (!state.retryTimer) return;
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
        const document = hocuspocus.documents.get(documentName);
        const nodeId = pageIdOf(documentName);
        if (!document || !nodeId) return;
        if (state.pinned) {
          document.removeDirectConnection();
          state.pinned = false;
        }
        if ((await persist(documentName, nodeId, document)).outcome !== 'stored') {
          log('error', 'final store failed; unsaved changes are lost', { document: documentName });
        }
      },
    }],
  });

  return hocuspocus;
}

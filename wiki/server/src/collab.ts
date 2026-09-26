/** Live editing: one Hocuspocus document per page, named `page:<uuid>`.
 *  The API decides who may connect (and whether read-only), loads the
 *  document and stores it; this module only relays. See the wiki design
 *  spec, "Live editing flow". */
import {
  Hocuspocus,
  type Connection,
  type Document,
  type afterUnloadDocumentPayload,
  type beforeUnloadDocumentPayload,
  type onAuthenticatePayload,
  type onChangePayload,
  type onLoadDocumentPayload,
  type onStoreDocumentPayload,
} from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';

import { wikiExtensions } from '../../web/src/editor/schema.js';
import { isRetryable, type Level, type WikiApi } from './apiClient.js';
import type { ServerConfig } from './config.js';
import { describeError, log } from './log.js';

/** The Y.Doc field the editor's Collaboration extension syncs (its default). */
export const COLLAB_FIELD = 'default';

const PAGE_NAME = /^page:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The page id in a document name, or null when it isn't `page:<uuid>`. */
export function pageIdOf(documentName: string): string | null {
  return PAGE_NAME.exec(documentName)?.[1] ?? null;
}

/** What a connection carries once authenticated: who it is (for cursors
 *  and the editor list) and the token it connected with (re-authorization
 *  reuses it; never log it). */
export interface CollabContext {
  user: { id: string; name: string; color: string; level: Level };
  token: string;
}

const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/** The client id a seed is written under. Seeding the same draft always
 *  produces the same Yjs items, so a client still holding an earlier
 *  load's seed (it reconnected after the document was unloaded unstored)
 *  merges with the new one instead of doubling the page. The draft can't
 *  change while a page has no stored document — every store writes one. */
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
}

type StoreOutcome = 'stored' | 'retry' | 'dropped';

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
  function persist(name: string, nodeId: string, document: Y.Doc): Promise<StoreOutcome> {
    const state = stateOf(name);
    const attempt = state.queue.then(async (): Promise<StoreOutcome> => {
      const editors = [...state.editors];
      let update: Uint8Array;
      let content: unknown;
      try {
        update = Y.encodeStateAsUpdate(document);
        content = TiptapTransformer.fromYdoc(document, COLLAB_FIELD);
      } catch (error) {
        log('error', 'could not encode a document to store', { document: name, error: describeError(error) });
        return 'dropped';
      }
      try {
        await api.storeState(nodeId, update, content, editors);
      } catch (error) {
        const retry = isRetryable(error);
        log('error', retry ? 'store failed; will retry' : 'store refused; not retrying',
          { document: name, error: describeError(error) });
        return retry ? 'retry' : 'dropped';
      }
      editors.forEach((id) => state.editors.delete(id));
      return 'stored';
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

  /** Store now; on a retryable failure keep the document loaded and try
   *  again (2 s doubling to 60 s) until a store lands or is refused. */
  async function store(name: string, document: Document, fromRetry: boolean): Promise<void> {
    const nodeId = pageIdOf(name);
    if (!nodeId) return;
    const state = stateOf(name);
    const outcome = await persist(name, nodeId, document);
    if (outcome === 'retry') {
      if (!state.pinned) {
        document.addDirectConnection();
        state.pinned = true;
      }
      if (!state.retryTimer) scheduleRetry(name, document);
      return;
    }
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.retryDelay = RETRY_FIRST_MS;
    if (!state.pinned) return;
    document.removeDirectConnection();
    state.pinned = false;
    // Hocuspocus unloads an idle document after its own stores; one our
    // retry kept loaded is ours to unload.
    if (fromRetry && document.getConnectionsCount() === 0) {
      hocuspocus.unloadDocument(document).catch((error: unknown) => {
        log('error', 'could not unload a document', { document: name, error: describeError(error) });
      });
    }
  }

  async function recheck(connection: Connection, name: string, nodeId: string): Promise<void> {
    const context = connection.context as Partial<CollabContext> | undefined;
    let authz;
    try {
      authz = context?.token ? await api.authorize(context.token, nodeId) : null;
    } catch (error) {
      // an unreachable API doesn't cost anyone their session
      log('error', 're-authorization failed; keeping the connection',
        { document: name, error: describeError(error) });
      return;
    }
    if (!authz) {
      log('info', 'closing a connection that lost access', { document: name, person: context?.user?.id });
      connection.close();
      return;
    }
    if (authz.level === 'view' && !connection.readOnly) {
      connection.readOnly = true;
      if (context?.user) context.user.level = 'view';
      log('info', 'connection downgraded to read-only', { document: name, person: context?.user?.id });
    }
  }

  let reauthorizing = false;
  /** Re-run authorize for every open connection with the token it
   *  connected with: close the ones that lost access, make read-only the
   *  ones that lost edit. */
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
        token,
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
        if (await persist(documentName, nodeId, document) !== 'stored') {
          log('error', 'final store failed; unsaved changes are lost', { document: documentName });
        }
      },
    }],
  });

  return hocuspocus;
}

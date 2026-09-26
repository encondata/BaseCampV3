/** Bringing a page's stored draft up to date with its live document before
 *  anything snapshots it (Publish; Phase 2's Submit for review). The wiki
 *  server stores the live document on a debounce — up to 10 s after the
 *  last change — and the API publishes the STORED draft, so publishing
 *  straight away would leave the last sentence out.
 *
 *  - `flushLive(provider)`: through an open editor's own connection. It
 *    resolves once the server has stored a state covering everything this
 *    editor typed (the server answers with how far its store covers our
 *    Yjs client id).
 *  - `flushPage(pageId)`: for a page not open in this tab (Publish from
 *    View mode): a short-lived connection, so edits other people are
 *    making live are stored too. When the server won't open the page live
 *    for this user at all (live editing switched off — no service token —
 *    or no live access), there is no live document to store and it
 *    resolves: the stored draft is all there is, and the publish itself
 *    still checks the user's access.
 *
 *  Both reject with a `FlushError` whose `code` is the server's reason
 *  (`too_large`, `bad_doc`, `deleted`, `unavailable`) or `offline`,
 *  `timeout`, `not_saved`. */
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';

import { collabUrl } from '../lib/origins';
import { currentAccessToken } from '../lib/session';
import { encodeMessage, parseServerMessage } from './collabMessages';

export const FLUSH_TIMEOUT_MS = 15_000;

export class FlushError extends Error {
  constructor(readonly code: string) {
    super(`The live document couldn't be stored (${code}).`);
    this.name = 'FlushError';
  }
}

/** How many changes this document's own client has made (its Yjs clock). */
export function ownClock(doc: Y.Doc): number {
  return Y.getState(doc.store, doc.clientID);
}

let sequence = 0;

export function flushLive(provider: HocuspocusProvider, timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
  if (provider.status !== 'connected' || !provider.synced) {
    return Promise.reject(new FlushError('offline'));
  }
  const doc = provider.document;
  const wanted = ownClock(doc);
  sequence += 1;
  const id = `flush-${Date.now()}-${sequence}`;
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: FlushError) => {
      clearTimeout(timer);
      provider.off('stateless', onMessage);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = ({ payload }: { payload: string }) => {
      const message = parseServerMessage(payload);
      if (message?.type !== 'flushed' || message.id !== id) return;
      if (!message.ok) finish(new FlushError(message.code));
      else if (message.clock < wanted) finish(new FlushError('not_saved'));
      else finish();
    };
    const timer = setTimeout(() => finish(new FlushError('timeout')), timeoutMs);
    provider.on('stateless', onMessage);
    provider.sendStateless(encodeMessage({ type: 'flush', id, client: doc.clientID }));
  });
}

export async function flushPage(pageId: string, timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
  const doc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({ url: collabUrl() });
  let provider: HocuspocusProvider | null = null;
  try {
    const live = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new FlushError('offline')), timeoutMs);
      provider = new HocuspocusProvider({
        websocketProvider: socket,
        name: `page:${pageId}`,
        document: doc,
        token: currentAccessToken,
        onSynced: ({ state }) => {
          if (!state) return;
          clearTimeout(timer);
          resolve(true);
        },
        onAuthenticationFailed: () => {
          clearTimeout(timer);
          resolve(false);
        },
      });
    });
    if (live) await flushLive(provider!, timeoutMs);
  } finally {
    (provider as HocuspocusProvider | null)?.destroy();
    socket.destroy();
    doc.destroy();
  }
}

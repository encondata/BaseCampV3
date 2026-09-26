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
 *  - `flushPage(pageId)` (flushPage.ts): for a page not open in this tab.
 *
 *  DOM- and portal-free, so the wiki server's tests can drive it too.
 *
 *  Both reject with a `FlushError` whose `code` is the server's reason
 *  (`too_large`, `bad_doc`, `deleted`, `unavailable`) or `offline`,
 *  `timeout`, `not_saved`. */
import type { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

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

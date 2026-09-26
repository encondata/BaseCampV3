/** `flushPage(pageId)`: store a page's live document when it isn't open in
 *  this tab (Publish from View mode) over a short-lived connection, so
 *  edits other people are making live are stored too (see `flushLive`).
 *  When the server won't open the page live for this user at all (live
 *  editing switched off — no service token — or no live access), there
 *  is no live document to store and it resolves: the stored draft is all
 *  there is, and the publish itself still checks the user's access. */
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';

import { collabUrl } from '../lib/origins';
import { currentAccessToken } from '../lib/session';
import { FLUSH_TIMEOUT_MS, FlushError, flushLive } from './liveFlush';

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

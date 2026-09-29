/** The flush round trip over a real WebSocket: a HocuspocusProvider (the
 *  editor's side, `flushLive`) against the real server wiring (`createApp`
 *  + Hocuspocus), with only the API faked. Proves what the hook-level
 *  tests can't: that a flush sent right after typing is answered only
 *  after a store that already includes the typing — no debounce wait. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';

import { FlushError, flushLive } from '../../web/src/editor/liveFlush';
import { ApiError, type WikiApi } from './apiClient';
import { createApp } from './app';
import { COLLAB_FIELD } from './collab';
import type { ServerConfig } from './config';

const NODE = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

let server: Server;
let socket: HocuspocusProviderWebsocket;
let provider: HocuspocusProvider;
let api: { [K in keyof WikiApi]: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  api = {
    authorize: vi.fn(async () => ({ level: 'edit', person: { id: 'p1', name: 'Pat' }, color: '#1f6feb' })),
    level: vi.fn(async () => 'edit'),
    loadState: vi.fn(async () => ({ ydoc: null, draftJson: null })),
    storeState: vi.fn(async () => undefined),
  };
  const cfg: ServerConfig = {
    port: 0, apiUrl: 'http://api.test', serviceToken: 'svc', staticDir: 'dist', reauthMs: 300_000,
  };
  const { app, attach } = createApp(cfg, api as unknown as WikiApi);
  server = createServer(app);
  attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${port}/collab`, WebSocketPolyfill: WebSocket,
  });
  provider = new HocuspocusProvider({
    websocketProvider: socket, name: `page:${NODE}`, document: new Y.Doc(), token: 'user-token',
  });
  await new Promise<void>((resolve) => {
    if (provider.synced) resolve();
    else provider.on('synced', ({ state }: { state: boolean }) => { if (state) resolve(); });
  });
});

afterEach(async () => {
  provider.destroy();
  socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function typeParagraph(text: string) {
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  provider.document.getXmlFragment(COLLAB_FIELD).insert(0, [paragraph]);
}

describe('flush over the wire', () => {
  it('stores what was just typed before answering, without waiting out the debounce', async () => {
    typeParagraph('The very last sentence.');
    await flushLive(provider, 5_000);
    expect(api.storeState).toHaveBeenCalledTimes(1);
    const [nodeId, , content] = api.storeState.mock.calls[0];
    expect(nodeId).toBe(NODE);
    expect(JSON.stringify(content)).toContain('The very last sentence.');
  });

  it('reports a refusal, and the editor is read-only from then on', async () => {
    const refused = new Promise<string>((resolve) => {
      provider.on('stateless', ({ payload }: { payload: string }) => {
        const message = JSON.parse(payload) as { type: string; code?: string };
        if (message.type === 'store_refused') resolve(message.code ?? '');
      });
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.storeState.mockRejectedValue(new ApiError(413, 'too_large'));
    typeParagraph('Too much.');
    await expect(flushLive(provider, 5_000)).rejects.toEqual(new FlushError('too_large'));
    expect(await refused).toBe('too_large');
  });
});

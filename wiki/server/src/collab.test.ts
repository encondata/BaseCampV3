/** The Hocuspocus hooks, called directly with fake payloads (the live
 *  WebSocket round trip is verified against the running stack). */
import { Document, type Hocuspocus } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { getSchema } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { fixtureDoc } from '../../web/src/editor/fixtures';
import { wikiExtensions } from '../../web/src/editor/schema';
import { ApiError, type Authz, type WikiApi } from './apiClient';
import { COLLAB_FIELD, createCollab } from './collab';
import type { ServerConfig } from './config';

const NODE = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const DOC_NAME = `page:${NODE}`;

const cfg: ServerConfig = {
  port: 5177,
  apiUrl: 'http://api.test',
  serviceToken: 'svc-secret',
  staticDir: 'dist',
  reauthMs: 300_000,
};

const authz = (level: Authz['level'], id = 'p1'): Authz => ({
  level, person: { id, name: `Person ${id}` }, color: '#aa5500',
});

function fakeApi(): WikiApi & {
  authorize: ReturnType<typeof vi.fn>;
  level: ReturnType<typeof vi.fn>;
  loadState: ReturnType<typeof vi.fn>;
  storeState: ReturnType<typeof vi.fn>;
} {
  return {
    authorize: vi.fn(async () => authz('edit')),
    level: vi.fn(async () => 'edit'),
    loadState: vi.fn(async () => ({ ydoc: null, draftJson: null })),
    storeState: vi.fn(async () => undefined),
  };
}

const schema = getSchema(wikiExtensions());
/** A document as the schema sees it: Yjs keeps no null attributes and
 *  gives attribute-less marks `attrs: {}`, so compare normalized JSON. */
const normalized = (json: unknown) => schema.nodeFromJSON(json).toJSON();

/** A Y.Doc holding the fixture in the collaboration field. */
function fixtureYdoc(): Y.Doc {
  return TiptapTransformer.toYdoc(fixtureDoc, COLLAB_FIELD, wikiExtensions());
}

type Hooks = Required<Hocuspocus['configuration']>;
const hook = <K extends keyof Hooks>(hp: Hocuspocus, name: K) =>
  hp.configuration[name] as (payload: unknown) => Promise<unknown>;

let hp: Hocuspocus;
let api: ReturnType<typeof fakeApi>;

beforeEach(() => {
  vi.useFakeTimers();
  api = fakeApi();
  hp = createCollab(cfg, api);
});

afterEach(async () => {
  await hook(hp, 'onDestroy')({ instance: hp });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('onAuthenticate', () => {
  const authenticate = (documentName: string, token = 'user-tok') => {
    const connection = { readOnly: false, requiresAuthentication: true, isAuthenticated: false };
    const result = hook(hp, 'onAuthenticate')({ token, documentName, connection, context: {} });
    return { connection, result };
  };

  it('lets an editor in read-write and keeps who they are, not their token', async () => {
    const { connection, result } = authenticate(DOC_NAME);
    await expect(result).resolves.toEqual({
      user: { id: 'p1', name: 'Person p1', color: '#aa5500', level: 'edit' },
    });
    expect(connection.readOnly).toBe(false);
    expect(api.authorize).toHaveBeenCalledWith('user-tok', NODE);
  });

  it('lets a manager in read-write', async () => {
    api.authorize.mockResolvedValueOnce(authz('manage'));
    const { connection, result } = authenticate(DOC_NAME);
    await result;
    expect(connection.readOnly).toBe(false);
  });

  it('makes a view-level connection read-only', async () => {
    api.authorize.mockResolvedValueOnce(authz('view'));
    const { connection, result } = authenticate(DOC_NAME);
    await expect(result).resolves.toMatchObject({ user: { level: 'view' } });
    expect(connection.readOnly).toBe(true);
  });

  it('rejects someone the API turns away', async () => {
    api.authorize.mockResolvedValueOnce(null);
    await expect(authenticate(DOC_NAME).result).rejects.toThrow();
  });

  it.each([
    'space:3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
    'page:not-a-uuid',
    `page:${NODE}/extra`,
    NODE,
    '',
  ])('rejects the document name %j without asking the API', async (name) => {
    await expect(authenticate(name).result).rejects.toThrow();
    expect(api.authorize).not.toHaveBeenCalled();
  });

  it('rejects a connection without a token', async () => {
    await expect(authenticate(DOC_NAME, '').result).rejects.toThrow();
    expect(api.authorize).not.toHaveBeenCalled();
  });

  it('rejects every connection while no service token is configured', async () => {
    const off = createCollab({ ...cfg, serviceToken: '' }, api);
    const connection = { readOnly: false };
    await expect(hook(off, 'onAuthenticate')({
      token: 'user-tok', documentName: DOC_NAME, connection, context: {},
    })).rejects.toThrow();
    expect(api.authorize).not.toHaveBeenCalled();
    await hook(off, 'onDestroy')({ instance: off });
  });
});

describe('onLoadDocument', () => {
  const load = (document: Y.Doc, documentName = DOC_NAME) =>
    hook(hp, 'onLoadDocument')({ documentName, document, context: {} });

  it('applies the stored update', async () => {
    const stored = fixtureYdoc();
    api.loadState.mockResolvedValueOnce({ ydoc: Y.encodeStateAsUpdate(stored), draftJson: null });
    const document = new Y.Doc();
    await load(document);
    expect(api.loadState).toHaveBeenCalledWith(NODE);
    expect(normalized(TiptapTransformer.fromYdoc(document, COLLAB_FIELD))).toEqual(normalized(fixtureDoc));
  });

  it('seeds a page never opened live from its draft JSON', async () => {
    api.loadState.mockResolvedValueOnce({ ydoc: null, draftJson: fixtureDoc });
    const document = new Y.Doc();
    await load(document);
    expect(normalized(TiptapTransformer.fromYdoc(document, COLLAB_FIELD))).toEqual(normalized(fixtureDoc));
  });

  // An unstored seed is rebuilt on every load; a client still holding the
  // previous load's seed (a reconnect after the document was unloaded) must
  // merge with the new one, not append a second copy of the page.
  it('seeds the same way every time, so a reconnecting client does not duplicate the page', async () => {
    api.loadState.mockResolvedValue({ ydoc: null, draftJson: fixtureDoc });
    const first = new Y.Doc();
    const second = new Y.Doc();
    await load(first);
    await load(second);
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
    expect(normalized(TiptapTransformer.fromYdoc(second, COLLAB_FIELD))).toEqual(normalized(fixtureDoc));
  });

  it('leaves a brand-new page empty', async () => {
    const document = new Y.Doc();
    await load(document);
    expect(document.getXmlFragment(COLLAB_FIELD).length).toBe(0);
  });

  it('refuses a document name that is not a page', async () => {
    await expect(load(new Y.Doc(), 'folder:x')).rejects.toThrow();
    expect(api.loadState).not.toHaveBeenCalled();
  });
});

describe('onStoreDocument', () => {
  /** A loaded Hocuspocus document holding the fixture. */
  function loadedDocument(): Document {
    const document = new Document(DOC_NAME);
    Y.applyUpdate(document, Y.encodeStateAsUpdate(fixtureYdoc()));
    hp.documents.set(DOC_NAME, document);
    return document;
  }
  const change = (document: Document, context: unknown) =>
    hook(hp, 'onChange')({ documentName: DOC_NAME, document, context });
  const store = (document: Document) =>
    hook(hp, 'onStoreDocument')({ documentName: DOC_NAME, document, context: {} });

  it('sends the update, the JSON and the people who edited since the last store', async () => {
    const document = loadedDocument();
    await change(document, { user: { id: 'p1' } });
    await change(document, { user: { id: 'p2' } });
    await change(document, { user: { id: 'p1' } });
    await change(document, {}); // a server-side change has no editor
    await store(document);

    expect(api.storeState).toHaveBeenCalledTimes(1);
    const [nodeId, ydoc, contentJson, editorIds] = api.storeState.mock.calls[0];
    expect(nodeId).toBe(NODE);
    expect(ydoc).toEqual(Y.encodeStateAsUpdate(document));
    expect(normalized(contentJson)).toEqual(normalized(fixtureDoc));
    expect([...editorIds].sort()).toEqual(['p1', 'p2']);

    // the editors are cleared once they're stored
    await store(document);
    expect(api.storeState.mock.calls[1][3]).toEqual([]);
  });

  it('closes every connection when the page went to the trash', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const document = loadedDocument();
    const editors = [{ close: vi.fn() }, { close: vi.fn() }];
    vi.spyOn(document, 'getConnections').mockReturnValue(editors as never);
    await change(document, { user: { id: 'p1' } });
    api.storeState.mockRejectedValueOnce(new ApiError(409, 'deleted'));

    await expect(store(document)).resolves.toBeUndefined();
    editors.forEach((c) => expect(c.close).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(errors.mock.calls)).toContain('in the trash');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.storeState).toHaveBeenCalledTimes(1);
  });

  it('logs and gives up on a refusal that retrying cannot fix', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const document = loadedDocument();
    const editor = { close: vi.fn() };
    vi.spyOn(document, 'getConnections').mockReturnValue([editor] as never);
    await change(document, { user: { id: 'p1' } });
    api.storeState.mockRejectedValueOnce(new ApiError(413, 'too_large'));
    await expect(store(document)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    expect(document.getConnectionsCount()).toBe(0);
    // only a trashed page sends its editors away
    expect(editor.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.storeState).toHaveBeenCalledTimes(1);
    // the editors are still owed a store
    await store(document);
    expect(api.storeState.mock.calls[1][3]).toEqual(['p1']);
  });

  it('keeps the document loaded and retries with backoff while the API is read-only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const document = loadedDocument();
    await change(document, { user: { id: 'p1' } });
    api.storeState
      .mockRejectedValueOnce(new ApiError(423, 'read_only_mode'))
      .mockRejectedValueOnce(new ApiError(503, null))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    const unload = vi.spyOn(hp, 'unloadDocument');

    await expect(store(document)).resolves.toBeUndefined();
    expect(api.storeState).toHaveBeenCalledTimes(1);
    // held in memory even with nobody connected
    expect(document.getConnectionsCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(api.storeState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);          // 2 s
    expect(api.storeState).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);      // then 4 s
    expect(api.storeState).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(7_999);      // then 8 s
    expect(api.storeState).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.storeState).toHaveBeenCalledTimes(4);

    // the fourth attempt succeeded: released and unloaded, editors cleared
    expect(api.storeState.mock.calls[3][3]).toEqual(['p1']);
    expect(document.getConnectionsCount()).toBe(0);
    expect(unload).toHaveBeenCalledWith(document);
    expect(log).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.storeState).toHaveBeenCalledTimes(4);
  });

  it('caps the backoff at a minute', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const document = loadedDocument();
    api.storeState.mockRejectedValue(new ApiError(423, 'read_only_mode'));
    await store(document);
    // 2 + 4 + 8 + 16 + 32 = 62 s for five retries, then 60 s apart
    await vi.advanceTimersByTimeAsync(62_000);
    expect(api.storeState).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(api.storeState).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.storeState).toHaveBeenCalledTimes(7);
  });

  it('keeps editing sessions connected to a document whose store is retrying', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const document = loadedDocument();
    document.addDirectConnection(); // someone is still connected
    api.storeState.mockRejectedValueOnce(new ApiError(423, 'read_only_mode'));
    const unload = vi.spyOn(hp, 'unloadDocument');
    await store(document);
    expect(document.getConnectionsCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(document.getConnectionsCount()).toBe(1);
    expect(unload).not.toHaveBeenCalled();
  });

  it('makes one final attempt when a document with a failed store unloads', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const document = loadedDocument();
    await change(document, { user: { id: 'p1' } });
    api.storeState.mockRejectedValueOnce(new ApiError(423, 'read_only_mode'));
    await store(document);
    expect(api.storeState).toHaveBeenCalledTimes(1);

    await hp.unloadDocument(document);
    expect(api.storeState).toHaveBeenCalledTimes(2);
    expect(api.storeState.mock.calls[1][3]).toEqual(['p1']);
    expect(hp.documents.has(DOC_NAME)).toBe(false);

    // the pending retry went with it
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.storeState).toHaveBeenCalledTimes(2);
  });

  it('never stores two versions of a document at once', async () => {
    const document = loadedDocument();
    let release!: () => void;
    let inFlight = 0;
    let maxInFlight = 0;
    api.storeState.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => { release = resolve; });
      inFlight -= 1;
    });
    const first = store(document);
    const second = store(document);
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await Promise.all([first, second]);
    expect(api.storeState).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });
});

describe('re-authorization', () => {
  interface FakeConnection {
    readOnly: boolean;
    context: { user: { id: string; level: string } };
    close: ReturnType<typeof vi.fn>;
  }
  const connection = (personId: string, level = 'edit'): FakeConnection => ({
    readOnly: level === 'view',
    context: { user: { id: personId, level } },
    close: vi.fn(),
  });

  function openDocument(name: string, connections: FakeConnection[]) {
    hp.documents.set(name, { name, getConnections: () => connections } as unknown as Document);
  }

  it('asks by person and closes connections that lost access or lost edit', async () => {
    const kept = connection('p-kept');
    const viewer = connection('p-viewer', 'view');
    const downgraded = connection('p-lost-edit');
    const revoked = connection('p-revoked');
    const apiDown = connection('p-api-down');
    openDocument(DOC_NAME, [kept, viewer, downgraded, revoked, apiDown]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const infos = vi.spyOn(console, 'log').mockImplementation(() => {});
    api.level.mockImplementation(async (_node: string, person: string) => {
      if (person === 'p-viewer' || person === 'p-lost-edit') return 'view';
      if (person === 'p-revoked') return null;
      if (person === 'p-api-down') throw new TypeError('fetch failed');
      return 'edit';
    });

    await vi.advanceTimersByTimeAsync(cfg.reauthMs - 1);
    expect(api.level).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(api.level).toHaveBeenCalledTimes(5);
    expect(api.level).toHaveBeenCalledWith(NODE, 'p-kept');
    // no user token involved: it expired long ago
    expect(api.authorize).not.toHaveBeenCalled();
    expect(kept.close).not.toHaveBeenCalled();
    // already read-only and still view: nothing to change
    expect(viewer.close).not.toHaveBeenCalled();
    // lost edit: closed, so the provider reconnects and comes back read-only
    expect(downgraded.close).toHaveBeenCalledTimes(1);
    expect(revoked.close).toHaveBeenCalledTimes(1);
    // an unreachable API doesn't cost anyone their session
    expect(apiDown.close).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
    expect(infos).toHaveBeenCalled();
  });

  it('closes a connection it cannot identify', async () => {
    const anonymous = { readOnly: false, context: {}, close: vi.fn() };
    openDocument(DOC_NAME, [anonymous as unknown as FakeConnection]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(cfg.reauthMs);
    expect(api.level).not.toHaveBeenCalled();
    expect(anonymous.close).toHaveBeenCalledTimes(1);
  });

  it('runs again on the next interval', async () => {
    openDocument(DOC_NAME, [connection('a')]);
    await vi.advanceTimersByTimeAsync(cfg.reauthMs * 2);
    expect(api.level).toHaveBeenCalledTimes(2);
  });

  it('stops when the server is destroyed', async () => {
    openDocument(DOC_NAME, [connection('a')]);
    await hook(hp, 'onDestroy')({ instance: hp });
    await vi.advanceTimersByTimeAsync(cfg.reauthMs * 2);
    expect(api.level).not.toHaveBeenCalled();
  });
});

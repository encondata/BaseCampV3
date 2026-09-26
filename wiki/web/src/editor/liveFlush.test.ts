import type { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { FlushError, flushLive, ownClock } from './liveFlush';

/** Just enough of a HocuspocusProvider for a flush: its document, state,
 *  stateless events, and what it sent. */
class FakeProvider {
  status = 'connected';
  synced = true;
  document = new Y.Doc();
  sent: Array<Record<string, unknown>> = [];
  private handlers = new Set<(arg: { payload: string }) => void>();
  on(_event: 'stateless', fn: (arg: { payload: string }) => void) { this.handlers.add(fn); }
  off(_event: 'stateless', fn: (arg: { payload: string }) => void) { this.handlers.delete(fn); }
  sendStateless(payload: string) { this.sent.push(JSON.parse(payload) as Record<string, unknown>); }
  answer(message: object) { this.handlers.forEach((fn) => fn({ payload: JSON.stringify(message) })); }
  get listeners() { return this.handlers.size; }
}

let provider: FakeProvider;
const flush = (timeout?: number) => flushLive(provider as unknown as HocuspocusProvider, timeout);
const type = (text: string) => provider.document.getText('t').insert(0, text);

beforeEach(() => { provider = new FakeProvider(); });
afterEach(() => { vi.useRealTimers(); });

describe('flushLive', () => {
  it('asks the server to store now and resolves once the store covers what this editor typed', async () => {
    type('fresh sentence');
    const done = flush();
    expect(provider.sent).toEqual([
      { type: 'flush', id: expect.any(String), client: provider.document.clientID }]);
    const { id } = provider.sent[0];
    provider.answer({ type: 'flushed', id: 'someone-elses', ok: true, clock: 0 }); // not ours
    provider.answer({ type: 'flushed', id, ok: true, clock: ownClock(provider.document) });
    await expect(done).resolves.toBeUndefined();
    expect(provider.listeners).toBe(0);
  });

  it('rejects with the server\'s reason when the store is refused', async () => {
    const done = flush();
    provider.answer({ type: 'flushed', id: provider.sent[0].id, ok: false, code: 'too_large' });
    await expect(done).rejects.toEqual(new FlushError('too_large'));
  });

  it('rejects when the store does not cover everything this editor typed', async () => {
    type('abc');
    const done = flush();
    provider.answer({ type: 'flushed', id: provider.sent[0].id, ok: true, clock: 1 });
    await expect(done).rejects.toEqual(new FlushError('not_saved'));
  });

  it('fails at once while offline, and after a timeout when nobody answers', async () => {
    provider.status = 'disconnected';
    await expect(flush()).rejects.toEqual(new FlushError('offline'));
    expect(provider.sent).toEqual([]);

    provider.status = 'connected';
    vi.useFakeTimers();
    const done = flush(1000);
    const check = expect(done).rejects.toEqual(new FlushError('timeout'));
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    expect(provider.listeners).toBe(0);
  });
});

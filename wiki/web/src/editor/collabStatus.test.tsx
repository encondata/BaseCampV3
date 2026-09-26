// @vitest-environment jsdom
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { CollabStatus, StoreRefusedBanner, useCollabState } from './collabStatus';

/** Just enough of a HocuspocusProvider: its state and events. */
class FakeProvider {
  status = 'connecting';
  synced = false;
  unsyncedChanges = 0;
  document = new Y.Doc();
  private handlers = new Map<string, Set<(arg: unknown) => void>>();
  on(event: string, fn: (arg: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
  }
  off(event: string, fn: (arg: unknown) => void) { this.handlers.get(event)?.delete(fn); }
  emit(event: string, arg: unknown) { this.handlers.get(event)?.forEach((fn) => fn(arg)); }
  setStatus(status: string) { this.status = status; this.emit('status', { status }); }
  setSynced(state: boolean) { this.synced = state; this.emit('synced', { state }); }
  setUnsynced(n: number) { this.unsyncedChanges = n; this.emit('unsyncedChanges', n); }
  tell(message: object) { this.emit('stateless', { payload: JSON.stringify(message) }); }
  type(text: string) { this.document.getText('t').insert(0, text); }
  get clock() { return Y.getState(this.document.store, this.document.clientID); }
}

function Harness({ provider }: { provider: FakeProvider }) {
  const state = useCollabState(provider as unknown as HocuspocusProvider);
  return (
    <div>
      <CollabStatus state={state} />
      <span data-testid="dim">{state.dimmed ? 'dimmed' : 'clear'}</span>
      <span data-testid="banner">{state.showBanner ? 'banner' : 'none'}</span>
      {state.refused && <StoreRefusedBanner code={state.refused} />}
    </div>
  );
}

let provider: FakeProvider;
beforeEach(() => { vi.useFakeTimers(); provider = new FakeProvider(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const status = () => screen.getByRole('status').textContent;

describe('live editing status', () => {
  it('connects, saves and goes offline without dimming the page again', () => {
    render(<Harness provider={provider} />);
    expect(status()).toBe('Connecting…');
    expect(screen.getByTestId('dim').textContent).toBe('dimmed');

    act(() => { provider.setStatus('connected'); provider.setSynced(true); });
    expect(status()).toBe('Saved');
    expect(screen.getByTestId('dim').textContent).toBe('clear');

    act(() => { provider.setUnsynced(2); });
    expect(status()).toBe('Saving…');
    act(() => { provider.setUnsynced(0); });
    expect(status()).toBe('Saved');

    // the socket drops: the provider also resets `synced`
    act(() => { provider.setStatus('disconnected'); provider.setSynced(false); });
    expect(status()).toBe('Offline');
    expect(screen.getByTestId('banner').textContent).toBe('banner');
    expect(screen.getByTestId('dim').textContent).toBe('clear');

    act(() => { provider.setStatus('connecting'); });
    expect(status()).toBe('Offline');
    act(() => { provider.setStatus('connected'); });
    expect(status()).toBe('Saving…');   // connected, catching up
    act(() => { provider.setSynced(true); });
    expect(status()).toBe('Saved');
    expect(screen.getByTestId('banner').textContent).toBe('none');
  });

  it('holds the banner back for a moment on the first connection only', () => {
    render(<Harness provider={provider} />);
    expect(screen.getByTestId('banner').textContent).toBe('none');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByTestId('banner').textContent).toBe('banner');
  });

  it('says Loading… while connected but before the first load, not Saving…', () => {
    render(<Harness provider={provider} />);
    act(() => { provider.setStatus('connected'); });
    expect(status()).toBe('Loading…');
    expect(screen.getByTestId('dim').textContent).toBe('dimmed');
    act(() => { provider.setSynced(true); });
    expect(status()).toBe('Saved');
  });

  it('says Saved only once a store covers what you typed, not when the server merely has it', () => {
    render(<Harness provider={provider} />);
    act(() => { provider.setStatus('connected'); provider.setSynced(true); });
    expect(status()).toBe('Saved');

    act(() => { provider.type('a sentence'); });
    // the server has it (nothing unsynced), but it isn't stored yet
    expect(status()).toBe('Saving…');
    const mine = String(provider.document.clientID);
    act(() => { provider.tell({ type: 'saved', clocks: { [mine]: provider.clock - 1 } }); });
    expect(status()).toBe('Saving…');
    act(() => { provider.tell({ type: 'saved', clocks: { 999: 50 } }); });
    expect(status()).toBe('Saving…');
    act(() => { provider.tell({ type: 'saved', clocks: { [mine]: provider.clock } }); });
    expect(status()).toBe('Saved');
  });

  it('says Not saved, with a way out, once the server refuses the page', () => {
    render(<Harness provider={provider} />);
    act(() => { provider.setStatus('connected'); provider.setSynced(true); });
    act(() => { provider.tell({ type: 'store_refused', code: 'too_large' }); });
    expect(status()).toBe('Not saved');
    expect(screen.getByRole('alert').textContent).toMatch(/too large to save.*copy/i);
  });
});

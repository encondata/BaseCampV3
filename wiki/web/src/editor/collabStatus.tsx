/** The live-editing connection as the editor shows it: the save state
 *  ("Connecting…", "Loading…", "Saving…", "Saved", "Offline", "Not
 *  saved"), whether the page is still loading (dimmed), whether the
 *  reconnecting banner shows, and whether the server refused the page for
 *  good (`refused`, with `StoreRefusedBanner`).
 *
 *  Being connected and being synced are tracked apart: the provider resets
 *  `synced` whenever the socket drops, so "never synced yet" (the first
 *  load — dim the page, say Connecting…) and "synced before, offline now"
 *  (keep the page bright, say Offline, show the banner) are different.
 *
 *  "Saved" means stored, not just received: the server stores on a
 *  debounce, and after each store tells every editor how far it covers
 *  their own changes (`saved`, see collabMessages.ts). Until a store
 *  covers what you typed, it says "Saving…". */
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useEffect, useState } from 'react';

import { parseServerMessage } from './collabMessages';
import { ownClock } from './liveFlush';

const BANNER_GRACE_MS = 1500;

export interface CollabState {
  connected: boolean;
  /** In step with the server on this connection. */
  synced: boolean;
  /** Has loaded the document at least once. */
  everSynced: boolean;
  unsynced: number;
  /** This editor typed something no store covers yet. */
  unsaved: boolean;
  /** Why the server refused the page for good (nothing more is kept), or null. */
  refused: string | null;
  /** Only before the first load — never during a reconnect. */
  dimmed: boolean;
  showBanner: boolean;
}

export function useCollabState(provider: HocuspocusProvider): CollabState {
  const [status, setStatus] = useState<string>(provider.status);
  const [unsynced, setUnsynced] = useState(provider.unsyncedChanges);
  const [synced, setSynced] = useState(provider.synced);
  const [everSynced, setEverSynced] = useState(provider.synced);
  const [everConnected, setEverConnected] = useState(provider.status === 'connected');
  const [grace, setGrace] = useState(true);
  const [unsaved, setUnsaved] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  // how far the server's stores cover this editor's own changes
  useEffect(() => {
    const doc = provider.document;
    let stored = 0;
    const check = () => setUnsaved(ownClock(doc) > stored);
    const onStateless = ({ payload }: { payload: string }) => {
      const message = parseServerMessage(payload);
      if (message?.type === 'saved') {
        const clock = message.clocks[String(doc.clientID)];
        if (clock !== undefined) stored = Math.max(stored, clock);
        check();
      } else if (message?.type === 'flushed' && message.ok) {
        stored = Math.max(stored, message.clock);
        check();
      } else if (message?.type === 'store_refused') {
        setRefused(message.code);
      }
    };
    doc.on('update', check);
    provider.on('stateless', onStateless);
    check();
    return () => {
      doc.off('update', check);
      provider.off('stateless', onStateless);
    };
  }, [provider]);

  useEffect(() => {
    const onStatus = ({ status: next }: { status: string }) => {
      setStatus(next);
      if (next === 'connected') setEverConnected(true);
    };
    const onUnsynced = (n: number) => setUnsynced(n);
    const onSynced = ({ state }: { state: boolean }) => {
      setSynced(state);
      if (state) setEverSynced(true);
    };
    provider.on('status', onStatus);
    provider.on('unsyncedChanges', onUnsynced);
    provider.on('synced', onSynced);
    const timer = setTimeout(() => setGrace(false), BANNER_GRACE_MS);
    return () => {
      provider.off('status', onStatus);
      provider.off('unsyncedChanges', onUnsynced);
      provider.off('synced', onSynced);
      clearTimeout(timer);
    };
  }, [provider]);

  const connected = status === 'connected';
  return {
    connected,
    synced,
    everSynced,
    unsynced,
    unsaved,
    refused,
    dimmed: !everSynced,
    showBanner: !connected && (everConnected || !grace),
  };
}

/** The save state's words and dot color. */
export function saveState({ connected, synced, everSynced, unsynced, unsaved, refused }: CollabState,
): { text: string; tone: string } {
  if (refused) return { text: 'Not saved', tone: 'error' };
  if (!connected) {
    return everSynced ? { text: 'Offline', tone: 'offline' } : { text: 'Connecting…', tone: 'pending' };
  }
  // connected, but the document hasn't loaded yet: nothing is being saved
  if (!synced && !everSynced) return { text: 'Loading…', tone: 'pending' };
  if (!synced || unsynced > 0 || unsaved) return { text: 'Saving…', tone: 'pending' };
  return { text: 'Saved', tone: 'saved' };
}

export function CollabStatus({ state }: { state: CollabState }) {
  const { text, tone } = saveState(state);
  return (
    <span className={`we-save we-save-${tone}`} role="status" aria-live="polite">
      <span className="we-save-dot" aria-hidden="true" />{text}
    </span>
  );
}

/** What the editor says once the server refused the page for good: the
 *  editor is read-only from then on, and what's on screen is the only copy
 *  of the changes since the last store. */
export function StoreRefusedBanner({ code }: { code: string }) {
  const why = code === 'too_large' ? 'This page is too large to save.' : 'This page can\'t be saved right now.';
  return (
    <div className="we-banner is-error" role="alert">
      {why} Your latest changes aren't being kept — copy them somewhere safe before you leave
      this page, then reload it.
    </div>
  );
}

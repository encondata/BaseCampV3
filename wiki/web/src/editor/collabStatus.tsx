/** The live-editing connection as the editor shows it: the save state
 *  ("Connecting…", "Loading…", "Saving…", "Saved", "Offline"), whether the page is
 *  still loading (dimmed), and whether the reconnecting banner shows.
 *
 *  Being connected and being synced are tracked apart: the provider resets
 *  `synced` whenever the socket drops, so "never synced yet" (the first
 *  load — dim the page, say Connecting…) and "synced before, offline now"
 *  (keep the page bright, say Offline, show the banner) are different. */
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useEffect, useState } from 'react';

const BANNER_GRACE_MS = 1500;

export interface CollabState {
  connected: boolean;
  /** In step with the server on this connection. */
  synced: boolean;
  /** Has loaded the document at least once. */
  everSynced: boolean;
  unsynced: number;
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
    dimmed: !everSynced,
    showBanner: !connected && (everConnected || !grace),
  };
}

/** The save state's words and dot color. */
export function saveState({ connected, synced, everSynced, unsynced }: CollabState): { text: string; tone: string } {
  if (!connected) {
    return everSynced ? { text: 'Offline', tone: 'offline' } : { text: 'Connecting…', tone: 'pending' };
  }
  // connected, but the document hasn't loaded yet: nothing is being saved
  if (!synced && !everSynced) return { text: 'Loading…', tone: 'pending' };
  if (!synced || unsynced > 0) return { text: 'Saving…', tone: 'pending' };
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

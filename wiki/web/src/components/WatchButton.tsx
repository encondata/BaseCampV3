/** Watch / Watching toggle for a page, folder or space (spec §7). A node
 *  target reads its watch state (own, inherited from an ancestor folder or
 *  the space, or none) through `getWatchState`; a space target watches the
 *  space itself directly, since a space has no ancestor to inherit from.
 *  An inherited watch shows as a disabled-looking chip — the simplest
 *  reading of "you already hear about this" without a second control for
 *  watching just this one page too. */
import { useEffect, useState } from 'react';

import { useToast } from '@portal/lib/notificationsContext';

import { Icon } from '../editor/icons';
import type { WatchVia } from '../lib/types';
import { errorMessage, getWatchState, listWatches, unwatch, watch as putWatch } from '../lib/wikiApi';

export type WatchTarget =
  | { kind: 'node'; nodeId: string }
  | { kind: 'space'; spaceId: string; spaceKey: string };

interface WatchState {
  watching: boolean;
  via: WatchVia | null;
  watchId: string | null;
}

const targetKey = (t: WatchTarget) => (t.kind === 'node' ? `node:${t.nodeId}` : `space:${t.spaceId}`);

async function loadState(target: WatchTarget): Promise<WatchState> {
  if (target.kind === 'node') {
    const s = await getWatchState(target.nodeId);
    return { watching: s.watching, via: s.via, watchId: s.watch_id };
  }
  const watches = await listWatches();
  const mine = watches.find((w) => w.node === null && w.space?.key === target.spaceKey);
  return mine ? { watching: true, via: 'space', watchId: mine.id } : { watching: false, via: null, watchId: null };
}

export default function WatchButton({ target, className }: { target: WatchTarget; className?: string }) {
  const toast = useToast();
  const [state, setState] = useState<WatchState | null>(null);
  const [busy, setBusy] = useState(false);
  const key = targetKey(target);

  useEffect(() => {
    let live = true;
    setState(null);
    loadState(target).then((s) => { if (live) setState(s); })
      .catch(() => { if (live) setState({ watching: false, via: null, watchId: null }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!state) return null;

  // a node's own watch has via 'node'; a space watched directly is always its own
  const own = target.kind === 'space' ? state.watching : state.via === 'node';

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (state.watching && own) {
        await unwatch(state.watchId as string);
        setState({ watching: false, via: null, watchId: null });
      } else if (!state.watching) {
        const w = target.kind === 'node'
          ? await putWatch({ node_id: target.nodeId })
          : await putWatch({ space_id: target.spaceId });
        setState({ watching: true, via: target.kind === 'node' ? 'node' : 'space', watchId: w.id });
      }
    } catch (err) {
      toast(errorMessage(err, "Couldn't update your watch."));
    } finally {
      setBusy(false);
    }
  };

  if (state.watching && !own) {
    const via = state.via === 'ancestor' ? 'folder' : 'library';
    return (
      <span className={`chip wiki-watch-chip${className ? ` ${className}` : ''}`}
            title={`You're watching the whole ${via}.`}>
        <Icon name="eye" />Watching via {via}
      </span>
    );
  }

  return (
    <button type="button" className={`btn-ghost wiki-watch-btn${state.watching ? ' on' : ''}${className ? ` ${className}` : ''}`}
            aria-pressed={state.watching} disabled={busy}
            title={state.watching ? 'Stop watching' : 'Get notified about changes here'}
            onClick={() => void toggle()}>
      <Icon name="eye" />{state.watching ? 'Watching' : 'Watch'}
    </button>
  );
}

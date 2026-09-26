/** /watching — everything I watch, newest first: a page, a folder (its
 *  subtree) or a whole space, each with Unwatch. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { relativeTime } from '@portal/lib/format';
import { useToast } from '@portal/lib/notificationsContext';

import NodeIcon, { nodeTypeLabel } from '../components/NodeIcon';
import { useWikiShell } from '../layout/shellContext';
import { libraryPath } from '../lib/paths';
import type { WatchOut } from '../lib/types';
import { errorMessage, listWatches, unwatch } from '../lib/wikiApi';


const GRID = { gridTemplateColumns: 'minmax(240px, 3fr) minmax(110px, 1fr) minmax(140px, 1.2fr) 120px' };

type State = WatchOut[] | 'loading' | 'error';

function targetHref(w: WatchOut): string {
  return w.node ? `/n/${w.node.id}` : libraryPath(w.space?.key ?? '');
}

function targetLabel(w: WatchOut): string {
  return w.node ? w.node.title : (w.space?.name ?? 'Library');
}

function typeLabel(w: WatchOut): string {
  return w.node ? nodeTypeLabel({ kind: w.node.kind, title: w.node.title, file: null }) : 'Library';
}

export default function WatchingPage() {
  const toast = useToast();
  const { setCurrentNode } = useWikiShell();
  const [state, setState] = useState<State>('loading');
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => { setCurrentNode(null); }, [setCurrentNode]);

  useEffect(() => {
    let live = true;
    listWatches().then((w) => { if (live) setState(w); }).catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, []);

  const drop = (id: string) => setState((cur) => (Array.isArray(cur) ? cur.filter((w) => w.id !== id) : cur));

  const stopWatching = async (w: WatchOut) => {
    setWorking(w.id);
    try {
      await unwatch(w.id);
      drop(w.id);
    } catch (err) {
      toast(errorMessage(err, `Couldn't stop watching “${targetLabel(w)}”.`));
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="portal-page wiki-page" data-testid="watching-page">
      <div className="dir-head wiki-folder-head">
        <div>
          <div className="eyebrow">Wiki</div>
          <h1 className="page-title">Watching</h1>
          <p className="page-hint">Pages, folders and libraries you get notified about.</p>
        </div>
      </div>

      {state === 'error' && <p className="pf-error">Couldn't load your watches. Refresh to try again.</p>}
      <div className="dir-list list-scroll wiki-watching-list">
        <div className="list-head" style={GRID} aria-hidden="true">
          <span>What</span><span>Type</span><span>Watching since</span><span />
        </div>
        <div role="list" aria-label="Watching">
          {Array.isArray(state) && state.map((w) => (
            <div className="dir-row" role="listitem" key={w.id}>
              <div className="row-main" style={GRID}>
                <div className="cell cell-primary">
                  {w.node && <NodeIcon node={{ kind: w.node.kind, title: w.node.title, file: null }} className="wiki-row-icon" />}
                  <div className="pn">
                    <Link to={targetHref(w)}><b title={targetLabel(w)}>{targetLabel(w)}</b></Link>
                  </div>
                </div>
                <div className="cell"><span className="cell-top cell-line">{typeLabel(w)}</span></div>
                <div className="cell">
                  <span className="cell-top cell-line" title={new Date(w.created_at).toLocaleString()}>
                    {relativeTime(w.created_at)}
                  </span>
                </div>
                <div className="cell wiki-watching-actions">
                  <button type="button" className="btn-ghost" aria-label={`Stop watching ${targetLabel(w)}`}
                          disabled={working === w.id} onClick={() => void stopWatching(w)}>
                    {working === w.id ? 'Removing…' : 'Unwatch'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
        {state === 'loading' && <div className="dir-empty">Loading…</div>}
        {Array.isArray(state) && state.length === 0 && (
          <div className="dir-empty"><b>Nothing watched yet</b>Watch a page, folder or library to hear about changes there.</div>
        )}
      </div>
    </div>
  );
}

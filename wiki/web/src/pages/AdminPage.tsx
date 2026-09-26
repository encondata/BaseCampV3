/** /admin — wiki administrators only (everyone else sees NotFound, same as
 *  any page they can't view): every space, including archived ones (which
 *  never show up in the ordinary space list), with a link to each space's
 *  settings and trash, and Unarchive — the one thing only a wiki admin,
 *  not even a space manager, can do. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useToast } from '@portal/lib/notificationsContext';

import { SpaceBadge } from '../components/NodeIcon';
import { useWikiShell } from '../layout/shellContext';
import type { SpaceOut } from '../lib/types';
import { useWikiMe } from '../lib/useWikiMe';
import { errorMessage, listSpaces, unarchiveSpace } from '../lib/wikiApi';
import NotFound from './NotFound';

type State =
  | { status: 'loading' }
  | { status: 'ready'; spaces: SpaceOut[] }
  | { status: 'error'; message: string };

const GRID = {
  gridTemplateColumns: 'minmax(220px, 2.6fr) minmax(120px, 1fr) minmax(110px, 0.9fr) 210px',
};

export default function AdminPage() {
  const toast = useToast();
  const me = useWikiMe();
  const { setCurrentNode } = useWikiShell();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => { setCurrentNode(null); }, [setCurrentNode]);

  useEffect(() => {
    if (!me?.is_admin) return undefined;
    let live = true;
    listSpaces(true)
      .then((spaces) => { if (live) setState({ status: 'ready', spaces }); })
      .catch((err) => { if (live) setState({ status: 'error', message: errorMessage(err, 'Couldn\'t load the spaces.') }); });
    return () => { live = false; };
  }, [me?.is_admin]);

  if (!me) return <div className="portal-page wiki-page"><p className="page-hint">Loading…</p></div>;
  if (!me.is_admin) return <NotFound />;

  const unarchive = async (space: SpaceOut) => {
    setWorking(space.key);
    try {
      const updated = await unarchiveSpace(space.key);
      setState((cur) => (cur.status === 'ready'
        ? { status: 'ready', spaces: cur.spaces.map((s) => (s.id === updated.id ? updated : s)) }
        : cur));
      toast(`“${space.name}” is back in use.`);
    } catch (err) {
      toast(errorMessage(err, `Couldn't unarchive “${space.name}”.`));
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="portal-page wiki-page wiki-admin-page" data-testid="admin-page">
      <div className="dir-head wiki-folder-head">
        <div>
          <div className="eyebrow">Wiki admin</div>
          <h1 className="page-title">All spaces</h1>
        </div>
      </div>

      {state.status === 'loading' && <p className="page-hint">Loading…</p>}
      {state.status === 'error' && <p className="pf-error">{state.message}</p>}
      {state.status === 'ready' && (
        <div className="dir-list list-scroll wiki-admin-list">
          <div className="list-head" style={GRID} aria-hidden="true">
            <span>Space</span><span>Key</span><span>Status</span><span />
          </div>
          <div role="list" aria-label="All spaces">
            {state.spaces.map((s) => (
              <div className="dir-row" role="listitem" key={s.id}>
                <div className="row-main" style={GRID}>
                  <div className="cell cell-primary">
                    <SpaceBadge space={s} />
                    <div className="pn">
                      <b title={s.name}>{s.name}</b>
                      {s.description && <span className="cell-sub cell-line">{s.description}</span>}
                    </div>
                  </div>
                  <div className="cell"><span className="mono cell-line">{s.key}</span></div>
                  <div className="cell">
                    {s.archived_at
                      ? <span className="chip c-amber"><span className="dot" />Archived</span>
                      : <span className="chip c-green"><span className="dot" />Active</span>}
                  </div>
                  <div className="cell wiki-admin-actions">
                    <Link className="btn-ghost" to={`/s/${s.key}/settings`}>Settings</Link>
                    <Link className="btn-ghost" to={`/trash/${s.key}`}>Trash</Link>
                    {s.archived_at && (
                      <button type="button" className="btn-ghost" disabled={working === s.key}
                              onClick={() => void unarchive(s)}>
                        {working === s.key ? 'Unarchiving…' : 'Unarchive'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {state.spaces.length === 0 && <div className="dir-empty"><b>No spaces yet</b></div>}
        </div>
      )}
    </div>
  );
}

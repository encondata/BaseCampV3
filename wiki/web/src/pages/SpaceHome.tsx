/** /s/:spaceKey — the space's home page (a normal page flagged by
 *  `home_node_id`, shown through NodePage) and "What's in this space": the
 *  space's top-level items. */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { ApiError } from '@portal/lib/api';

import WatchButton from '../components/WatchButton';
import { useWikiShell } from '../layout/shellContext';
import { useChildren } from '../lib/treeStore';
import type { SpaceOut } from '../lib/types';
import { errorMessage, getSpace } from '../lib/wikiApi';
import { ContentsList } from './FolderView';
import NodePage from './NodePage';
import NotFound from './NotFound';

type State =
  | { key: string; status: 'ready'; space: SpaceOut }
  | { key: string; status: 'missing' }
  | { key: string; status: 'error'; message: string };

export default function SpaceHome() {
  const { spaceKey = '' } = useParams();
  const { setCurrentSpace, setCurrentNode } = useWikiShell();
  const [state, setState] = useState<State | null>(null);
  const shown = state?.key === spaceKey ? state : null;
  const space = shown?.status === 'ready' ? shown.space : null;
  const { nodes, error } = useChildren(space ? space.key : null, null);

  useEffect(() => {
    let live = true;
    getSpace(spaceKey)
      .then((s) => {
        if (!live) return;
        setState({ key: spaceKey, status: 'ready', space: s });
        setCurrentSpace(s);
        if (!s.home_node_id) setCurrentNode(null);
      })
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404) setState({ key: spaceKey, status: 'missing' });
        else setState({ key: spaceKey, status: 'error', message: errorMessage(err, 'Couldn\'t load this space.') });
      });
    return () => { live = false; };
  }, [spaceKey, setCurrentSpace, setCurrentNode]);

  if (!shown) return <div className="portal-page wiki-page"><p className="page-hint">Loading…</p></div>;
  if (shown.status === 'missing') return <NotFound what="space" />;
  if (shown.status === 'error') {
    return <div className="portal-page wiki-page"><p className="pf-error">{shown.message}</p></div>;
  }

  const items = nodes?.filter((n) => n.id !== shown.space.home_node_id) ?? null;
  return (
    <>
      {shown.space.home_node_id ? <NodePage nodeId={shown.space.home_node_id} /> : (
        <div className="portal-page wiki-page">
          <div className="dir-head">
            <div>
              <div className="eyebrow">Space</div>
              <h1 className="page-title">{shown.space.name}</h1>
              {shown.space.description && <p className="page-hint">{shown.space.description}</p>}
            </div>
            <WatchButton target={{ kind: 'space', spaceId: shown.space.id, spaceKey: shown.space.key }} />
          </div>
        </div>
      )}
      <section className="portal-page wiki-page wiki-space-contents" aria-label="What's in this space">
        <div className="wiki-section-label wiki-space-contents-head">
          What's in this space
          {shown.space.home_node_id && (
            <WatchButton target={{ kind: 'space', spaceId: shown.space.id, spaceKey: shown.space.key }} />
          )}
        </div>
        <ContentsList label="What's in this space" nodes={items} error={error}
                      emptyTitle="Nothing here yet" empty="Pages and folders added at the top of the space show up here." />
      </section>
    </>
  );
}

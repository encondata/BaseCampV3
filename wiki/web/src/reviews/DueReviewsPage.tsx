/** /library/:spaceKey/due — the space's pages whose periodic review is due within
 *  two weeks or overdue, soonest first, with their state, owner and when
 *  they were last reviewed. Linked from the space's settings, and from its
 *  home page while anything is due. */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ApiError } from '@portal/lib/api';
import { longDate } from '@portal/lib/format';

import NodeIcon from '../components/NodeIcon';
import { useWikiShell } from '../layout/shellContext';
import { libraryPath } from '../lib/paths';
import type { NodeOut, SpaceOut } from '../lib/types';
import { errorMessage, getSpace, listDueReviews } from '../lib/wikiApi';
import NotFound from '../pages/NotFound';
import ReviewChip from './ReviewChip';

const GRID = {
  gridTemplateColumns: 'minmax(240px, 3fr) minmax(170px, 1.3fr) minmax(130px, 1fr) minmax(120px, 1fr)',
};

type State =
  | { key: string; status: 'ready'; space: SpaceOut; nodes: NodeOut[] }
  | { key: string; status: 'missing' }
  | { key: string; status: 'error'; message: string };

export default function DueReviewsPage() {
  const { spaceKey = '' } = useParams();
  const { setCurrentSpace, setCurrentNode } = useWikiShell();
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([getSpace(spaceKey), listDueReviews(spaceKey)])
      .then(([space, nodes]) => {
        if (!live) return;
        setState({ key: spaceKey, status: 'ready', space, nodes });
        setCurrentSpace(space);
        setCurrentNode(null);
      })
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404) setState({ key: spaceKey, status: 'missing' });
        else setState({ key: spaceKey, status: 'error', message: errorMessage(err, 'Couldn\'t load the pages due for review.') });
      });
    return () => { live = false; };
  }, [spaceKey, setCurrentSpace, setCurrentNode]);

  const shown = state?.key === spaceKey ? state : null;
  if (!shown) return <div className="portal-page wiki-page"><p className="page-hint">Loading…</p></div>;
  if (shown.status === 'missing') return <NotFound what="library" />;
  if (shown.status === 'error') {
    return <div className="portal-page wiki-page"><p className="pf-error">{shown.message}</p></div>;
  }

  const { space, nodes } = shown;
  return (
    <div className="portal-page wiki-page" data-testid="due-reviews-page">
      <nav className="wiki-crumbs" aria-label="Breadcrumb"><Link to={libraryPath(space.key)}>{space.name}</Link></nav>
      <div className="dir-head wiki-folder-head">
        <div>
          <div className="eyebrow">Page reviews</div>
          <h1 className="page-title">Due for review</h1>
          <p className="page-hint">Pages to confirm are still right: overdue, or due within two weeks.</p>
        </div>
      </div>

      <div className="dir-list list-scroll wiki-due-list">
        <div className="list-head" style={GRID} aria-hidden="true">
          <span>Page</span><span>Review</span><span>Owner</span><span>Last reviewed</span>
        </div>
        <div role="list" aria-label="Due for review">
          {nodes.map((n) => (
            <div className="dir-row" role="listitem" key={n.id}>
              <div className="row-main" style={GRID}>
                <div className="cell cell-primary">
                  <NodeIcon node={n} className="wiki-row-icon" />
                  <div className="pn"><Link to={`/n/${n.id}`}><b title={n.title}>{n.title}</b></Link></div>
                </div>
                <div className="cell"><ReviewChip review={n.review} /></div>
                <div className="cell"><span className="cell-top cell-line">{n.owner?.name ?? '—'}</span></div>
                <div className="cell">
                  <span className="cell-top cell-line">
                    {n.review?.last_reviewed_at ? longDate(n.review.last_reviewed_at) : 'Never'}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
        {nodes.length === 0 && (
          <div className="dir-empty"><b>Nothing due for review</b>Every page with a review schedule is up to date.</div>
        )}
      </div>
    </div>
  );
}

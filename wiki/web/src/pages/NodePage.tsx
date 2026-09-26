/** /n/:nodeId (and a space's home page): loads the node, tells the shell
 *  what's showing, and hands it to the view for its kind — FolderView for
 *  folders; the page view (Task 12) and file view (Task 14) are
 *  placeholders until then. Refetches whenever the tree changes, so a
 *  rename or move anywhere shows up here. */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { ApiError } from '@portal/lib/api';

import { useWikiShell } from '../layout/shellContext';
import { useTreeRevision } from '../lib/treeStore';
import type { NodeDetailOut } from '../lib/types';
import { errorMessage, getNode } from '../lib/wikiApi';
import FolderView, { Breadcrumbs } from './FolderView';
import NotFound from './NotFound';

type State =
  | { id: string; status: 'ready'; node: NodeDetailOut }
  | { id: string; status: 'missing' }
  | { id: string; status: 'error'; message: string };

function Placeholder({ node, testId }: { node: NodeDetailOut; testId: string }) {
  return (
    <div className="portal-page wiki-page" data-testid={testId}>
      <Breadcrumbs node={node} />
      <div className="dir-head wiki-folder-head">
        <h1 className="page-title wiki-title">{node.title}</h1>
      </div>
    </div>
  );
}

export default function NodePage({ nodeId }: { nodeId?: string }) {
  const params = useParams();
  const id = nodeId ?? params.nodeId ?? '';
  const revision = useTreeRevision();
  const { setCurrentNode, setCurrentSpace } = useWikiShell();
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    let live = true;
    getNode(id)
      .then((node) => {
        if (!live) return;
        setState({ id, status: 'ready', node });
        setCurrentSpace(node.space);
        setCurrentNode(node);
      })
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404) setState({ id, status: 'missing' });
        else setState({ id, status: 'error', message: errorMessage(err, 'Couldn\'t load this item.') });
      });
    return () => { live = false; };
  }, [id, revision, setCurrentNode, setCurrentSpace]);

  // a refetch of the same node keeps showing the last copy meanwhile
  const shown = state?.id === id ? state : null;
  if (!shown) return <div className="portal-page wiki-page"><p className="page-hint">Loading…</p></div>;
  if (shown.status === 'missing') return <NotFound />;
  if (shown.status === 'error') {
    return <div className="portal-page wiki-page"><p className="pf-error">{shown.message}</p></div>;
  }
  const { node } = shown;
  if (node.kind === 'folder') return <FolderView node={node} />;
  if (node.kind === 'page') return <Placeholder node={node} testId="page-view" />;
  return <Placeholder node={node} testId="file-view" />;
}

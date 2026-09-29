/** /library/:spaceKey/trash — a space's trash (space managers): each deleted batch
 *  (what, how many items, who deleted it and when, when it's purged) with
 *  Restore (back to where it was, or the top of the space if that's gone)
 *  and Delete forever. */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ApiError } from '@portal/lib/api';
import { relativeTime } from '@portal/lib/format';
import { useToast } from '@portal/lib/notificationsContext';

import ConfirmDialog from '../components/ConfirmDialog';
import NodeIcon from '../components/NodeIcon';
import { atLeast } from '../components/RowMenu';
import { useWikiShell } from '../layout/shellContext';
import { libraryPath } from '../lib/paths';
import { noteCreated } from '../lib/treeStore';
import type { SpaceOut, TrashBatch } from '../lib/types';
import { errorMessage, getSpace, getSpaceTrash, purgeTrash, restoreTrash } from '../lib/wikiApi';
import NotFound from './NotFound';

const GRID = {
  gridTemplateColumns:
    'minmax(240px, 3fr) minmax(70px, 0.5fr) minmax(140px, 1.2fr) minmax(100px, 0.9fr) minmax(110px, 0.9fr) 236px',
};

type State =
  | { key: string; status: 'ready'; space: SpaceOut; batches: TrashBatch[] }
  | { key: string; status: 'forbidden'; space: SpaceOut | null }
  | { key: string; status: 'missing' }
  | { key: string; status: 'error'; message: string };

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export default function TrashPage() {
  const { spaceKey = '' } = useParams();
  const toast = useToast();
  const { setCurrentSpace, setCurrentNode } = useWikiShell();
  const [state, setState] = useState<State | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [purging, setPurging] = useState<{ batch: TrashBatch; busy: boolean; error: string } | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      let space: SpaceOut | null = null;
      try {
        space = await getSpace(spaceKey);
        if (!live) return;
        setCurrentSpace(space);
        setCurrentNode(null);
        const batches = await getSpaceTrash(spaceKey);
        if (live) setState({ key: spaceKey, status: 'ready', space, batches });
      } catch (err) {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404) setState({ key: spaceKey, status: 'missing' });
        else if (err instanceof ApiError && err.status === 403) setState({ key: spaceKey, status: 'forbidden', space });
        else setState({ key: spaceKey, status: 'error', message: errorMessage(err, 'Couldn\'t load the trash.') });
      }
    })();
    return () => { live = false; };
  }, [spaceKey, setCurrentSpace, setCurrentNode]);

  const shown = state?.key === spaceKey ? state : null;
  const drop = (batchId: string) => setState((cur) => (cur?.status === 'ready'
    ? { ...cur, batches: cur.batches.filter((b) => b.batch_id !== batchId) } : cur));

  const restore = async (batch: TrashBatch) => {
    setWorking(batch.batch_id);
    try {
      const node = await restoreTrash(batch.batch_id);
      noteCreated(node);
      drop(batch.batch_id);
      toast(`Restored “${batch.root.title}”.`);
    } catch (err) {
      toast(errorMessage(err, `Couldn't restore “${batch.root.title}”.`));
    } finally {
      setWorking(null);
    }
  };

  const purge = async () => {
    if (!purging) return;
    const { batch } = purging;
    setPurging({ batch, busy: true, error: '' });
    try {
      await purgeTrash(batch.batch_id);
      drop(batch.batch_id);
      setPurging(null);
      toast(`Deleted “${batch.root.title}” forever.`);
    } catch (err) {
      setPurging({ batch, busy: false, error: errorMessage(err, `Couldn't delete “${batch.root.title}”.`) });
    }
  };

  if (!shown) return <div className="portal-page wiki-page"><p className="page-hint">Loading…</p></div>;
  if (shown.status === 'missing') return <NotFound what="library" />;
  if (shown.status === 'error') {
    return <div className="portal-page wiki-page"><p className="pf-error">{shown.message}</p></div>;
  }

  const { space } = shown;
  const head = (
    <>
      {space && (
        <nav className="wiki-crumbs" aria-label="Breadcrumb">
          <Link to={libraryPath(space.key)}>{space.name}</Link>
          {atLeast(space.my_level, 'manage') && (
            <span className="wiki-crumb"><span className="wiki-crumb-sep" aria-hidden="true">/</span>
              <Link to={libraryPath(space.key, 'settings')}>Settings</Link></span>
          )}
        </nav>
      )}
      <div className="dir-head wiki-folder-head">
        <div>
          <div className="eyebrow">Trash</div>
          <h1 className="page-title">{space ? `${space.name} trash` : 'Trash'}</h1>
        </div>
      </div>
    </>
  );

  if (shown.status === 'forbidden') {
    return (
      <div className="portal-page wiki-page">
        {head}
        <p className="page-hint">Only library managers can see and restore what's in a library's trash.</p>
      </div>
    );
  }

  const { batches } = shown;
  const readOnly = !!shown.space.archived_at;
  return (
    <div className="portal-page wiki-page" data-testid="trash-page">
      {head}
      <p className="page-hint wiki-trash-hint">
        {readOnly
          ? 'This library is archived, so nothing here can be restored or deleted until it\'s unarchived.'
          : 'Deleted items stay here until their purge date, then they\'re removed for good.'}
      </p>
      <div className="dir-list list-scroll wiki-trash-list">
        <div className="list-head" style={GRID} aria-hidden="true">
          <span>What</span><span>Items</span><span>Deleted by</span><span>Deleted</span><span>Purged on</span><span />
        </div>
        <div role="list" aria-label="Deleted items">
          {batches.map((b) => (
            <div className="dir-row" role="listitem" key={b.batch_id}>
              <div className="row-main" style={GRID}>
                <div className="cell cell-primary">
                  <NodeIcon node={{ kind: b.root.kind, title: b.root.title, file: null }} className="wiki-row-icon" />
                  <div className="pn"><b title={b.root.title}>{b.root.title}</b></div>
                </div>
                <div className="cell"><span className="mono cell-line" title={plural(b.count, 'item')}>{b.count}</span></div>
                <div className="cell"><span className="cell-top cell-line">{b.deleted_by?.name ?? '—'}</span></div>
                <div className="cell">
                  <span className="cell-top cell-line" title={new Date(b.deleted_at).toLocaleString()}>
                    {relativeTime(b.deleted_at)}
                  </span>
                </div>
                <div className="cell">
                  <span className="cell-top cell-line">
                    {b.purge_at ? new Date(b.purge_at).toLocaleDateString() : '—'}
                  </span>
                </div>
                <div className="cell wiki-trash-actions">
                  <button type="button" className="btn-ghost" aria-label={`Restore ${b.root.title}`}
                          disabled={readOnly || working === b.batch_id} onClick={() => void restore(b)}>
                    {working === b.batch_id ? 'Restoring…' : 'Restore'}
                  </button>
                  <button type="button" className="btn-ghost wiki-danger" aria-label={`Delete ${b.root.title} forever`}
                          disabled={readOnly || working === b.batch_id}
                          onClick={() => setPurging({ batch: b, busy: false, error: '' })}>
                    Delete forever
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
        {batches.length === 0 && (
          <div className="dir-empty"><b>The trash is empty</b>Deleted pages, folders and files show up here.</div>
        )}
      </div>

      {purging && (
        <ConfirmDialog
          eyebrow="Trash"
          title={`Delete “${purging.batch.root.title}” forever?`}
          description={purging.batch.count > 1
            ? `This removes it and the ${purging.batch.count - 1} other items deleted with it for good. It can't be undone.`
            : 'This removes it for good. It can\'t be undone.'}
          confirmLabel="Delete forever"
          busyLabel="Deleting…"
          danger
          busy={purging.busy}
          error={purging.error}
          onConfirm={() => void purge()}
          onCancel={() => setPurging(null)}
        />
      )}
    </div>
  );
}

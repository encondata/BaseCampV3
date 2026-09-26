/** /admin/help-links — wiki administrators only (everyone else sees
 *  NotFound): which wiki page or file the portal's and kiosk's ? button
 *  opens on each screen. Add, edit, delete. `?context=` opens the add form
 *  with that context (the portal's "Link a guide"); `?node=` opens it with
 *  that guide (a page's "Use as help for…"). */
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { relativeTime } from '@portal/lib/format';
import { useToast } from '@portal/lib/notificationsContext';

import ConfirmDialog from '../components/ConfirmDialog';
import HelpLinkDialog, { type GuideRef } from '../components/HelpLinkDialog';
import { useWikiShell } from '../layout/shellContext';
import type { HelpLinkOut } from '../lib/types';
import { useWikiMe } from '../lib/useWikiMe';
import { deleteHelpLink, errorMessage, getNode, listHelpLinks } from '../lib/wikiApi';
import NotFound from './NotFound';

type State =
  | { status: 'loading' }
  | { status: 'ready'; links: HelpLinkOut[] }
  | { status: 'error'; message: string };

type Editing =
  | { mode: 'add'; context: string; guideId: string | null }
  | { mode: 'edit'; link: HelpLinkOut };

const GRID = {
  gridTemplateColumns: 'minmax(200px, 1.6fr) minmax(220px, 2fr) minmax(130px, 1fr) 150px',
};

const byContext = (a: HelpLinkOut, b: HelpLinkOut) => a.context.localeCompare(b.context);

export default function HelpLinksPage() {
  const toast = useToast();
  const me = useWikiMe();
  const { setCurrentNode } = useWikiShell();
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [editing, setEditing] = useState<Editing | null>(() => {
    const context = params.get('context');
    const guideId = params.get('node');
    return context || guideId ? { mode: 'add', context: context ?? '', guideId } : null;
  });
  const [initialGuide, setInitialGuide] = useState<GuideRef | null>(null);
  const [deleting, setDeleting] = useState<{ link: HelpLinkOut; busy: boolean; error: string } | null>(null);

  useEffect(() => { setCurrentNode(null); }, [setCurrentNode]);

  useEffect(() => {
    if (!me?.is_admin) return undefined;
    let live = true;
    listHelpLinks()
      .then((links) => { if (live) setState({ status: 'ready', links }); })
      .catch((err) => { if (live) setState({ status: 'error', message: errorMessage(err, 'Couldn\'t load the help links.') }); });
    return () => { live = false; };
  }, [me?.is_admin]);

  // "Use as help for…": the guide's title for the prefilled picker
  const guideId = editing?.mode === 'add' ? editing.guideId : null;
  useEffect(() => {
    if (!guideId || !me?.is_admin) return undefined;
    let live = true;
    getNode(guideId)
      .then((n) => { if (live) setInitialGuide({ id: n.id, title: n.title, kind: n.kind, space_name: n.space.name }); })
      .catch(() => { /* the picker stays empty; the admin searches instead */ });
    return () => { live = false; };
  }, [guideId, me?.is_admin]);

  const closeEditor = useCallback(() => {
    setEditing(null);
    setInitialGuide(null);
    // a reload shouldn't reopen a prefilled form
    if (params.has('context') || params.has('node')) setParams({}, { replace: true });
  }, [params, setParams]);

  if (!me) return <div className="portal-page wiki-page"><p className="page-hint">Loading…</p></div>;
  if (!me.is_admin) return <NotFound />;

  const saved = (link: HelpLinkOut) => {
    const adding = editing?.mode === 'add';
    setState((cur) => (cur.status === 'ready'
      ? { status: 'ready', links: [...cur.links.filter((l) => l.id !== link.id), link].sort(byContext) }
      : cur));
    toast(adding ? 'Help link added.' : 'Help link saved.');
    closeEditor();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const { link } = deleting;
    setDeleting({ link, busy: true, error: '' });
    try {
      await deleteHelpLink(link.id);
      setState((cur) => (cur.status === 'ready'
        ? { status: 'ready', links: cur.links.filter((l) => l.id !== link.id) }
        : cur));
      setDeleting(null);
      toast('Help link deleted.');
    } catch (err) {
      setDeleting({ link, busy: false, error: errorMessage(err, 'Couldn\'t delete the help link.') });
    }
  };

  return (
    <div className="portal-page wiki-page wiki-admin-page" data-testid="help-links-page">
      <div className="dir-head wiki-folder-head">
        <div>
          <div className="eyebrow"><Link to="/admin">Wiki admin</Link></div>
          <h1 className="page-title">Help links</h1>
          <p className="page-hint">
            The guide the ? button opens on each portal and kiosk screen. People only see guides they can view.
          </p>
        </div>
        <button type="button" className="btn-solid"
                onClick={() => setEditing({ mode: 'add', context: '', guideId: null })}>
          Add help link
        </button>
      </div>

      {state.status === 'loading' && <p className="page-hint">Loading…</p>}
      {state.status === 'error' && <p className="pf-error">{state.message}</p>}
      {state.status === 'ready' && (
        <div className="dir-list list-scroll wiki-admin-list">
          <div className="list-head" style={GRID} aria-hidden="true">
            <span>Context</span><span>Guide</span><span>Added</span><span />
          </div>
          <div role="list" aria-label="Help links">
            {state.links.map((l) => (
              <div className="dir-row" role="listitem" key={l.id}>
                <div className="row-main" style={GRID}>
                  <div className="cell cell-primary">
                    <span className="mono cell-line" title={l.context}>{l.context}</span>
                  </div>
                  <div className="cell">
                    <div className="pn">
                      <Link className="wiki-row-link" to={`/n/${l.node.id}`}><b title={l.node.title}>{l.node.title}</b></Link>
                      <span className="cell-sub cell-line">{l.node.space_name} · {l.node.kind === 'file' ? 'File' : 'Page'}</span>
                    </div>
                    {l.trashed && <span className="chip c-amber"><span className="dot" />In trash</span>}
                  </div>
                  <div className="cell">
                    <div className="pn">
                      <span className="cell-line">{relativeTime(l.created_at)}</span>
                      {l.created_by && <span className="cell-sub cell-line">{l.created_by.name}</span>}
                    </div>
                  </div>
                  <div className="cell wiki-admin-actions">
                    <button type="button" className="btn-ghost" onClick={() => setEditing({ mode: 'edit', link: l })}>
                      Edit
                    </button>
                    <button type="button" className="btn-ghost wiki-danger"
                            onClick={() => setDeleting({ link: l, busy: false, error: '' })}>
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {state.links.length === 0 && <div className="dir-empty"><b>No help links yet</b></div>}
        </div>
      )}

      {editing && (
        <HelpLinkDialog
          link={editing.mode === 'edit' ? editing.link : undefined}
          initialContext={editing.mode === 'add' ? editing.context : undefined}
          initialGuide={initialGuide}
          onSaved={saved}
          onClose={closeEditor}
        />
      )}
      {deleting && (
        <ConfirmDialog
          eyebrow="Help links"
          title="Delete this help link?"
          description={<>The ? button on <span className="mono">{deleting.link.context}</span> stops opening “{deleting.link.node.title}”.</>}
          confirmLabel="Delete link"
          busyLabel="Deleting…"
          danger
          busy={deleting.busy}
          error={deleting.error}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

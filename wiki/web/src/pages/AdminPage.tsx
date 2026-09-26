/** /admin — wiki administrators only (everyone else sees NotFound, same as
 *  any page they can't view): every space, including archived ones (which
 *  never show up in the ordinary space list), with a link to each space's
 *  settings and trash, and Unarchive — the one thing only a wiki admin,
 *  not even a space manager, can do. Below, the way to the portal/kiosk
 *  Help links page, the way to Analytics, and every public share link in
 *  the wiki (newest first), with Revoke. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { longDate, relativeTime } from '@portal/lib/format';
import { useToast } from '@portal/lib/notificationsContext';

import { SpaceBadge } from '../components/NodeIcon';
import { useWikiShell } from '../layout/shellContext';
import type { ShareLinkOut, ShareLinkStatus, SpaceOut } from '../lib/types';
import { useWikiMe } from '../lib/useWikiMe';
import {
  errorMessage, listAllShareLinks, listSpaces, revokeShareLink, unarchiveSpace,
} from '../lib/wikiApi';
import NotFound from './NotFound';

type State =
  | { status: 'loading' }
  | { status: 'ready'; spaces: SpaceOut[] }
  | { status: 'error'; message: string };

const GRID = {
  gridTemplateColumns: 'minmax(220px, 2.6fr) minmax(120px, 1fr) minmax(110px, 0.9fr) 210px',
};

const LINK_GRID = {
  gridTemplateColumns: 'minmax(220px, 2.4fr) minmax(96px, 0.8fr) minmax(150px, 1.2fr) minmax(120px, 1fr) 72px 110px',
};

/** The API's cap on GET /wiki/share-links (newest first). */
export const ADMIN_LINKS_CAP = 500;

const STATUS_CHIP: Record<ShareLinkStatus, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'c-green' },
  expired: { label: 'Expired', tone: 'c-amber' },
  revoked: { label: 'Revoked', tone: 'c-slate' },
};

type LinksState =
  | { status: 'loading' }
  | { status: 'ready'; links: ShareLinkOut[] }
  | { status: 'error'; message: string };

function PublicLinksSection() {
  const toast = useToast();
  const [state, setState] = useState<LinksState>({ status: 'loading' });
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listAllShareLinks()
      .then((links) => { if (live) setState({ status: 'ready', links }); })
      .catch((err) => {
        if (live) setState({ status: 'error', message: errorMessage(err, 'Couldn\'t load the public links.') });
      });
    return () => { live = false; };
  }, []);

  const revoke = async (link: ShareLinkOut) => {
    setRevoking(link.id);
    try {
      await revokeShareLink(link.id);
      const revokedAt = new Date().toISOString();
      setState((cur) => (cur.status === 'ready'
        ? { status: 'ready', links: cur.links.map((l) => (l.id === link.id ? { ...l, status: 'revoked', revoked_at: revokedAt } : l)) }
        : cur));
      toast('Link revoked. It stops working right away.');
    } catch (err) {
      toast(errorMessage(err, 'Couldn\'t revoke the link.'));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="wiki-admin-section" aria-label="Public links">
      <div className="dir-head wiki-folder-head">
        <div>
          <h2 className="wiki-section-title">Public links</h2>
          <p className="page-hint">Links anyone can open without signing in. A space can turn them off in its settings.</p>
        </div>
      </div>
      {state.status === 'loading' && <p className="page-hint">Loading…</p>}
      {state.status === 'error' && <p className="pf-error">{state.message}</p>}
      {state.status === 'ready' && (
        <div className="dir-list list-scroll wiki-admin-list">
          <div className="list-head" style={LINK_GRID} aria-hidden="true">
            <span>Shared item</span><span>Status</span><span>Created</span><span>Expires</span><span>Views</span><span />
          </div>
          <div role="list" aria-label="Public links">
            {state.links.map((l) => {
              const chip = STATUS_CHIP[l.status];
              return (
                <div className="dir-row" role="listitem" key={l.id}>
                  <div className="row-main" style={LINK_GRID}>
                    <div className="cell cell-primary">
                      <div className="pn">
                        <Link className="wiki-row-link" to={`/n/${l.node.id}`}><b title={l.node.title}>{l.node.title}</b></Link>
                        <span className="cell-sub cell-line">{l.node.space_name} · {l.node.kind === 'file' ? 'File' : 'Page'}</span>
                      </div>
                    </div>
                    <div className="cell"><span className={`chip ${chip.tone}`}><span className="dot" />{chip.label}</span></div>
                    <div className="cell">
                      <div className="pn">
                        <span className="cell-line">{relativeTime(l.created_at)}</span>
                        {l.created_by && <span className="cell-sub cell-line">{l.created_by.name}</span>}
                      </div>
                    </div>
                    <div className="cell"><span className="cell-line">{l.expires_at ? longDate(l.expires_at) : 'Never'}</span></div>
                    <div className="cell"><span className="cell-line">{l.view_count}</span></div>
                    <div className="cell wiki-admin-actions">
                      {l.status !== 'revoked' && (
                        <button type="button" className="btn-ghost wiki-danger" disabled={revoking === l.id}
                                onClick={() => void revoke(l)}>
                          {revoking === l.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {state.links.length === 0 && <div className="dir-empty"><b>No public links yet</b></div>}
        </div>
      )}
      {state.status === 'ready' && state.links.length >= ADMIN_LINKS_CAP && (
        <p className="page-hint">Showing the newest {ADMIN_LINKS_CAP} links.</p>
      )}
    </section>
  );
}

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

      <section className="wiki-admin-section" aria-label="Help links">
        <div className="dir-head wiki-folder-head">
          <div>
            <h2 className="wiki-section-title">Help links</h2>
            <p className="page-hint">Which guide the ? button opens on each portal screen.</p>
          </div>
          <Link className="btn-ghost" to="/admin/help-links">Manage help links</Link>
        </div>
      </section>

      <section className="wiki-admin-section" aria-label="Analytics">
        <div className="dir-head wiki-folder-head">
          <div>
            <h2 className="wiki-section-title">Analytics</h2>
            <p className="page-hint">What people read, whether it helped, searches that found nothing, and pages that need attention.</p>
          </div>
          <Link className="btn-ghost" to="/analytics">Open analytics</Link>
        </div>
      </section>

      <PublicLinksSection />
    </div>
  );
}

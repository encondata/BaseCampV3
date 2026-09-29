/** Share… on a page or file (manage level): public links anyone can open
 *  without signing in. Create one with an expiry (1, 7, 30 or 90 days, or
 *  never); its URL is shown once, to copy — the wiki never shows it again.
 *  Below, the node's links that still exist (active or expired), each with
 *  its expiry, views and Revoke. Where the space has public links turned
 *  off, a hint replaces the create row (with a link to the space's
 *  settings for someone who manages the space); existing links stay
 *  listed so they can still be revoked. In the modal header pattern,
 *  sized to its content. */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import ComboBox from '@portal/components/ComboBox';
import { longDate, relativeTime } from '@portal/lib/format';
import { useToast } from '@portal/lib/notificationsContext';

import { libraryPath } from '../lib/paths';
import { spaceSetting } from '../lib/spaceSettings';
import type { NodeOut, ShareExpiryDays, ShareLinkOut, SpaceOut } from '../lib/types';
import {
  createShareLink, errorMessage, getSpace, listShareLinks, revokeShareLink,
} from '../lib/wikiApi';
import { atLeast } from './RowMenu';

const EXPIRY_OPTIONS: { value: string; label: string }[] = [
  { value: '1', label: 'In 1 day' },
  { value: '7', label: 'In 7 days' },
  { value: '30', label: 'In 30 days' },
  { value: '90', label: 'In 90 days' },
  { value: 'never', label: 'Never' },
];

const expiryDays = (value: string): ShareExpiryDays | null =>
  (value === 'never' ? null : Number(value) as ShareExpiryDays);

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; space: SpaceOut; links: ShareLinkOut[] }
  | { status: 'error'; message: string };

function copy(text: string, toast: (m: string) => void) {
  const done = () => toast('Link copied.');
  const failed = () => toast('Couldn’t copy the link. Select it and copy it yourself.');
  try {
    navigator.clipboard.writeText(text).then(done, failed);
  } catch {
    failed();
  }
}

function LinkRow({ link, busy, onRevoke }: { link: ShareLinkOut; busy: boolean; onRevoke: () => void }) {
  const expired = link.status === 'expired';
  const views = `${link.view_count} ${link.view_count === 1 ? 'view' : 'views'}`;
  return (
    <div className="wiki-share-row" role="listitem">
      <div className="wiki-share-row-text">
        <b>
          {expired ? <span className="chip c-amber"><span className="dot" />Expired</span>
            : link.expires_at ? `Expires ${longDate(link.expires_at)}` : 'Never expires'}
        </b>
        <span className="cell-sub">
          Created {relativeTime(link.created_at)}{link.created_by ? ` by ${link.created_by.name}` : ''}
          {' · '}<span>{views}</span>
          {link.last_viewed_at ? ` · last opened ${relativeTime(link.last_viewed_at)}` : ''}
        </span>
      </div>
      <button type="button" className="btn-ghost wiki-danger" disabled={busy} onClick={onRevoke}>
        {busy ? 'Revoking…' : 'Revoke'}
      </button>
    </div>
  );
}

export default function ShareDialog({ node, onClose }: { node: NodeOut; onClose: () => void }) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [expiry, setExpiry] = useState('30');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const reloadLinks = useCallback(async () => {
    const links = await listShareLinks(node.id);
    setLoaded((cur) => (cur.status === 'ready' ? { ...cur, links } : cur));
  }, [node.id]);

  useEffect(() => {
    let live = true;
    Promise.all([getSpace(node.space_key), listShareLinks(node.id)])
      .then(([space, links]) => { if (live) setLoaded({ status: 'ready', space, links }); })
      .catch((err) => {
        if (live) setLoaded({ status: 'error', message: errorMessage(err, 'Couldn’t load this item’s links.') });
      });
    return () => { live = false; };
  }, [node.id, node.space_key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !creating) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [creating, onClose]);

  const create = async () => {
    setCreating(true);
    setCreateError('');
    try {
      const out = await createShareLink(node.id, expiryDays(expiry));
      setCreated(out.url);
      await reloadLinks().catch(() => {});
    } catch (err) {
      setCreateError(errorMessage(err, 'Couldn’t create the link. Try again.'));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (link: ShareLinkOut) => {
    setRevoking(link.id);
    try {
      await revokeShareLink(link.id);
      toast('Link revoked. It stops working right away.');
      await reloadLinks().catch(() => {});
    } catch (err) {
      toast(errorMessage(err, 'Couldn’t revoke the link.'));
    } finally {
      setRevoking(null);
    }
  };

  const noun = node.kind === 'file' ? 'file' : 'page';
  const neverPublished = node.kind === 'page' && !node.page?.published_version_id;

  let body;
  if (loaded.status === 'loading') {
    body = <div className="modal-body"><p className="page-hint">Loading…</p></div>;
  } else if (loaded.status === 'error') {
    body = <div className="modal-body"><p className="pf-error">{loaded.message}</p></div>;
  } else {
    const allowed = spaceSetting(loaded.space, 'allow_public_links');
    const shown = loaded.links.filter((l) => l.status !== 'revoked');
    body = (
      <div className="modal-body wiki-share-body">
        {allowed ? (
          <>
            {neverPublished && (
              <p className="page-hint">
                Only the published version is shared, and this page hasn’t been published yet — a link won’t open until it is.
              </p>
            )}
            <div className="wiki-share-create">
              <div className="wiki-share-expiry">
                <label htmlFor="wiki-share-expiry">Link expires</label>
                <ComboBox inputId="wiki-share-expiry" options={EXPIRY_OPTIONS} value={expiry} portal
                          disabled={creating} ariaLabel="Link expires" onChange={setExpiry} />
              </div>
              <button type="button" className="btn-solid" disabled={creating} onClick={() => void create()}>
                {creating ? 'Creating…' : 'Create link'}
              </button>
            </div>
            {createError && <p className="pf-error">{createError}</p>}
            {created && (
              <div className="wiki-share-created">
                <div className="wiki-share-url">
                  <input readOnly value={created} aria-label="New public link" className="mono"
                         onFocus={(e) => e.currentTarget.select()} />
                  <button type="button" className="btn-solid" onClick={() => copy(created, toast)}>Copy</button>
                </div>
                <p className="wiki-field-note">Copy it now — this link won’t be shown again.</p>
              </div>
            )}
          </>
        ) : (
          <p className="page-hint wiki-share-off">
            <span>Public links are turned off for this library.</span>
            {' '}
            {atLeast(loaded.space.my_level, 'manage') ? (
              <Link to={libraryPath(loaded.space.key, 'settings')} onClick={onClose}>Library settings</Link>
            ) : <span>Ask a library manager to turn them on.</span>}
          </p>
        )}

        {loaded.space.archived_at && allowed && (
          <p className="page-hint">
            This library is archived: its public links keep working until a wiki administrator revokes them on
            the <Link to="/admin" onClick={onClose}>Admin page</Link>.
          </p>
        )}

        <div className="modal-section">Links</div>
        {shown.length === 0 ? (
          <p className="page-hint">No public links to this {noun}.</p>
        ) : (
          <div className="wiki-share-list" role="list" aria-label="Public links">
            {shown.map((l) => (
              <LinkRow key={l.id} link={l} busy={revoking === l.id} onRevoke={() => void revoke(l)} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !creating) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card wiki-dialog-card wiki-share-card" role="dialog"
           aria-modal="true" aria-labelledby="wiki-share-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Share</div>
            <h3 id="wiki-share-title">Share “{node.title}” publicly</h3>
            <p className="page-hint">
              Anyone with a link can view the {node.kind === 'page' ? 'published page' : 'file'} without signing in.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={creating}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        {body}
        <div className="modal-foot">
          <button type="button" className="mini-btn" onClick={onClose} disabled={creating}>Done</button>
        </div>
      </div>
    </div>
  );
}

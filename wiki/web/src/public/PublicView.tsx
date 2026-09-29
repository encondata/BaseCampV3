/** /p/:token — a page or file someone shared with a public link, shown to
 *  anyone, signed in or not: a slim "Shared from ServerSherpa Wiki"
 *  header and the content, nothing else. It makes exactly one request,
 *  `GET /wiki/public/{token}` (`getPublicShare`), without credentials.
 *
 *  A page renders through ReadOnlyDoc in public mode: its images and
 *  embedded files use the URLs that came with it, and links into the rest
 *  of the wiki arrive as plain text. A file shows its preview only when
 *  the API serves it inline (never active content), with a Download. The
 *  page asks search engines not to index it and sends no referrer.
 *
 *  The presigned URLs in the response live `url_ttl_seconds`; past
 *  STALE_FRACTION of that they count as stale. Fresh URLs come from a
 *  re-read (`?refresh=1`, not counted as a view):
 *    - when an image or video fails to load — once per set of URLs, and a
 *      set that itself came from such a retry gets another only once it's
 *      stale (so a file that's really gone can't loop, and a later expiry
 *      still recovers);
 *    - before a Download, or reopening an embedded preview, once stale
 *      (an iframe can't report a 403: it just shows the error page).
 *  A re-read that's refused or fails keeps the content on screen with a
 *  small notice; only a fresh share or a gone link (404) replaces it. */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useParams } from 'react-router-dom';

import { longDate } from '@portal/lib/format';

import { fileType } from '../components/NodeIcon';
import ReadOnlyDoc from '../editor/ReadOnlyDoc';
import type { PublicShareHooks } from '../editor/nodeViews';
import { openDownload } from '../lib/download';
import { getPublicShare, PublicShareError } from '../lib/publicApi';
import type { PublicFileOut, PublicShareOut } from '../lib/types';
import { formatSize } from '../pages/FolderView';

type Ready = {
  token: string;
  status: 'ready';
  share: PublicShareOut;
  fetchedAt: number;
  /** These URLs came from a re-read after a load error. */
  viaErrorRetry: boolean;
};
type State = Ready | { token: string; status: 'missing' | 'limited' | 'error' };

/** The share of a URL's lifetime after which it's treated as stale. */
export const STALE_FRACTION = 0.8;

const isStaleAt = (s: Ready, now: number) => now - s.fetchedAt >= s.share.url_ttl_seconds * 1000 * STALE_FRACTION;

async function readShare(token: string, { refresh = false, viaErrorRetry = false } = {}): Promise<State> {
  try {
    const share = await getPublicShare(token, { refresh });
    return { token, status: 'ready', share, fetchedAt: Date.now(), viaErrorRetry };
  } catch (err) {
    const status = err instanceof PublicShareError ? err.status : 0;
    return { token, status: status === 404 ? 'missing' : status === 429 ? 'limited' : 'error' };
  }
}

const TYPE_LABEL = {
  pdf: 'PDF', image: 'Image', video: 'Video', doc: 'Document', sheet: 'Spreadsheet',
  slides: 'Presentation', other: 'File',
} as const;

/** For as long as the view is open: keep crawlers off the shared link,
 *  and never send it (the token) as a referrer. */
function usePrivacyMeta() {
  useEffect(() => {
    const metas = [['robots', 'noindex, nofollow'], ['referrer', 'no-referrer']].map(([name, content]) => {
      const meta = document.createElement('meta');
      meta.name = name;
      meta.content = content;
      document.head.appendChild(meta);
      return meta;
    });
    return () => { metas.forEach((m) => m.remove()); };
  }, []);
}

function FilePreview({ file, onError }: { file: PublicFileOut; onError: () => void }) {
  if (!file.inline) return <p className="page-hint wiki-public-nopreview">No preview — download to open</p>;
  const type = fileType(file.content_type, file.filename);
  const name = file.filename;
  if (type === 'image') return <img className="wiki-fileview-img" src={file.url} alt={name} onError={onError} />;
  if (type === 'video') {
    return <video className="wiki-fileview-media" src={file.url} controls preload="metadata" onError={onError} />;
  }
  if (file.content_type.toLowerCase().startsWith('audio/')) {
    return <audio src={file.url} controls preload="metadata" onError={onError} />;
  }
  // a PDF, or text the API serves as text/plain
  return <iframe className="wiki-fileview-frame" src={file.url} title={`Preview of ${name}`} />;
}

function Notice({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="wiki-public-notice">
      <h1 className="page-title">{title}</h1>
      <p className="page-hint">{hint}</p>
    </div>
  );
}

export default function PublicView() {
  const { token = '' } = useParams();
  const [state, setState] = useState<State | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  // one re-read at a time: several images failing together share it
  const inFlight = useRef<Promise<State> | null>(null);
  usePrivacyMeta();

  useEffect(() => {
    let live = true;
    setRefreshNote(null);
    void readShare(token).then((next) => { if (live) setState(next); });
    return () => { live = false; };
  }, [token]);

  const refresh = useCallback((viaErrorRetry: boolean): Promise<State> => {
    if (inFlight.current) return inFlight.current;
    const pending = readShare(token, { refresh: true, viaErrorRetry }).then((next) => {
      inFlight.current = null;
      if (next.status === 'ready' || next.status === 'missing') {
        setState(next);
        setRefreshNote(null);
      } else {
        setRefreshNote(next.status === 'limited'
          ? 'Couldn’t refresh this page’s files: too many requests. Try again in a minute.'
          : 'Couldn’t refresh this page’s files. Check your connection and try again.');
      }
      return next;
    });
    inFlight.current = pending;
    return pending;
  }, [token]);

  const isStale = useCallback(() => {
    const s = stateRef.current;
    return s?.status === 'ready' && isStaleAt(s, Date.now());
  }, []);

  const onMediaError = useCallback(() => {
    const s = stateRef.current;
    if (s?.status !== 'ready') return;
    if (s.viaErrorRetry && !isStaleAt(s, Date.now())) return;
    void refresh(true);
  }, [refresh]);

  const publicHooks = useMemo<PublicShareHooks>(() => ({
    onAssetError: onMediaError,
    isStale,
    refresh: async () => {
      const next = await refresh(false);
      return next.status === 'ready' && next.share.kind === 'page' ? next.share.asset_urls : null;
    },
  }), [onMediaError, isStale, refresh]);

  const shown = state?.token === token ? state : null;
  const share = shown?.status === 'ready' ? shown.share : null;
  const title = share?.title ?? null;
  useEffect(() => {
    document.title = title ? `${title} · ServerSherpa Wiki` : 'ServerSherpa Wiki';
  }, [title]);

  let body;
  if (!shown) {
    body = <p className="page-hint">Loading…</p>;
  } else if (shown.status === 'missing') {
    body = (
      <Notice title="This link isn’t available"
              hint="It may have expired or been turned off. Ask whoever shared it for a new link." />
    );
  } else if (shown.status === 'limited') {
    body = <Notice title="Too many requests" hint="Wait a minute, then reload the page." />;
  } else if (shown.status === 'error') {
    body = <Notice title="Couldn’t load this page" hint="Check your connection and try again." />;
  } else if (share?.kind === 'page') {
    const page = share;
    body = (
      <article className="wiki-public-page">
        <h1 className="page-title">{page.title}</h1>
        <p className="page-hint">Published {longDate(page.published_at)}</p>
        <ReadOnlyDoc content={page.content_json} publicAssets={page.asset_urls} publicHooks={publicHooks} />
      </article>
    );
  } else if (share) {
    const file = share;
    const download = (e: MouseEvent<HTMLAnchorElement>) => {
      if (!isStale()) return;
      e.preventDefault();
      void refresh(false).then((next) => {
        if (next.status === 'ready' && next.share.kind === 'file') openDownload(next.share.download_url);
      });
    };
    body = (
      <article className="wiki-public-page wiki-public-file">
        <div className="wiki-public-file-head">
          <div>
            <h1 className="page-title">{file.title}</h1>
            <p className="page-hint">
              {TYPE_LABEL[fileType(file.content_type, file.filename)]} · {formatSize(file.size_bytes)}
            </p>
          </div>
          <a className="btn-solid" href={file.download_url} rel="noopener noreferrer" onClick={download}>Download</a>
        </div>
        <div className="wiki-public-preview"><FilePreview file={file} onError={onMediaError} /></div>
      </article>
    );
  }

  return (
    <div className="portal-shell wiki-root wiki-public">
      <header className="wiki-public-head">
        <span className="wiki-public-brand">Shared from ServerSherpa Wiki</span>
      </header>
      <main className="wiki-public-main">
        {refreshNote && <p className="wiki-public-refresh-note" role="status">{refreshNote}</p>}
        {body}
      </main>
    </div>
  );
}

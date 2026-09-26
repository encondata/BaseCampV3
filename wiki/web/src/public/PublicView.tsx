/** /p/:token — a page or file someone shared with a public link, shown to
 *  anyone, signed in or not: a slim "Shared from ServerSherpa Wiki"
 *  header and the content, nothing else. It makes exactly one request,
 *  `GET /wiki/public/{token}` (`getPublicShare`), without credentials.
 *
 *  A page renders through ReadOnlyDoc in public mode: its images and
 *  embedded files use the URLs that came with it, and links into the rest
 *  of the wiki arrive as plain text. A file shows its preview only when
 *  the API serves it inline (never active content), with a Download. The
 *  page asks search engines not to index it. */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { longDate } from '@portal/lib/format';

import { fileType } from '../components/NodeIcon';
import ReadOnlyDoc from '../editor/ReadOnlyDoc';
import { getPublicShare, PublicShareError } from '../lib/publicApi';
import type { PublicFileOut, PublicShareOut } from '../lib/types';
import { formatSize } from '../pages/FolderView';

type State =
  | { token: string; status: 'ready'; share: PublicShareOut }
  | { token: string; status: 'missing' | 'limited' | 'error' };

const TYPE_LABEL = {
  pdf: 'PDF', image: 'Image', video: 'Video', doc: 'Document', sheet: 'Spreadsheet',
  slides: 'Presentation', other: 'File',
} as const;

/** Keeps crawlers off a shared link for as long as the view is open. */
function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, []);
}

function FilePreview({ file }: { file: PublicFileOut }) {
  if (!file.inline) return <p className="page-hint wiki-public-nopreview">No preview — download to open</p>;
  const type = fileType(file.content_type, file.filename);
  const name = file.filename;
  if (type === 'image') return <img className="wiki-fileview-img" src={file.url} alt={name} />;
  if (type === 'video') return <video className="wiki-fileview-media" src={file.url} controls preload="metadata" />;
  if (file.content_type.toLowerCase().startsWith('audio/')) {
    return <audio src={file.url} controls preload="metadata" />;
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
  useNoIndex();

  useEffect(() => {
    let live = true;
    getPublicShare(token)
      .then((share) => { if (live) setState({ token, status: 'ready', share }); })
      .catch((err: unknown) => {
        if (!live) return;
        const status = err instanceof PublicShareError ? err.status : 0;
        setState({ token, status: status === 404 ? 'missing' : status === 429 ? 'limited' : 'error' });
      });
    return () => { live = false; };
  }, [token]);

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
        <ReadOnlyDoc content={page.content_json} publicAssets={page.asset_urls} />
      </article>
    );
  } else if (share) {
    const file = share;
    body = (
      <article className="wiki-public-page wiki-public-file">
        <div className="wiki-public-file-head">
          <div>
            <h1 className="page-title">{file.title}</h1>
            <p className="page-hint">
              {TYPE_LABEL[fileType(file.content_type, file.filename)]} · {formatSize(file.size_bytes)}
            </p>
          </div>
          <a className="btn-solid" href={file.download_url} rel="noopener noreferrer">Download</a>
        </div>
        <div className="wiki-public-preview"><FilePreview file={file} /></div>
      </article>
    );
  }

  return (
    <div className="portal-shell wiki-root wiki-public">
      <header className="wiki-public-head">
        <span className="wiki-public-brand">Shared from ServerSherpa Wiki</span>
      </header>
      <main className="wiki-public-main">{body}</main>
    </div>
  );
}

/** Where an export stands, for the person who asked for it: checked every
 *  EXPORT_POLL_MS while it's queued or running, then a Download button
 *  once it's done (which asks for a fresh link on every click — a link
 *  only lives ten minutes), or why it failed. Shared by the Export dialog
 *  and the `/exports/:jobId` page an inbox notification opens. */
import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '@portal/lib/api';

import { openDownload } from '../lib/download';
import type { ExportOut } from '../lib/types';
import { errorMessage, getExport } from '../lib/wikiApi';

export const EXPORT_POLL_MS = 2000;

const GONE = 'This export isn’t available. Exports are kept for 7 days, and only the person who asked for one can download it.';

type State =
  | { status: 'loading' }
  | { status: 'ready'; job: ExportOut; error: string }
  | { status: 'gone' };

export default function ExportProgress({ jobId }: { jobId: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const job = await getExport(jobId);
        if (!live) return;
        setState({ status: 'ready', job, error: '' });
        if (job.status === 'queued' || job.status === 'running') timer = setTimeout(check, EXPORT_POLL_MS);
      } catch (err) {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404) {
          setState({ status: 'gone' });
          return;
        }
        // a blip: say so, and keep checking
        setState((cur) => (cur.status === 'ready'
          ? { ...cur, error: errorMessage(err, 'Couldn’t check on the export. Still trying…') }
          : cur));
        timer = setTimeout(check, EXPORT_POLL_MS);
      }
    };
    void check();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [jobId]);

  const download = useCallback(async () => {
    setDownloading(true);
    setDownloadError('');
    try {
      const job = await getExport(jobId);
      if (job.url) openDownload(job.url);
      else setDownloadError('The download isn’t ready. Try again in a moment.');
    } catch (err) {
      setDownloadError(errorMessage(err, 'Couldn’t get the download. Try again.'));
    } finally {
      setDownloading(false);
    }
  }, [jobId]);

  if (state.status === 'loading') return <p className="page-hint">Checking on the export…</p>;
  if (state.status === 'gone') return <p className="page-hint">{GONE}</p>;

  const { job, error } = state;
  return (
    <div className="wiki-export-progress" aria-live="polite">
      {(job.status === 'queued' || job.status === 'running') && (
        <>
          <div className="wiki-export-status">
            <span className="wiki-export-spinner" aria-hidden="true" />
            <b>Preparing “{job.filename}”…</b>
          </div>
          <p className="page-hint">
            A big folder or space can take a few minutes. You can close this — you’ll get a notification when it’s ready.
          </p>
        </>
      )}
      {job.status === 'done' && (
        <div className="wiki-export-done">
          <div className="wiki-export-status"><b>“{job.filename}” is ready.</b></div>
          <button type="button" className="btn-solid" disabled={downloading} onClick={() => void download()}>
            {downloading ? 'Getting the link…' : 'Download'}
          </button>
        </div>
      )}
      {job.status === 'failed' && (
        <p className="pf-error">{job.error ?? 'The export couldn’t be finished. Try again.'}</p>
      )}
      {error && <p className="pf-error">{error}</p>}
      {downloadError && <p className="pf-error">{downloadError}</p>}
    </div>
  );
}

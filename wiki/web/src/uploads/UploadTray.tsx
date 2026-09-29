/** The bottom-right upload tray: every upload in the queue with its
 *  progress and where it's going, Cancel while it's waiting or sending,
 *  Retry / Dismiss after a failure, and "Clear finished". Hidden while the
 *  queue is empty; collapsible to its header. */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { cancel, clearDone, dismiss, retry, useUploads, type UploadItem } from './uploadQueue';

function statusText(item: UploadItem): string {
  switch (item.status) {
    case 'queued': return 'Waiting…';
    case 'uploading': return `${Math.round(item.progress * 100)}%`;
    case 'completing': return 'Finishing…';
    case 'done': return 'Done';
    default: return item.error ?? 'Failed.';
  }
}

function Row({ item }: { item: UploadItem }) {
  const name = item.file.name;
  const busy = item.status === 'uploading' || item.status === 'completing';
  return (
    <li className={`wiki-tray-item is-${item.status}`} aria-label={name}>
      <div className="wiki-tray-line">
        <span className="wiki-tray-name">
          {item.status === 'done' && item.result
            ? <Link to={`/n/${item.result.id}`} title={name}>{name}</Link>
            : <span title={name}>{name}</span>}
        </span>
        <span className="wiki-tray-actions">
          {(item.status === 'queued' || item.status === 'uploading') && (
            <button type="button" className="mini-btn" aria-label={`Cancel ${name}`} onClick={() => cancel(item.id)}>
              Cancel
            </button>
          )}
          {item.status === 'error' && (
            <>
              <button type="button" className="mini-btn" aria-label={`Retry ${name}`} onClick={() => retry(item.id)}>
                Retry
              </button>
              <button type="button" className="mini-btn" aria-label={`Dismiss ${name}`} onClick={() => dismiss(item.id)}>
                Dismiss
              </button>
            </>
          )}
        </span>
      </div>
      <div className="wiki-tray-meta">
        <span className="wiki-tray-dest">to {item.target.label}</span>
        <span className={`wiki-tray-status${item.status === 'error' ? ' pf-error' : ''}`}>{statusText(item)}</span>
      </div>
      {busy && (
        <div className="wiki-upload-bar wiki-tray-bar" role="progressbar" aria-label={`Uploading ${name}`}
             aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}>
          <span style={{ width: `${Math.round(item.progress * 100)}%` }} />
        </div>
      )}
    </li>
  );
}

export default function UploadTray() {
  const items = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  if (!items.length) return null;

  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'error').length;
  const active = items.length - done - failed;
  const title = active ? `Uploading ${active} ${active === 1 ? 'file' : 'files'}` : 'Uploads';

  return (
    <section className="wiki-tray" role="region" aria-label="Uploads">
      <header className="wiki-tray-head">
        <div className="wiki-tray-title">
          <b>{title}</b>
          <span>{`${done} of ${items.length} done`}{failed ? ` · ${failed} failed` : ''}</span>
        </div>
        {done > 0 && (
          <button type="button" className="mini-btn" onClick={clearDone}>Clear finished</button>
        )}
        <button type="button" className="wiki-icon-btn wiki-tray-toggle"
                aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'} aria-expanded={!collapsed}
                onClick={() => setCollapsed((c) => !c)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
               strokeLinejoin="round" aria-hidden="true"><path d={collapsed ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg>
        </button>
      </header>
      {!collapsed && (
        <ul className="wiki-tray-list">
          {items.map((item) => <Row key={item.id} item={item} />)}
        </ul>
      )}
    </section>
  );
}

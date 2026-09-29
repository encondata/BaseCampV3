/** /n/:nodeId/history — a page's versions, newest first: published ones
 *  emphasized, autosaves folded into one collapsed group per day. Picking
 *  a version previews it read-only; "Compare with…" picks a second one and
 *  shows the block diff between them (older → newer). Editors can restore
 *  a version: after a confirmation the page opens in the editor with
 *  `?restore=<id>`, and the editor puts that version's content into the
 *  live document (see PageView). Viewers only ever get published versions,
 *  and no Restore. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import ComboBox from '@portal/components/ComboBox';
import { ApiError } from '@portal/lib/api';
import { relativeTime } from '@portal/lib/format';

import ConfirmDialog from '../components/ConfirmDialog';
import { atLeast } from '../components/RowMenu';
import { Icon } from '../editor/icons';
import ReadOnlyDoc from '../editor/ReadOnlyDoc';
import { useWikiShell } from '../layout/shellContext';
import type { NodeDetailOut, VersionDetail, VersionKind, VersionOut } from '../lib/types';
import { errorMessage, getNode, getVersion, listVersions } from '../lib/wikiApi';
import { Breadcrumbs } from '../pages/FolderView';
import NotFound from '../pages/NotFound';
import { diffDocs } from './diff';
import DiffView from './DiffView';

const KIND_LABEL: Record<VersionKind, string> = {
  published: 'Published', autosave: 'Autosave', restored: 'Restored', imported: 'Imported',
  submitted: 'Submitted for review',
};
const KIND_CHIP: Partial<Record<VersionKind, string>> = {
  published: 'c-green', restored: 'c-amber', imported: 'c-blue',
};

type Item =
  | { type: 'version'; version: VersionOut }
  | { type: 'autosaves'; key: string; day: string; versions: VersionOut[] };

const dayKey = (iso: string) => new Date(iso).toDateString();
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Newest first; each day's run of autosaves becomes one group. */
export function groupVersions(versions: VersionOut[]): Item[] {
  const items: Item[] = [];
  for (const v of versions) {
    const last = items.at(-1);
    if (v.kind === 'autosave') {
      if (last?.type === 'autosaves' && last.day === dayKey(v.created_at)) {
        last.versions.push(v);
      } else {
        items.push({ type: 'autosaves', key: `auto-${v.id}`, day: dayKey(v.created_at), versions: [v] });
      }
    } else {
      items.push({ type: 'version', version: v });
    }
  }
  return items;
}

function VersionRow({ v, selected, onSelect }: { v: VersionOut; selected: boolean; onSelect: () => void }) {
  const chip = KIND_CHIP[v.kind];
  return (
    <button type="button" className={`wiki-version${selected ? ' on' : ''}${v.kind === 'published' ? ' published' : ''}`}
            aria-pressed={selected} onClick={onSelect}>
      <span className="wiki-version-top">
        <b>Version {v.version_no}</b>
        {v.kind !== 'autosave' && (
          <span className={`chip${chip ? ` ${chip}` : ''}`}><span className="dot" />{KIND_LABEL[v.kind]}</span>
        )}
      </span>
      <span className="wiki-version-meta" title={new Date(v.created_at).toLocaleString()}>
        {[v.created_by?.name, relativeTime(v.created_at)].filter(Boolean).join(' · ')}
      </span>
      {v.note && <span className="wiki-version-note">{v.note}</span>}
    </button>
  );
}

type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string };

/** Versions' content by id (ids are unique across pages), each fetched once. */
function useVersions(pageId: string, ids: string[]) {
  const [cache, setCache] = useState<Record<string, Loaded<VersionDetail>>>({});
  const requested = useRef(new Set<string>());
  const key = ids.join(',');
  useEffect(() => {
    for (const id of key ? key.split(',') : []) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      setCache((cur) => ({ ...cur, [id]: { status: 'loading' } }));
      getVersion(pageId, id)
        .then((value) => setCache((cur) => ({ ...cur, [id]: { status: 'ready', value } })))
        .catch((err) => {
          requested.current.delete(id);   // picking it again retries
          setCache((cur) => ({
            ...cur, [id]: { status: 'error', message: errorMessage(err, 'Couldn\'t load this version.') },
          }));
        });
    }
  }, [pageId, key]);
  return cache;
}

export default function HistoryPage() {
  const { nodeId = '' } = useParams();
  const navigate = useNavigate();
  const { setCurrentNode, setCurrentSpace } = useWikiShell();
  const [node, setNode] = useState<Loaded<NodeDetailOut> | { status: 'missing' }>({ status: 'loading' });
  const [versions, setVersions] = useState<Loaded<VersionOut[]>>({ status: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState('');
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let live = true;
    setNode({ status: 'loading' });
    setVersions({ status: 'loading' });
    setSelectedId(null);
    setCompareId('');
    getNode(nodeId)
      .then((n) => {
        if (!live) return;
        setNode({ status: 'ready', value: n });
        setCurrentSpace(n.space);
        setCurrentNode(n);
      })
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404) setNode({ status: 'missing' });
        else setNode({ status: 'error', message: errorMessage(err, 'Couldn\'t load this page.') });
      });
    listVersions(nodeId)
      .then((list) => {
        if (!live) return;
        setVersions({ status: 'ready', value: list });
        // the newest version that isn't an autosave (those start folded away)
        setSelectedId((cur) => cur ?? (list.find((v) => v.kind !== 'autosave') ?? list[0])?.id ?? null);
      })
      .catch((err) => {
        if (live) setVersions({ status: 'error', message: errorMessage(err, 'Couldn\'t load the versions.') });
      });
    return () => { live = false; };
  }, [nodeId, setCurrentNode, setCurrentSpace]);

  const list = versions.status === 'ready' ? versions.value : [];
  const items = useMemo(() => groupVersions(list), [list]);
  const byId = useMemo(() => new Map(list.map((v) => [v.id, v])), [list]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const compared = compareId ? byId.get(compareId) ?? null : null;
  const contents = useVersions(nodeId, [selected?.id, compared?.id].filter((x): x is string => !!x));

  const diff = useMemo(() => {
    if (!selected || !compared) return null;
    const [older, newer] = selected.version_no < compared.version_no ? [selected, compared] : [compared, selected];
    const a = contents[older.id];
    const b = contents[newer.id];
    if (a?.status !== 'ready' || b?.status !== 'ready') return { older, newer, blocks: null };
    return { older, newer, blocks: diffDocs(a.value.content_json, b.value.content_json) };
  }, [selected, compared, contents]);

  if (node.status === 'missing') return <NotFound />;
  if (node.status === 'error') {
    return <div className="portal-page wiki-page"><p className="pf-error">{node.message}</p></div>;
  }
  if (node.status === 'loading') return <div className="portal-page wiki-page"><p className="page-hint">Loading…</p></div>;
  const page = node.value;
  if (page.kind !== 'page') return <NotFound />;
  const canRestore = atLeast(page.my_level, 'edit');

  const select = (id: string) => {
    setSelectedId(id);
    if (id === compareId) setCompareId('');
  };
  const toggleGroup = (key: string) => setOpenGroups((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const compareOptions = list.filter((v) => v.id !== selected?.id).map((v) => ({
    value: v.id,
    label: `Version ${v.version_no}`,
    sub: `${KIND_LABEL[v.kind]} · ${new Date(v.created_at).toLocaleString()}`,
  }));

  const shownContent = selected ? contents[selected.id] : undefined;

  return (
    <div className="portal-page wiki-page wiki-history-page" data-testid="history-page">
      <Breadcrumbs node={page} />
      <header className="wiki-page-head">
        <div className="wiki-page-head-main">
          <div className="eyebrow">History</div>
          <h1 className="page-title wiki-title"><span>{page.title}</span></h1>
        </div>
        <div className="wiki-page-actions">
          <Link className="btn-ghost" to={`/n/${page.id}`}>Back to the page</Link>
        </div>
      </header>

      {versions.status === 'loading' && <p className="page-hint">Loading…</p>}
      {versions.status === 'error' && <p className="pf-error">{versions.message}</p>}
      {versions.status === 'ready' && list.length === 0 && (
        <div className="wiki-empty-page">
          <Icon name="history" className="wiki-empty-icon" />
          <b>No versions yet</b>
          <span>{canRestore ? 'Versions are saved as the page is edited and each time it\'s published.'
            : 'Versions show up here once the page is published.'}</span>
        </div>
      )}

      {list.length > 0 && (
        <div className="wiki-history">
          <aside className="wiki-history-list">
            <ul aria-label="Versions">
              {items.map((it) => {
                if (it.type === 'version') {
                  return (
                    <li key={it.version.id}>
                      <VersionRow v={it.version} selected={it.version.id === selectedId}
                                  onSelect={() => select(it.version.id)} />
                    </li>
                  );
                }
                const open = openGroups.has(it.key);
                const n = it.versions.length;
                return (
                  <li key={it.key} className="wiki-version-group">
                    <button type="button" className="wiki-version-group-btn" aria-expanded={open}
                            onClick={() => toggleGroup(it.key)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                      {n} {n === 1 ? 'autosave' : 'autosaves'} · {dayLabel(it.versions[0].created_at)}
                    </button>
                    {open && (
                      <ul>
                        {it.versions.map((v) => (
                          <li key={v.id}>
                            <VersionRow v={v} selected={v.id === selectedId} onSelect={() => select(v.id)} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </aside>

          <section className="wiki-history-view" aria-label="Version">
            {selected && (
              <div className="wiki-history-bar">
                <div className="wiki-history-title">
                  <b>Version {selected.version_no}</b>
                  <span>{KIND_LABEL[selected.kind]} · {new Date(selected.created_at).toLocaleString()}</span>
                </div>
                <div className="wiki-history-compare">
                  <ComboBox options={compareOptions} value={compareId} onChange={setCompareId}
                            placeholder="Compare with…" ariaLabel="Compare with" clearable portal />
                </div>
                {canRestore && (
                  <button type="button" className="btn-solid" onClick={() => setConfirming(true)}>
                    Restore this version
                  </button>
                )}
              </div>
            )}

            {diff ? (
              diff.blocks
                ? <DiffView blocks={diff.blocks} from={`version ${diff.older.version_no}`} to={`version ${diff.newer.version_no}`} />
                : <p className="page-hint">Loading…</p>
            ) : (
              <>
                {shownContent?.status === 'loading' && <p className="page-hint">Loading…</p>}
                {shownContent?.status === 'error' && <p className="pf-error">{shownContent.message}</p>}
                {shownContent?.status === 'ready' && (
                  <div className="wiki-history-preview"><ReadOnlyDoc content={shownContent.value.content_json} /></div>
                )}
              </>
            )}
          </section>
        </div>
      )}

      {confirming && selected && (
        <ConfirmDialog
          eyebrow="Restore"
          title={`Restore version ${selected.version_no}?`}
          description="Its content replaces the live draft for everyone editing, and is saved as a new version. Readers keep the published version until you publish."
          confirmLabel="Restore"
          onConfirm={() => {
            setConfirming(false);
            navigate(`/n/${page.id}?edit=1&restore=${encodeURIComponent(selected.id)}`);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

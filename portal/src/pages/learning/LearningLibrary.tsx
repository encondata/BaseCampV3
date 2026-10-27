/**
 * /learning/library — every learning document as a standard house list:
 * title, version, published date, the packets it is in, how many sign-offs it
 * has, and a chip per translation language colored by status. Search, column
 * menus and the columns picker like the other lists. New document (a wiki
 * page from the Learning space plus a title) needs learning:add and opens the
 * new document's page.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '../../auth/AuthContext';
import NewDocumentModal from '../../components/learning/NewDocumentModal';
import { useLearningAccess } from '../../components/learning/useLearningAccess';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters, usePersistentListState,
} from '../../lib/columnMenu';
import {
  languageName, listLearningDocuments, type LearningDocumentListItem,
} from '../../lib/learning';
import { shortDate, TRANSLATION_STATUS } from '../../lib/learningDoc';
import {
  applyColumnOrder, ColHead, ColumnsButton, listGridStyle, listScale, moveKey, titleFor,
  useReorderDrag, useSearchHaystacks, visibleColumnsFor, type ColumnDef,
} from '../../lib/listTools';
import { useToast } from '../../lib/notificationsContext';
import { naturalCompare } from '../../lib/sites';
import { VirtualRows } from '../../lib/virtualRows';
import '../../styles/directory.css';
import '../../styles/learning.css';

export const LIBRARY_COLUMNS: ColumnDef[] = [
  { key: 'title', label: 'Document', width: '2fr', default: true, min: 180 },
  { key: 'version', label: 'Version', short: 'Ver.', width: '1fr', default: true, min: 110 },
  { key: 'published', label: 'Published', width: '1fr', default: true, min: 120 },
  { key: 'packets', label: 'Packets', width: '1.6fr', default: true, min: 160 },
  { key: 'signoffs', label: 'Sign-offs', short: 'Signed', width: '0.8fr', default: true, min: 90 },
  { key: 'translations', label: 'Translations', short: 'Lang.', width: '1.4fr', default: true, min: 150 },
];
const ALL_KEYS = new Set(LIBRARY_COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set(LIBRARY_COLUMNS.filter((c) => c.default).map((c) => c.key));

const versionText = (d: LearningDocumentListItem) =>
  (d.current_version_no === null ? 'Not published' : `v${d.current_version_no}`);

function cellText(d: LearningDocumentListItem, key: string): string {
  switch (key) {
    case 'title': return d.title;
    case 'version': return versionText(d);
    case 'published': return d.published_at ? shortDate(d.published_at) : '';
    case 'packets': return d.packets.join(', ');
    case 'signoffs': return String(d.signoff_count);
    case 'translations':
      return Object.entries(d.languages)
        .map(([l, s]) => `${l.toUpperCase()} ${TRANSLATION_STATUS[s].label}`).join(', ');
    default: return '';
  }
}

/** What a column sorts by: dates and counts by value, the rest as text. */
function sortValue(d: LearningDocumentListItem, key: string): string | number {
  if (key === 'published') return d.published_at ?? '';
  if (key === 'signoffs') return d.signoff_count;
  if (key === 'version') return d.current_version_no ?? 0;
  return cellText(d, key);
}

function compare(a: string | number, b: string | number): number {
  return typeof a === 'number' && typeof b === 'number' ? a - b : naturalCompare(String(a), String(b));
}

export default function LearningLibrary() {
  const { preferences } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const canAdd = useLearningAccess()('add');
  const listGridScale = listScale(preferences?.list_size);

  const [docs, setDocs] = useState<LearningDocumentListItem[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setError('');
    listLearningDocuments()
      .then(setDocs)
      .catch(() => { setError('Couldn’t load the library.'); setDocs((d) => d ?? []); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const {
    visibleCols, setVisibleCols, sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters, colOrder, setColOrder,
  } = usePersistentListState(
    'learning_library', { visible: DEFAULT_VISIBLE, sortKey: 'title', sortDir: 1 }, ALL_KEYS,
  );

  const orderedCols = applyColumnOrder(LIBRARY_COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const haystack = useSearchHaystacks(docs, (d: LearningDocumentListItem) =>
    LIBRARY_COLUMNS.map((c) => cellText(d, c.key)).join(' ').toLowerCase());

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (docs ?? [])
      .filter((d) => passesColumnFilters(d, filters, cellText) && (!q || haystack(d).includes(q)))
      .sort((a, b) => compare(sortValue(a, sortKey), sortValue(b, sortKey)) * sortDir);
  }, [docs, filters, query, sortKey, sortDir, haystack]);

  const grid = listGridStyle(shownCols, [], undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  const cellFor = (d: LearningDocumentListItem, key: string) => {
    switch (key) {
      case 'title':
        return (
          <Link className="cell-top cell-line" to={`/learning/library/${d.id}`} title={titleFor(d.title)}>
            {d.title}
          </Link>
        );
      case 'version':
        return d.current_version_no === null
          ? <span className="chip c-slate">Not published</span>
          : <span className="cell-top cell-line">v{d.current_version_no}</span>;
      case 'published': {
        const text = d.published_at ? shortDate(d.published_at) : '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'packets': {
        const text = d.packets.length ? d.packets.join(', ') : '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'signoffs':
        return <span className="cell-top cell-line">{d.signoff_count.toLocaleString()}</span>;
      case 'translations': {
        const entries = Object.entries(d.languages);
        if (entries.length === 0) return <span className="cell-top cell-line">—</span>;
        return (
          <div className="chips">
            {entries.map(([lang, status]) => (
              <span key={lang} className={`chip ${TRANSLATION_STATUS[status].cls}`}
                    title={`${languageName(lang)}: ${TRANSLATION_STATUS[status].label}`}>
                {lang.toUpperCase()}
              </span>
            ))}
          </div>
        );
      }
      default: return null;
    }
  };

  const failed = error !== '' && (docs ?? []).length === 0;

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Learning</div>
          <h1 className="page-title">
            Library
            {docs !== null && <span className="badge-count">{docs.length}</span>}
          </h1>
          <p className="page-hint">
            Documents workers read and sign. Each one is a page in the Learning space of the wiki,
            with its own sign-off rules.
          </p>
        </div>
        {canAdd && (
          <button type="button" className="btn-solid" onClick={() => setCreating(true)}>New document</button>
        )}
      </div>

      {failed && (
        <div className="dir-empty" role="alert">
          <b>{error}</b>
          <div className="audit-more">
            <button type="button" className="mini-btn" onClick={load}>Try again</button>
          </div>
        </div>
      )}
      {docs === null && <p className="page-hint">Loading…</p>}

      {docs !== null && !failed && (
        <>
          <div className="dir-toolbar">
            <div className="toolbar-right">
              <div className="dir-search" style={{ marginLeft: 0 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                <input placeholder="Search documents…" value={query}
                       onChange={(e) => setQuery(e.target.value)} />
              </div>
              <span className="result-count">{visible.length} of {docs.length} shown</span>
              <FilterSummaryChip filters={filters} onClear={clearFilters} />
              <ColumnsButton columns={orderedCols} visible={visibleCols}
                             onChange={setVisibleCols} onReorder={setColOrder} />
            </div>
          </div>

          <div className="dir-list list-scroll">
            <div className="list-head" style={rowStyle}>
              {shownCols.map((c) => (
                <ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
                         onToggleSort={() => toggleSort(c.key)}
                         className={headerDrag.dropClass(c.key)}
                         dragProps={headerDrag.dragProps(c.key)}>
                  <ColumnMenu colKey={c.key} label={c.label}
                              allRows={docs} filters={filters} text={cellText}
                              filter={filters[c.key]} onFilter={setFilter}
                              sortDir={sortKey === c.key ? sortDir : null}
                              onSort={(dir) => setSort(c.key, dir)} />
                </ColHead>
              ))}
            </div>

            {docs.length === 0 && (
              <div className="dir-empty">
                <b>No documents yet</b>
                {canAdd ? 'Create one from a page in the Learning space of the wiki.' : 'Documents appear here once a manager adds them.'}
              </div>
            )}
            {docs.length > 0 && visible.length === 0 && (
              <div className="dir-empty">
                <b>No matches</b>Try a different search or filter.
                <EmptyClearFilters filters={filters} onClear={clearFilters} />
              </div>
            )}

            <VirtualRows rows={visible}
              renderRow={(d, vp) => (
                <div key={d.id} className="dir-row" {...vp}
                     style={{ ...vp?.style, minWidth: rowStyle.minWidth } as CSSProperties}>
                  <div className="row-main" style={rowStyle}>
                    {shownCols.map((c) => (
                      <div className="cell" key={c.key}>{cellFor(d, c.key)}</div>
                    ))}
                  </div>
                </div>
              )} />
          </div>
        </>
      )}

      {creating && (
        <NewDocumentModal onClose={() => setCreating(false)}
                          onCreated={(doc) => {
                            setCreating(false);
                            toast(`Created ${doc.title ?? 'the document'}`);
                            navigate(`/learning/library/${doc.id}`);
                          }} />
      )}
    </div>
  );
}

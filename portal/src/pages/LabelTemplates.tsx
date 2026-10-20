/** Label Templates — the template list as a tree (spec §3.4, §4.1, §4.9).
 *  Standalone page (own .portal-page/.dir-head) on the shared
 *  directory-list pattern: search + toolbar FilterButton facets + per-column
 *  ColumnMenu filters + persisted visible/sort/order state + CSV export +
 *  virtualized rows.
 *
 *  Each top-level template is a row: a builder parent, which opens onto
 *  its DPI children (current and kept "Old" ones, nested, in the API's
 *  natural name order), or an older single row with nothing under it.
 *  Search, facets, column filters and sort act on the top-level rows; a
 *  search that matches a child's name opens its parent. Which parents are
 *  open is remembered in localStorage. The DPI column reads "All" when a
 *  parent has 203, 300 and 600, else the DPIs it has; a child's state
 *  chips say From parent, Customized, Out of date (parent vN) or, for an
 *  Old child, Kept · inactive.
 *
 *  Row menus (rank 80 and up, on top of labels:*; below that the list is
 *  read-only — no menus, no New template):
 *   - a parent: Edit design, Versions…, Clone to new template…, Sites…,
 *     Add DPI… (a DPI missing), Replace… (older active rows of its family
 *     and type), Activate/Deactivate, Delete… (typed name);
 *   - a child: Edit this DPI only, Update from parent… (customized only),
 *     Versions…, Test print… (the child in the builder), Delete this DPI…
 *     — never on or off: a child follows its parent;
 *   - an older single row: Edit as raw ZPL (a code row, or a schema 1
 *     design converted first), Activate/Deactivate, Delete… (typed name).
 *  Activate goes through POST …/activate; a refusal because another
 *  active template prints the same family, type and DPI opens Replace…
 *  for a parent. Versions' Open shows that version in the builder (the
 *  detail rides the navigation state as `openVersion`). */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import {
  ApiError, activateLabelTemplate, convertLabelTemplate, deleteLabelTemplate, listLabelTemplateTree,
  listLabelVocab, listSites, templateVersionLabel,
  type LabelTemplate, type LabelTemplateChild, type LabelTemplateTreeNode, type LabelVocab, type SiteItem,
} from '../lib/api';
import { SUPER_ADMIN_RANK } from '../lib/access';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState, type CellText,
} from '../lib/columnMenu';
import {
  childStateChips, isTreeParent, keptChildName, missingDpis, replaceCandidates, siteNames, sitesCellText,
  templateDpiText, templateSearchText, vocabLabel, vocabOfKind, type StateChip,
} from '../lib/labels';
import {
  ACTIONS_TRACK, ColHead, ColumnsButton, ExportButton, FilterButton, applyColumnOrder, exportCsv,
  listGridStyle, listScale, moveKey, passesFacets, titleFor, useReorderDrag,
  useSearchHaystacks, visibleColumnsFor, type ColumnDef, type FacetGroup, type FacetState,
} from '../lib/listTools';
import { compareValues } from '../lib/naturalSort';
import { VirtualRows, type VirtualRowProps } from '../lib/virtualRows';
import { CloneModal } from '../components/labels/builder/BuilderDialogs';
import VersionsModal from '../components/labels/builder/VersionsModal';
import DeleteTemplateModal from '../components/labels/DeleteTemplateModal';
import ReplaceTemplateModal from '../components/labels/ReplaceTemplateModal';
import { AddDpiModal, SitesModal, UpdateFromParentModal } from '../components/labels/TemplateRowDialogs';
import { RowActionsMenu, type RowAction } from '../components/hardware/RowActionsMenu';
import '../styles/directory.css';
import '../styles/labels.css';

// Fit: default columns + trailing ≤ LIST_FIT.page
// (1172px — .portal-page at a 1512px window, nav expanded).
const COLUMNS: ColumnDef[] = [
  // the toggle (or its spacer) and a child's indent ride in the name cell
  { key: 'name', label: 'Name', width: '2.6fr', default: true, min: 200 },
  { key: 'label_type', label: 'Type', width: '1fr', default: true, min: 120 },
  { key: 'size_key', label: 'Size', width: '0.7fr', default: true },
  { key: 'dpi', label: 'DPI', width: '0.7fr', default: true, min: 84 },
  { key: 'version', label: 'Version', short: 'Ver', width: '0.5fr', default: true, min: 60 },
  // a customized child's two chips wrap to a second line (labels.css .lt-chips)
  { key: 'state', label: 'State', width: '1.8fr', default: true, min: 150 },
  { key: 'sites', label: 'Sites', width: '0.8fr', default: true },
  { key: 'updated_at', label: 'Updated', width: '0.8fr', default: true, min: 96 },
  { key: 'language_key', label: 'Language', width: '0.8fr', default: false },
  { key: 'kind', label: 'Kind', width: '0.8fr', default: false },
  { key: 'description', label: 'Description', width: '1.6fr', default: false },
];

const ALL_COLUMN_KEYS = new Set<string>(COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

/** Which parents are open: their ids, in localStorage. A convenience,
 *  never load-bearing — a blocked or garbled store reads as none open. */
const OPEN_KEY = 'labels.templates.open';

function readOpen(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeOpen(ids: ReadonlySet<string>): void {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...ids])); } catch { /* ignore */ }
}

/** The generic fallback template carries a chip (api kiosk_templates FALLBACK_NAME). */
const FALLBACK_FAMILY = 'generic rack and ru';

const kindLabel = (kind: LabelTemplate['kind']) => (kind === 'design' ? 'Builder' : 'Raw code');
const activeLabel = (active: boolean) => (active ? 'Active' : 'Inactive');
const rawLabel = (t: LabelTemplate) => (t.language_key === 'zpl' ? 'Edit as raw ZPL' : 'Edit as raw code');

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? `Request failed (${err.code}).` : "Couldn't complete that action.";

const updatedText = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
};

/** One line of the list: a top-level template, or a DPI child under its
 *  (open) parent. */
type Line =
  | { kind: 'top'; node: LabelTemplateTreeNode; open: boolean; byQuery: boolean }
  | { kind: 'child'; child: LabelTemplateChild; parent: LabelTemplateTreeNode };

type Dialog =
  | { kind: 'versions'; template: LabelTemplate }
  | { kind: 'clone'; template: LabelTemplate }
  | { kind: 'sites'; template: LabelTemplate }
  | { kind: 'add-dpi'; node: LabelTemplateTreeNode }
  | { kind: 'replace'; node: LabelTemplateTreeNode }
  | { kind: 'update'; child: LabelTemplateChild; parent: LabelTemplateTreeNode }
  | { kind: 'delete'; template: LabelTemplate; dpiChildren: LabelTemplateChild[] };

export default function LabelTemplates() {
  const { can, maxRank, preferences } = useAuth();
  const navigate = useNavigate();
  // Designing, editing, versions, cloning, Replace… and delete need rank
  // 80 as well as the labels permission (spec §4.9); below that, read-only.
  const designer = maxRank >= SUPER_ADMIN_RANK;
  const canAdd = designer && can('labels', 'add');
  const canChange = designer && can('labels', 'change');
  const canDelete = designer && can('labels', 'delete');
  const listGridScale = listScale(preferences?.list_size);

  const [nodes, setNodes] = useState<LabelTemplateTreeNode[] | null>(null);
  const [vocab, setVocab] = useState<LabelVocab[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<FacetState>({});
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const [openIds, setOpenIds] = useState<Set<string>>(readOpen);
  const toggleOpen = (id: string) => setOpenIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  // Persisting is a side effect, kept out of the updater (StrictMode runs
  // updaters twice) and skipped on mount, which only records the set read.
  const writtenOpen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (writtenOpen.current === openIds) return;
    const firstSeen = writtenOpen.current === null;
    writtenOpen.current = openIds;
    if (!firstSeen) writeOpen(openIds);
  }, [openIds]);

  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'labels-template-tree', { visible: DEFAULT_VISIBLE, sortKey: 'name', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  const load = async () => {
    try {
      const [t, v, s] = await Promise.all([
        listLabelTemplateTree(), listLabelVocab(), listSites().catch(() => []),
      ]);
      setNodes(t);
      setVocab(v);
      setSites(s);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? "You don't have access to labels."
        : "Couldn't load label templates.");
    }
  };

  useEffect(() => { void load(); }, []);

  /** Close the dialog and re-read the tree. */
  const done = () => {
    setDialog(null);
    void load();
  };

  const cellText: CellText<LabelTemplateTreeNode> = (t, key) => {
    switch (key) {
      case 'label_type': return vocabLabel(vocab, 'type', t.label_type);
      case 'size_key': return vocabLabel(vocab, 'size', t.size_key);
      case 'language_key': return vocabLabel(vocab, 'language', t.language_key);
      case 'dpi': return templateDpiText(t);
      case 'kind': return kindLabel(t.kind);
      case 'version': return templateVersionLabel(t);
      case 'state': return activeLabel(t.is_active);
      case 'sites': return sitesCellText(t.site_ids, sites);
      case 'description': return t.description;
      case 'updated_at': return t.updated_at;
      default: return t.name;
    }
  };

  const sortValue = (t: LabelTemplateTreeNode, key: string): string | number => {
    if (key === 'version') return t.version;
    if (key === 'state') return t.is_active ? 1 : 0;
    return cellText(t, key).toLowerCase();
  };

  const CSV_COLUMNS: [string, (t: LabelTemplate) => string][] = [
    ['ID', (t) => t.id],
    ['Name', (t) => t.name],
    ['Parent', (t) => (t.parent_id ? nodes?.find((n) => n.id === t.parent_id)?.name ?? '' : '')],
    ['Type', (t) => vocabLabel(vocab, 'type', t.label_type)],
    ['Size', (t) => vocabLabel(vocab, 'size', t.size_key)],
    ['Language', (t) => vocabLabel(vocab, 'language', t.language_key)],
    ['DPI', (t) => (t.parent_id ? t.dpi_key : templateDpiText(t as LabelTemplateTreeNode))],
    ['Kind', (t) => kindLabel(t.kind)],
    ['Version', (t) => templateVersionLabel(t)],
    ['State', (t) => {
      if (!t.parent_id) return activeLabel(t.is_active);
      const parent = nodes?.find((n) => n.id === t.parent_id);
      return parent ? childStateChips(t as LabelTemplateChild, parent).map((c) => c.text).join('; ') : '';
    }],
    ['Sites', (t) => siteNames(t.site_ids, sites).join('; ')],
    ['Description', (t) => t.description],
    ['Updated', (t) => t.updated_at],
  ];

  const childNames = (t: LabelTemplateTreeNode) => t.children.map((c) => c.name).join(' ').toLowerCase();
  const searchText = (t: LabelTemplateTreeNode) =>
    `${templateSearchText(t)} ${siteNames(t.site_ids, sites).join(' ').toLowerCase()} ${childNames(t)}`;
  const haystack = useSearchHaystacks(nodes, searchText);

  const facetGroups = useMemo<FacetGroup[]>(() => [
    {
      key: 'label_type', title: 'Type',
      options: vocabOfKind(vocab, 'type').map((v) => ({ value: v.key, label: v.label })),
    },
    {
      key: 'size_key', title: 'Size',
      options: vocabOfKind(vocab, 'size').map((v) => ({ value: v.key, label: v.label })),
    },
    {
      key: 'language_key', title: 'Language',
      options: vocabOfKind(vocab, 'language').map((v) => ({ value: v.key, label: v.label })),
    },
    {
      key: 'kind', title: 'Kind',
      options: [{ value: 'design', label: 'Builder' }, { value: 'code', label: 'Raw code' }],
    },
    {
      key: 'is_active', title: 'Active',
      options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }],
    },
    {
      key: 'sites', title: 'Sites',
      options: [
        { value: '', label: 'All sites (global)' },
        ...Array.from(new Set((nodes ?? []).flatMap((t) => t.site_ids)))
          .map((id) => ({ value: id, label: siteNames([id], sites)[0] })),
      ],
    },
  ], [vocab, nodes, sites]);

  const facetValues = (t: LabelTemplate) => (groupKey: string): string[] => {
    if (groupKey === 'label_type') return [t.label_type];
    if (groupKey === 'size_key') return [t.size_key];
    if (groupKey === 'language_key') return [t.language_key];
    if (groupKey === 'kind') return [t.kind];
    if (groupKey === 'is_active') return [String(t.is_active)];
    if (groupKey === 'sites') return t.site_ids.length ? t.site_ids : [''];
    return [];
  };

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!nodes) return [];
    const rows = nodes.filter((t) => {
      if (!passesFacets(facets, facetValues(t))) return false;
      if (!passesColumnFilters(t, filters, cellText)) return false;
      if (!q) return true;
      return haystack(t).includes(q);
    });
    return rows.sort((a, b) => compareValues(sortValue(a, sortKey), sortValue(b, sortKey)) * sortDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, vocab, sites, facets, filters, q, sortKey, sortDir, haystack]);

  const lines = useMemo<Line[]>(() => visible.flatMap((node): Line[] => {
    // a search that finds one of its DPI versions holds the parent open
    const byQuery = !!q && node.children.some((c) => c.name.toLowerCase().includes(q));
    const open = node.children.length > 0 && (openIds.has(node.id) || byQuery);
    return [
      { kind: 'top', node, open, byQuery },
      ...(open ? node.children.map((child): Line => ({ kind: 'child', child, parent: node })) : []),
    ];
  }), [visible, openIds, q]);

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = listGridStyle(shownCols, [ACTIONS_TRACK], undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  // ── actions ────────────────────────────────────────────────────────

  const deactivate = async (t: LabelTemplate) => {
    const what = isTreeParent(t) ? `"${t.name}" and its DPI versions` : `"${t.name}"`;
    if (!window.confirm(`Deactivate ${what}?`)) return;
    setError('');
    try {
      await deleteLabelTemplate(t.id);
      await load();
    } catch (err) {
      setError(msgFor(err));
    }
  };

  const activate = async (node: LabelTemplateTreeNode) => {
    setError('');
    try {
      await activateLabelTemplate(node.id);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'active_conflict') {
        const candidates = replaceCandidates(node, nodes ?? []);
        if (isTreeParent(node) && candidates.length) {
          setDialog({ kind: 'replace', node });
          return;
        }
        const names = (err.detail as { names?: string[] } | undefined)?.names ?? [];
        setError(`Another active template already prints this family, type and DPI${
          names.length ? `: ${names.join(', ')}` : ''}. Turn it off first.`);
        return;
      }
      setError(msgFor(err));
    }
  };

  const convert = (t: LabelTemplate) => {
    if (!window.confirm('One-way: the draggable elements are discarded '
      + 'and this becomes a raw-code template. Continue?')) return;
    void convertLabelTemplate(t.id)
      .then(() => navigate(`/labels/templates/${t.id}/code`))
      .catch((err: unknown) => setError(msgFor(err)));
  };

  const edit = (t: LabelTemplate) => navigate(`/labels/templates/${t.id}/edit`);
  const versionsAction = (t: LabelTemplate): RowAction[] => (designer ? [{
    key: 'versions', label: 'Versions…', onSelect: () => setDialog({ kind: 'versions', template: t }),
  }] : []);
  const onOff = (node: LabelTemplateTreeNode): RowAction[] => {
    if (!canChange) return [];
    return node.is_active
      ? [{ key: 'deactivate', label: 'Deactivate', onSelect: () => void deactivate(node) }]
      : [{ key: 'activate', label: 'Activate', onSelect: () => void activate(node) }];
  };

  const parentActions = (node: LabelTemplateTreeNode): RowAction[] => [
    ...(canChange ? [{ key: 'edit', label: 'Edit design', onSelect: () => edit(node) }] : []),
    ...versionsAction(node),
    ...(canAdd ? [{
      key: 'clone', label: 'Clone to new template…', onSelect: () => setDialog({ kind: 'clone', template: node }),
    }] : []),
    ...(canChange ? [{
      key: 'sites', label: 'Sites…', onSelect: () => setDialog({ kind: 'sites', template: node }),
    }] : []),
    ...(canChange && missingDpis(node).length ? [{
      key: 'add-dpi', label: 'Add DPI…', onSelect: () => setDialog({ kind: 'add-dpi', node }),
    }] : []),
    ...(canChange && replaceCandidates(node, nodes ?? []).length ? [{
      key: 'replace', label: 'Replace…', onSelect: () => setDialog({ kind: 'replace', node }),
    }] : []),
    ...onOff(node),
    ...(canDelete ? [{
      key: 'delete', label: 'Delete…', destructive: true,
      onSelect: () => setDialog({ kind: 'delete', template: node, dpiChildren: node.children }),
    }] : []),
  ];

  const childActions = (child: LabelTemplateChild, parent: LabelTemplateTreeNode): RowAction[] => [
    ...(canChange ? [{ key: 'edit', label: 'Edit this DPI only', onSelect: () => edit(child) }] : []),
    ...(canChange && child.customized && !child.is_old ? [{
      key: 'update', label: 'Update from parent…', onSelect: () => setDialog({ kind: 'update', child, parent }),
    }] : []),
    ...versionsAction(child),
    // a test print happens in the builder, at this child's DPI (⌘P there)
    ...(canChange ? [{ key: 'print', label: 'Test print…', onSelect: () => edit(child) }] : []),
    ...(canDelete ? [{
      key: 'delete', label: 'Delete this DPI…', destructive: true,
      onSelect: () => setDialog({ kind: 'delete', template: child, dpiChildren: [] }),
    }] : []),
  ];

  const singleActions = (node: LabelTemplateTreeNode): RowAction[] => [
    ...(canChange && node.kind === 'code' ? [{
      key: 'code', label: rawLabel(node), onSelect: () => navigate(`/labels/templates/${node.id}/code`),
    }] : []),
    ...(canChange && node.kind === 'design' ? [{
      key: 'convert', label: rawLabel(node), onSelect: () => convert(node),
    }] : []),
    ...onOff(node),
    ...(canDelete ? [{
      key: 'delete', label: 'Delete…', destructive: true,
      onSelect: () => setDialog({ kind: 'delete', template: node, dpiChildren: [] }),
    }] : []),
  ];

  // ── cells ──────────────────────────────────────────────────────────

  const chips = (list: StateChip[]) => (
    <span className="lt-chips" title={list.map((c) => c.text).join(' · ')}>
      {list.map((c) => <span key={c.text} className={`chip ${c.color}`}>{c.text}</span>)}
    </span>
  );

  const line = (text: string, className = 'cell-line') => (
    <span className={className} title={titleFor(text)}>{text}</span>
  );

  const nameCell = (l: Line) => {
    if (l.kind === 'child') {
      return (
        <>
          <span className="tree-spacer" aria-hidden="true" />
          <span className="cell-top cell-line" title={l.child.name}>{l.child.name}</span>
        </>
      );
    }
    const { node, open, byQuery } = l;
    return (
      <>
        {node.children.length > 0 ? (
          // held open while the search matches one of its DPI versions
          <button type="button" className="tree-toggle" aria-expanded={open} disabled={byQuery}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
            title={byQuery ? 'Open while the search matches a DPI version' : undefined}
            onClick={(e) => { e.stopPropagation(); toggleOpen(node.id); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
              strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
            <span className="tree-count">{node.children.length}</span>
          </button>
        ) : (
          <span className="tree-spacer" aria-hidden="true" />
        )}
        <b className="cell-top cell-line" title={node.name}>{node.name}</b>
      </>
    );
  };

  const topCell = (t: LabelTemplateTreeNode, key: string) => {
    switch (key) {
      case 'label_type':
      case 'size_key':
      case 'language_key':
      case 'dpi':
        return <span className="chip tag" title={cellText(t, key)}>{cellText(t, key)}</span>;
      case 'version':
        return line(cellText(t, key), 'mono cell-line');
      case 'kind':
        return <span className={`chip ${t.kind === 'design' ? 'c-violet' : 'c-slate'}`}>{kindLabel(t.kind)}</span>;
      case 'state':
        return chips([
          { text: activeLabel(t.is_active), color: t.is_active ? 'c-green' : 'c-slate' },
          ...(t.family.toLowerCase() === FALLBACK_FAMILY ? [{ text: 'Fallback', color: 'tag' }] : []),
        ]);
      case 'sites':
        return line(sitesCellText(t.site_ids, sites), 'cell-sub cell-line');
      case 'description':
        return line(t.description || '—', 'cell-sub cell-line');
      case 'updated_at':
        return line(updatedText(t.updated_at), 'mono cell-line');
      default:
        return line(cellText(t, key));
    }
  };

  /** A child shows only what is its own: DPI, version, state, when. */
  const childCell = (c: LabelTemplateChild, parent: LabelTemplateTreeNode, key: string) => {
    switch (key) {
      case 'dpi': return <span className="chip tag">{c.dpi_key}</span>;
      case 'version': return line(templateVersionLabel(c), 'mono cell-line');
      case 'state': return chips(childStateChips(c, parent));
      case 'updated_at': return line(updatedText(c.updated_at), 'mono cell-line');
      default: return null;
    }
  };

  const keyOf = (l: Line) => (l.kind === 'top' ? l.node.id : l.child.id);

  const renderLine = (l: Line, vp?: VirtualRowProps) => {
    const isChild = l.kind === 'child';
    const actions = !designer ? []
      : l.kind === 'child' ? childActions(l.child, l.parent)
        : isTreeParent(l.node) ? parentActions(l.node) : singleActions(l.node);
    const className = ['dir-row', isChild ? 'lt-child' : '', isChild && l.child.is_old ? 'lt-old' : '']
      .filter(Boolean).join(' ');
    return (
      <div key={keyOf(l)} className={className} {...vp}
        style={{ ...vp?.style, '--depth': isChild ? 1 : 0, minWidth: rowStyle.minWidth } as CSSProperties}>
        <div className="row-main" style={rowStyle}
          onClick={l.kind === 'top' && l.node.children.length && !l.byQuery
            ? () => toggleOpen(l.node.id) : undefined}>
          {shownCols.map((c) => (
            <div className={c.key === 'name' ? 'cell cell-primary' : 'cell'} key={c.key}>
              {c.key === 'name' ? nameCell(l)
                : l.kind === 'child' ? childCell(l.child, l.parent, c.key) : topCell(l.node, c.key)}
            </div>
          ))}
          <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <RowActionsMenu actions={actions} />
          </div>
        </div>
      </div>
    );
  };

  // every name in the tree, for the "… Old" name Update from parent gives
  const allNames = useMemo(
    () => new Set((nodes ?? []).flatMap((n) => [n.name, ...n.children.map((c) => c.name)])), [nodes]);

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Labels</div>
          <h1 className="page-title">
            Templates
            <span className="badge-count">{nodes?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">Label templates and their DPI versions. Open a template to design it.</p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {nodes?.length ?? 0} shown</span>
          <FilterButton groups={facetGroups} state={facets} onChange={setFacets} />
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                         onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('label-templates', CSV_COLUMNS,
            visible.flatMap((n): LabelTemplate[] => [n, ...n.children]))} />
          {canAdd && (
            <button type="button" className="btn-solid" onClick={() => navigate('/labels/templates/new')}>
              + New template
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>{nodes ? "Couldn't complete that action" : 'Cannot load label templates'}</b>{error}
        </div>
      )}

      {nodes && (
        <div className="dir-list list-scroll">
          <div className="list-head" style={rowStyle}>
            {shownCols.map((c) => (
              <ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
                       onToggleSort={() => toggleSort(c.key)} className={headerDrag.dropClass(c.key)}
                       dragProps={headerDrag.dragProps(c.key)}>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={nodes} filters={filters}
                            text={cellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </ColHead>
            ))}
            <span className="col-head" aria-hidden="true" />
          </div>

          {visible.length === 0 && (
            nodes.length === 0 ? (
              <div className="dir-empty">
                No label templates yet{canAdd ? ' — create the first one.' : '.'}
              </div>
            ) : (
              <div className="dir-empty">
                <b>No matches</b>Try a different filter.
                <EmptyClearFilters filters={filters}
                                    onClear={() => { clearFilters(); setFacets({}); }} />
              </div>
            )
          )}

          <VirtualRows rows={lines} renderRow={renderLine} />
        </div>
      )}

      {dialog?.kind === 'versions' && (
        <VersionsModal templateId={dialog.template.id} templateName={dialog.template.name}
          current={templateVersionLabel(dialog.template)} dirty={false}
          onOpen={(v) => navigate(`/labels/templates/${dialog.template.id}/edit`, { state: { openVersion: v } })}
          onRestored={done} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'clone' && (
        <CloneModal template={dialog.template} onCloned={done} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'sites' && (
        <SitesModal template={dialog.template} sites={sites} onSaved={done} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'add-dpi' && (
        <AddDpiModal template={dialog.node} missing={missingDpis(dialog.node)} onAdded={done}
          onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'replace' && (
        <ReplaceTemplateModal template={dialog.node} candidates={replaceCandidates(dialog.node, nodes ?? [])}
          onReplaced={done} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'update' && (
        <UpdateFromParentModal child={dialog.child} parentVersion={templateVersionLabel(dialog.parent)}
          keptName={keptChildName(dialog.parent.name, dialog.child.dpi_key, allNames)}
          onUpdated={done} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteTemplateModal template={dialog.template} dpiChildren={dialog.dpiChildren}
          onDeleted={done} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

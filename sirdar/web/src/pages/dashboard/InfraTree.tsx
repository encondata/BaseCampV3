/** Infrastructure card: an expandable tree of every environment and its
 *  parts, then the DigitalOcean resources Sirdar doesn't manage, as a
 *  WAI-ARIA treegrid (rows move with Up/Down; Left/Right collapse and expand
 *  or step to the parent/first child). The selected environment (the
 *  spotlight's) comes first and opens; a new selection closes the previous
 *  one again unless the user opened it by hand. */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { DashNode } from '../../lib/sirdarApi';

import {
  BranchIcon, BucketIcon, ChevronIcon, CollapseIcon, DatabaseIcon, DropletIcon, ExpandIcon,
  FolderIcon, LoadBalancerIcon, LockIcon, RefreshIcon, ServerRackIcon,
} from './icons';
import { Dot, dotTone, statusTone } from './parts';

const COLUMNS = ['Instance / resource', 'Type', 'Status', 'Region', 'Endpoint'];
const BRANCH_KINDS = new Set(['environment', 'deployment', 'group']);

type Row = { node: DashNode; level: number; parent: string | null; open: boolean };

function parentIds(tree: DashNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: DashNode[]) => ns.forEach((n) => {
    if (n.children.length) { out.push(n.id); walk(n.children); }
  });
  walk(tree);
  return out;
}

/** The ids a selection opens: its top-level node and every branch under it. */
function autoIds(tree: DashNode[], selected: string | null): string[] {
  const top = selected ? tree.find((n) => n.id === selected) : undefined;
  return top ? parentIds([top]) : [];
}

/** The selected environment first; the rest keep the API's order (card order, then other resources). */
function ordered(tree: DashNode[], selected: string | null): DashNode[] {
  const idx = selected ? tree.findIndex((n) => n.id === selected) : -1;
  return idx > 0 ? [tree[idx], ...tree.slice(0, idx), ...tree.slice(idx + 1)] : tree;
}

function visibleRows(tree: DashNode[], open: Set<string>): Row[] {
  const out: Row[] = [];
  const walk = (ns: DashNode[], level: number, parent: string | null) => ns.forEach((n) => {
    const isOpen = open.has(n.id);
    out.push({ node: n, level, parent, open: isOpen });
    if (n.children.length && isOpen) walk(n.children, level + 1, n.id);
  });
  walk(tree, 1, null);
  return out;
}

function KindIcon({ node }: { node: DashNode }) {
  switch (node.kind) {
    case 'droplet':
      return <DropletIcon size={15} filled={node.status === 'running'} className="sd-ico is-blue" />;
    case 'database':
      return <DatabaseIcon size={15} className="sd-ico is-ink" />;
    case 'spaces':
      return <BucketIcon size={15} className="sd-ico is-ink" />;
    case 'load_balancer':
      return <BranchIcon size={15} className="sd-ico is-blue" />;
    case 'proxy':
      return <LoadBalancerIcon size={15} className="sd-ico is-blue" />;
    case 'server':
      return <ServerRackIcon size={15} className="sd-ico is-ink" />;
    case 'certificate':
      return <LockIcon size={15} className="sd-ico is-ink" />;
    default:
      return <FolderIcon size={15}
                         className={`sd-ico ${node.tone === 'shared' ? 'is-green' : 'is-blue'}`} />;
  }
}

export default function InfraTree({ source, error, tree, selected, refreshing, onRefresh }: {
  source: string;
  error: string | null;
  tree: DashNode[];
  /** The selected card's id: its environment node comes first, open. */
  selected: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const headingId = useId();
  const allParents = useMemo(() => parentIds(tree), [tree]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(autoIds(tree, selected)));
  // ids the user opened by hand (a chevron or a key): a new selection leaves them open
  const [manual, setManual] = useState<Set<string>>(() => new Set());
  const [seenTree, setSeenTree] = useState(tree);
  const [seenSelected, setSeenSelected] = useState(selected);
  if (seenTree !== tree) {           // new data (a refresh): keep what is open that still exists
    const ids = new Set(allParents);
    const keep = (prev: Set<string>) => new Set([...prev].filter((id) => ids.has(id)));
    setSeenTree(tree);
    setOpen(keep);
    setManual(keep);
  }
  const [focusId, setFocusId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  if (seenSelected !== selected) {   // a new pick opens; the old pick closes unless opened by hand
    // The rows move: unless focus is in the tree, the tab stop goes back to the first row.
    if (!gridRef.current?.contains(document.activeElement)) setFocusId(null);
    const before = autoIds(tree, seenSelected).filter((id) => !manual.has(id));
    const after = autoIds(tree, selected);
    setSeenSelected(selected);
    setOpen((prev) => {
      const next = new Set(prev);
      before.forEach((id) => next.delete(id));
      after.forEach((id) => next.add(id));
      return next;
    });
  }
  const rows = useMemo(() => visibleRows(ordered(tree, selected), open), [tree, selected, open]);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const tabStop = rows.some((r) => r.node.id === focusId) ? focusId : rows[0]?.node.id ?? null;

  const toggle = (id: string, to?: boolean) => {
    const opening = to ?? !open.has(id);
    const set = (prev: Set<string>) => {
      const next = new Set(prev);
      if (opening) next.add(id); else next.delete(id);
      return next;
    };
    setOpen(set);
    setManual(set);
  };

  const focusRow = (id: string | null | undefined) => {
    if (!id) return;
    setFocusId(id);
    rowEls.current.get(id)?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>, idx: number) => {
    const row = rows[idx];
    const hasKids = row.node.children.length > 0;
    switch (e.key) {
      case 'ArrowDown': focusRow(rows[idx + 1]?.node.id); break;
      case 'ArrowUp': focusRow(rows[idx - 1]?.node.id); break;
      case 'Home': focusRow(rows[0]?.node.id); break;
      case 'End': focusRow(rows[rows.length - 1]?.node.id); break;
      case 'ArrowRight':
        if (hasKids && !row.open) toggle(row.node.id, true);
        else if (hasKids) focusRow(rows[idx + 1]?.node.id);
        break;
      case 'ArrowLeft':
        if (hasKids && row.open) toggle(row.node.id, false);
        else focusRow(row.parent);
        break;
      case 'Enter': case ' ':
        if (hasKids) toggle(row.node.id);
        break;
      default: return;
    }
    e.preventDefault();
  };

  let subtitle = 'Droplet instances and shared resources';
  if (source === 'none') {
    subtitle = tree.length
      ? "Each environment's parts. Connect DigitalOcean on the Deploy page to see its resources too."
      : 'Connect DigitalOcean on the Deploy page to see your droplets and resources.';
  } else if (source !== 'demo') {
    subtitle = "Each environment's parts, then DigitalOcean resources Sirdar doesn't manage";
  }

  return (
    <section className="sd-card sd-infra" aria-labelledby={headingId}>
      <header className="sd-card-head">
        <div>
          <h2 id={headingId}>Infrastructure</h2>
          <p className="sd-sub">{subtitle}</p>
          {error && <p className="sd-inline-error" role="alert">Couldn't load DigitalOcean resources: {error}</p>}
        </div>
        <div className="sd-head-actions">
          <button type="button" className="sd-btn sd-btn-outline sd-btn-sm"
                  onClick={() => setOpen(new Set(allParents))}>
            <ExpandIcon size={14} />Expand all
          </button>
          <button type="button" className="sd-btn sd-btn-outline sd-btn-sm" onClick={() => { setOpen(new Set()); setManual(new Set()); }}>
            <CollapseIcon size={14} />Collapse all
          </button>
          <button type="button" className={`sd-btn sd-btn-outline sd-btn-sm${refreshing ? ' is-spinning' : ''}`}
                  onClick={onRefresh} aria-busy={refreshing || undefined}>
            <RefreshIcon size={14} className="sd-refresh-ico" />Refresh
          </button>
        </div>
      </header>

      <div ref={gridRef} className="sd-tree" role="treegrid" aria-labelledby={headingId} aria-readonly="true">
        <div className="sd-tree-row sd-tree-headrow" role="row">
          {COLUMNS.map((c) => <div key={c} role="columnheader">{c}</div>)}
        </div>
        {rows.length === 0 && <div className="sd-tree-empty">No droplets or resources to show.</div>}
        {rows.map((row, idx) => {
          const { node, level } = row;
          const hasKids = node.children.length > 0;
          const tone = dotTone(node.dot);
          return (
            <div key={node.id} role="row" aria-label={node.name} aria-level={level}
                 aria-expanded={hasKids ? row.open : undefined}
                 tabIndex={node.id === tabStop ? 0 : -1}
                 ref={(el) => { if (el) rowEls.current.set(node.id, el); else rowEls.current.delete(node.id); }}
                 className={`sd-tree-row${BRANCH_KINDS.has(node.kind) ? ' is-branch' : ''}`}
                 onKeyDown={(e) => onKey(e, idx)} onFocus={() => setFocusId(node.id)}>
              <div role="gridcell" className="sd-tree-cell-name">
                {Array.from({ length: level - 1 }, (_, i) => <span key={i} className="sd-tree-guide" />)}
                {hasKids ? (
                  <button type="button" tabIndex={-1} className={`sd-tree-chev${row.open ? '' : ' is-closed'}`}
                          aria-label={`${row.open ? 'Collapse' : 'Expand'} ${node.name}`}
                          onClick={() => toggle(node.id)}>
                    <ChevronIcon size={14} />
                  </button>
                ) : <span className="sd-tree-chev-pad" />}
                <KindIcon node={node} />
                <span className="sd-tree-name">{node.name}</span>
                {tone && <Dot tone={tone} />}
                {node.badge && <span className="sd-badge">{node.badge}</span>}
              </div>
              <div role="gridcell" className="sd-tree-type">{node.type_label}</div>
              <div role="gridcell">
                <span className={`sd-status is-${statusTone(node.status)}`}>
                  <Dot tone={statusTone(node.status)} />{node.status_label}
                </span>
              </div>
              <div role="gridcell">{node.region || '—'}</div>
              <div role="gridcell" className="sd-tree-endpoint">{node.endpoint || '—'}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The sidebar tree of one space: children load lazily per expand, the
 *  expanded set is remembered per space (localStorage), rows carry a ⋯ /
 *  right-click RowMenu and inline rename, and rows can be dragged (HTML5
 *  DnD) into a folder or page (middle half of the row) or before/after a
 *  sibling (top/bottom quarter). The keyboard alternative to dragging is
 *  the RowMenu's Move… dialog (the RowMenu opens the shell's dialogs). */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type DragEvent, type KeyboardEvent,
} from 'react';
import { Link } from 'react-router-dom';

import { useToast } from '@portal/lib/notificationsContext';

import NodeIcon from '../components/NodeIcon';
import RowMenu, { atLeast, type RowMenuHandle } from '../components/RowMenu';
import {
  childrenKey, noteChanged, noteMoved, refetchChildren, useChildren, useTreeSnapshot,
} from '../lib/treeStore';
import type { NodeMoveIn, NodeOut, SpaceOut } from '../lib/types';
import { errorMessage, moveNode, updateNode } from '../lib/wikiApi';

export type DropZone = 'before' | 'after' | 'into';

/** Which part of a row the pointer is over: top/bottom quarter → before/
 *  after, the middle half → into (halves when the row can't hold children). */
export function dropZone(offsetY: number, height: number, canNest: boolean): DropZone {
  const f = height > 0 ? offsetY / height : 0.5;
  if (!canNest) return f < 0.5 ? 'before' : 'after';
  if (f < 0.25) return 'before';
  if (f > 0.75) return 'after';
  return 'into';
}

// ── expanded set, per space, in localStorage ──────────────────────────

const storageKey = (spaceKey: string) => `ss.wiki.expanded.${spaceKey}`;

function readExpanded(spaceKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(spaceKey));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeExpanded(spaceKey: string, ids: string[]) {
  try { localStorage.setItem(storageKey(spaceKey), JSON.stringify(ids)); } catch { /* storage off */ }
}

function useExpanded(spaceKey: string) {
  const [state, setState] = useState(() => ({ spaceKey, ids: readExpanded(spaceKey) }));
  const ids = state.spaceKey === spaceKey ? state.ids : readExpanded(spaceKey);
  const update = useCallback((fn: (cur: string[]) => string[]) => {
    setState((cur) => {
      const base = cur.spaceKey === spaceKey ? cur.ids : readExpanded(spaceKey);
      const next = fn(base);
      if (next === base) return cur.spaceKey === spaceKey ? cur : { spaceKey, ids: base };
      writeExpanded(spaceKey, next);
      return { spaceKey, ids: next };
    });
  }, [spaceKey]);
  const setOpen = useCallback((id: string, open: boolean) => update((cur) => {
    if (open === cur.includes(id)) return cur;
    return open ? [...cur, id] : cur.filter((x) => x !== id);
  }), [update]);
  const reveal = useCallback((reveal: string[]) => update((cur) => {
    const missing = reveal.filter((id) => !cur.includes(id));
    return missing.length ? [...cur, ...missing] : cur;
  }), [update]);
  return { expanded: useMemo(() => new Set(ids), [ids]), setOpen, reveal };
}

// ── tree ──────────────────────────────────────────────────────────────

interface Props {
  space: SpaceOut;
  activeId: string | null;
  /** Ancestors of the active node — expanded so it's in view. */
  revealIds?: string[];
  onNewChild: (parent: NodeOut, kind: 'page' | 'folder') => void;
}

interface Dragged { node: NodeOut; }
interface DropTarget { id: string; zone: DropZone }

interface TreeCtx extends Omit<Props, 'space' | 'revealIds'> {
  spaceKey: string;
  expanded: Set<string>;
  setOpen: (id: string, open: boolean) => void;
  drop: DropTarget | null;
  renaming: string | null;
  setRenaming: (id: string | null) => void;
  onDragStart: (node: NodeOut) => void;
  onDragEnd: () => void;
  onDragLeave: (node: NodeOut) => void;
  onDragOver: (e: DragEvent, node: NodeOut, ancestors: string[]) => void;
  onDrop: (e: DragEvent, node: NodeOut, ancestors: string[]) => void;
  onRename: (node: NodeOut, title: string) => void;
}

const Ctx = createContext<TreeCtx | null>(null);

export default function SpaceTree({ space, activeId, revealIds, ...handlers }: Props) {
  const toast = useToast();
  const { expanded, setOpen, reveal } = useExpanded(space.key);
  const dragged = useRef<Dragged | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const revealKey = (revealIds ?? []).join(',');
  useEffect(() => {
    if (revealKey) reveal(revealKey.split(','));
  }, [revealKey, reveal]);

  /** The allowed zone for dropping the dragged row on `target`, or null. */
  const zoneFor = (e: DragEvent, target: NodeOut, ancestors: string[]): DropZone | null => {
    const src = dragged.current?.node;
    if (!src) return null;
    // never onto itself or into its own subtree (the server refuses too)
    if (target.id === src.id || ancestors.includes(src.id)) return null;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const canNest = target.kind !== 'file' && atLeast(target.my_level, 'edit');
    return dropZone(e.clientY - rect.top, rect.height, canNest);
  };

  const move = async (src: NodeOut, target: NodeOut, zone: DropZone) => {
    const body: NodeMoveIn = zone === 'into'
      ? { parent_id: target.id }
      : zone === 'before'
        ? { parent_id: target.parent_id, before_id: target.id }
        : { parent_id: target.parent_id, after_id: target.id };
    try {
      const moved = await moveNode(src.id, body);
      noteMoved(moved, { spaceKey: src.space_key, parentId: src.parent_id });
      if (zone === 'into') setOpen(target.id, true);
    } catch (err) {
      toast(errorMessage(err, `Couldn't move “${src.title}”.`));
      refetchChildren(src.space_key, src.parent_id);
      refetchChildren(space.key, body.parent_id);
    }
  };

  const ctx: TreeCtx = {
    ...handlers,
    activeId,
    spaceKey: space.key,
    expanded,
    setOpen,
    drop,
    renaming,
    setRenaming,
    onDragStart: (node) => { dragged.current = { node }; },
    onDragEnd: () => { dragged.current = null; setDrop(null); },
    onDragLeave: (node) => setDrop((cur) => (cur?.id === node.id ? null : cur)),
    onDragOver: (e, node, ancestors) => {
      const zone = zoneFor(e, node, ancestors);
      if (!zone) {
        setDrop((cur) => (cur?.id === node.id ? null : cur));
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDrop((cur) => (cur?.id === node.id && cur.zone === zone ? cur : { id: node.id, zone }));
    },
    onDrop: (e, node, ancestors) => {
      const zone = zoneFor(e, node, ancestors);
      const src = dragged.current?.node;
      dragged.current = null;
      setDrop(null);
      if (!zone || !src) return;
      e.preventDefault();
      void move(src, node, zone);
    },
    onRename: (node, title) => {
      setRenaming(null);
      const next = title.trim();
      if (!next || next === node.title) return;
      if (next.length > 200) { toast('Titles can be up to 200 characters.'); return; }
      updateNode(node.id, { title: next })
        .then((saved) => noteChanged(saved))
        .catch((err) => toast(errorMessage(err, `Couldn't rename “${node.title}”.`)));
    },
  };

  return (
    <Ctx.Provider value={ctx}>
      <ul className="wiki-tree" role="tree" aria-label={`${space.name} pages`}>
        <Branch parentId={null} depth={0} ancestors={[]} />
      </ul>
    </Ctx.Provider>
  );
}

function Branch({ parentId, depth, ancestors }: { parentId: string | null; depth: number; ancestors: string[] }) {
  const ctx = useContext(Ctx)!;
  const { nodes, loading, error } = useChildren(ctx.spaceKey, parentId);
  if (!nodes) {
    if (loading) return <li className="wiki-tree-note" style={{ ['--depth' as string]: depth }}>Loading…</li>;
    if (error) return <li className="wiki-tree-note" style={{ ['--depth' as string]: depth }}>Couldn't load.</li>;
    return null;
  }
  if (nodes.length === 0 && depth === 0) {
    return <li className="wiki-tree-note">Nothing here yet.</li>;
  }
  return <>{nodes.map((n) => <Row key={n.id} node={n} depth={depth} ancestors={ancestors} />)}</>;
}

function Row({ node, depth, ancestors }: { node: NodeOut; depth: number; ancestors: string[] }) {
  const ctx = useContext(Ctx)!;
  const snap = useTreeSnapshot();
  const menuRef = useRef<RowMenuHandle>(null);
  const cached = snap.entries.get(childrenKey(ctx.spaceKey, node.id))?.nodes;
  const hasKids = cached ? cached.length > 0 : node.has_children;
  const open = hasKids && ctx.expanded.has(node.id);
  const active = ctx.activeId === node.id;
  const canEdit = atLeast(node.my_level, 'edit');
  const drop = ctx.drop?.id === node.id ? ctx.drop.zone : null;
  const renaming = ctx.renaming === node.id;
  const childAncestors = useMemo(() => [...ancestors, node.id], [ancestors, node.id]);

  return (
    <li role="treeitem" aria-expanded={hasKids ? open : undefined} aria-selected={active}
        aria-level={depth + 1} className="wiki-tree-item">
      <div
        className={`wiki-tree-row${active ? ' active' : ''}`}
        data-node-id={node.id}
        data-drop={drop ?? undefined}
        style={{ ['--depth' as string]: depth }}
        draggable={canEdit && !renaming}
        onDragStart={(e) => {
          ctx.onDragStart(node);
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', node.title); } catch { /* jsdom */ }
        }}
        onDragEnd={ctx.onDragEnd}
        onDragOver={(e) => ctx.onDragOver(e, node, ancestors)}
        onDragLeave={(e) => {
          // leaving the row (not just moving onto one of its children)
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) ctx.onDragLeave(node);
        }}
        onDrop={(e) => ctx.onDrop(e, node, ancestors)}
        onContextMenu={(e) => { e.preventDefault(); menuRef.current?.openAt(e.clientX, e.clientY); }}
      >
        {hasKids ? (
          <button type="button" className="wiki-tree-toggle" aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${node.title}`}
                  onClick={() => ctx.setOpen(node.id, !open)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          </button>
        ) : <span className="wiki-tree-spacer" />}
        <NodeIcon node={node} />
        {renaming ? (
          <RenameField node={node} onDone={(title) => ctx.onRename(node, title)}
                       onCancel={() => ctx.setRenaming(null)} />
        ) : (
          <Link to={`/n/${node.id}`} className="wiki-tree-title" draggable={false}
                aria-current={active ? 'page' : undefined} title={node.title}>
            {node.title}
          </Link>
        )}
        <RowMenu
          ref={menuRef}
          node={node}
          onNewChild={(kind) => ctx.onNewChild(node, kind)}
          onRename={() => ctx.setRenaming(node.id)}
        />
      </div>
      {open && (
        <ul role="group" className="wiki-tree-group">
          <Branch parentId={node.id} depth={depth + 1} ancestors={childAncestors} />
        </ul>
      )}
    </li>
  );
}

function RenameField({ node, onDone, onCancel }: {
  node: NodeOut; onDone: (title: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(node.title);
  const settled = useRef(false);
  const finish = (fn: () => void) => { if (!settled.current) { settled.current = true; fn(); } };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(() => onDone(value)); }
    if (e.key === 'Escape') { e.preventDefault(); finish(onCancel); }
  };
  return (
    <input className="wiki-tree-rename" aria-label={`Rename ${node.title}`} value={value} autoFocus
           maxLength={220} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey}
           onBlur={() => finish(() => onDone(value))} onFocus={(e) => e.currentTarget.select()} />
  );
}

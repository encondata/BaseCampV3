/** A destination picker for Move and Copy: the spaces, each with its tree
 *  (children load lazily through the shared tree cache). A space's top
 *  level or a folder/page can be picked when the person can edit it;
 *  files, places without edit, and — when `exclude` is given — that node
 *  and everything inside it are shown but can't be picked. */
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';

import { useChildren } from '../lib/treeStore';
import type { NodeOut, SpaceOut } from '../lib/types';
import NodeIcon, { SpaceBadge } from './NodeIcon';
import { atLeast } from './RowMenu';

export interface Destination {
  spaceId: string;
  spaceKey: string;
  /** null = the space's top level */
  parentId: string | null;
  /** The folder's title, or the space's name for its top level. */
  title: string;
}

interface Props {
  spaces: SpaceOut[];
  value: Destination | null;
  onChange: (dest: Destination) => void;
  /** The node being moved or copied: it and its subtree can't be picked. */
  exclude?: string;
  /** Marked "Current location" (a move's starting point). */
  current?: { spaceId: string; parentId: string | null };
  /** Spaces expanded at first. */
  initiallyOpen?: string[];
}

interface Ctx extends Omit<Props, 'spaces' | 'initiallyOpen'> {
  open: Set<string>;
  toggle: (id: string) => void;
}

const isHere = (value: Destination | null, spaceId: string, parentId: string | null) =>
  !!value && value.spaceId === spaceId && value.parentId === parentId;

// a click or key on a nested row must not also pick the rows around it
const onPick = (pick: () => void) => (e: MouseEvent) => { e.stopPropagation(); pick(); };
const onPickKey = (pick: () => void) => (e: KeyboardEvent) => {
  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  pick();
};

function Toggle({ label, open, onClick }: { label: string; open: boolean; onClick: () => void }) {
  return (
    <button type="button" className="wiki-tree-toggle" aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
            onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
    </button>
  );
}

function Branch({ ctx, space, parentId, depth, excluded }: {
  ctx: Ctx; space: SpaceOut; parentId: string | null; depth: number; excluded: boolean;
}) {
  const { nodes, loading, error } = useChildren(space.key, parentId);
  const pad = { ['--depth' as string]: depth };
  if (!nodes) {
    if (loading) return <li className="wiki-tree-note" style={pad}>Loading…</li>;
    if (error) return <li className="wiki-tree-note" style={pad}>Couldn't load.</li>;
    return null;
  }
  if (nodes.length === 0 && depth === 1) return <li className="wiki-tree-note" style={pad}>Nothing here yet.</li>;
  return (
    <>
      {nodes.map((n) => (
        <NodeRow key={n.id} ctx={ctx} space={space} node={n} depth={depth}
                 excluded={excluded || n.id === ctx.exclude} />
      ))}
    </>
  );
}

function NodeRow({ ctx, space, node, depth, excluded }: {
  ctx: Ctx; space: SpaceOut; node: NodeOut; depth: number; excluded: boolean;
}) {
  const open = ctx.open.has(node.id);
  const canHold = node.kind !== 'file';
  const enabled = canHold && !excluded && atLeast(node.my_level, 'edit');
  const selected = isHere(ctx.value, space.id, node.id);
  const current = ctx.current?.spaceId === space.id && ctx.current.parentId === node.id;
  const pick = () => {
    if (enabled) ctx.onChange({ spaceId: space.id, spaceKey: space.key, parentId: node.id, title: node.title });
  };
  return (
    <li role="treeitem" aria-label={node.title} aria-level={depth + 1} aria-selected={selected}
        aria-disabled={!enabled} aria-expanded={canHold && node.has_children ? open : undefined}
        className="wiki-tree-item" tabIndex={enabled ? 0 : -1} onClick={onPick(pick)} onKeyDown={onPickKey(pick)}>
      <div className={`wiki-tree-row wiki-picker-row${selected ? ' active' : ''}${enabled ? '' : ' disabled'}`}
           style={{ ['--depth' as string]: depth }}>
        {canHold && node.has_children
          ? <Toggle label={node.title} open={open} onClick={() => ctx.toggle(node.id)} />
          : <span className="wiki-tree-spacer" />}
        <NodeIcon node={node} />
        <span className="wiki-tree-title" title={node.title}>{node.title}</span>
        {current && <span className="wiki-picker-here">Current location</span>}
      </div>
      {open && (
        <ul role="group" className="wiki-tree-group">
          <Branch ctx={ctx} space={space} parentId={node.id} depth={depth + 1} excluded={excluded} />
        </ul>
      )}
    </li>
  );
}

function SpaceRow({ ctx, space }: { ctx: Ctx; space: SpaceOut }) {
  const open = ctx.open.has(space.id);
  const enabled = atLeast(space.my_level, 'edit');
  const selected = isHere(ctx.value, space.id, null);
  const current = ctx.current?.spaceId === space.id && ctx.current.parentId === null;
  const pick = () => {
    if (enabled) ctx.onChange({ spaceId: space.id, spaceKey: space.key, parentId: null, title: space.name });
  };
  return (
    <li role="treeitem" aria-label={space.name} aria-level={1} aria-selected={selected}
        aria-disabled={!enabled} aria-expanded={open} className="wiki-tree-item"
        tabIndex={enabled ? 0 : -1} onClick={onPick(pick)} onKeyDown={onPickKey(pick)}>
      <div className={`wiki-tree-row wiki-picker-row${selected ? ' active' : ''}${enabled ? '' : ' disabled'}`}
           style={{ ['--depth' as string]: 0 }}>
        <Toggle label={space.name} open={open} onClick={() => ctx.toggle(space.id)} />
        <SpaceBadge space={space} size="sm" />
        <span className="wiki-tree-title" title={space.name}>{space.name}</span>
        {current && <span className="wiki-picker-here">Current location</span>}
      </div>
      {open && (
        <ul role="group" className="wiki-tree-group">
          <Branch ctx={ctx} space={space} parentId={null} depth={1} excluded={false} />
        </ul>
      )}
    </li>
  );
}

export default function TreePicker({ spaces, initiallyOpen = [], ...rest }: Props) {
  const [open, setOpen] = useState(() => new Set(initiallyOpen));
  const openKey = initiallyOpen.join(',');
  useEffect(() => {
    if (openKey) setOpen((cur) => new Set([...cur, ...openKey.split(',')]));
  }, [openKey]);
  const toggle = (id: string) => setOpen((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const ctx: Ctx = { ...rest, open, toggle };
  return (
    <ul className="wiki-tree wiki-picker" role="tree" aria-label="Destination">
      {spaces.map((s) => <SpaceRow key={s.id} ctx={ctx} space={s} />)}
    </ul>
  );
}

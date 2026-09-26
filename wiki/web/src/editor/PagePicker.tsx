/** Finding a wiki node to link or embed. `PageLinkMenu` follows "[[" typed
 *  in the text (search-as-you-type, Enter inserts a page link);
 *  `PickerPopover` is the same search with its own box, opened from the
 *  toolbar or the slash menu (pages to link, files to embed). */
import type { Editor } from '@tiptap/core';
import {
  useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react';

import NodeIcon from '../components/NodeIcon';
import type { NodeKind, SearchHit } from '../lib/types';
import { search } from '../lib/wikiApi';
import { Icon } from './icons';
import {
  cycle, findTrigger, menuPosition, PAGE_LINK_PATTERN, useMenuKeys, useTrigger,
} from './suggest';

const DEBOUNCE_MS = 150;

type SearchState = { status: 'idle' | 'loading' | 'error'; hits: SearchHit[] }
  | { status: 'done'; hits: SearchHit[] };

/** Debounced `search` of one kind; the newest query wins. */
export function useNodeSearch(query: string, kind: NodeKind): SearchState {
  const [state, setState] = useState<SearchState>({ status: 'idle', hits: [] });
  const q = query.trim();
  useEffect(() => {
    if (!q) { setState({ status: 'idle', hits: [] }); return undefined; }
    let live = true;
    setState((s) => ({ status: 'loading', hits: s.hits }));
    const timer = setTimeout(() => {
      search({ q, kind, limit: 8, log: false })   // as you type: not logged
        .then((hits) => { if (live) setState({ status: 'done', hits }); })
        .catch(() => { if (live) setState({ status: 'error', hits: [] }); });
    }, DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [q, kind]);
  return state;
}

export interface PickedNode {
  id: string;
  title: string;
  kind: NodeKind;
}

const picked = (hit: SearchHit): PickedNode => ({ id: hit.node.id, title: hit.node.title, kind: hit.node.kind });

function Results({ state, query, kind, active, onActive, onPick }: {
  state: SearchState; query: string; kind: NodeKind; active: number;
  onActive: (i: number) => void; onPick: (hit: SearchHit) => void;
}) {
  const noun = kind === 'file' ? 'files' : 'pages';
  return (
    <div role="listbox" aria-label={kind === 'file' ? 'Files' : 'Pages'} className="we-menu-list">
      {state.hits.map((hit, i) => (
        <div
          key={hit.node.id}
          role="option"
          aria-selected={i === active}
          className={`we-menu-item${i === active ? ' active' : ''}`}
          onMouseEnter={() => onActive(i)}
          onMouseDown={(e) => { e.preventDefault(); onPick(hit); }}
        >
          <span className="we-menu-icon"><NodeIcon node={{ kind: hit.node.kind, title: hit.node.title, file: null }} /></span>
          <span className="we-menu-text">
            <b>{hit.node.title}</b>
            <span>{[hit.node.space_name, ...hit.breadcrumbs].join(' / ')}</span>
          </span>
        </div>
      ))}
      {!query.trim() && <div className="we-menu-empty">Type to search {noun}</div>}
      {query.trim() && state.status === 'done' && !state.hits.length && (
        <div className="we-menu-empty">No {noun} match “{query.trim()}”</div>
      )}
      {state.status === 'loading' && !state.hits.length && <div className="we-menu-empty">Searching…</div>}
      {state.status === 'error' && <div className="we-menu-empty">Search isn't available right now</div>}
    </div>
  );
}

/** Inserts a page link (and a space after it) over `range`. */
export function insertPageLink(editor: Editor, node: PickedNode, range?: { from: number; to: number }): void {
  const chain = editor.chain().focus();
  (range ? chain.deleteRange(range) : chain)
    .insertContent([
      // no title: the target may be hidden from some of this page's readers,
      // who each see its live title (or "Missing page") instead
      { type: 'pageLink', attrs: { nodeId: node.id } },
      { type: 'text', text: ' ' },
    ])
    .run();
}

const findPageLink = (state: Editor['state']) => findTrigger(state, PAGE_LINK_PATTERN);

/** The "[[" page picker that follows the text. */
export function PageLinkMenu({ editor }: { editor: Editor | null }) {
  const [trigger, dismiss] = useTrigger(editor, findPageLink);
  const query = trigger?.query ?? '';
  const state = useNodeSearch(query, 'page');
  const [active, setActive] = useState(0);

  useEffect(() => { setActive(0); }, [state.hits]);

  const pick = (hit: SearchHit | undefined) => {
    if (!editor || !trigger || !hit) return;
    insertPageLink(editor, picked(hit), trigger);
  };

  useMenuKeys(editor, !!trigger, (event) => {
    const n = state.hits.length;
    if (event.key === 'ArrowDown') { setActive((i) => cycle(i, 1, n)); return true; }
    if (event.key === 'ArrowUp') { setActive((i) => cycle(i, -1, n)); return true; }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (!n) return event.key === 'Tab';
      pick(state.hits[active]);
      return true;
    }
    if (event.key === 'Escape') { dismiss(); return true; }
    return false;
  });

  if (!editor || !trigger) return null;
  const pos = menuPosition(editor, trigger.from);
  return (
    <div className="we-menu we-picker" style={{ top: pos.top, left: pos.left }}
         onMouseDown={(e) => e.preventDefault()}>
      <div className="we-menu-title">Link to a page</div>
      <Results state={state} query={query} kind="page" active={active} onActive={setActive} onPick={pick} />
    </div>
  );
}

/** A search box with results, anchored under a toolbar button. */
export function PickerPopover({ kind, anchor, title, onPick, onClose, extra }: {
  kind: 'page' | 'file';
  anchor: { top: number; left: number };
  title: string;
  onPick: (node: PickedNode) => void;
  onClose: () => void;
  /** More actions under the results (Upload a file…). */
  extra?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const state = useNodeSearch(query, kind);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setActive(0); }, [state.hits]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [onClose]);

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const n = state.hits.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => cycle(i, 1, n)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => cycle(i, -1, n)); }
    if (e.key === 'Enter' && n) { e.preventDefault(); onPick(picked(state.hits[active])); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };

  return (
    <div ref={boxRef} className="we-menu we-picker" style={{ top: anchor.top, left: anchor.left }}
         role="dialog" aria-label={title}>
      <div className="we-menu-title">{title}</div>
      <label className="we-picker-search">
        <Icon name="search" />
        <input autoFocus value={query} placeholder={kind === 'file' ? 'Search files' : 'Search pages'}
               aria-label={kind === 'file' ? 'Search files' : 'Search pages'}
               onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
      </label>
      <Results state={state} query={query} kind={kind} active={active} onActive={setActive}
               onPick={(hit) => onPick(picked(hit))} />
      {extra && <div className="we-menu-foot">{extra}</div>}
    </div>
  );
}

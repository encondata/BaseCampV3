/** The top bar's search box: type to see live results (debounced 200 ms,
 *  top 8), ↑↓ to move through them, Enter opens the highlighted hit or —
 *  with nothing highlighted — the full results page, Escape closes the
 *  dropdown. ⌘K / Ctrl+K focuses it from anywhere in the wiki.
 *
 *  Every hit's snippet is `snippet_html`: server-escaped HTML with only
 *  `<mark></mark>` in it. Rendering it with `dangerouslySetInnerHTML` is
 *  safe (and the only place in the wiki that does it) because the server
 *  escapes everything else first — a hit whose title or file contents
 *  literally contain `<img onerror=…>` arrives as the escaped text
 *  `&lt;img onerror=…&gt;`, which renders as visible text, not markup. */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import NodeIcon from '../components/NodeIcon';
import type { SearchHit } from '../lib/types';
import { search } from '../lib/wikiApi';

const DEBOUNCE_MS = 200;
const LIMIT = 8;

const hitPath = (hit: SearchHit) => `/n/${hit.node.id}`;
const resultsPath = (q: string) => `/search?q=${encodeURIComponent(q)}`;
const hitLabel = (hit: SearchHit) =>
  hit.node.space_name + (hit.breadcrumbs.length ? ` / ${hit.breadcrumbs.join(' / ')}` : '');

export default function SearchBox() {
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(-1);
  const requestSeq = useRef(0);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); setActive(-1); return undefined; }
    const mine = ++requestSeq.current;
    const timer = setTimeout(() => {
      search({ q, limit: LIMIT })
        .then((found) => { if (requestSeq.current === mine) { setHits(found); setActive(-1); } })
        .catch(() => { if (requestSeq.current === mine) { setHits([]); setActive(-1); } });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  const go = (path: string) => {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
    navigate(path);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      if (!hits.length) return;
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % hits.length);
    } else if (e.key === 'ArrowUp') {
      if (!hits.length) return;
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a - 1 + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      const q = query.trim();
      if (active >= 0 && hits[active]) {
        e.preventDefault();
        go(hitPath(hits[active]));
      } else if (q) {
        e.preventDefault();
        go(resultsPath(q));
      }
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  const showMenu = open && query.trim().length > 0;

  return (
    <div className="tb-search" ref={wrapRef}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input
        ref={inputRef}
        type="search"
        placeholder="Search the wiki…"
        aria-label="Search the wiki"
        aria-expanded={showMenu}
        aria-controls="wiki-search-results"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { if (query.trim()) setOpen(true); }}
        onKeyDown={onKeyDown}
      />
      <kbd>⌘K</kbd>
      {showMenu && (
        <div className="wiki-search-menu" id="wiki-search-results">
          {hits.length === 0 && <div className="pop-empty">No results for “{query.trim()}”.</div>}
          {hits.map((hit, i) => (
            <button
              key={hit.node.id}
              type="button"
              className={`wiki-search-hit${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); go(hitPath(hit)); }}
            >
              <NodeIcon node={{ kind: hit.node.kind, title: hit.node.title, file: null }} className="wiki-search-hit-icon" />
              <span className="wiki-search-hit-body">
                <span className="wiki-search-hit-title">{hit.node.title}</span>
                <span className="wiki-search-hit-meta">{hitLabel(hit)}</span>
                <span className="wiki-search-hit-snippet" dangerouslySetInnerHTML={{ __html: hit.snippet_html }} />
              </span>
            </button>
          ))}
          {hits.length > 0 && (
            <button type="button" className="wiki-search-more"
                    onMouseDown={(e) => { e.preventDefault(); go(resultsPath(query.trim())); }}>
              See all results for “{query.trim()}”
            </button>
          )}
        </div>
      )}
    </div>
  );
}

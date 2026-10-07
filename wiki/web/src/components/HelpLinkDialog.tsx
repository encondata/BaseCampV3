/** Add or edit a help link (wiki admins): the portal or kiosk screen it
 *  covers (`portal:/bulk/time` — the server normalizes it) and the page or
 *  file that explains it, found with a search ComboBox. Opened from the
 *  Help links page, prefilled with a context (the portal's "Link a guide")
 *  or a guide (a page's "Use as help for…"). */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import ComboBox, { type ComboOption } from '@portal/components/ComboBox';

import type { HelpLinkOut, NodeKind, NodeOut, SearchHit } from '../lib/types';
import { createHelpLink, errorMessage, listRecent, search, updateHelpLink } from '../lib/wikiApi';

const SEARCH_DEBOUNCE_MS = 150;

export interface GuideRef {
  id: string;
  title: string;
  kind: NodeKind;
  space_name?: string;
}

function guideOption(g: GuideRef): ComboOption {
  return { value: g.id, label: g.title, sub: [g.space_name, g.kind === 'file' ? 'File' : 'Page'].filter(Boolean).join(' · ') };
}

const fromHit = (hit: SearchHit): GuideRef => ({
  id: hit.node.id, title: hit.node.title, kind: hit.node.kind, space_name: hit.node.space_name,
});

const fromNode = (node: NodeOut): GuideRef => ({ id: node.id, title: node.title, kind: node.kind });

/** The guide ComboBox: server search over pages and files, debounced; with
 *  nothing typed it lists the pages and files you edited most recently
 *  (loaded once, the first time the list opens). */
function GuidePicker({ value, onChange, disabled }: {
  value: GuideRef | null; onChange: (g: GuideRef | null) => void; disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GuideRef[]>([]);
  const [recent, setRecent] = useState<GuideRef[]>([]);
  const recentAsked = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const loadRecent = () => {
    if (recentAsked.current) return;
    recentAsked.current = true;
    listRecent({ limit: 10 })
      .then((nodes) => {
        if (alive.current) setRecent(nodes.filter((n) => n.kind !== 'folder').map(fromNode));
      })
      .catch(() => { /* no recent list: typing still searches */ });
  };

  // what the list shows: search hits once you type, the recent guides before
  const shown = query.trim() ? results : recent;

  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); return undefined; }
    let live = true;
    const timer = setTimeout(() => {
      search({ q, limit: 10, log: false })   // as you type: not logged
        .then((hits) => {
          if (live) setResults(hits.filter((h) => h.node.kind !== 'folder').map(fromHit));
        })
        .catch(() => { if (live) setResults([]); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);

  const options = useMemo(() => {
    const list = shown.map(guideOption);
    // the pick keeps its label after the results move on
    if (value && !list.some((o) => o.value === value.id)) list.unshift(guideOption(value));
    return list;
  }, [shown, value]);

  return (
    <ComboBox
      inputId="wiki-help-guide"
      options={options}
      value={value?.id ?? ''}
      ariaLabel="Guide"
      placeholder="Search pages and files…"
      disabled={disabled}
      portal
      onOpen={loadRecent}
      onSearch={setQuery}
      onChange={(id) => onChange(shown.find((g) => g.id === id) ?? (value?.id === id ? value : null))}
    />
  );
}

export default function HelpLinkDialog({ link, initialContext = '', initialGuide = null, onSaved, onClose }: {
  /** Editing this link; absent = adding one. */
  link?: HelpLinkOut;
  initialContext?: string;
  initialGuide?: GuideRef | null;
  onSaved: (saved: HelpLinkOut) => void;
  onClose: () => void;
}) {
  const [context, setContext] = useState(link?.context ?? initialContext);
  const [guide, setGuide] = useState<GuideRef | null>(link ? link.node : initialGuide);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // a guide that arrives after opening (read from ?node=) fills an empty pick
  useEffect(() => {
    if (initialGuide) setGuide((cur) => cur ?? initialGuide);
  }, [initialGuide]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const trimmed = context.trim();
  const canSave = !!trimmed && !!guide && !busy;
  const title = link ? 'Edit help link' : 'Add help link';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave || !guide) return;
    setBusy(true);
    setError('');
    try {
      let saved: HelpLinkOut;
      if (link) {
        const changes: { context?: string; node_id?: string } = {};
        if (trimmed !== link.context) changes.context = trimmed;
        if (guide.id !== link.node.id) changes.node_id = guide.id;
        saved = await updateHelpLink(link.id, changes);
      } else {
        saved = await createHelpLink({ context: trimmed, node_id: guide.id });
      }
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err, 'Couldn\'t save the help link. Try again.'));
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card wiki-dialog-card" role="dialog"
           aria-modal="true" aria-labelledby="wiki-help-link-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Help links</div>
            <h3 id="wiki-help-link-title">{title}</h3>
            <p className="page-hint">
              The ? button on that portal screen opens this guide (the kiosk has no ? button yet). A link covers the screens
              under it too, unless one of them has its own.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            <div className="pf-form">
              <div className="full">
                <label htmlFor="wiki-help-context">Context</label>
                <input id="wiki-help-context" className="mono" value={context} disabled={busy}
                       autoFocus={!link && !initialContext} maxLength={300} spellCheck={false}
                       placeholder="portal:/bulk/time" onChange={(e) => setContext(e.target.value)} />
                <p className="page-hint">
                  <span className="mono">portal:</span> or <span className="mono">kiosk:</span> and the page's
                  path. IDs in the path become <span className="mono">:id</span>.
                </p>
              </div>
              <div className="full">
                <label htmlFor="wiki-help-guide">Guide</label>
                <GuidePicker value={guide} onChange={setGuide} disabled={busy} />
              </div>
            </div>
            {error && <p className="pf-error">{error}</p>}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={!canSave}>
              {busy ? 'Saving…' : link ? 'Save' : 'Add link'}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

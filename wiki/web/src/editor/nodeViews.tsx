/** React node views for the wiki's custom nodes, used by both the live
 *  editor and the read-only view (controls that change the document only
 *  show while the editor is editable):
 *    - WikiImage: resolves its asset URL, caption and alt text, a resize handle
 *    - FileEmbed: a card with an inline PDF/image/video preview
 *    - PageLink: the target's current title ("Missing page" when it's gone,
 *      "Couldn't load link" when the lookup failed — retried once)
 *    - Mention: "@" + the person's current name when known, else the stored label
 *    - Callout: the variant's icon and a variant switcher
 *    - Details: an open/close toggle (open state is per reader, not stored)
 *  `withNodeViews` swaps them into the shared schema's extension list.
 *
 *  In public mode (the `PublicShare` extension — a public share link's
 *  view, signed out) nothing is looked up in the wiki: images and embedded
 *  files use the URLs that came with the content, a page link is plain
 *  text, and an embed of another wiki file shows as unavailable. */
import { Extension, type AnyExtension, type Editor, type Extensions } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
  NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps,
} from '@tiptap/react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { fileType } from '../components/NodeIcon';
import { resolveAssetUrl } from '../lib/assetUrls';
import { nodeTitle } from '../lib/nodeTitles';
import { personName } from '../lib/personNames';
import { getFileUrl } from '../lib/wikiApi';
import { CALLOUT_VARIANTS, type CalloutVariant } from './extensions/Callout';
import { Icon, type IconName } from './icons';

// ── public mode ───────────────────────────────────────────────────────

type AssetUrlMap = Record<string, string>;

/** Puts a view in public mode: `assetUrls` (asset id → presigned URL) is
 *  every asset URL it may show. */
export const PublicShare = Extension.create<{ assetUrls: AssetUrlMap }>({
  name: 'publicShare',
  addOptions() {
    return { assetUrls: {} };
  },
  addStorage() {
    return { assetUrls: this.options.assetUrls };
  },
});

/** The public view's asset URLs, or null when this isn't a public view. */
function publicAssets(editor: Editor): AssetUrlMap | null {
  const storage = (editor.storage as Record<string, { assetUrls?: AssetUrlMap } | undefined>).publicShare;
  return storage?.assetUrls ?? null;
}

// ── shared lookups ────────────────────────────────────────────────────

/** undefined while loading, null when not viewable. With `publicUrls`
 *  (public mode) it only looks the id up there. */
function useAssetUrl(assetId: string | null, publicUrls: AssetUrlMap | null = null): string | null | undefined {
  const [url, setUrl] = useState<{ id: string | null; url: string | null } | null>(null);
  useEffect(() => {
    if (!assetId || publicUrls) return undefined;
    let live = true;
    resolveAssetUrl(assetId)
      .then((u) => { if (live) setUrl({ id: assetId, url: u }); })
      .catch(() => { if (live) setUrl({ id: assetId, url: null }); });
    return () => { live = false; };
  }, [assetId, publicUrls]);
  if (!assetId) return null;
  if (publicUrls) return Object.prototype.hasOwnProperty.call(publicUrls, assetId) ? publicUrls[assetId] : null;
  return url?.id === assetId ? url.url : undefined;
}

/** The in-app route of a wiki node (ids come from client-written documents). */
const nodePath = (id: string) => `/n/${encodeURIComponent(id)}`;

// ── image ─────────────────────────────────────────────────────────────

const MIN_WIDTH = 120;

function WikiImageView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const { assetId, alt, caption, width } = node.attrs as {
    assetId: string | null; alt: string; caption: string; width: number | null;
  };
  const url = useAssetUrl(assetId, publicAssets(editor));
  const editable = editor.isEditable;
  const frameRef = useRef<HTMLDivElement>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [editingAlt, setEditingAlt] = useState(false);

  const startResize = (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    const frame = frameRef.current;
    if (!frame) return;
    const startX = e.clientX;
    const startW = frame.getBoundingClientRect().width;
    const maxW = frame.parentElement?.getBoundingClientRect().width || startW;
    let current = startW;
    const move = (ev: PointerEvent) => {
      current = Math.round(Math.max(MIN_WIDTH, Math.min(maxW, startW + (ev.clientX - startX))));
      setDragWidth(current);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragWidth(null);
      updateAttributes({ width: current >= maxW - 2 ? null : current });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const shownWidth = dragWidth ?? width;
  return (
    <NodeViewWrapper as="figure" className={`wiki-image${selected && editable ? ' is-selected' : ''}`}
                     data-wiki-image={assetId ?? ''}>
      <div ref={frameRef} className="wiki-image-frame" data-drag-handle=""
           style={shownWidth ? { width: `${shownWidth}px` } : undefined}>
        {url === undefined && <div className="wiki-image-skeleton" aria-label="Loading image" />}
        {url === null && (
          <div className="wiki-image-missing"><Icon name="image" /><span>Image unavailable</span></div>
        )}
        {url && <img src={url} alt={alt} draggable={false} />}
        {editable && url && (
          <span className="wiki-image-resize" role="presentation" title="Drag to resize"
                onPointerDown={startResize} />
        )}
      </div>
      {editable ? (
        <div className="wiki-image-meta" contentEditable={false}>
          <input className="wiki-image-caption" value={caption} placeholder="Add a caption"
                 aria-label="Image caption" onChange={(e) => updateAttributes({ caption: e.target.value })} />
          {(selected || editingAlt) && (editingAlt ? (
            <input className="wiki-image-alt" value={alt} autoFocus placeholder="Describe the image"
                   aria-label="Alt text" onChange={(e) => updateAttributes({ alt: e.target.value })}
                   onBlur={() => setEditingAlt(false)}
                   onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditingAlt(false); }} />
          ) : (
            <button type="button" className="we-chip-btn" onClick={() => setEditingAlt(true)}>
              {alt ? 'Edit alt text' : 'Add alt text'}
            </button>
          ))}
        </div>
      ) : (caption && <figcaption>{caption}</figcaption>)}
    </NodeViewWrapper>
  );
}

// ── file embed ────────────────────────────────────────────────────────

type Preview = { url: string | null; type: string } | undefined;

function FileEmbedView({ node, editor, selected }: NodeViewProps) {
  const { nodeId, assetId, filename, contentType } = node.attrs as {
    nodeId: string | null; assetId: string | null; filename: string; contentType: string;
  };
  const publicUrls = publicAssets(editor);
  const [preview, setPreview] = useState<Preview>(undefined);
  const [open, setOpen] = useState(true);
  // a file node shows its live title; the stored name is the page's own
  // asset's (a file node's is never stored — it may name a hidden file)
  const [liveTitle, setLiveTitle] = useState<{ id: string; title: string | null } | null>(null);

  useEffect(() => {
    if (!nodeId || publicUrls) return undefined;
    let live = true;
    nodeTitle(nodeId)
      .then((title) => { if (live) setLiveTitle({ id: nodeId, title }); })
      .catch(() => { if (live) setLiveTitle({ id: nodeId, title: null }); });
    return () => { live = false; };
  }, [nodeId, publicUrls]);

  useEffect(() => {
    let live = true;
    setPreview(undefined);
    const done = (url: string | null, type: string) => { if (live) setPreview({ url, type }); };
    if (publicUrls) {
      // another wiki file is never part of a public share
      const own = !nodeId && assetId && Object.prototype.hasOwnProperty.call(publicUrls, assetId);
      done(own ? publicUrls[assetId] : null, contentType);
    } else if (nodeId) {
      getFileUrl(nodeId, { disposition: 'inline' })
        .then((r) => done(r.url, r.content_type || contentType))
        .catch(() => done(null, contentType));
    } else if (assetId) {
      resolveAssetUrl(assetId).then((u) => done(u, contentType)).catch(() => done(null, contentType));
    } else {
      done(null, contentType);
    }
    return () => { live = false; };
  }, [nodeId, assetId, contentType, publicUrls]);

  const titleLoading = !!nodeId && !publicUrls && liveTitle?.id !== nodeId;
  const shownName = nodeId ? (liveTitle?.id === nodeId ? liveTitle.title ?? '' : '') : filename;
  const type = fileType(preview?.type ?? contentType, shownName);
  const previewable = type === 'pdf' || type === 'image' || type === 'video';
  const loading = preview === undefined || titleLoading;
  const missing = !loading && !preview?.url;
  // the stored name shows only once the reader is known to be able to see the file
  const name = loading ? 'Loading…' : missing ? 'File unavailable' : shownName || 'Untitled file';
  const label = { pdf: 'PDF', image: 'Image', video: 'Video', doc: 'Document', sheet: 'Spreadsheet',
    slides: 'Presentation', other: 'File' }[type];

  return (
    <NodeViewWrapper className={`wiki-file-embed${selected && editor.isEditable ? ' is-selected' : ''}`}
                     data-file-embed="">
      <div className="wiki-file-card" data-drag-handle="">
        <span className={`wiki-file-icon wiki-file-${type}`}><Icon name="file" /></span>
        <span className="wiki-file-text">
          <b title={loading || missing ? undefined : shownName}>{name}</b>
          <span>
            {missing ? (publicUrls ? 'Not included in this share' : 'Removed, or not shared with you') : loading ? '' : label}
          </span>
        </span>
        <span className="wiki-file-actions" contentEditable={false}>
          {previewable && preview?.url && (
            <button type="button" className="we-chip-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <Icon name="eye" />{open ? 'Hide preview' : 'Preview'}
            </button>
          )}
          {nodeId && !missing && (
            <Link className="we-chip-btn" to={nodePath(nodeId)}><Icon name="external" />Open</Link>
          )}
          {!nodeId && preview?.url && (
            <a className="we-chip-btn" href={preview.url} target="_blank" rel="noopener noreferrer">
              <Icon name="download" />Download
            </a>
          )}
        </span>
      </div>
      {open && preview?.url && previewable && (
        <div className="wiki-file-preview" contentEditable={false}>
          {type === 'image' && <img src={preview.url} alt={shownName} draggable={false} />}
          {type === 'pdf' && <iframe src={preview.url} title={`Preview of ${shownName}`} loading="lazy" />}
          {type === 'video' && <video src={preview.url} controls preload="metadata" />}
        </div>
      )}
    </NodeViewWrapper>
  );
}

// ── page link ─────────────────────────────────────────────────────────

/** How long a failed title lookup waits before its one retry. */
export const PAGE_LINK_RETRY_MS = 5000;

type TitleLookup =
  | { id: string; status: 'ok'; title: string }
  | { id: string; status: 'missing' }
  | { id: string; status: 'error' };

function PageLinkView({ node, editor }: NodeViewProps) {
  // the stored title is never shown: it may be stale, or name a page the
  // reader can't see
  const { nodeId } = node.attrs as { nodeId: string | null };
  const isPublic = publicAssets(editor) !== null;
  const navigate = useNavigate();
  const [lookup, setLookup] = useState<TitleLookup | null>(null);

  useEffect(() => {
    if (!nodeId || isPublic) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = (retry: boolean) => {
      nodeTitle(nodeId)
        .then((t) => {
          if (live) setLookup(t === null ? { id: nodeId, status: 'missing' } : { id: nodeId, status: 'ok', title: t });
        })
        .catch(() => {
          // gone or not viewable answers null; this is anything else (offline, 5xx)
          if (!live) return;
          setLookup({ id: nodeId, status: 'error' });
          if (retry) timer = setTimeout(() => look(false), PAGE_LINK_RETRY_MS);
        });
    };
    look(true);
    return () => { live = false; clearTimeout(timer); };
  }, [nodeId, isPublic]);

  if (isPublic) {
    // the API already turns these into text for a public share; this is
    // only for a link that slipped through
    return <NodeViewWrapper as="span" className="wiki-page-link public">Linked page</NodeViewWrapper>;
  }
  const current = lookup?.id === nodeId ? lookup : null;
  if (!nodeId || current?.status === 'missing') {
    return (
      <NodeViewWrapper as="span" className="wiki-page-link missing" title="This page was removed or isn't shared with you">
        <Icon name="pageLink" className="wiki-page-link-icon" />Missing page
      </NodeViewWrapper>
    );
  }
  if (current?.status === 'error') {
    return (
      <NodeViewWrapper as="span" className="wiki-page-link missing" title="The link's page couldn't be looked up">
        <Icon name="pageLink" className="wiki-page-link-icon" />Couldn't load link
      </NodeViewWrapper>
    );
  }
  if (!current) {
    return (
      <NodeViewWrapper as="span" className="wiki-page-link loading">
        <Icon name="pageLink" className="wiki-page-link-icon" />Loading…
      </NodeViewWrapper>
    );
  }
  const path = nodePath(nodeId);
  return (
    <NodeViewWrapper as="span" className="wiki-page-link">
      <a href={path} onClick={(e) => { e.preventDefault(); navigate(path); }}>
        <Icon name="pageLink" className="wiki-page-link-icon" />
        {current.title}
      </a>
    </NodeViewWrapper>
  );
}

// ── mention ───────────────────────────────────────────────────────────

function MentionView({ node }: NodeViewProps) {
  // only people who can view the page are mentioned, so the stored label
  // is safe to show when the current name isn't known
  const { personId, label } = node.attrs as { personId: string | null; label: string };
  const name = (personId && personName(personId)) || label;
  return (
    <NodeViewWrapper as="span" className="wiki-mention" data-mention={personId ?? ''}>
      @{name}
    </NodeViewWrapper>
  );
}

// ── callout ───────────────────────────────────────────────────────────

const VARIANT_LABEL: Record<CalloutVariant, string> = {
  info: 'Info', tip: 'Tip', warning: 'Warning', danger: 'Danger',
};

function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const variant = (CALLOUT_VARIANTS as readonly string[]).includes(node.attrs.variant)
    ? node.attrs.variant as CalloutVariant : 'info';
  return (
    <NodeViewWrapper className="wiki-callout" data-callout={variant}>
      <span className="wiki-callout-icon" contentEditable={false} aria-hidden="true">
        <Icon name={variant as IconName} />
      </span>
      <NodeViewContent className="wiki-callout-body" />
      {editor.isEditable && (
        <span className="wiki-callout-variants" contentEditable={false} role="group" aria-label="Callout style">
          {CALLOUT_VARIANTS.map((v) => (
            <button key={v} type="button" data-variant={v} aria-pressed={v === variant}
                    aria-label={VARIANT_LABEL[v]} title={VARIANT_LABEL[v]}
                    onClick={() => updateAttributes({ variant: v })}>
              <Icon name={v as IconName} />
            </button>
          ))}
        </span>
      )}
    </NodeViewWrapper>
  );
}

// ── details ───────────────────────────────────────────────────────────

function DetailsView({ editor, getPos, node }: NodeViewProps) {
  const [open, setOpen] = useState(editor.isEditable);

  // the cursor moving into the hidden part opens it
  useEffect(() => {
    if (!editor.isEditable) return undefined;
    const onSelection = () => {
      const pos = typeof getPos === 'function' ? getPos() : null;
      if (pos == null) return;
      const { from } = editor.state.selection;
      const summaryEnd = pos + 1 + (node.firstChild?.nodeSize ?? 0);
      if (from > summaryEnd && from < pos + node.nodeSize) setOpen(true);
    };
    editor.on('selectionUpdate', onSelection);
    return () => { editor.off('selectionUpdate', onSelection); };
  }, [editor, getPos, node]);

  return (
    <NodeViewWrapper className="wiki-details" data-open={open ? 'true' : 'false'}>
      <button type="button" className="wiki-details-toggle" contentEditable={false}
              aria-expanded={open} aria-label={open ? 'Collapse section' : 'Expand section'}
              onClick={() => setOpen((o) => !o)}>
        <Icon name="chevronRight" />
      </button>
      <NodeViewContent className="wiki-details-body" />
    </NodeViewWrapper>
  );
}

// ── wiring ────────────────────────────────────────────────────────────

const VIEWS: Record<string, (ext: AnyExtension) => AnyExtension> = {
  wikiImage: (ext) => ext.extend({ addNodeView: () => ReactNodeViewRenderer(WikiImageView) }),
  fileEmbed: (ext) => ext.extend({ addNodeView: () => ReactNodeViewRenderer(FileEmbedView) }),
  pageLink: (ext) => ext.extend({ addNodeView: () => ReactNodeViewRenderer(PageLinkView, { as: 'span' }) }),
  mention: (ext) => ext.extend({ addNodeView: () => ReactNodeViewRenderer(MentionView, { as: 'span' }) }),
  callout: (ext) => ext.extend({ addNodeView: () => ReactNodeViewRenderer(CalloutView) }),
  details: (ext) => ext.extend({ addNodeView: () => ReactNodeViewRenderer(DetailsView) }),
  detailsSummary: (ext) => ext.extend({
    addKeyboardShortcuts() {
      return {
        // Enter in a summary moves on to the section's content
        Enter: ({ editor }) => {
          const { $from, empty } = editor.state.selection;
          if (!empty || $from.parent.type.name !== 'detailsSummary') return false;
          return editor.commands.command(({ tr }) => {
            tr.setSelection(TextSelection.near(tr.doc.resolve($from.after() + 1)));
            return true;
          });
        },
        // Backspace at the very start of a summary unwraps the section:
        // the summary becomes a paragraph, followed by the content
        Backspace: ({ editor }) => {
          const { $from, empty } = editor.state.selection;
          if (!empty || $from.parent.type.name !== 'detailsSummary' || $from.parentOffset !== 0) return false;
          const details = $from.node($from.depth - 1);
          const start = $from.before($from.depth - 1);
          const blocks = [editor.schema.nodes.paragraph.create(null, $from.parent.content)];
          details.lastChild?.forEach((block) => { blocks.push(block); });
          return editor.commands.command(({ tr }) => {
            tr.replaceWith(start, start + details.nodeSize, blocks);
            tr.setSelection(TextSelection.create(tr.doc, start + 1));
            return true;
          });
        },
      };
    },
  }),
};

/** The shared extension list with the editor's node views in place. */
export function withNodeViews(extensions: Extensions): Extensions {
  return extensions.map((ext) => VIEWS[ext.name]?.(ext) ?? ext);
}

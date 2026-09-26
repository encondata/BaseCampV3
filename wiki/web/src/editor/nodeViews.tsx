/** React node views for the wiki's custom nodes, used by both the live
 *  editor and the read-only view (controls that change the document only
 *  show while the editor is editable):
 *    - WikiImage: resolves its asset URL, caption and alt text, a resize handle
 *    - FileEmbed: a card with an inline PDF/image/video preview
 *    - PageLink: the target's current title ("Missing page" when it's gone)
 *    - Callout: the variant's icon and a variant switcher
 *    - Details: an open/close toggle (open state is per reader, not stored)
 *  `withNodeViews` swaps them into the shared schema's extension list. */
import type { AnyExtension, Extensions } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
  NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps,
} from '@tiptap/react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ApiError } from '@portal/lib/api';

import { fileType } from '../components/NodeIcon';
import { resolveAssetUrl } from '../lib/assetUrls';
import { getFileUrl, getNode } from '../lib/wikiApi';
import { CALLOUT_VARIANTS, type CalloutVariant } from './extensions/Callout';
import { Icon, type IconName } from './icons';

// ── shared lookups ────────────────────────────────────────────────────

/** undefined while loading, null when not viewable. */
function useAssetUrl(assetId: string | null): string | null | undefined {
  const [url, setUrl] = useState<{ id: string | null; url: string | null } | null>(null);
  useEffect(() => {
    if (!assetId) return undefined;
    let live = true;
    resolveAssetUrl(assetId)
      .then((u) => { if (live) setUrl({ id: assetId, url: u }); })
      .catch(() => { if (live) setUrl({ id: assetId, url: null }); });
    return () => { live = false; };
  }, [assetId]);
  if (!assetId) return null;
  return url?.id === assetId ? url.url : undefined;
}

const TITLE_TTL_MS = 2 * 60_000;
const titles = new Map<string, { at: number; title: Promise<string | null> }>();

/** A node's current title (null: gone or not viewable), cached briefly. */
function nodeTitle(id: string): Promise<string | null> {
  const hit = titles.get(id);
  if (hit && Date.now() - hit.at < TITLE_TTL_MS) return hit.title;
  const title = getNode(id).then((n) => n.title).catch((err) => {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return null;
    titles.delete(id);   // a network failure is retried next time
    throw err;
  });
  titles.set(id, { at: Date.now(), title });
  return title;
}

// ── image ─────────────────────────────────────────────────────────────

const MIN_WIDTH = 120;

function WikiImageView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const { assetId, alt, caption, width } = node.attrs as {
    assetId: string | null; alt: string; caption: string; width: number | null;
  };
  const url = useAssetUrl(assetId);
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
  const [preview, setPreview] = useState<Preview>(undefined);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let live = true;
    setPreview(undefined);
    const done = (url: string | null, type: string) => { if (live) setPreview({ url, type }); };
    if (nodeId) {
      getFileUrl(nodeId, { disposition: 'inline' })
        .then((r) => done(r.url, r.content_type || contentType))
        .catch(() => done(null, contentType));
    } else if (assetId) {
      resolveAssetUrl(assetId).then((u) => done(u, contentType)).catch(() => done(null, contentType));
    } else {
      done(null, contentType);
    }
    return () => { live = false; };
  }, [nodeId, assetId, contentType]);

  const type = fileType(preview?.type ?? contentType, filename);
  const previewable = type === 'pdf' || type === 'image' || type === 'video';
  const missing = preview !== undefined && !preview.url;
  const label = { pdf: 'PDF', image: 'Image', video: 'Video', doc: 'Document', sheet: 'Spreadsheet',
    slides: 'Presentation', other: 'File' }[type];

  return (
    <NodeViewWrapper className={`wiki-file-embed${selected && editor.isEditable ? ' is-selected' : ''}`}
                     data-file-embed="">
      <div className="wiki-file-card" data-drag-handle="">
        <span className={`wiki-file-icon wiki-file-${type}`}><Icon name="file" /></span>
        <span className="wiki-file-text">
          <b title={filename}>{filename || 'Untitled file'}</b>
          <span>{missing ? 'File unavailable' : label}</span>
        </span>
        <span className="wiki-file-actions" contentEditable={false}>
          {previewable && preview?.url && (
            <button type="button" className="we-chip-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <Icon name="eye" />{open ? 'Hide preview' : 'Preview'}
            </button>
          )}
          {nodeId && !missing && (
            <Link className="we-chip-btn" to={`/n/${nodeId}`}><Icon name="external" />Open</Link>
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
          {type === 'image' && <img src={preview.url} alt={filename} draggable={false} />}
          {type === 'pdf' && <iframe src={preview.url} title={`Preview of ${filename}`} loading="lazy" />}
          {type === 'video' && <video src={preview.url} controls preload="metadata" />}
        </div>
      )}
    </NodeViewWrapper>
  );
}

// ── page link ─────────────────────────────────────────────────────────

function PageLinkView({ node }: NodeViewProps) {
  const { nodeId } = node.attrs as { nodeId: string | null; title: string };
  const navigate = useNavigate();
  const [title, setTitle] = useState<{ id: string; title: string | null } | null>(null);

  useEffect(() => {
    if (!nodeId) return undefined;
    let live = true;
    nodeTitle(nodeId)
      .then((t) => { if (live) setTitle({ id: nodeId, title: t }); })
      .catch(() => { if (live) setTitle({ id: nodeId, title: (node.attrs.title as string) || null }); });
    return () => { live = false; };
  }, [nodeId, node.attrs.title]);

  const current = title?.id === nodeId ? title : null;
  if (!nodeId || (current && current.title === null)) {
    return (
      <NodeViewWrapper as="span" className="wiki-page-link missing" title="This page was removed or isn't shared with you">
        <Icon name="pageLink" className="wiki-page-link-icon" />Missing page
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper as="span" className="wiki-page-link">
      <a href={`/n/${nodeId}`} onClick={(e) => { e.preventDefault(); navigate(`/n/${nodeId}`); }}>
        <Icon name="pageLink" className="wiki-page-link-icon" />
        {current ? current.title : (node.attrs.title as string) || 'Loading…'}
      </a>
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

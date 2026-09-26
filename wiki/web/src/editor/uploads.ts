/** Files into the page: pasted or dropped files (and the toolbar's image /
 *  file pickers, via the `uploadFiles` command) upload as page assets —
 *  `startUpload` → PUT to storage → `completeUpload` — and land as a
 *  `wikiImage` (images) or a `fileEmbed` card (anything else).
 *
 *  While a file uploads, a local placeholder (a widget, never part of the
 *  shared document) shows its name and progress where it will land. The
 *  landing spot survives other people's edits: while collaborating it is
 *  kept as a Yjs relative position (y-prosemirror applies every remote
 *  change as a whole-document replace, which a plain mapped position
 *  can't survive), and otherwise as a position mapped through each change.
 *  Files added together land in the order they were added. An upload never
 *  disappears silently: when it can't land where it was dropped it lands
 *  at the cursor, and every failure is reported through `onError`. */
import { Extension, type Editor } from '@tiptap/core';
import type { Node as PMNode, NodeType } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey,
} from 'y-prosemirror';
import type { RelativePosition } from 'yjs';

import { ApiError } from '@portal/lib/api';

import { putUpload } from '../lib/putUpload';
import type { AssetOut } from '../lib/types';
import { completeUpload, errorMessage, startUpload } from '../lib/wikiApi';

export interface FileHandlingOptions {
  /** The page the uploads belong to (their assets are the page's). */
  pageId: string;
  /** A sentence for a toast when an upload fails. */
  onError: (message: string) => void;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    wikiFileHandling: {
      /** Uploads `files` as page assets, inserting each after the block at `pos` (default: the cursor). */
      uploadFiles: (files: File[], pos?: number) => ReturnType;
    };
  }
}

// ── landing spots ───────────────────────────────────────────────────

interface Landing {
  /** Where it lands, kept current through every change. */
  pos: number;
  /** The same spot in the shared Y.Doc (null when not collaborating). */
  rel: RelativePosition | null;
  dom: HTMLElement;
  /** Keeps placeholders at the same spot in the order they were added. */
  order: number;
}

type Landings = ReadonlyMap<string, Landing>;
type Meta = { add: { id: string } & Landing } | { remove: string };

/** The sync binding (Y type + node mapping), once the editor collaborates. */
interface YBinding {
  doc: Parameters<typeof relativePositionToAbsolutePosition>[0];
  type: Parameters<typeof relativePositionToAbsolutePosition>[1];
  mapping: Parameters<typeof relativePositionToAbsolutePosition>[3];
}

function bindingOf(state: EditorState): YBinding | null {
  try {
    return (ySyncPluginKey.getState(state)?.binding as YBinding | undefined) ?? null;
  } catch {
    return null;
  }
}

/** `pos` as a position in the shared Y.Doc — it follows other people's
 *  edits; null when the editor isn't collaborating. */
export function toRelative(state: EditorState, pos: number): RelativePosition | null {
  const binding = bindingOf(state);
  if (!binding) return null;
  try {
    return absolutePositionToRelativePosition(pos, binding.type, binding.mapping);
  } catch {
    return null;
  }
}

/** Where a `toRelative` position is now (null when not collaborating). */
export function fromRelative(state: EditorState, rel: RelativePosition | null): number | null {
  const binding = bindingOf(state);
  if (!binding || !rel) return null;
  try {
    const pos = relativePositionToAbsolutePosition(binding.doc, binding.type, rel, binding.mapping);
    return pos === null ? null : Math.max(0, Math.min(pos, state.doc.content.size));
  } catch {
    return null;
  }
}

const landingsKey = new PluginKey<Landings>('wikiUploadLandings');

const landingsPlugin = new Plugin<Landings>({
  key: landingsKey,
  state: {
    init: () => new Map(),
    apply(tr, landings, _old, state) {
      let next: Map<string, Landing> | null = null;
      if (tr.docChanged && landings.size) {
        // a change from another editor replaced the whole document: read
        // the spot back from the Y.Doc (the binding's mapping is already
        // current when that transaction is applied)
        const remote = !!(tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin;
        next = new Map();
        for (const [id, l] of landings) {
          const fromY = remote ? fromRelative(state, l.rel) : null;
          const pos = fromY ?? Math.min(tr.mapping.map(l.pos), state.doc.content.size);
          next.set(id, { ...l, pos });
        }
      }
      const meta = tr.getMeta(landingsKey) as Meta | undefined;
      if (meta) {
        next ??= new Map(landings);
        if ('add' in meta) {
          const { id, ...landing } = meta.add;
          next.set(id, landing);
        } else {
          next.delete(meta.remove);
        }
      }
      return next ?? landings;
    },
  },
  props: {
    decorations(state) {
      const landings = landingsKey.getState(state);
      if (!landings?.size) return DecorationSet.empty;
      return DecorationSet.create(state.doc, [...landings].map(([id, l]) =>
        Decoration.widget(l.pos, l.dom, { id, key: id, side: l.order })));
    },
  },
});

/** Where upload `id` lands now: from the Y.Doc when collaborating, else
 *  its mapped position; null when it has no spot any more. */
function landingPos(state: EditorState, id: string): number | null {
  const landing = landingsKey.getState(state)?.get(id);
  if (!landing) return null;
  return fromRelative(state, landing.rel) ?? landing.pos;
}

/** Where an upload lands: `pos` itself when it's already between blocks
 *  that may hold a `type` node, else just after the innermost block around
 *  it that may be followed by one. */
function blockInsertPos(doc: PMNode, pos: number, type: NodeType): number {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if (!$pos.parent.isTextblock && $pos.parent.canReplaceWith($pos.index(), $pos.index(), type)) return $pos.pos;
  for (let d = $pos.depth; d > 0; d -= 1) {
    const index = $pos.indexAfter(d - 1);
    if ($pos.node(d - 1).canReplaceWith(index, index, type)) return $pos.after(d);
  }
  return doc.content.size;
}

function placeholderDom(file: File): { dom: HTMLElement; setProgress: (f: number) => void } {
  const dom = document.createElement('div');
  dom.className = 'wiki-upload-placeholder';
  dom.contentEditable = 'false';
  const name = document.createElement('span');
  name.className = 'wiki-upload-name';
  name.textContent = `Uploading ${file.name}…`;
  const bar = document.createElement('span');
  bar.className = 'wiki-upload-bar';
  const fill = document.createElement('span');
  fill.style.width = '0%';
  bar.appendChild(fill);
  dom.append(name, bar);
  return { dom, setProgress: (f) => { fill.style.width = `${Math.round(f * 100)}%`; } };
}

// ── the upload itself ───────────────────────────────────────────────

let seq = 0;

function failureText(file: File, err: unknown): string {
  const reason = err instanceof ApiError ? errorMessage(err, '') : (err as Error)?.message ?? '';
  return reason ? `Couldn't upload “${file.name}”: ${reason}` : `Couldn't upload “${file.name}”. Try again.`;
}

async function transfer(file: File, pageId: string, onProgress: (f: number) => void): Promise<AssetOut> {
  const start = await startUpload({
    target: 'asset',
    page_id: pageId,
    filename: file.name,
    content_type: file.type || 'application/octet-stream',
    size: file.size,
  });
  await putUpload(start.url, start.headers, file, { onProgress });
  return (await completeUpload(start.upload_id)) as AssetOut;
}

function nodeFor(file: File, asset: AssetOut) {
  return file.type.startsWith('image/')
    ? { type: 'wikiImage', attrs: { assetId: asset.id, alt: '', caption: '', width: null } }
    : {
      type: 'fileEmbed',
      attrs: { nodeId: null, assetId: asset.id, filename: asset.filename, contentType: asset.content_type },
    };
}

/** Uploads `files`, each landing after the block at `pos` — in the order given. */
export function uploadFiles(editor: Editor, files: File[], pos: number, opts: FileHandlingOptions): void {
  let turn: Promise<void> = Promise.resolve();
  for (const file of files) {
    const type = editor.schema.nodes[file.type.startsWith('image/') ? 'wikiImage' : 'fileEmbed'];
    seq += 1;
    const id = `upload-${seq}`;
    const { dom, setProgress } = placeholderDom(file);
    const at = blockInsertPos(editor.state.doc, pos, type);
    editor.view.dispatch(editor.state.tr.setMeta(landingsKey, {
      add: { id, pos: at, rel: toRelative(editor.state, at), dom, order: seq },
    }));
    const removePlaceholder = () => {
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(landingsKey, { remove: id }));
    };

    // transfers run side by side; landing waits for the files before it
    const result = transfer(file, opts.pageId, setProgress).then(
      (asset) => ({ asset }),
      (err: unknown) => {
        removePlaceholder();
        opts.onError(failureText(file, err));
        return null;
      },
    );
    turn = turn.then(async () => {
      const done = await result;
      if (!done) return;
      if (editor.isDestroyed) {
        opts.onError(`“${file.name}” was uploaded, but the page closed before it could be added. Add it again.`);
        return;
      }
      const { state } = editor;
      const spot = landingPos(state, id) ?? state.selection.to;
      const landed = editor.chain()
        .command(({ tr }) => { tr.setMeta(landingsKey, { remove: id }); return true; })
        .insertContentAt(blockInsertPos(state.doc, spot, type), nodeFor(file, done.asset),
          { updateSelection: false })
        .run();
      if (!landed) {
        removePlaceholder();
        opts.onError(`“${file.name}” was uploaded, but couldn't be added to the page. Add it again.`);
      }
    }).catch(() => {
      // one file failing to land never holds up the files after it
      removePlaceholder();
      opts.onError(`“${file.name}” was uploaded, but couldn't be added to the page. Add it again.`);
    });
  }
}

function filesOf(data: DataTransfer | null | undefined): File[] {
  return data?.files ? Array.from(data.files) : [];
}

export const FileHandling = Extension.create<FileHandlingOptions>({
  name: 'wikiFileHandling',

  addOptions() {
    return { pageId: '', onError: () => {} };
  },

  addCommands() {
    return {
      uploadFiles: (files, pos) => ({ editor }) => {
        uploadFiles(editor, files, pos ?? editor.state.selection.to, this.options);
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const { editor, options } = this;
    return [
      landingsPlugin,
      new Plugin({
        key: new PluginKey('wikiFileDrop'),
        props: {
          handlePaste: (view, event) => {
            const files = filesOf(event.clipboardData);
            // text with a file (an office app's snapshot image) pastes as text
            if (!files.length || event.clipboardData?.getData('text/plain')) return false;
            uploadFiles(editor, files, view.state.selection.to, options);
            return true;
          },
          handleDrop: (view, event, _slice, moved) => {
            if (moved) return false;
            const files = filesOf(event.dataTransfer);
            if (!files.length) return false;
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            uploadFiles(editor, files, at?.pos ?? view.state.selection.to, options);
            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});

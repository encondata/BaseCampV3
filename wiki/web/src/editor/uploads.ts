/** Files into the page: pasted or dropped files (and the toolbar's image /
 *  file pickers, via the `uploadFiles` command) upload as page assets —
 *  `startUpload` → PUT to storage → `completeUpload` — and land as a
 *  `wikiImage` (images) or a `fileEmbed` card (anything else). While one
 *  uploads, a local placeholder (a widget decoration, never part of the
 *  shared document) shows its name and progress where it will land. */
import { Extension, type Editor } from '@tiptap/core';
import type { Node as PMNode, NodeType } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

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

type Meta = { add: { id: string; pos: number; dom: HTMLElement } } | { remove: string };

const placeholdersKey = new PluginKey<DecorationSet>('wikiUploadPlaceholders');

const placeholders = new Plugin<DecorationSet>({
  key: placeholdersKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      let next = set.map(tr.mapping, tr.doc);
      const meta = tr.getMeta(placeholdersKey) as Meta | undefined;
      if (meta && 'add' in meta) {
        const { id, pos, dom } = meta.add;
        next = next.add(tr.doc, [Decoration.widget(pos, dom, { id, side: 1 })]);
      } else if (meta && 'remove' in meta) {
        next = next.remove(next.find(undefined, undefined, (spec) => spec.id === meta.remove));
      }
      return next;
    },
  },
  props: {
    decorations: (state) => placeholdersKey.getState(state),
  },
});

function placeholderPos(state: EditorState, id: string): number | null {
  const found = placeholdersKey.getState(state)?.find(undefined, undefined, (spec) => spec.id === id);
  return found?.length ? found[0].from : null;
}

/** The position just after the innermost block around `pos` that may be
 *  followed by a `type` node — where an upload lands. */
function blockInsertPos(doc: PMNode, pos: number, type: NodeType): number {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
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

let seq = 0;

async function uploadOne(editor: Editor, file: File, pos: number, opts: FileHandlingOptions): Promise<void> {
  const isImage = file.type.startsWith('image/');
  const type = editor.schema.nodes[isImage ? 'wikiImage' : 'fileEmbed'];
  seq += 1;
  const id = `upload-${seq}`;
  const { dom, setProgress } = placeholderDom(file);
  const at = blockInsertPos(editor.state.doc, pos, type);
  editor.view.dispatch(editor.state.tr.setMeta(placeholdersKey, { add: { id, pos: at, dom } }));
  const removePlaceholder = () => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(placeholdersKey, { remove: id }));
  };

  let asset: AssetOut;
  try {
    const start = await startUpload({
      target: 'asset',
      page_id: opts.pageId,
      filename: file.name,
      content_type: file.type || 'application/octet-stream',
      size: file.size,
    });
    await putUpload(start.url, start.headers, file, { onProgress: setProgress });
    asset = (await completeUpload(start.upload_id)) as AssetOut;
  } catch (err) {
    removePlaceholder();
    const reason = err instanceof ApiError ? errorMessage(err, '') : (err as Error)?.message ?? '';
    opts.onError(reason
      ? `Couldn't upload “${file.name}”: ${reason}`
      : `Couldn't upload “${file.name}”. Try again.`);
    return;
  }
  if (editor.isDestroyed) return;
  const landing = placeholderPos(editor.state, id);
  removePlaceholder();
  if (landing === null) return;
  const node = isImage
    ? { type: 'wikiImage', attrs: { assetId: asset.id, alt: '', caption: '', width: null } }
    : {
      type: 'fileEmbed',
      attrs: { nodeId: null, assetId: asset.id, filename: asset.filename, contentType: asset.content_type },
    };
  editor.chain().insertContentAt(blockInsertPos(editor.state.doc, landing, type), node).run();
}

export function uploadFiles(editor: Editor, files: File[], pos: number, opts: FileHandlingOptions): void {
  files.forEach((file) => { void uploadOne(editor, file, pos, opts); });
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
      placeholders,
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

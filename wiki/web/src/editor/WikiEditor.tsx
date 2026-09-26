/** The live editor: a Y.Doc synced through the wiki server
 *  (`HocuspocusProvider`, document `page:<id>`, the portal access token as
 *  its credential), the shared schema with the editor's node views, and
 *  the chrome around it — toolbar, presence, save state, the reconnecting
 *  banner, the slash menu, the "[[" page picker, the selection bubble and
 *  the image/file/page pickers. Only mounted for people with edit; the
 *  server's answer still decides (a read-only or refused connection calls
 *  `onAccessLost`). */
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import * as Y from 'yjs';

import { useToast } from '@portal/lib/notificationsContext';

import { collabUrl } from '../lib/origins';
import { currentAccessToken } from '../lib/session';
import { CollabStatus, useCollabState } from './collabStatus';
import { withNodeViews } from './nodeViews';
import { insertPageLink, PageLinkMenu, PickerPopover, type PickedNode } from './PagePicker';
import LinkPopover from './LinkPopover';
import PresenceStack from './PresenceStack';
import { wikiExtensions } from './schema';
import SelectionBubble from './SelectionBubble';
import SlashMenu from './SlashMenu';
import { menuPosition } from './suggest';
import { buildToc, HeadingIds, type TocEntry } from './toc';
import Toolbar, { type ToolbarActions } from './Toolbar';
import { FileHandling } from './uploads';
import { Icon } from './icons';

export interface EditorUser {
  name: string;
  color: string;
}

export interface WikiEditorProps {
  pageId: string;
  user: EditorUser;
  /** The server made the connection read-only (`view`) or refused it (`none`). */
  onAccessLost: (level: 'view' | 'none') => void;
  /** The live table of contents, as the document changes. */
  onToc: (toc: TocEntry[]) => void;
  /** Once, when the editor first holds the live document (e.g. to restore a version into it). */
  onFirstSync?: (editor: Editor) => void;
}

const PLACEHOLDER = 'Type “/” for blocks, “[[” to link a page…';

type Anchor = { top: number; left: number };

function CollabEditor({ pageId, doc, provider, user, onToc, onFirstSync }: {
  pageId: string; doc: Y.Doc; provider: HocuspocusProvider; user: EditorUser; onToc: (toc: TocEntry[]) => void;
  onFirstSync?: (editor: Editor) => void;
}) {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const onTocRef = useRef(onToc);
  onTocRef.current = onToc;
  const userRef = useRef(user);
  userRef.current = user;
  const onFirstSyncRef = useRef(onFirstSync);
  onFirstSyncRef.current = onFirstSync;
  const [picker, setPicker] = useState<{ kind: 'page' | 'file'; anchor: Anchor } | null>(null);
  const [linkAt, setLinkAt] = useState<Anchor | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const collabState = useCollabState(provider);

  const cursorAnchor = useCallback((ed: Editor | null): Anchor => (
    ed ? menuPosition(ed, ed.state.selection.from, 380) : { top: 160, left: 160 }), []);

  const extensions = useMemo(() => [
    ...withNodeViews(wikiExtensions({
      collab: { doc, provider, user: userRef.current },
      placeholder: PLACEHOLDER,
    })),
    HeadingIds,
    FileHandling.configure({ pageId, onError: (message) => toastRef.current(message) }),
  ], [doc, provider, pageId]);

  const editor = useEditor({
    extensions,
    editorProps: {
      attributes: { class: 'wiki-prose', 'aria-label': 'Page content', spellcheck: 'true' },
    },
  }, [extensions]);

  // ⌘K / Ctrl+K opens the link editor at the cursor
  useEffect(() => {
    if (!editor) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setLinkAt(cursorAnchor(editor));
      }
    };
    const dom = editor.view.dom;
    dom.addEventListener('keydown', onKey);
    return () => dom.removeEventListener('keydown', onKey);
  }, [editor, cursorAnchor]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.updateUser({ name: user.name, color: user.color });
  }, [editor, user.name, user.color]);

  // the table of contents follows the document (local and remote changes)
  useEffect(() => {
    if (!editor) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const emit = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (!editor.isDestroyed) onTocRef.current(buildToc(editor.getJSON())); }, 250);
    };
    emit();
    editor.on('update', emit);
    return () => { editor.off('update', emit); clearTimeout(timer); };
  }, [editor]);

  // once the live document has first loaded: a new, empty page is ready to
  // type into, and the caller hears about it
  useEffect(() => {
    if (!editor) return undefined;
    let first = true;
    const ready = () => {
      if (!first || editor.isDestroyed) return;
      first = false;
      if (editor.isEmpty) editor.commands.focus('start');
      onFirstSyncRef.current?.(editor);
    };
    const onSynced = ({ state }: { state: boolean }) => { if (state) ready(); };
    provider.on('synced', onSynced);
    // it may have synced before the editor existed
    if (provider.synced) ready();
    return () => { provider.off('synced', onSynced); };
  }, [editor, provider]);

  const actions: ToolbarActions = {
    pickImage: () => imageInput.current?.click(),
    pickFile: () => setPicker({ kind: 'file', anchor: cursorAnchor(editor) }),
    pickPage: () => setPicker({ kind: 'page', anchor: cursorAnchor(editor) }),
    editLink: (anchor) => setLinkAt(anchor),
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length && editor) editor.chain().focus().uploadFiles(files).run();
  };

  const onPick = (node: PickedNode) => {
    const kind = picker?.kind;
    setPicker(null);
    if (!editor) return;
    if (kind === 'page') {
      insertPageLink(editor, node);
    } else {
      editor.chain().focus().insertContent({
        type: 'fileEmbed',
        attrs: { nodeId: node.id, assetId: null, filename: node.title, contentType: '' },
      }).run();
    }
  };
  const closePicker = useCallback(() => setPicker(null), []);
  const closeLink = useCallback(() => setLinkAt(null), []);

  return (
    <div className="we-shell">
      <div className="we-bar">
        {editor && <Toolbar editor={editor} actions={actions} />}
        <div className="we-status">
          <PresenceStack provider={provider} />
          <CollabStatus state={collabState} />
        </div>
      </div>
      {collabState.showBanner && (
        <div className="we-banner" role="status">
          <span className="we-banner-spin" aria-hidden="true" />
          Reconnecting… your changes are kept on this device
        </div>
      )}
      <EditorContent editor={editor} className={`wiki-doc wiki-doc-editing${collabState.dimmed ? ' is-loading' : ''}`} />

      <SlashMenu editor={editor} actions={actions} />
      <PageLinkMenu editor={editor} />
      {editor && <SelectionBubble editor={editor} onLink={setLinkAt} />}
      {editor && linkAt && <LinkPopover editor={editor} anchor={linkAt} onClose={closeLink} />}
      {picker && (
        <PickerPopover
          kind={picker.kind}
          anchor={picker.anchor}
          title={picker.kind === 'page' ? 'Link to a page' : 'Embed a file'}
          onPick={onPick}
          onClose={closePicker}
          extra={picker.kind === 'file' && (
            <button type="button" className="we-menu-item we-menu-action"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setPicker(null); fileInput.current?.click(); }}>
              <span className="we-menu-icon"><Icon name="upload" /></span>
              <span className="we-menu-text"><b>Upload a file…</b><span>From this computer</span></span>
            </button>
          )}
        />
      )}
      <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={onFiles}
             aria-label="Upload images" tabIndex={-1} />
      <input ref={fileInput} type="file" multiple hidden onChange={onFiles} aria-label="Upload files" tabIndex={-1} />
    </div>
  );
}

export default function WikiEditor({ pageId, user, onAccessLost, onToc, onFirstSync }: WikiEditorProps) {
  const [collab, setCollab] = useState<{ doc: Y.Doc; provider: HocuspocusProvider } | null>(null);
  const lostRef = useRef(onAccessLost);
  lostRef.current = onAccessLost;

  useEffect(() => {
    const doc = new Y.Doc();
    // our own socket, so unmounting closes it (a provider given only a url
    // leaves its socket open and reconnecting after destroy())
    const socket = new HocuspocusProviderWebsocket({ url: collabUrl() });
    const provider: HocuspocusProvider = new HocuspocusProvider({
      websocketProvider: socket,
      name: `page:${pageId}`,
      document: doc,
      token: currentAccessToken,
      onAuthenticated: () => {
        if (provider.authorizedScope === 'readonly') lostRef.current('view');
      },
      onAuthenticationFailed: () => lostRef.current('none'),
    });
    setCollab({ doc, provider });
    return () => {
      setCollab(null);
      provider.destroy();
      socket.destroy();
      doc.destroy();
    };
  }, [pageId]);

  if (!collab) return <div className="we-shell"><p className="page-hint">Opening the editor…</p></div>;
  return <CollabEditor key={collab.doc.guid} pageId={pageId} doc={collab.doc} provider={collab.provider}
                       user={user} onToc={onToc} onFirstSync={onFirstSync} />;
}

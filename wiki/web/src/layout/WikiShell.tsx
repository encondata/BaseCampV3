/** The signed-in wiki: system banners, the top bar, the collapsible
 *  sidebar (button or Ctrl/⌘+B, remembered in localStorage) and the routed
 *  page. Owns the dialogs pages and the tree ask for through the shell
 *  context: New page/folder, Delete, Move…, Copy… and Permissions…. */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';

import SystemBanners from '@portal/components/SystemBanners';
import { useToast } from '@portal/lib/notificationsContext';

import ConfirmDialog from '../components/ConfirmDialog';
import MoveCopyDialog from '../components/MoveCopyDialog';
import NewNodeDialog from '../components/NewNodeDialog';
import PermissionsDialog from '../components/PermissionsDialog';
import { atLeast } from '../components/RowMenu';
import { noteDeleted } from '../lib/treeStore';
import type { NodeDetailOut, NodeOut, SpaceOut } from '../lib/types';
import { useWikiMe } from '../lib/useWikiMe';
import { deleteNode, errorMessage, listSpaces } from '../lib/wikiApi';
import Home from '../pages/Home';
import NewSpace from '../pages/NewSpace';
import NodePage from '../pages/NodePage';
import NotFound from '../pages/NotFound';
import SpaceHome from '../pages/SpaceHome';
import SpaceSettings from '../pages/SpaceSettings';
import TrashPage from '../pages/TrashPage';
import { ShellContext, type NewNodeTarget, type ShellValue } from './shellContext';
import Sidebar from './Sidebar';
import TopBar from './TopBar';

// history renders versions with the editor's schema, which loads with the first page
const HistoryPage = lazy(() => import('../history/HistoryPage'));

const SIDEBAR_KEY = 'ss.wiki.sidebar';
const LAST_SPACE_KEY = 'ss.wiki.lastSpace';

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStored(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage off */ }
}

function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target;
  return t instanceof Element && !!t.closest('input, textarea, select, [contenteditable]');
}

export default function WikiShell() {
  const me = useWikiMe();
  const toast = useToast();
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState<SpaceOut[] | null>(null);
  const [currentSpace, setCurrentSpaceState] = useState<SpaceOut | null>(null);
  const [currentNode, setCurrentNode] = useState<NodeDetailOut | null>(null);
  const [collapsed, setCollapsed] = useState(() => readStored(SIDEBAR_KEY) === 'collapsed');
  const [creating, setCreating] = useState<{ target: NewNodeTarget; kind: 'page' | 'folder' } | null>(null);
  const [deleting, setDeleting] = useState<{ node: NodeOut; busy: boolean; error: string } | null>(null);
  const [moving, setMoving] = useState<{ node: NodeOut; mode: 'move' | 'copy' } | null>(null);
  const [permissionsFor, setPermissionsFor] = useState<NodeOut | null>(null);

  const reloadSpaces = useCallback(() => {
    listSpaces().then(setSpaces).catch(() => setSpaces((cur) => cur ?? []));
  }, []);
  useEffect(reloadSpaces, [reloadSpaces]);

  // a space created (or first shared) since the list loaded — asked once
  // per space, since an archived one never shows up in the list
  const reloadedFor = useRef(new Set<string>());
  useEffect(() => {
    if (!currentSpace || !spaces || currentSpace.archived_at) return;
    if (spaces.some((s) => s.key === currentSpace.key) || reloadedFor.current.has(currentSpace.key)) return;
    reloadedFor.current.add(currentSpace.key);
    reloadSpaces();
  }, [currentSpace, spaces, reloadSpaces]);

  const setCurrentSpace = useCallback((space: SpaceOut) => {
    setCurrentSpaceState(space);
    writeStored(LAST_SPACE_KEY, space.key);
    // renamed, recolored or archived since the list loaded
    setSpaces((cur) => {
      if (!cur) return cur;
      const i = cur.findIndex((s) => s.id === space.id);
      if (i < 0) return cur;
      if (space.archived_at) return cur.filter((s) => s.id !== space.id);
      return cur[i].updated_at === space.updated_at && cur[i].my_level === space.my_level
        ? cur : cur.map((s, j) => (j === i ? space : s));
    });
  }, []);

  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      writeStored(SIDEBAR_KEY, c ? 'open' : 'collapsed');
      return !c;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'b' && !isTypingTarget(e)) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

  // the sidebar follows the space on screen, else the last one visited
  const sidebarSpace = useMemo(() => {
    if (currentSpace) return currentSpace;
    const last = readStored(LAST_SPACE_KEY);
    return spaces?.find((s) => s.key === last) ?? null;
  }, [currentSpace, spaces]);

  const activeNode = currentNode && currentNode.space_key === sidebarSpace?.key ? currentNode : null;
  const revealIds = useMemo(
    () => (activeNode?.breadcrumbs ?? []).flatMap((b) => (b.id ? [b.id] : [])),
    [activeNode],
  );

  const openNewNode = useCallback((target: NewNodeTarget, kind: 'page' | 'folder') => {
    setCreating({ target, kind });
  }, []);

  /** Where the top bar's New page/folder lands: inside the folder on
   *  screen, beside the page or file on screen, else the space's top level. */
  const newTarget = useMemo((): NewNodeTarget | null => {
    if (activeNode) {
      if (activeNode.kind === 'folder') {
        return atLeast(activeNode.my_level, 'edit')
          ? { spaceId: activeNode.space_id, parentId: activeNode.id, parentTitle: activeNode.title }
          : null;
      }
      const parent = activeNode.breadcrumbs.at(-1);
      return {
        spaceId: activeNode.space_id,
        parentId: activeNode.parent_id,
        parentTitle: parent?.id ? parent.title : activeNode.space.name,
      };
    }
    if (sidebarSpace && atLeast(sidebarSpace.my_level, 'edit')) {
      return { spaceId: sidebarSpace.id, parentId: null, parentTitle: sidebarSpace.name };
    }
    return null;
  }, [activeNode, sidebarSpace]);

  const requestDelete = useCallback((node: NodeOut) => setDeleting({ node, busy: false, error: '' }), []);

  const confirmDelete = async () => {
    if (!deleting) return;
    const { node } = deleting;
    setDeleting({ node, busy: true, error: '' });
    try {
      const { count } = await deleteNode(node.id);
      setDeleting(null);
      toast(`Moved ${count} ${count === 1 ? 'item' : 'items'} to the trash.`);
      noteDeleted(node);
      const showing = currentNode
        && (currentNode.id === node.id || currentNode.breadcrumbs.some((b) => b.id === node.id));
      if (showing) navigate(node.parent_id ? `/n/${node.parent_id}` : `/s/${node.space_key}`);
    } catch (err) {
      setDeleting({ node, busy: false, error: errorMessage(err, `Couldn't delete “${node.title}”.`) });
    }
  };

  const requestMove = useCallback((node: NodeOut) => setMoving({ node, mode: 'move' }), []);
  const requestCopy = useCallback((node: NodeOut) => setMoving({ node, mode: 'copy' }), []);
  const requestPermissions = useCallback((node: NodeOut) => setPermissionsFor(node), []);
  const closeMoving = useCallback(() => setMoving(null), []);
  const closePermissions = useCallback(() => setPermissionsFor(null), []);

  const shell = useMemo<ShellValue>(() => ({
    setCurrentNode,
    setCurrentSpace,
    openNewNode,
    requestDelete,
    requestMove,
    requestCopy,
    requestPermissions,
  }), [setCurrentSpace, openNewNode, requestDelete, requestMove, requestCopy, requestPermissions]);

  return (
    <ShellContext.Provider value={shell}>
      <div className="wiki-shell" data-sidebar={collapsed ? 'collapsed' : 'open'}>
        <SystemBanners />
        <TopBar
          me={me}
          spaces={spaces}
          currentSpace={sidebarSpace}
          sidebarCollapsed={collapsed}
          onShowSidebar={toggleSidebar}
          onNew={newTarget ? (kind) => openNewNode(newTarget, kind) : null}
        />
        <div className="wiki-body">
          {!collapsed && (
            <Sidebar
              space={sidebarSpace}
              spaces={spaces}
              activeId={activeNode?.id ?? null}
              revealIds={revealIds}
              onCollapse={toggleSidebar}
              onNewAtRoot={(s) => openNewNode({ spaceId: s.id, parentId: null, parentTitle: s.name }, 'page')}
              onNewChild={(parent, kind) => openNewNode(
                { spaceId: parent.space_id, parentId: parent.id, parentTitle: parent.title }, kind)}
            />
          )}
          <main className="wiki-main">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/spaces/new" element={<><Home /><NewSpace /></>} />
              <Route path="/s/:spaceKey" element={<SpaceHome />} />
              <Route path="/s/:spaceKey/settings" element={<SpaceSettings />} />
              <Route path="/trash/:spaceKey" element={<TrashPage />} />
              <Route path="/n/:nodeId" element={<NodePage />} />
              <Route path="/n/:nodeId/history" element={(
                <Suspense fallback={<div className="portal-page wiki-page"><p className="page-hint">Loading…</p></div>}>
                  <HistoryPage />
                </Suspense>
              )} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>
        </div>
      </div>

      {creating && (
        <NewNodeDialog kind={creating.kind} spaceId={creating.target.spaceId} parentId={creating.target.parentId}
                       parentTitle={creating.target.parentTitle} onClose={() => setCreating(null)} />
      )}
      {moving && <MoveCopyDialog node={moving.node} mode={moving.mode} onClose={closeMoving} />}
      {permissionsFor && (
        <PermissionsDialog target={{ kind: 'node', node: permissionsFor }} onClose={closePermissions} />
      )}
      {deleting && (
        <ConfirmDialog
          eyebrow="Delete"
          title={`Delete “${deleting.node.title}”?`}
          description={deleting.node.kind === 'folder'
            ? 'The folder and everything in it move to the space\'s trash, where a space manager can restore them.'
            : 'It moves to the space\'s trash, where a space manager can restore it.'}
          confirmLabel="Move to trash"
          busyLabel="Deleting…"
          danger
          busy={deleting.busy}
          error={deleting.error}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </ShellContext.Provider>
  );
}

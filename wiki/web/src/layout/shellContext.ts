/** What pages tell the shell (which space and node are showing) and the
 *  shell-owned actions they can ask for — the one way the tree, the page
 *  header's ⋯ menu and any other caller open the Delete, Move, Copy and
 *  Permissions dialogs. Outside a WikiShell (tests) every member is a
 *  harmless no-op. */
import { createContext, useContext } from 'react';

import type { NodeDetailOut, NodeOut, SpaceOut } from '../lib/types';

export interface NewNodeTarget {
  spaceId: string;
  spaceKey: string;
  parentId: string | null;
  parentTitle: string;
}

export interface ShellValue {
  /** The page being shown (for the tree highlight and the New menu). */
  setCurrentNode: (node: NodeDetailOut | null) => void;
  /** The space being shown (the sidebar tree follows it). */
  setCurrentSpace: (space: SpaceOut) => void;
  /** `startStep: 'template'` opens a new page straight on the template
   *  picker (the top bar's "From template…"), rather than the title field. */
  openNewNode: (target: NewNodeTarget, kind: 'page' | 'folder', startStep?: 'template') => void;
  requestDelete: (node: NodeOut) => void;
  requestMove: (node: NodeOut) => void;
  requestCopy: (node: NodeOut) => void;
  requestPermissions: (node: NodeOut) => void;
}

const noop = () => {};

export const ShellContext = createContext<ShellValue>({
  setCurrentNode: noop,
  setCurrentSpace: noop,
  openNewNode: noop,
  requestDelete: noop,
  requestMove: noop,
  requestCopy: noop,
  requestPermissions: noop,
});

export function useWikiShell(): ShellValue {
  return useContext(ShellContext);
}

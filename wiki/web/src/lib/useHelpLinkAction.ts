/** The page and file header ⋯ menu's "Use as help for…": for wiki admins,
 *  a handler that opens the Help links page's add form with this node as
 *  the guide; for everyone else, undefined (so the menu leaves it out). */
import { useNavigate } from 'react-router-dom';

import { useWikiMe } from './useWikiMe';

export function useHelpLinkAction(nodeId: string): (() => void) | undefined {
  const me = useWikiMe();
  const navigate = useNavigate();
  if (!me?.is_admin) return undefined;
  return () => navigate(`/admin/help-links?node=${encodeURIComponent(nodeId)}`);
}

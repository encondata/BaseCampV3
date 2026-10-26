import { useAuth } from '../../auth/AuthContext';
import { canManageLearning, type Action } from '../../lib/access';

/** What the signed-in user may do in Learning, per the API's own rule
 *  (`learning:<action>` or a global wiki:delete). The server still decides;
 *  this only keeps the page from offering a control it would refuse. */
export function useLearningAccess(): (action: Action) => boolean {
  const { can, scope } = useAuth();
  const isGlobal = scope?.global ?? true;
  return (action) => canManageLearning({ can, isGlobal }, action);
}

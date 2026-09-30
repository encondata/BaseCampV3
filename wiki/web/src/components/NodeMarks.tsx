/** What sets a private or no-print item apart. Tree rows and list rows get
 *  the lock (`PrivateMark`); a page, file or folder header gets chips
 *  (`NodeChips`): "Private", and "Printing off" when printing isn't
 *  allowed for the caller. */
import { Icon } from '../editor/icons';
import type { NodeOut } from '../lib/types';

/** The lock beside a private item's name; nothing for any other item. */
export function PrivateMark({ node }: { node: Pick<NodeOut, 'is_private'> }) {
  if (!node.is_private) return null;
  return (
    <span className="wiki-private-mark" role="img" aria-label="Private" title="Private">
      <Icon name="lock" className="wiki-private-icon" />
    </span>
  );
}

export function NodeChips({ node }: { node: Pick<NodeOut, 'kind' | 'is_private' | 'can_print'> }) {
  if (!node.is_private && node.can_print) return null;
  const noun = node.kind === 'folder' ? 'folder' : node.kind === 'file' ? 'file' : 'page';
  return (
    <>
      {node.is_private && (
        <span className="chip c-amber wiki-private-chip" title="Only its author and developers can see this.">
          <Icon name="lock" className="wiki-private-icon" />Private
        </span>
      )}
      {!node.can_print && (
        <span className="chip wiki-printing-chip" title={`Printing is turned off for this ${noun}.`}>
          <span className="dot" />Printing off
        </span>
      )}
    </>
  );
}

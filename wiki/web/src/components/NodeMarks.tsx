/** What sets a private or no-print item apart. Tree rows and list rows get
 *  the lock (`PrivateMark`); a page, file or folder header gets chips
 *  (`NodeChips`): "Private", and "Printing off" when printing isn't
 *  allowed for the caller. Private here means private itself or inside a
 *  private folder (`in_private`). */
import { Icon } from '../editor/icons';
import type { NodeOut } from '../lib/types';

type PrivacyFields = Pick<NodeOut, 'is_private' | 'in_private'>;

function isPrivate(node: PrivacyFields): boolean {
  return node.in_private || node.is_private;
}

/** The lock beside a private item's name; nothing for any other item. */
export function PrivateMark({ node }: { node: PrivacyFields }) {
  if (!isPrivate(node)) return null;
  return (
    <span className="wiki-private-mark" role="img" aria-label="Private" title="Private">
      <Icon name="lock" className="wiki-private-icon" />
    </span>
  );
}

export function NodeChips({ node }: { node: PrivacyFields & Pick<NodeOut, 'kind' | 'can_print'> }) {
  const priv = isPrivate(node);
  if (!priv && node.can_print) return null;
  const noun = node.kind === 'folder' ? 'folder' : node.kind === 'file' ? 'file' : 'page';
  return (
    <>
      {priv && (
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

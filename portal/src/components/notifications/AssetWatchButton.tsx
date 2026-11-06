/**
 * AssetWatchButton — the Watch / Watching button in the header of the asset page and the move
 * asset page. It looks like WatchButton (components/notifications/WatchButton.tsx), the Watch
 * button of an initiative, site or truck page, and reads like it: whether the person watches
 * the asset themselves in this place (on its own, or on `initiativeId`), renders nothing until
 * that is known, and a failure to read it counts as not watching.
 *
 * Unlike WatchButton a click does not toggle: an asset watch has a choice to make (its next
 * update, or a status), so it opens the Watch modal, on the person's watch when they have one
 * (Save, Stop watching). What the modal saves or stops is what the button then shows, with no
 * read again: `onSaved` hands over the watch, or null once it was stopped (or found ended).
 *
 * The modal is portaled to the enclosing .portal-page, out of the page header's action row, whose
 * rules (`.idet-header-actions .mini-btn`) would resize the buttons of a dialog opened inside it,
 * but still under the page's header styles (`.portal-page .eyebrow`, `.portal-page .page-hint`),
 * as a modal a row menu opens is. Without a page it goes to the enclosing .portal-shell, where the
 * theme tokens are declared, and without one to document.body. An answer or a save that comes
 * back after the page has moved to another asset or place is not this button's to show, and a
 * modal left open on the old one is closed.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getAssetWatchState, type AssetWatch } from '../../lib/api';
import WatchAssetModal from './WatchAssetModal';
import '../../styles/notifications.css';  // .watch-btn.on, and its size in a page header

export default function AssetWatchButton({
  assetId, assetName, initiativeId, initiativeName, currentStatus, currentStatusLabel,
}: {
  assetId: string;
  /** The asset as the notices name it: its serial number, else its name, else its id. */
  assetName: string;
  /** The initiative the watch is set on; none for a watch on the asset itself. */
  initiativeId?: string | null;
  initiativeName?: string | null;
  /** The status the watch reads now: the asset's own, or its status on the initiative. */
  currentStatus: string | null;
  currentStatusLabel: string | null;
}) {
  // The person's watch of the asset here, once it is known (null: they have none).
  const [state, setState] = useState<{ watch: AssetWatch | null } | null>(null);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The place the button is on right now, as the page moves from one asset (or initiative) to
  // another.
  const inInitiative = initiativeId ?? null;
  const place = `${assetId}:${inInitiative ?? ''}`;
  const shown = useRef(place);
  shown.current = place;

  useEffect(() => {
    let live = true;
    setState(null);
    setOpen(false);
    getAssetWatchState(assetId, inInitiative)
      .then((s) => { if (live) setState({ watch: s.watch }); })
      .catch(() => { if (live) setState({ watch: null }); });
    return () => { live = false; };
  }, [assetId, inInitiative]);

  if (!state) return null;

  const watching = state.watch !== null;
  const button = buttonRef.current;
  const host = button?.closest<HTMLElement>('.portal-page')
    ?? button?.closest<HTMLElement>('.portal-shell') ?? document.body;

  return (
    <>
      <button ref={buttonRef} type="button" className={`btn-ghost watch-btn${watching ? ' on' : ''}`}
              aria-pressed={watching} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
          <circle cx="12" cy="12" r="2.8" />
        </svg>
        {watching ? 'Watching' : 'Watch'}
      </button>
      {open && createPortal(
        <WatchAssetModal
          assetId={assetId} assetName={assetName}
          initiativeId={initiativeId} initiativeName={initiativeName}
          currentStatus={currentStatus} currentStatusLabel={currentStatusLabel}
          watch={state.watch}
          onClose={() => { if (shown.current === place) setOpen(false); }}
          onSaved={(watch) => { if (shown.current === place) setState({ watch }); }} />,
        host,
      )}
    </>
  );
}

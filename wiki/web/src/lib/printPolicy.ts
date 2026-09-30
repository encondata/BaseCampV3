/** Whether the node being shown may be printed, downloaded or exported
 *  (`NodeOut.can_print`). A page or file view provides it around its
 *  content so the editor's node views and the image viewer — which sit
 *  several layers down — can drop their download links, context menus and
 *  native media controls without each being handed a prop. Defaults to
 *  true (a public share link can't exist for a node that can't print). */
import { createContext, useContext } from 'react';

export const CanPrintContext = createContext(true);

export function useCanPrint(): boolean {
  return useContext(CanPrintContext);
}

const noMenu = (e: { preventDefault(): void }) => e.preventDefault();

/** Extra props for a <video> or <audio> whose file can't be printed: no
 *  download or playback-rate control, no picture-in-picture, no context
 *  menu. Spread it only when `can_print` is false. */
export const MEDIA_LOCKED: Record<string, unknown> = {
  controlsList: 'nodownload noplaybackrate',
  disablePictureInPicture: true,
  onContextMenu: noMenu,
};

/** Extra props for an <img> whose page can't be printed: no context menu
 *  (Save image as…) and no dragging it out. */
export const IMAGE_LOCKED: Record<string, unknown> = { draggable: false, onContextMenu: noMenu };

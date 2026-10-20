/**
 * The worker's time clock QR — people.badge_uid drawn as a QR code. The
 * kiosk time clock reads it to identify the worker. BadgeQr is the
 * on-screen image (Profile › My QR code); printBadgeQr opens the printable
 * card (name above the QR, the Badge ID below) from the worker page.
 */
import { qrDataUrl } from '../../lib/qr';

export function BadgeQr({ badgeUid, size = 240 }: { badgeUid: string; size?: number }) {
  return (
    <img
      alt="Your time clock QR code"
      src={qrDataUrl(badgeUid)}
      width={size}
      height={size}
      style={{ display: 'block', imageRendering: 'pixelated' }}
    />
  );
}

// The name is user data written into a window we open, so it is escaped.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const CARD_CSS = `
  @page { margin: 0.5in; }
  body { margin: 0; font-family: system-ui, sans-serif; color: #111827;
         background: #fff; text-align: center; }
  h1 { font-size: 28pt; margin: 0.6in 0 0.3in; font-weight: 600; }
  img { width: 3.2in; height: 3.2in; image-rendering: pixelated; }
  .uid { margin-top: 0.2in; font-family: ui-monospace, Menlo, Consolas, monospace;
         font-size: 9pt; color: #374151; }
`;

export function printBadgeQr({ name, badgeUid }: { name: string; badgeUid: string }) {
  const win = window.open('', '_blank');
  if (!win) return; // popup blocked — quiet no-op
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8">`
    + `<title>${esc(name)} — time clock QR</title>`
    + `<style>${CARD_CSS}</style></head><body>`
    + `<h1>${esc(name)}</h1>`
    + `<img alt="" src="${esc(qrDataUrl(badgeUid))}">`
    + `<div class="uid">${esc(badgeUid)}</div>`
    + `<script>window.onload = () => { window.print(); };</script>`
    + `</body></html>`,
  );
  win.document.close();
}

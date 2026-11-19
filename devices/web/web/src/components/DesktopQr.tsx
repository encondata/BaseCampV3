/** Installs happen on the phone: off it (a desktop, or a phone of the
 *  other platform) a card shows this page's address as a QR code. */
import { useMemo } from 'react';

import { qrDataUrl } from '@portal/lib/qr';

export default function DesktopQr() {
  const src = useMemo(() => {
    try {
      return qrDataUrl(location.href);
    } catch {
      return null;   // no canvas: the sentence still says what to do
    }
  }, []);
  return (
    <div className="devices-qr">
      {src && <img src={src} alt="QR code for this page" width={96} height={96} />}
      <p className="page-hint">Open this page on the phone to install.</p>
    </div>
  );
}

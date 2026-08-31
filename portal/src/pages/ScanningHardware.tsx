/** Scanning Hardware placeholders — one shell, three pages. Each device
 *  family (handhelds, fixed readers, kiosks) gets its own real spec/
 *  build later; these just claim the routes and copy. Routers has its
 *  own real page now — see pages/Routers.tsx. */

import '../styles/directory.css';

function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Scanning Hardware</div>
          <h1 className="page-title">{title}</h1>
          <p className="page-hint">{hint}</p>
        </div>
      </div>
      <div className="dir-empty">
        Nothing here yet — device records land when this section is built out.
      </div>
    </div>
  );
}

export function HandheldReaders() {
  return <Placeholder title="Handheld Readers"
                      hint="Android, iOS, and Zebra (Android) handheld scanners." />;
}

export function FixedReaders() {
  return <Placeholder title="Fixed Readers"
                      hint="Zebra FX9600 fixed RFID readers." />;
}

export function KioskDevices() {
  return <Placeholder title="Kiosk Devices"
                      hint="Web and iOS (iPad) kiosk stations." />;
}

/** Settings › Devices: one card per device type (RFID reader, label
 *  printer, barcode scanner), two columns on wide screens and one on
 *  narrow ones; the scanner card spans the full width. Each card polls or
 *  listens only while this panel is mounted. */

import ReaderCard from './ReaderCard';
import ScannerCard from './ScannerCard';

export default function DevicesPanel() {
  return (
    <div className="devices-grid">
      <ReaderCard />
      {/* ── Label printer slot (Task 3): render <PrinterCard /> here, between
           the reader and the scanner. ── */}
      <ScannerCard />
    </div>
  );
}

/** Printing Your Badge — a placeholder until real badge printing lands:
 *  the flow moves on to Verify after PRINTING_MS. */

import { IconPrinter } from '../icons';

export default function PrintingBadge() {
  return (
    <section className="tcx-screen tcx-printing">
      <h1 className="tcx-title">Printing Your Badge</h1>
      <p className="tcx-lead">Please wait while we print your badge…</p>
      <IconPrinter className="tcx-art" />
      <span className="tcx-spinner" role="status" aria-label="Printing" />
    </section>
  );
}

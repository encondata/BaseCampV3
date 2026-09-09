/** Placeholder for the Generate flow — the real three-step modal
 *  (initiative picker, section picks, progress + download) lands in
 *  Task 9. It renders nothing so the Reports page can already wire the
 *  "Generate" row action to it. */
import type { ReportDefinition } from '../../lib/api';

export default function GenerateReportModal(_props: {
  definition: ReportDefinition;
  onClose: () => void;
}) {
  return null;
}

import type { KioskConfig } from '../../../lib/kioskConfig';

/** What every section card on the Settings tab receives. */
export interface SectionProps {
  /** The document being shown: the stored config, or the defaults. */
  config: KioskConfig;
  kioskName: string;
  /** The card's source line, already worded. */
  source: string | null;
  /** Set only for a super admin who may edit this kiosk. Resolves once the
   *  whole document (with this section replaced) is stored; rejects with
   *  the ApiError otherwise. */
  onSave?: (section: string, value: unknown) => Promise<void>;
  /** Re-fetch the kiosk (after a stale-version 409). */
  onReload?: () => Promise<void>;
}

/** The Label Printing entry screen's sections: what its launcher tiles
 *  link to, and what each section placeholder page shows. Mirrors the
 *  shape of `KioskFeature` (see `features.ts`) but scoped to `/labels/*`. */

export interface LabelSection {
  id: 'station' | 'bulk' | 'printers';
  path: string;
  title: string;
  blurb: string;
}

export const LABEL_SECTIONS: LabelSection[] = [
  { id: 'station', path: '/labels/station', title: 'Printing Station', blurb: 'Scan an asset and print its labels.' },
  { id: 'bulk', path: '/labels/bulk', title: 'Bulk Print', blurb: 'Print labels for a whole move, rack, or list.' },
  { id: 'printers', path: '/labels/printers', title: 'Printer Setup / Troubleshooting', blurb: 'Connect, align, and test the label printer.' },
];

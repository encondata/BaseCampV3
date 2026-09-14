/** The kiosk's feature registry: what the Home launcher tiles link to,
 *  what routes exist, and what the top bar's section label reads.
 *  Permission gating of tiles is deferred (see spec). */

export interface KioskFeature {
  id: 'scan' | 'labels' | 'timeclock';
  path: string;
  title: string;
  blurb: string;
}

export const FEATURES: KioskFeature[] = [
  { id: 'scan', path: '/scan', title: 'Scanning', blurb: 'Scan assets, containers, and badges.' },
  { id: 'labels', path: '/labels', title: 'Label Printing', blurb: 'Print asset and container labels.' },
  { id: 'timeclock', path: '/timeclock', title: 'Timeclock', blurb: 'Clock in and out of a move.' },
];

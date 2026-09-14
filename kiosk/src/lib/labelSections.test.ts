import { expect, it } from 'vitest';

import { LABEL_SECTIONS } from './labelSections';

it('lists the three sections in order: station, bulk, printers', () => {
  expect(LABEL_SECTIONS.map((s) => s.id)).toEqual(['station', 'bulk', 'printers']);
});

it('gives each section its path, title, and blurb', () => {
  expect(LABEL_SECTIONS).toEqual([
    { id: 'station', path: '/labels/station', title: 'Printing Station', blurb: 'Scan an asset and print its labels.' },
    { id: 'bulk', path: '/labels/bulk', title: 'Bulk Print', blurb: 'Print labels for a whole move, rack, or list.' },
    { id: 'printers', path: '/labels/printers', title: 'Printer Setup / Troubleshooting', blurb: 'Connect, align, and test the label printer.' },
  ]);
});

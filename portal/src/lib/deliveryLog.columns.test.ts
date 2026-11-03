/** The Delivery log list (components/notifications/DeliveryLogTab.tsx) lives
 *  inside the auth shell, so its fit check runs against the pure column
 *  registry here, as SystemProcesses.columns.test.ts does (recipe R7). */
import { describe, expect, it } from 'vitest';

import { DELIVERY_LOG_COLUMNS, DELIVERY_LOG_TRAILING } from './deliveryLog';
import { LIST_FIT, columnFloor, listGridStyle, listScale } from './listTools';

describe('Delivery log columns', () => {
  it('default columns plus the chevron fit .portal-page at a 1512px window, nav expanded', () => {
    const defaults = DELIVERY_LOG_COLUMNS.filter((c) => c.default);
    expect(listGridStyle(defaults, DELIVERY_LOG_TRAILING).minWidth).toBeLessThanOrEqual(LIST_FIT.page);
  });

  it('lists When, Person, Notification, Category, Channel, Outcome and Detail, all shown by default', () => {
    expect(DELIVERY_LOG_COLUMNS.map((c) => c.label)).toEqual([
      'When', 'Person', 'Notification', 'Category', 'Channel', 'Outcome', 'Detail',
    ]);
    expect(DELIVERY_LOG_COLUMNS.every((c) => c.default)).toBe(true);
  });

  it('gives the Category column room for its longest chip ("Approvals & requests")', () => {
    const category = DELIVERY_LOG_COLUMNS.find((c) => c.key === 'category');
    expect(category && columnFloor(category)).toBeGreaterThanOrEqual(156);
  });

  it('gives the Outcome column room for its longest chip ("Held for summary") at every list size', () => {
    const outcome = DELIVERY_LOG_COLUMNS.find((c) => c.key === 'outcome');
    expect(outcome).toBeTruthy();
    // Measured in Chromium (Geologica 12px, weight 500): the chip's text is 105px at the
    // default list size and scales with it; its 20px of padding and border does not. So the
    // smallest size, where the text shrinks and the padding does not, needs the most floor.
    const CHIP_TEXT = 105;
    const CHIP_PADDING = 20;
    for (const size of ['small', 'default', 'large', 'xlarge']) {
      const scale = listScale(size);
      const track = listGridStyle([outcome!], [], undefined, scale).gridTemplateColumns;
      const floor = Number(/minmax\((\d+)px/.exec(track)?.[1]);
      expect(floor, size).toBeGreaterThanOrEqual(Math.ceil(CHIP_TEXT * scale + CHIP_PADDING));
    }
  });
});

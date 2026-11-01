/** The Delivery log list (components/notifications/DeliveryLogTab.tsx) lives
 *  inside the auth shell, so its fit check runs against the pure column
 *  registry here, as SystemProcesses.columns.test.ts does (recipe R7). */
import { describe, expect, it } from 'vitest';

import { DELIVERY_LOG_COLUMNS, DELIVERY_LOG_TRAILING } from './deliveryLog';
import { LIST_FIT, columnFloor, listGridStyle } from './listTools';

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
});

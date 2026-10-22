/**
 * Container label tag keys (labels/tags.py): the five tags the Container
 * Labels PDF assigns per container, their bulk-create assignment order and
 * their display labels.
 *
 * Pure: no DOM, no Intl, no Node.
 */

import { pyStrip } from './py';

export const LABEL_TAG_KEYS = ['priority', 'vendor', 'accessories', 'ewaste', 'warehouse'] as const;

export type LabelTag = (typeof LABEL_TAG_KEYS)[number];

/** Bulk-create assignment order: deliberately not LABEL_TAG_KEYS' order. */
export const LABEL_TAG_ASSIGNMENT_ORDER: readonly LabelTag[] = [
  'priority', 'vendor', 'accessories', 'warehouse', 'ewaste',
];

/** Display labels, for by-label matching (e.g. "E-Waste"). */
export const LABEL_TAG_LABELS: Readonly<Record<LabelTag, string>> = {
  priority: 'Priority',
  vendor: 'Vendor',
  accessories: 'Accessories',
  ewaste: 'E-Waste',
  warehouse: 'Warehouse',
};

/** Case-insensitive match against either the key or the display label
 *  ("ewaste" or "E-Waste" both resolve to "ewaste"); null for neither. */
export function resolveLabelTag(raw: string): LabelTag | null {
  const value = pyStrip(raw).toLowerCase();
  const key = LABEL_TAG_KEYS.find((k) => k === value);
  if (key) return key;
  for (const k of LABEL_TAG_KEYS) {
    if (LABEL_TAG_LABELS[k].toLowerCase() === value) return k;
  }
  return null;
}

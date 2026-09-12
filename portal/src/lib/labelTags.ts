/**
 * LABEL_TAG_OPTIONS — the five real container label tags (key/label/color),
 * for the Containers list's "Label tag" column/facet and its edit modal's
 * picker. Sourced from `labels/tagTypes.ts` directly — NOT
 * `labels/containerLabelSheet.ts`, which imports jsPDF at module scope —
 * so the Containers page doesn't pull the PDF drawing module's heavy
 * dependencies (jspdf, bwip-js) into its bundle merely to show a colored
 * chip. `'none'` (a `TagKey` member `TAG_TYPES` carries for the drawing
 * routine's own harmless fallback) is deliberately excluded here: "no
 * tag" is the absence of `label_tag` (`null`), matching
 * `lib/containerLabels.ts`'s own `TAG_CHOICES` convention.
 */
import { TAG_TYPES, type TagKey } from '../labels/tagTypes';

export interface LabelTagOption {
  key: TagKey;
  label: string;
  color: string;
}

const KEYS: TagKey[] = ['priority', 'vendor', 'accessories', 'ewaste', 'warehouse'];

export const LABEL_TAG_OPTIONS: LabelTagOption[] = KEYS.map((key) => ({
  key, label: TAG_TYPES[key].label, color: TAG_TYPES[key].color,
}));

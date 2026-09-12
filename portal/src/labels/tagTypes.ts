/**
 * Container label tag definitions (V2's `TAG_TYPES`) — split out of
 * `containerLabelSheet.ts` because that module imports jsPDF at module
 * scope. Callers that only need the tag keys/labels/colors — the
 * Containers list column/facet, the edit modal's picker, and
 * `lib/labelTags.ts`'s `LABEL_TAG_OPTIONS` — import from here instead, so
 * they don't pull in the PDF drawing module's heavy dependencies just to
 * show a colored chip. `containerLabelSheet.ts` re-exports these for its
 * own existing importers (the Container Labels page, `ContainerPickList`,
 * `ContainerTagPicker`), so nothing else needs to change its import path.
 */

export type TagKey = 'none' | 'priority' | 'vendor' | 'accessories' | 'ewaste' | 'warehouse';

export interface TagDefinition {
  label: string;
  color: string;
  qrColor: string;
  image: string | null;
}

// Tag type definitions
export const TAG_TYPES: Record<TagKey, TagDefinition> = {
  none: { label: 'None', color: '#000000', qrColor: '000000', image: null },
  priority: { label: 'Priority', color: '#f5222d', qrColor: 'CC0000', image: '/images/priority-tag.png' },
  vendor: { label: 'Vendor', color: '#1890ff', qrColor: '1890ff', image: '/images/vendor-tag.png' },
  accessories: { label: 'Accessories', color: '#722ed1', qrColor: '722ed1', image: '/images/accessories-tag.png' },
  ewaste: { label: 'E-Waste', color: '#fa8c16', qrColor: 'e08200', image: '/images/e-waste-tag.png' },
  warehouse: { label: 'Warehouse', color: '#d4b106', qrColor: 'b89e00', image: '/images/warehouse-tag.png' },
};

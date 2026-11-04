/**
 * Printers › Test labels › Mock-data label: which templates the dialog
 * offers and which row of one prints at a DPI. One option per family and
 * label type, the key Labels › Templates' one-active rule uses, so an
 * option has at most one active row per DPI. A builder parent is never
 * printed itself: its DPI children are. Only Zebra (`zpl`) rows are listed,
 * since these are Zebra tools; Old and inactive rows never are.
 */
import type { LabelTemplate, LabelTemplateTreeNode } from '../lib/api';
import { isTreeParent } from '../lib/labels';
import { naturalCompare } from '../lib/naturalSort';

export interface MockTemplateOption {
  /** `${family}|${labelType}` */
  key: string;
  family: string;
  labelType: string;
  /** The family and the label type's label: "Generic Rack and RU · Top". */
  label: string;
  /** The printable rows, by `dpi_key`. */
  versions: Record<string, LabelTemplate>;
}

export function mockTemplateOptions(tree: LabelTemplateTreeNode[], typeLabels: Record<string, string>): MockTemplateOption[] {
  const groups = new Map<string, MockTemplateOption>();
  for (const node of tree) {
    const rows: LabelTemplate[] = isTreeParent(node) ? node.children : [node];
    for (const row of rows) {
      if (!row.is_active || row.is_old || row.language_key !== 'zpl') continue;
      const key = `${node.family}|${row.label_type}`;
      let option = groups.get(key);
      if (!option) {
        option = {
          key, family: node.family, labelType: row.label_type,
          label: `${node.family} · ${typeLabels[row.label_type] ?? row.label_type}`, versions: {},
        };
        groups.set(key, option);
      }
      option.versions[row.dpi_key] ??= row;
    }
  }
  return [...groups.values()].sort((a, b) => naturalCompare(a.label, b.label));
}

/** The row that prints at `dpiKey`, or null when the template has none. */
export function versionAt(option: MockTemplateOption, dpiKey: string): LabelTemplate | null {
  return option.versions[dpiKey] ?? null;
}

/** Why `option` can't print on a `dpiKey` DPI printer. */
export function noVersionText(option: MockTemplateOption, dpiKey: string): string {
  const dpis = Object.keys(option.versions).sort(naturalCompare).join(' or ');
  return `"${option.family}" is only available at ${dpis} DPI, so it can't print on this ${dpiKey} DPI printer.`;
}

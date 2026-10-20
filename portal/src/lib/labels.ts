/**
 * Pure helpers for the Labels pages — vocab lookups, meta accessors with
 * safe defaults, search haystacks. No fetching, no React.
 */

import { naturalCompare } from './naturalSort';
import type {
  LabelPlaceholder, LabelTemplate, LabelTemplateChild, LabelTemplateTreeNode, LabelVocab,
} from './api';

export type VocabKind = 'type' | 'size' | 'dpi' | 'language';

export const VOCAB_KIND_LABELS: Record<VocabKind, string> = {
  type: 'Types', size: 'Sizes', dpi: 'DPI', language: 'Languages',
};

export function vocabOfKind(
  rows: LabelVocab[], kind: VocabKind,
  opts: { activeOnly?: boolean } = {},
): LabelVocab[] {
  const activeOnly = opts.activeOnly ?? true;
  return rows
    .filter((v) => v.kind === kind && (!activeOnly || v.is_active))
    .sort((a, b) => a.sort_order - b.sort_order || naturalCompare(a.key, b.key));
}

export function vocabLabel(rows: LabelVocab[], kind: VocabKind, key: string): string {
  return rows.find((v) => v.kind === kind && v.key === key)?.label ?? key;
}

/** Which label types describe a container rather than an asset.
 *
 *  ⚠ This is the SECOND copy of that mapping. The first — and the one the
 *  server actually labels from — is `ENTITY_FOR_TYPE` in
 *  `api/src/serversherpa/labels/generate/__init__.py`. A new container-shaped
 *  label type must be added to BOTH or the labels pages will describe a run
 *  in assets, and Print Labels will show the asset roster for a type whose
 *  labels are keyed by container id. There is no third copy: Generate
 *  Labels and Print Labels both ask this function. (It lived in
 *  `printLabels.ts` until Generate Labels needed it too.) */
const CONTAINER_LABEL_TYPES: ReadonlySet<string> = new Set(['container', 'container_info']);

export function isContainerLabelType(labelType: string): boolean {
  return CONTAINER_LABEL_TYPES.has(labelType);
}

export interface SizeMeta { width_in: number; height_in: number; has_tab: boolean }

export function sizeMeta(v: LabelVocab): SizeMeta {
  const w = v.meta.width_in, h = v.meta.height_in;
  return {
    width_in: typeof w === 'number' && w > 0 ? w : 4,
    height_in: typeof h === 'number' && h > 0 ? h : 2,
    has_tab: v.meta.has_tab === true,
  };
}

export function dpiDots(rows: LabelVocab[], key: string): number {
  const dots = rows.find((v) => v.kind === 'dpi' && v.key === key)?.meta.dots;
  return typeof dots === 'number' && dots > 0 ? dots : 203;
}

export function metaSummary(v: LabelVocab): string {
  if (v.kind === 'size') {
    const m = sizeMeta(v);
    return `${m.width_in} x ${m.height_in} in${m.has_tab ? ' + tab' : ''}`;
  }
  if (v.kind === 'dpi') {
    return typeof v.meta.dots === 'number' ? `${v.meta.dots} dots/in` : '';
  }
  if (v.kind === 'language') {
    return typeof v.meta.family === 'string' ? v.meta.family : '';
  }
  return '';
}

export function placeholdersFor(
  rows: LabelPlaceholder[], labelType: string,
): LabelPlaceholder[] {
  return rows
    .filter((p) => p.is_active && p.applies_to.includes(labelType))
    .sort((a, b) => a.sort_order - b.sort_order || naturalCompare(a.key, b.key));
}

export function vocabSearchText(v: LabelVocab): string {
  return `${v.key} ${v.label} ${v.description} ${metaSummary(v)}`.toLowerCase();
}

export function placeholderSearchText(p: LabelPlaceholder): string {
  return `${p.key} ${p.label} ${p.description} ${p.sample_value} ${p.applies_to.join(' ')}`
    .toLowerCase();
}

export function siteNames(
  siteIds: string[], sites: { id: string; name: string }[],
): string[] {
  return siteIds.map((id) => sites.find((s) => s.id === id)?.name ?? id);
}

export function sitesCellText(
  siteIds: string[], sites: { id: string; name: string }[],
): string {
  if (siteIds.length === 0) return 'All sites';
  const names = siteNames(siteIds, sites);
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}

export function templateSearchText(t: LabelTemplate): string {
  return `${t.name} ${t.description} ${t.label_type} ${t.size_key} ${t.dpi_key} ${t.language_key} ${t.kind}`
    .toLowerCase();
}

// ── the templates list tree (spec §3.4, §4.1, §4.9) ──────────────────

/** The DPIs a builder template has children for (api templates_tree.py). */
export const TREE_DPIS = ['203', '300', '600'] as const;

/** A builder parent: a top-level schema 2 design. Anything else at the top
 *  of the tree is an older single row. */
export function isTreeParent(t: LabelTemplate): boolean {
  return !t.parent_id && t.kind === 'design' && (t.schema_version ?? 1) >= 2;
}

/** The DPIs a parent prints at: its current children's (an Old child is
 *  kept history), in DPI order. */
function currentDpis(node: LabelTemplateTreeNode): string[] {
  return [...new Set(node.children.filter((c) => !c.is_old).map((c) => c.dpi_key))].sort(naturalCompare);
}

/** The DPI column: "All" when a parent has all three DPIs, else the ones it
 *  has ("203 · 300"); an older single row shows its own. */
export function templateDpiText(node: LabelTemplateTreeNode): string {
  if (!isTreeParent(node)) return node.dpi_key;
  const dpis = currentDpis(node);
  if (TREE_DPIS.every((d) => dpis.includes(d))) return 'All';
  return dpis.length ? dpis.join(' · ') : '—';
}

/** The DPIs Add DPI can bring back to a parent. */
export function missingDpis(node: LabelTemplateTreeNode): string[] {
  if (!isTreeParent(node)) return [];
  const dpis = currentDpis(node);
  return TREE_DPIS.filter((d) => !dpis.includes(d));
}

export interface StateChip { text: string; color: string }

/** A DPI child's state: From parent, or Customized (Out of date once the
 *  parent has saved past it); a kept Old child is Kept · inactive. */
export function childStateChips(child: LabelTemplateChild, parent: LabelTemplate): StateChip[] {
  if (child.is_old) return [{ text: 'Kept · inactive', color: 'c-slate' }];
  if (!child.customized) return [{ text: 'From parent', color: 'c-blue' }];
  return [
    { text: 'Customized', color: 'c-violet' },
    ...(child.out_of_date ? [{ text: `Out of date (parent v${parent.version})`, color: 'c-amber' }] : []),
  ];
}

/** What Replace… on `node` can turn off: the other active top-level
 *  templates of its family (case-insensitive, as the API compares) and
 *  label type. */
export function replaceCandidates(
  node: LabelTemplateTreeNode, nodes: LabelTemplateTreeNode[],
): LabelTemplateTreeNode[] {
  const family = node.family.toLowerCase();
  return nodes.filter((n) => n.id !== node.id && n.is_active && n.label_type === node.label_type
    && n.family.toLowerCase() === family);
}

/** The name "Update from parent" gives a customized child it keeps: "<parent>
 *  · <dpi> Old", then " Old 2", … (api templates_tree._old_name). */
export function keptChildName(parentName: string, dpi: string, taken: ReadonlySet<string>): string {
  const base = `${parentName} · ${dpi} Old`;
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base} ${n}`;
  return name;
}

/**
 * Pure helpers for the Labels pages — vocab lookups, meta accessors with
 * safe defaults, search haystacks. No fetching, no React.
 */

import type { LabelPlaceholder, LabelTemplate, LabelVocab } from './api';

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
    .sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key));
}

export function vocabLabel(rows: LabelVocab[], kind: VocabKind, key: string): string {
  return rows.find((v) => v.kind === kind && v.key === key)?.label ?? key;
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
    .sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key));
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

/**
 * The builder's field catalog as the panels show it (spec §3.6, §4.6): the
 * groups GET /labels/fields returns for the template's label type, then the
 * From-To columns (`ft:<header>`, every header seen across moves plus any a
 * design already places), with how often each field and Split piece is on
 * the label. Unused fields come first in their group, placed ones after
 * them; both keep the catalog's order.
 *
 * A custom label type (New template › Custom…, a shelf tag) is one the
 * catalog doesn't know: the API sends it every group but Person
 * (labels/fields.py `groups_for`), so it can place any asset, move, site or
 * container field, and it has From-To columns like any label that isn't a
 * container's. The ID badge's only group is Person, and it has no From-To
 * columns.
 */

import type { LabelFields } from '../../../lib/api';
import { isContainerLabelType, isPersonLabelType } from '../../../lib/labels';
import { naturalCompare } from '../../../lib/naturalSort';
import type { DesignV2, ElementV2 } from '../../../labels/builder/model';
import { piece as splitPiece } from '../../../labels/fieldRules';

export const FT_PREFIX = 'ft:';

/** The drag payload a field carries out of the panel: JSON `{key, piece}`. */
export const FIELD_DRAG_TYPE = 'application/x-label-field';

export type FieldKind = 'text' | 'number' | 'date';

export interface CatalogField {
  key: string;
  label: string;
  kind: FieldKind;
  groupLabel: string;
}

export interface CatalogGroup {
  key: string;
  label: string;
  fields: CatalogField[];
}

export const FT_GROUP_LABEL = 'From-To columns';

/** Container labels have no From-To row, and an ID badge describes a
 *  person (labels/fields.py `allows_from_to`). */
export function allowsFromTo(labelType: string | undefined): boolean {
  return !labelType || !(isContainerLabelType(labelType) || isPersonLabelType(labelType));
}

function own<V>(obj: Readonly<Record<string, V>> | undefined, key: string): V | undefined {
  return obj !== undefined && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** The field an element prints, if any: a placement, or a barcode or QR
 *  code bound to a field. */
export function boundField(el: ElementV2): string | null {
  if (el.type === 'field') return el.field;
  if ((el.type === 'barcode' || el.type === 'qr') && typeof el.field === 'string' && el.field) return el.field;
  return null;
}

/** The elements printing `key`; with `piece`, only that Split piece's
 *  placements (null: whole-value placements only). */
export function placementsOf(design: DesignV2, key: string, piece?: number | null): ElementV2[] {
  return design.elements.filter((el) => {
    if (boundField(el) !== key) return false;
    if (piece === undefined) return true;
    const p = el.type === 'field' ? el.piece ?? null : null;
    return p === piece;
  });
}

/** The names of `key`'s Split pieces, or [] when it has none. */
export function pieceNames(design: DesignV2, key: string): string[] {
  return own(design.splits, key)?.pieces ?? [];
}

/** Every group the panel and the picker list, From-To columns last. */
export function catalogGroups(fields: LabelFields | null, design: DesignV2, labelType?: string): CatalogGroup[] {
  const groups: CatalogGroup[] = (fields?.groups ?? []).map((g) => ({
    key: g.key,
    label: g.label,
    fields: g.fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind, groupLabel: g.label })),
  }));
  if (!allowsFromTo(labelType)) return groups;
  const headers = new Set(fields?.ft_headers ?? []);
  const placed = design.elements
    .map(boundField)
    .filter((k): k is string => !!k && k.startsWith(FT_PREFIX))
    .map((k) => k.slice(FT_PREFIX.length))
    .filter((h) => !headers.has(h));
  const extra = [...new Set(placed)].sort(naturalCompare);
  const all = [...(fields?.ft_headers ?? []), ...extra];
  if (all.length) {
    groups.push({
      key: 'ft',
      label: FT_GROUP_LABEL,
      fields: all.map((h) => ({ key: `${FT_PREFIX}${h}`, label: h, kind: 'text', groupLabel: FT_GROUP_LABEL })),
    });
  }
  return groups;
}

/** A field key's display name: the catalog's, a From-To column's header,
 *  else the key itself. */
export function fieldLabel(fields: LabelFields | null, key: string): string {
  for (const g of fields?.groups ?? []) {
    const f = g.fields.find((x) => x.key === key);
    if (f) return f.label;
  }
  return key.startsWith(FT_PREFIX) ? key.slice(FT_PREFIX.length) : key;
}

/** A field's kind; a From-To column or an unknown key is text. */
export function fieldKind(fields: LabelFields | null, key: string): FieldKind {
  for (const g of fields?.groups ?? []) {
    const f = g.fields.find((x) => x.key === key);
    if (f) return f.kind;
  }
  return 'text';
}

/** A field, or one of its Split pieces, with how often it is placed. */
export interface FieldUse {
  field: CatalogField;
  count: number;
  /** The field's Split pieces, each with its own count. */
  pieces: { index: number; name: string; count: number }[];
}

/** `fields` with their counts: unused first, then placed, each part in the
 *  order given. */
export function byUse(fields: readonly CatalogField[], design: DesignV2): FieldUse[] {
  const uses = fields.map((field) => ({
    field,
    count: placementsOf(design, field.key).length,
    pieces: pieceNames(design, field.key).map((name, index) => ({
      index, name, count: placementsOf(design, field.key, index).length,
    })),
  }));
  return [...uses.filter((u) => u.count === 0), ...uses.filter((u) => u.count > 0)];
}

/** A Split piece of a sample (fieldRules `piece`). */
export function pieceSample(sample: string | undefined, index: number): string {
  return splitPiece(sample ?? '', index);
}

/** Case-blind match of a search on a name. */
export function matches(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || text.toLowerCase().includes(q);
}

export function sampleOf(samples: Readonly<Record<string, string>>, key: string): string {
  return own(samples, key) ?? '';
}

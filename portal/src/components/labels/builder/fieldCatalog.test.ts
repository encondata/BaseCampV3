/**
 * fieldCatalog for a custom label type (New template › Custom…, an ID
 * badge): the API sends every group for a type it doesn't know
 * (labels/fields.py groups_for), and the panel keeps them all and adds the
 * From-To columns; a container label alone has none.
 */

import { expect, it } from 'vitest';

import type { LabelFields } from '../../../lib/api';
import { newDesign } from '../../../labels/builder/model';
import { FIELDS } from './builderTestKit';
import { allowsFromTo, catalogGroups } from './fieldCatalog';

const CONTAINER_GROUP = {
  key: 'container', label: 'Container', label_types: ['container', 'container_info'],
  fields: [{ key: 'container_name', label: 'Container name', kind: 'text' as const, mock: 'CRATE-01' }],
};
/** What GET /labels/fields?label_type=id_badge answers: every group. */
const EVERY: LabelFields = { ...FIELDS, groups: [...FIELDS.groups, CONTAINER_GROUP] };

it('a custom type keeps every group the API sends, From-To columns last', () => {
  expect(allowsFromTo('id_badge')).toBe(true);
  const groups = catalogGroups(EVERY, newDesign({ w: 3.375, h: 2.125 }), 'id_badge');
  expect(groups.map((g) => g.key)).toEqual(['asset', 'model', 'move_row', 'move', 'sites', 'container', 'ft']);
  expect(groups.at(-1)?.fields.map((f) => f.key)).toEqual(['ft:Data 2', 'ft:Data 10', 'ft:Notes']);
});

it('a container label has no From-To columns', () => {
  expect(allowsFromTo('container')).toBe(false);
  const groups = catalogGroups(EVERY, newDesign({ w: 4, h: 6 }), 'container');
  expect(groups.map((g) => g.key)).not.toContain('ft');
});

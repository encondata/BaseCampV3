/**
 * fieldCatalog for a custom label type (New template › Custom…, a shelf
 * tag): the API sends every group but Person for a type it doesn't know
 * (labels/fields.py groups_for), and the panel keeps them all and adds the
 * From-To columns. A container label has none, and neither has the ID
 * badge, whose only group is Person.
 */

import { expect, it } from 'vitest';

import type { LabelFields } from '../../../lib/api';
import { addElement, newDesign } from '../../../labels/builder/model';
import { FIELDS, PERSON_FIELDS } from './builderTestKit';
import { allowsFromTo, catalogGroups, personFieldKeys } from './fieldCatalog';

const CONTAINER_GROUP = {
  key: 'container', label: 'Container', label_types: ['container', 'container_info'],
  fields: [{ key: 'container_name', label: 'Container name', kind: 'text' as const, mock: 'CRATE-01' }],
};
/** What GET /labels/fields?label_type=shelf answers: every group but Person. */
const EVERY: LabelFields = { ...FIELDS, groups: [...FIELDS.groups, CONTAINER_GROUP] };

const PERSON_GROUP = {
  key: 'person', label: 'Person', label_types: ['id_badge'],
  fields: [
    { key: 'person_name', label: 'Name', kind: 'text' as const, mock: 'Jordan Rivera' },
    { key: 'badge_id', label: 'Badge ID', kind: 'text' as const, mock: '3f2a9c1e-7b4d-4e21-9a0c-5d6e7f809a1b' },
  ],
};
/** What GET /labels/fields?label_type=id_badge answers: Person, no headers. */
const BADGE: LabelFields = { groups: [PERSON_GROUP], ft_headers: [] };

it('a custom type keeps every group the API sends, From-To columns last', () => {
  expect(allowsFromTo('shelf')).toBe(true);
  const groups = catalogGroups(EVERY, newDesign({ w: 3.375, h: 2.125 }), 'shelf');
  expect(groups.map((g) => g.key)).toEqual(['asset', 'model', 'move_row', 'move', 'sites', 'container', 'ft']);
  expect(groups.at(-1)?.fields.map((f) => f.key)).toEqual(['ft:Data 2', 'ft:Data 10', 'ft:Notes']);
});

it('a container label has no From-To columns', () => {
  expect(allowsFromTo('container')).toBe(false);
  const groups = catalogGroups(EVERY, newDesign({ w: 4, h: 6 }), 'container');
  expect(groups.map((g) => g.key)).not.toContain('ft');
});

it('an ID badge has the Person group and no From-To columns', () => {
  expect(allowsFromTo('id_badge')).toBe(false);
  const design = newDesign({ w: 3.375, h: 2.125 });
  expect(catalogGroups(BADGE, design, 'id_badge').map((g) => g.key)).toEqual(['person']);
  // a From-To placement (a template whose type was changed to ID Badge) adds no column group
  const placed = addElement(design, {
    id: 'f1', type: 'field', field: 'ft:Notes', display: 'text', x: 0, y: 0, w: 1, h: 0.3, rotation: 0,
  });
  expect(catalogGroups(BADGE, placed, 'id_badge').map((g) => g.key)).toEqual(['person']);
  expect(catalogGroups(EVERY, placed, 'shelf').at(-1)?.fields.map((f) => f.key)).toContain('ft:Notes');
});

it('personFieldKeys: the Person group’s keys, what Load from person… fills and Clear sample person empties', () => {
  expect(personFieldKeys(PERSON_FIELDS)).toEqual(PERSON_FIELDS.groups[0].fields.map((f) => f.key));
  expect(personFieldKeys(PERSON_FIELDS)).toContain('person_rfid_tag');
  // an asset label has none; nor has a catalog still loading
  expect(personFieldKeys(FIELDS)).toEqual([]);
  expect(personFieldKeys(null)).toEqual([]);
});

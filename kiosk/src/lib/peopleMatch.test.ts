/** Finding a worker at the kiosk: a badge, an id, or a name typed in
 *  whatever order the person at the screen thinks of it. */
import { expect, it } from 'vitest';

import { buildPeopleIndex, matchPersonExact, searchPeople, type MatchPerson } from './peopleMatch';

const person = (over: Partial<MatchPerson> & { id: string }): MatchPerson => ({
  display_name: 'Someone', first_name: 'Some', last_name: 'One',
  preferred_name: null, rfid_tag: null, is_worker: true, has_account: false,
  ...over,
});

const JIMMY = person({
  id: '11111111-2222-4333-8444-555555555555',
  display_name: 'Jimmy Henderson', first_name: 'James', last_name: 'Henderson',
  preferred_name: 'Jimmy', rfid_tag: '000000000000100348',
});
const JIM = person({
  id: '22222222-2222-4333-8444-555555555555',
  display_name: 'Jim Hendricks', first_name: 'Jim', last_name: 'Hendricks',
});
const TINA = person({
  id: '33333333-2222-4333-8444-555555555555',
  display_name: 'Tina Marie Tanaka', first_name: 'Tina', last_name: 'Tanaka',
  preferred_name: null, rfid_tag: '4821', has_account: true,
});

const PEOPLE = [JIMMY, JIM, TINA];
const index = buildPeopleIndex(PEOPLE);

const ids = (rows: MatchPerson[]) => rows.map((p) => p.display_name);

it('finds a person by first name then last name', () => {
  expect(ids(searchPeople(index, 'jim hen'))).toEqual(['Jim Hendricks', 'Jimmy Henderson']);
  expect(ids(searchPeople(index, 'james henderson'))).toEqual(['Jimmy Henderson']);
});

it('finds the same person by last name then first name', () => {
  expect(ids(searchPeople(index, 'hen jim'))).toEqual(['Jim Hendricks', 'Jimmy Henderson']);
  expect(ids(searchPeople(index, 'henderson j'))).toEqual(['Jimmy Henderson']);
});

it('matches the preferred name and the display name alike', () => {
  expect(ids(searchPeople(index, 'jimmy'))).toEqual(['Jimmy Henderson']);
  expect(ids(searchPeople(index, 'marie'))).toEqual(['Tina Marie Tanaka']);
});

it('every term must be a prefix of a distinct name part', () => {
  // "tina tanaka" matches on two different parts; "tina tina" does not,
  // because the single "Tina" part is already consumed by the first term.
  expect(ids(searchPeople(index, 'tina tan'))).toEqual(['Tina Marie Tanaka']);
  expect(searchPeople(index, 'tina tina')).toEqual([]);
});

it('ignores case and extra whitespace', () => {
  expect(ids(searchPeople(index, '   HEN   JiM  '))).toEqual(['Jim Hendricks', 'Jimmy Henderson']);
});

it('ranks fewer name parts first, then alphabetically', () => {
  // Jim Hendricks is two name parts, Jimmy Henderson is three (James,
  // Henderson, Jimmy), so the shorter name leads on a prefix both share.
  expect(ids(searchPeople(index, 'jim'))).toEqual(['Jim Hendricks', 'Jimmy Henderson']);
  expect(ids(searchPeople(index, 'j'))).toEqual(['Jim Hendricks', 'Jimmy Henderson']);
  const sameShape = buildPeopleIndex([
    person({ id: 'b', display_name: 'Bo Zender', first_name: 'Bo', last_name: 'Zender' }),
    person({ id: 'a', display_name: 'Bo Ackley', first_name: 'Bo', last_name: 'Ackley' }),
  ]);
  expect(ids(searchPeople(sameShape, 'bo'))).toEqual(['Bo Ackley', 'Bo Zender']);
});

it('ranks a name typed out in full above a shorter name that merely matches', () => {
  const deans = buildPeopleIndex([
    person({ id: 'x', display_name: 'Dee Annson', first_name: 'Dee', last_name: 'Annson' }),
    person({
      id: 'y', display_name: 'Dee Ann', first_name: 'Deanna', last_name: 'Ann',
      preferred_name: 'Dee',
    }),
  ]);
  expect(ids(searchPeople(deans, 'dee ann'))).toEqual(['Dee Ann', 'Dee Annson']);
});

it('returns at most the limit', () => {
  const many = Array.from({ length: 20 }, (_, i) => person({
    id: `id-${i}`, display_name: `Adam Anderson${i}`, first_name: 'Adam', last_name: `Anderson${i}`,
  }));
  const big = buildPeopleIndex(many);
  expect(searchPeople(big, 'adam')).toHaveLength(8);
  expect(searchPeople(big, 'adam', 3)).toHaveLength(3);
});

it('finds nothing for a name nobody has, and nothing for a blank query', () => {
  expect(searchPeople(index, 'zzz')).toEqual([]);
  expect(searchPeople(index, '   ')).toEqual([]);
});

it('matches an RFID with or without its leading zeros, in any case', () => {
  expect(matchPersonExact(index, '000000000000100348')).toBe(JIMMY);
  expect(matchPersonExact(index, '100348')).toBe(JIMMY);
  expect(matchPersonExact(index, ' 0000100348 ')).toBe(JIMMY);
  expect(matchPersonExact(index, '4821')).toBe(TINA);
});

it('matches a full id and an eight-character short id', () => {
  expect(matchPersonExact(index, JIMMY.id)).toBe(JIMMY);
  expect(matchPersonExact(index, JIMMY.id.toUpperCase())).toBe(JIMMY);
  expect(matchPersonExact(index, '11111111')).toBe(JIMMY);
});

it('is null for a typed name or an unknown value', () => {
  expect(matchPersonExact(index, 'jimmy')).toBeNull();
  expect(matchPersonExact(index, 'nope123')).toBeNull();
  expect(matchPersonExact(index, '   ')).toBeNull();
});

it('indexes people by tag and id and reports its size', () => {
  expect(index.size).toBe(3);
  expect(index.byRfid.get('100348')).toBe(JIMMY);
  expect(index.byId.get(TINA.id)).toBe(TINA);
});

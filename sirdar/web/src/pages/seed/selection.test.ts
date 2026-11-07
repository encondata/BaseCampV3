import { describe, expect, it } from 'vitest';

import {
  fromRecipe, pkKey, range, setAll, setMany, tickedCount, toBody, toggle, type Selection,
} from './selection';

const a = pkKey({ id: '1' });
const b = pkKey({ id: '2' });
const c = pkKey({ id: '3' });

describe('pkKey', () => {
  it('sorts the keys so the same pk always gives the same string', () => {
    expect(pkKey({ b: '2', a: '1' })).toBe(pkKey({ a: '1', b: '2' }));
    expect(pkKey({ b: '2', a: '1' })).toBe('{"a":"1","b":"2"}');
  });
});

describe('toggle', () => {
  it('ticks and unticks one row without touching the input', () => {
    const empty: Selection = {};
    const on = toggle(empty, 'people', a, true);
    expect([...on.people.pks]).toEqual([a]);
    expect(on.people.mode).toBe('rows');
    expect(empty).toEqual({});
    const off = toggle(on, 'people', a, false);
    expect(off.people.pks.size).toBe(0);
    expect(on.people.pks.has(a)).toBe(true);
  });
});

describe('range', () => {
  const order = [a, b, c];
  it('ticks every row between the two indexes, either direction', () => {
    expect([...range({}, 't', order, 2, 0, true).t.pks].sort()).toEqual([a, b, c].sort());
    expect([...range({}, 't', order, 0, 1, true).t.pks].sort()).toEqual([a, b].sort());
  });
  it('unticks the range and leaves rows outside it', () => {
    const all = setMany({}, 't', order, true);
    const out = range(all, 't', order, 1, 2, false);
    expect([...out.t.pks]).toEqual([a]);
  });
});

describe('setMany', () => {
  it('adds or removes many keys at once', () => {
    const on = setMany(toggle({}, 't', a, true), 't', [b, c], true);
    expect(on.t.pks.size).toBe(3);
    expect([...setMany(on, 't', [a, c], false).t.pks]).toEqual([b]);
  });
});

describe('setAll', () => {
  it('flips the mode and keeps the ticked rows', () => {
    const ticked = toggle({}, 't', a, true);
    const all = setAll(ticked, 't', true);
    expect(all.t.mode).toBe('all');
    expect(all.t.pks.has(a)).toBe(true);
    const back = setAll(all, 't', false);
    expect(back.t.mode).toBe('rows');
    expect(back.t.pks.has(a)).toBe(true);
  });
});

describe('recipe shape', () => {
  it('reads a recipe and writes the PUT body, dropping empty tables', () => {
    const sel = fromRecipe({ people: { mode: 'rows', pks: [{ id: '1' }] }, sites: { mode: 'all', pks: [] } });
    expect(tickedCount(sel, 'people', 9)).toBe(1);
    expect(tickedCount(sel, 'sites', 9)).toBe(9);
    const withEmpty = toggle(sel, 'assets', a, false);
    expect(toBody(withEmpty)).toEqual({
      people: { mode: 'rows', pks: [{ id: '1' }] }, sites: { mode: 'all', pks: [] },
    });
  });
});

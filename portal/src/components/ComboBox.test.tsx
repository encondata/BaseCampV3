// @vitest-environment jsdom
/**
 * ComboBox.tsx: the pure `shouldDropUp` flip-decision helper that decides
 * whether the option menu should open upward instead of downward when
 * there isn't enough room below the trigger.
 */

import { describe, expect, it } from 'vitest';

import { shouldDropUp } from './ComboBox';

describe('shouldDropUp', () => {
  it('stays down when there is plenty of room below', () => {
    expect(shouldDropUp({ spaceBelow: 400, spaceAbove: 100, neededHeight: 260 })).toBe(false);
  });

  it('flips up when space below is short and space above is greater', () => {
    expect(shouldDropUp({ spaceBelow: 80, spaceAbove: 300, neededHeight: 260 })).toBe(true);
  });

  it('stays down when space below is short but space above is also short (or shorter)', () => {
    expect(shouldDropUp({ spaceBelow: 80, spaceAbove: 60, neededHeight: 260 })).toBe(false);
  });

  it('stays down when space below is short but space above is exactly equal', () => {
    expect(shouldDropUp({ spaceBelow: 80, spaceAbove: 80, neededHeight: 260 })).toBe(false);
  });

  it('stays down when space below already meets the needed height', () => {
    expect(shouldDropUp({ spaceBelow: 260, spaceAbove: 1000, neededHeight: 260 })).toBe(false);
  });

  it('flips up right at the boundary where space below is just under needed height', () => {
    expect(shouldDropUp({ spaceBelow: 259, spaceAbove: 260, neededHeight: 260 })).toBe(true);
  });
});

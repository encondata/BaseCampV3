import { beforeEach, describe, expect, it } from 'vitest';

import { clearPersonNames, personName, rememberPersonNames } from './personNames';

beforeEach(clearPersonNames);

describe('personNames', () => {
  it('remembers the names the mention picker saw, newest answer winning', () => {
    expect(personName('p1')).toBeUndefined();
    rememberPersonNames([{ id: 'p1', name: 'Pat Doe' }, { id: 'p2', name: 'Sam Roe' }]);
    rememberPersonNames([{ id: 'p1', name: 'Pat Smith' }]);
    expect(personName('p1')).toBe('Pat Smith');
    expect(personName('p2')).toBe('Sam Roe');
  });

  it('forgets everything on clear', () => {
    rememberPersonNames([{ id: 'p1', name: 'Pat Doe' }]);
    clearPersonNames();
    expect(personName('p1')).toBeUndefined();
  });
});

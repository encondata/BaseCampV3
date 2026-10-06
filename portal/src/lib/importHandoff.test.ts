/**
 * importHandoff — the in-memory file handoff from Convert Raw F-T to a
 * move's From-To import page.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { clearHandedOffImportFile, handOffImportFile, peekHandedOffImportFile } from './importHandoff';

const f = (name: string) => new File(['x'], name);

afterEach(() => { clearHandedOffImportFile('m1'); clearHandedOffImportFile('m2'); });

describe('importHandoff', () => {
  it('peek returns nothing before a handoff', () => {
    expect(peekHandedOffImportFile('m1')).toBeNull();
  });

  it('peek returns the handed-off file for its initiative, without consuming it', () => {
    const file = f('a.xlsx');
    handOffImportFile('m1', file);
    expect(peekHandedOffImportFile('m1')).toBe(file);
    expect(peekHandedOffImportFile('m1')).toBe(file);
  });

  it('peek returns nothing for another initiative or an undefined id', () => {
    handOffImportFile('m1', f('a.xlsx'));
    expect(peekHandedOffImportFile('m2')).toBeNull();
    expect(peekHandedOffImportFile(undefined)).toBeNull();
  });

  it('clear removes the file for its initiative', () => {
    handOffImportFile('m1', f('a.xlsx'));
    clearHandedOffImportFile('m1');
    expect(peekHandedOffImportFile('m1')).toBeNull();
  });

  it('clear for another initiative or undefined leaves the file', () => {
    const file = f('a.xlsx');
    handOffImportFile('m1', file);
    clearHandedOffImportFile('m2');
    clearHandedOffImportFile(undefined);
    expect(peekHandedOffImportFile('m1')).toBe(file);
  });

  it('a newer handoff replaces the earlier one', () => {
    handOffImportFile('m1', f('a.xlsx'));
    const b = f('b.xlsx');
    handOffImportFile('m2', b);
    expect(peekHandedOffImportFile('m1')).toBeNull();
    expect(peekHandedOffImportFile('m2')).toBe(b);
  });
});

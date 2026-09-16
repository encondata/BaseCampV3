import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearEnrollLog, enrollLogSize, noteTagHolder, recordEnrollment, tagHolder,
} from './enrollLog';

beforeEach(() => { clearEnrollLog(); });

describe('recordEnrollment / tagHolder', () => {
  it('remembers which asset a tag went on', () => {
    recordEnrollment({ tag: `${'0'.repeat(18)}100348`, assetId: 'a-1', assetName: 'Rack 4 switch' });
    expect(tagHolder(`${'0'.repeat(18)}100348`)).toMatchObject({
      assetId: 'a-1', assetName: 'Rack 4 switch',
    });
  });

  it('knows nothing about a tag it has never seen', () => {
    expect(tagHolder('100348')).toBeNull();
  });

  it('matches however the tag is written — padding, case, and spaces', () => {
    recordEnrollment({ tag: '00000000000000000010ab48', assetId: 'a-1', assetName: 'Switch' });
    expect(tagHolder('10ab48')?.assetId).toBe('a-1');
    expect(tagHolder('10AB48')?.assetId).toBe('a-1');
    expect(tagHolder('10 ab 48')?.assetId).toBe('a-1');
    expect(tagHolder(`${'0'.repeat(18)}10AB48`)?.assetId).toBe('a-1');
  });

  it('ignores a value that is not a tag at all', () => {
    expect(tagHolder('')).toBeNull();
    expect(tagHolder('   ')).toBeNull();
    expect(tagHolder('nope-123')).toBeNull();          // punctuation
    expect(tagHolder('0'.repeat(25))).toBeNull();      // longer than the format
  });

  it('a re-enrollment of the same tag onto another asset moves the holder', () => {
    recordEnrollment({ tag: '100348', assetId: 'a-1', assetName: 'Switch' });
    recordEnrollment({ tag: '100348', assetId: 'a-2', assetName: 'Patch panel' });
    expect(tagHolder('100348')?.assetId).toBe('a-2');
  });

  it("forgets an asset's previous tag when it is given a new one", () => {
    recordEnrollment({ tag: '100348', assetId: 'a-1', assetName: 'Switch' });
    recordEnrollment({ tag: '200500', assetId: 'a-1', assetName: 'Switch' });
    expect(tagHolder('200500')?.assetId).toBe('a-1');
    // The old tag is free again: the portal no longer has it on a-1, so
    // refusing it here would block a legitimate re-use.
    expect(tagHolder('100348')).toBeNull();
  });
});

describe('noteTagHolder', () => {
  it('records a holder the portal named, so a retry is caught locally', () => {
    noteTagHolder('100348', 'a-9', 'Patch panel');
    expect(tagHolder('100348')).toMatchObject({ assetId: 'a-9', assetName: 'Patch panel' });
  });

  it('does not invent a holder for an unusable value', () => {
    noteTagHolder('nope-123', 'a-9', 'Patch panel');
    expect(enrollLogSize()).toBe(0);
  });
});

describe('clearEnrollLog', () => {
  it('empties the log', () => {
    recordEnrollment({ tag: '100348', assetId: 'a-1', assetName: 'Switch' });
    expect(enrollLogSize()).toBe(1);
    clearEnrollLog();
    expect(enrollLogSize()).toBe(0);
    expect(tagHolder('100348')).toBeNull();
  });
});

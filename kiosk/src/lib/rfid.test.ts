import { expect, it } from 'vitest';

import { padRfid, RFID_LENGTH } from './rfid';

it('pads a short numeric tag with leading zeros to 24 characters', () => {
  const { tag, problem } = padRfid('100348');
  expect(problem).toBeNull();
  expect(tag).toBe('000000000000000000100348');
  expect(tag).toHaveLength(RFID_LENGTH);
});

it('leaves an already-24-character tag alone, and is idempotent', () => {
  const stored = padRfid('100348').tag!;
  expect(padRfid(stored).tag).toBe(stored);
  expect(padRfid('E2004321' + '0'.repeat(16)).tag).toBe('E2004321' + '0'.repeat(16));
});

it('upper-cases and strips whitespace, inside as well as around', () => {
  expect(padRfid('  e200 4321 ').tag).toBe('0'.repeat(16) + 'E2004321');
});

it('reports an empty value rather than padding it to 24 zeros', () => {
  for (const raw of ['', '   ', '\t\n']) {
    expect(padRfid(raw)).toEqual({ tag: null, problem: 'empty' });
  }
});

it('rejects anything that is not alphanumeric', () => {
  for (const raw of ['E200-4321', '1003.48', 'tag_1', 'é200']) {
    expect(padRfid(raw)).toEqual({ tag: null, problem: 'not_alphanumeric' });
  }
});

it('rejects a tag longer than 24 characters', () => {
  expect(padRfid('1'.repeat(25))).toEqual({ tag: null, problem: 'too_long' });
  expect(padRfid('1'.repeat(24)).problem).toBeNull();
});

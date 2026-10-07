import { describe, expect, it } from 'vitest';

import type { EnvEntry, EnvMissingEntry } from './api';
import {
  changedDescriptions, changedMissing, changedValues, describeEntry, filterEntries,
  filterMissing, describeMissing,
} from './envConfig';

const plain = (key: string, value: string, description = '', section = ''): EnvEntry =>
  ({ key, secret: false, value, description, section });
const secret = (key: string, set = true, description = '', section = ''): EnvEntry =>
  ({ key, secret: true, set, description, section });

describe('filterEntries', () => {
  const entries = [
    plain('SS_ENV', 'development', 'Deployment environment name'),
    secret('SS_JWT_SECRET', true, 'Signs session JWTs'),
  ];
  it('matches case-insensitively on key', () => {
    expect(filterEntries(entries, 'jwt')).toHaveLength(1);
    expect(filterEntries(entries, '')).toHaveLength(2);
    expect(filterEntries(entries, 'nope')).toHaveLength(0);
  });
  it('also matches case-insensitively on description', () => {
    expect(filterEntries(entries, 'session')).toEqual([entries[1]]);
    expect(filterEntries(entries, 'DEPLOYMENT')).toEqual([entries[0]]);
  });
});

describe('changedValues', () => {
  const entries = [plain('SS_ENV', 'development'), secret('SS_JWT_SECRET')];
  it('plain values count only when different', () => {
    expect(changedValues(entries, { SS_ENV: 'development' })).toEqual({});
    expect(changedValues(entries, { SS_ENV: 'production' }))
      .toEqual({ SS_ENV: 'production' });
  });
  it('secrets count only when non-empty', () => {
    expect(changedValues(entries, { SS_JWT_SECRET: '' })).toEqual({});
    expect(changedValues(entries, { SS_JWT_SECRET: 'new' }))
      .toEqual({ SS_JWT_SECRET: 'new' });
  });
});

describe('changedDescriptions', () => {
  const entries = [
    plain('SS_ENV', 'development', 'Deployment environment name'),
    secret('SS_JWT_SECRET', true, 'Signs session JWTs'),
    plain('SS_SMTP_HOST', 'smtp.example.com'),
  ];
  it('counts only descriptions that differ from the entry', () => {
    expect(changedDescriptions(entries, { SS_ENV: 'Deployment environment name' }))
      .toEqual({});
    expect(changedDescriptions(entries, { SS_ENV: 'New description' }))
      .toEqual({ SS_ENV: 'New description' });
  });
  it('counts a new description on a key that had none', () => {
    expect(changedDescriptions(entries, { SS_SMTP_HOST: 'SMTP relay host' }))
      .toEqual({ SS_SMTP_HOST: 'SMTP relay host' });
  });
  it('counts clearing a description down to empty', () => {
    expect(changedDescriptions(entries, { SS_JWT_SECRET: '' }))
      .toEqual({ SS_JWT_SECRET: '' });
  });
  it('ignores edits for keys not present in entries', () => {
    expect(changedDescriptions(entries, { SS_NOPE: 'x' })).toEqual({});
  });
});

describe('describeEntry', () => {
  it('marks secrets', () => {
    expect(describeEntry(secret('X')).chip).toBe('set');
    expect(describeEntry(secret('X', false)).chip).toBe('not set');
    expect(describeEntry(plain('X', 'v')).chip).toBeNull();
  });
});

describe('missing entries', () => {
  const missing: EnvMissingEntry[] = [
    { key: 'SS_NEW', secret: false, section: 'Misc', description: 'A new knob', example: '5' },
    { key: 'SS_NEW_SECRET', secret: true, section: 'Misc', description: 'A new secret' },
  ];

  it('changedMissing sends a typed non-secret, even when blank, but never an untouched or blank secret', () => {
    expect(changedMissing(missing, {})).toEqual({});
    expect(changedMissing(missing, { SS_NEW: '' })).toEqual({ SS_NEW: '' });
    expect(changedMissing(missing, { SS_NEW: '7' })).toEqual({ SS_NEW: '7' });
    expect(changedMissing(missing, { SS_NEW_SECRET: '' })).toEqual({});
    expect(changedMissing(missing, { SS_NEW_SECRET: 's' })).toEqual({ SS_NEW_SECRET: 's' });
    expect(changedMissing(missing, { OTHER: 'x' })).toEqual({});
  });

  it('filterMissing matches key or description', () => {
    expect(filterMissing(missing, '')).toEqual(missing);
    expect(filterMissing(missing, 'knob').map((m) => m.key)).toEqual(['SS_NEW']);
    expect(filterMissing(missing, 'new_secret').map((m) => m.key)).toEqual(['SS_NEW_SECRET']);
  });

  it('describeMissing: placeholder is the example or "secret", chip is "Not in .env"', () => {
    expect(describeMissing(missing[0])).toEqual({ placeholder: '5', chip: 'Not in .env' });
    expect(describeMissing(missing[1])).toEqual({ placeholder: 'secret', chip: 'Not in .env' });
  });
});

import { describe, expect, it } from 'vitest';

import type { EnvEntry } from './api';
import { changedValues, describeEntry, filterEntries } from './envConfig';

const plain = (key: string, value: string, description = ''): EnvEntry =>
  ({ key, secret: false, value, description });
const secret = (key: string, set = true, description = ''): EnvEntry =>
  ({ key, secret: true, set, description });

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

describe('describeEntry', () => {
  it('marks secrets', () => {
    expect(describeEntry(secret('X')).chip).toBe('set');
    expect(describeEntry(secret('X', false)).chip).toBe('not set');
    expect(describeEntry(plain('X', 'v')).chip).toBeNull();
  });
});

import { expect, it } from 'vitest';

import { VISIBILITY_LABEL, visibilityOptions } from './visibility';

it('offers only Everyone to non-global (client / partner) users, whatever the rank', () => {
  expect(visibilityOptions(false, 0)).toEqual(['everyone']);
  expect(visibilityOptions(false, 80)).toEqual(['everyone']);
});

it('offers Everyone and Internal to staff below Admin rank', () => {
  expect(visibilityOptions(true, 40)).toEqual(['everyone', 'internal']);
});

it('adds Admin at rank 60 and above', () => {
  expect(visibilityOptions(true, 60)).toEqual(['everyone', 'internal', 'admin']);
  expect(visibilityOptions(true, 80)).toEqual(['everyone', 'internal', 'admin']);
});

it('labels every level in plain words', () => {
  expect(VISIBILITY_LABEL).toEqual({ everyone: 'Everyone', internal: 'Internal', admin: 'Admin' });
});

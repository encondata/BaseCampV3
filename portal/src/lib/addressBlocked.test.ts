import { expect, it } from 'vitest';

import { addressBlockedMessage, isAddressBlocked } from './addressBlocked';

const PERMANENT = 'This network is blocked from signing in. Contact your administrator.';

it('rounds the wait up to whole minutes', () => {
  expect(addressBlockedMessage({ code: 'address_blocked', retry_after: 3600 }))
    .toBe('Too many failed sign-in attempts from this network. Try again in 60 minutes.');
  expect(addressBlockedMessage({ retry_after: 61 }))
    .toBe('Too many failed sign-in attempts from this network. Try again in 2 minutes.');
  expect(addressBlockedMessage({ retry_after: 30 }))
    .toBe('Too many failed sign-in attempts from this network. Try again in 1 minute.');
  expect(addressBlockedMessage({ retry_after: 0 }))
    .toBe('Too many failed sign-in attempts from this network. Try again in 1 minute.');
});

it('a null or missing retry_after is the permanent text', () => {
  expect(addressBlockedMessage({ retry_after: null })).toBe(PERMANENT);
  expect(addressBlockedMessage({})).toBe(PERMANENT);
  expect(addressBlockedMessage(undefined)).toBe(PERMANENT);
  expect(addressBlockedMessage('nope')).toBe(PERMANENT);
});

it('isAddressBlocked duck-types on code', () => {
  expect(isAddressBlocked({ status: 429, code: 'address_blocked' })).toBe(true);
  expect(isAddressBlocked({ code: 'account_locked' })).toBe(false);
  expect(isAddressBlocked(new Error('x'))).toBe(false);
  expect(isAddressBlocked(null)).toBe(false);
  expect(isAddressBlocked('address_blocked')).toBe(false);
});

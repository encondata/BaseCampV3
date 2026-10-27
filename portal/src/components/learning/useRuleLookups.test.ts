// @vitest-environment jsdom
/**
 * The lists behind rule conditions: each loads once on first use, countries
 * come from the sites list (distinct, upper-cased values), work types come
 * from the status values, and a failed list can be retried.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const apiLib = vi.hoisted(() => ({
  listClients: vi.fn(),
  listPartners: vi.fn(),
  listSites: vi.fn(),
  listInitiatives: vi.fn(),
  listInitiativeWorkTypes: vi.fn(),
  listWorkers: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...apiLib,
}));

const { countryOptions, useRuleLookups } = await import('./useRuleLookups');

const SITES = [
  { id: 'S1', name: 'DFW', code: 'DFW1', country: 'Singapore' },
  { id: 'S2', name: 'SIN', code: null, country: 'SINGAPORE' },
  { id: 'S3', name: 'KUL', code: null, country: ' Malaysia ' },
  { id: 'S4', name: 'Nowhere', code: null, country: '' },
] as never[];

beforeEach(() => {
  Object.values(apiLib).forEach((f) => f.mockReset());
  apiLib.listSites.mockResolvedValue(SITES);
});

it('countryOptions lists each country once, upper-cased, in order', () => {
  expect(countryOptions(SITES)).toEqual([
    { value: 'MALAYSIA', label: 'Malaysia' },
    { value: 'SINGAPORE', label: 'Singapore' },
  ]);
});

it('site and site country share one sites request, loaded on first use only', async () => {
  const { result } = renderHook(() => useRuleLookups());
  expect(result.current.status('site')).toBe('idle');
  act(() => { result.current.load('site'); result.current.load('site_country'); result.current.load('site'); });
  await waitFor(() => expect(result.current.status('site_country')).toBe('ready'));
  expect(apiLib.listSites).toHaveBeenCalledTimes(1);
  expect(result.current.options('site')[0]).toMatchObject({ value: 's1' });
  expect(result.current.label('site_country', 'SINGAPORE')).toBe('Singapore');
  expect(result.current.label('site_country', 'ELSEWHERE')).toBe('ELSEWHERE');
});

it('worker roles are the work types, keyed by their stored key', async () => {
  apiLib.listInitiativeWorkTypes.mockResolvedValue([
    { key: 'forklift', label: 'Forklift operator', is_active: true },
    { key: 'old', label: 'Retired role', is_active: false },
  ]);
  const { result } = renderHook(() => useRuleLookups());
  act(() => result.current.load('worker_role'));
  await waitFor(() => expect(result.current.status('worker_role')).toBe('ready'));
  expect(result.current.options('worker_role')).toEqual([
    { value: 'forklift', label: 'Forklift operator', sub: null },
    { value: 'old', label: 'Retired role', sub: 'Inactive' },
  ]);
});

it('a failed list reports it and can be retried', async () => {
  apiLib.listClients.mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce([{ id: 'C1', name: 'Acme Corp' }]);
  const { result } = renderHook(() => useRuleLookups());
  act(() => result.current.load('client'));
  await waitFor(() => expect(result.current.status('client')).toBe('failed'));
  act(() => result.current.retry('client'));
  await waitFor(() => expect(result.current.status('client')).toBe('ready'));
  expect(result.current.label('client', 'c1')).toBe('Acme Corp');
});

// @vitest-environment jsdom
/**
 * The record-type dropdown is fed by GET /status-values/record-types (the
 * API's frozen registry), not a list kept in the portal — so every record
 * type is offered and a deploy that adds one needs no portal change.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { StatusValue } from '../../lib/api';

const api = vi.hoisted(() => ({
  listStatusRecordTypes: vi.fn(),
  createStatusValue: vi.fn(),
  updateStatusValue: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

import StatusEditModal from './StatusEditModal';

const TYPES = [
  { id: 'site', label: 'Site', resource: 'sites', array: false },
  { id: 'partner_type', label: 'Partner type', resource: 'partners', array: true },
  { id: 'device_type', label: 'Device type', resource: 'scanning_hardware', array: false },
];

beforeEach(() => {
  api.listStatusRecordTypes.mockResolvedValue(TYPES);
});
afterEach(cleanup);

it('create mode offers every record type the API registry returns', async () => {
  render(<StatusEditModal value={null} canChange onClose={() => {}} onSaved={() => {}} />);
  await waitFor(() => expect(api.listStatusRecordTypes).toHaveBeenCalled());
  const select = await screen.findByLabelText(/Record type/) as HTMLSelectElement;
  const labels = [...select.options].map((o) => o.textContent).filter((l) => l && !l.startsWith('Select'));
  expect(labels).toEqual(['Site', 'Partner type', 'Device type']);
  expect([...select.options].map((o) => o.value)).toContain('partner_type');
});

it('edit mode shows the registry label for the existing record type', async () => {
  const value: StatusValue = {
    record_type: 'partner_type', key: 'cable', label: 'Cable', description: '',
    color: '#1668a7', sort_order: 3, is_active: true,
  } as StatusValue;
  render(<StatusEditModal value={value} canChange onClose={() => {}} onSaved={() => {}} />);
  expect(await screen.findByText('Partner type')).toBeTruthy();
});

it('says so when the registry cannot be loaded', async () => {
  api.listStatusRecordTypes.mockRejectedValue(new Error('boom'));
  render(<StatusEditModal value={null} canChange onClose={() => {}} onSaved={() => {}} />);
  expect(await screen.findByText(/Could not load record types/)).toBeTruthy();
});

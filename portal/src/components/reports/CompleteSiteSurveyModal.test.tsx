// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import CompleteSiteSurveyModal from './CompleteSiteSurveyModal';
import type { MissingSurveyField } from '../../lib/siteMoveSurvey';

// jsdom doesn't implement Element.scrollIntoView — ComboBox calls it when
// the active item changes (see Warehouse.test.tsx for the same shim).
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

afterEach(() => cleanup());

const FIELDS: MissingSurveyField[] = [
  { key: 'contact_name', label: 'Contact name', kind: 'text', options: [] },
  { key: 'floor', label: 'Floor', kind: 'int', options: [] },
  { key: 'elevator_available', label: 'Elevator available', kind: 'bool', options: [] },
  {
    key: 'floor_covering_required', label: 'Floor covering required', kind: 'select',
    options: ['none', 'carpet', 'masonite'],
  },
];

it('renders one input per missing field, by kind', () => {
  render(<CompleteSiteSurveyModal siteName="NAP11" fields={FIELDS}
                                   onSave={async () => {}} onCancel={() => {}} />);
  expect(screen.getByLabelText('Contact name')).toBeTruthy();
  expect(screen.getByLabelText('Floor')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'No' })).toBeTruthy();
  expect(screen.getByPlaceholderText('Choose floor covering required…')).toBeTruthy();
});

it('Save & continue is disabled until every field has a value', async () => {
  const user = userEvent.setup();
  render(<CompleteSiteSurveyModal siteName="NAP11" fields={FIELDS}
                                   onSave={async () => {}} onCancel={() => {}} />);
  const save = screen.getByRole('button', { name: /Save & continue/ });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toMatch(/answers? still needed/);

  await user.type(screen.getByLabelText('Contact name'), 'Jane Doe');
  await user.type(screen.getByLabelText('Floor'), '2');
  await user.click(screen.getByRole('button', { name: 'Yes' }));
  expect((save as HTMLButtonElement).disabled).toBe(true);   // select still unset

  const combo = screen.getByPlaceholderText('Choose floor covering required…');
  await user.click(combo);
  await user.click(await screen.findByText('carpet'));
  expect((save as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole('status')).toBeNull();
});

it('calls onSave with the collected values and shows the error on failure', async () => {
  const user = userEvent.setup();
  const onSave = vi.fn().mockRejectedValue(new Error('boom'));
  render(<CompleteSiteSurveyModal siteName="NAP11" fields={FIELDS.slice(0, 1)}
                                   onSave={onSave} onCancel={() => {}} />);
  await user.type(screen.getByLabelText('Contact name'), 'Jane Doe');
  await user.click(screen.getByRole('button', { name: /Save & continue/ }));
  expect(onSave).toHaveBeenCalledWith({ contact_name: 'Jane Doe' });
  expect(await screen.findByText("Couldn't save the survey.")).toBeTruthy();
});

it('Cancel calls onCancel', async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  render(<CompleteSiteSurveyModal siteName="NAP11" fields={[]}
                                   onSave={async () => {}} onCancel={onCancel} />);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalled();
});

it('a bool field toggles between Yes and No', async () => {
  const user = userEvent.setup();
  render(<CompleteSiteSurveyModal siteName="NAP11" fields={[FIELDS[2]]}
                                   onSave={async () => {}} onCancel={() => {}} />);
  const group = screen.getByRole('radiogroup', { name: 'Elevator available' });
  await user.click(within(group).getByRole('button', { name: 'No' }));
  expect(within(group).getByRole('button', { name: 'No' }).className).toContain('on');
  await user.click(within(group).getByRole('button', { name: 'Yes' }));
  expect(within(group).getByRole('button', { name: 'Yes' }).className).toContain('on');
  expect(within(group).getByRole('button', { name: 'No' }).className).not.toContain('on');
});

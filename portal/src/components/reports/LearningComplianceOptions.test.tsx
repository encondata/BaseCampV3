// @vitest-environment jsdom
/**
 * GenerateReportModal's options step for `learning_compliance`: an optional
 * initiative (blank = everyone) and a format, posted as the run's
 * initiative_id and options {initiative_id, format}.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ReportDefinition } from '../../lib/api';

const api = vi.hoisted(() => ({ listInitiatives: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: LearningComplianceOptions } = await import('./LearningComplianceOptions');

const DEF: ReportDefinition = {
  id: 'd11', name: 'Learning compliance', description: '', report_type: 'learning_compliance',
  is_system: true, updated_at: '2026-10-26T10:00:00Z', options: { default_format: 'xlsx' },
};

beforeEach(() => {
  api.listInitiatives.mockResolvedValue([
    { id: 'i1', name: 'NAP11 Move', archived_at: null },
    { id: 'i2', name: 'Old Job', archived_at: '2026-01-01T00:00:00Z' },
    { id: 'i3', name: 'Acme DFW', archived_at: null },
  ]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('defaults to everyone and the definition format, and generates', async () => {
  const onGenerate = vi.fn();
  render(<LearningComplianceOptions definition={DEF} onGenerate={onGenerate} />);
  expect(screen.getByRole('radio', { name: /Excel workbook/ }).getAttribute('aria-checked')).toBe('true');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Generate Report' }));
  expect(onGenerate).toHaveBeenCalledWith({
    initiative_id: null, options: { initiative_id: null, format: 'xlsx' }, notify: false,
  });
});

it('starts on the definition default when it is PDF', async () => {
  render(<LearningComplianceOptions definition={{ ...DEF, options: { default_format: 'pdf' } }}
                                   onGenerate={() => {}} />);
  expect(screen.getByRole('radio', { name: /PDF document/ }).getAttribute('aria-checked')).toBe('true');
});

it('offers only unarchived initiatives and posts the chosen one with the chosen format', async () => {
  const onGenerate = vi.fn();
  const user = userEvent.setup();
  render(<LearningComplianceOptions definition={DEF} onGenerate={onGenerate} />);
  const input = screen.getByLabelText('Initiative', { selector: 'input' });
  fireEvent.focus(input);
  expect(await screen.findByText('NAP11 Move')).toBeTruthy();
  expect(screen.queryByText('Old Job')).toBeNull();
  fireEvent.mouseDown(screen.getByText('Acme DFW'));
  await user.click(screen.getByRole('radio', { name: /PDF document/ }));
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  expect(onGenerate).toHaveBeenCalledWith({
    initiative_id: 'i3', options: { initiative_id: 'i3', format: 'pdf' }, notify: false,
  });
});

it('passes Notify me through', async () => {
  const onGenerate = vi.fn();
  const user = userEvent.setup();
  render(<LearningComplianceOptions definition={DEF} onGenerate={onGenerate} />);
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  expect(onGenerate.mock.calls[0][0].notify).toBe(true);
});

it('says when the initiative list could not load', async () => {
  api.listInitiatives.mockRejectedValue(new Error('x'));
  render(<LearningComplianceOptions definition={DEF} onGenerate={() => {}} />);
  expect(await screen.findByText(/Couldn.t load the initiatives/)).toBeTruthy();
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import type { InitiativeItem, ReportDefinition } from '../../lib/api';
import { MOVE_REPORT_SECTIONS } from '../../lib/reports';

import MoveReportOptions from './MoveReportOptions';

const DEF: ReportDefinition = {
  id: 'd1', name: 'Move Report', description: 'Sections covering a move end to end.',
  report_type: 'move_report', is_system: true,
  updated_at: '2026-09-09T10:00:00Z',
  options: { summary: true, assets_by_source: true, assets_by_destination: true, size_weight: true,
    rail_usage: true, collisions: false, source_racks: true, destination_racks: true },
};
const INITIATIVE = {
  id: 'i2', name: 'NAP11 Hall Migration', client_name: 'Acme',
  type_label: 'Move', type_color: '#000', status_label: 'In progress', status_color: '#000',
  scheduled_start: '2026-10-01T00:00:00Z', scheduled_end: null,
  origin_site_name: 'NAP11', destination_site_name: 'NAP22',
} as unknown as InitiativeItem;

afterEach(() => { cleanup(); });

it('shows the eight sections with the definition\'s own defaults', () => {
  render(<MoveReportOptions definition={DEF} initiative={INITIATIVE}
                             onBack={() => {}} onGenerate={() => {}} />);
  const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
  // 8 sections + the Notify me switch
  expect(boxes).toHaveLength(9);
  expect(boxes.slice(0, 8).map((b) => b.checked))
    .toEqual([true, true, true, true, true, false, true, true]);
  expect(boxes[8].checked).toBe(false);   // Notify me defaults off
});

it('the preview\'s "Report contents" line starts at "7 of 8 sections · PDF" and updates live as a section is toggled', async () => {
  const user = userEvent.setup();
  render(<MoveReportOptions definition={DEF} initiative={INITIATIVE}
                             onBack={() => {}} onGenerate={() => {}} />);
  expect(screen.getByText('7 of 8 sections · PDF')).toBeTruthy();
  await user.click(screen.getByLabelText(/^Collision Report/));
  expect(screen.getByText('8 of 8 sections · PDF')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Deselect All' }));
  expect(screen.getByText('0 of 8 sections · PDF')).toBeTruthy();
});

it('the preview card shows the selected initiative\'s name, client, and route', () => {
  render(<MoveReportOptions definition={DEF} initiative={INITIATIVE}
                             onBack={() => {}} onGenerate={() => {}} />);
  expect(screen.getByText('NAP11 Hall Migration')).toBeTruthy();
  expect(screen.getByText('Acme')).toBeTruthy();
  expect(screen.getByText('NAP11 → NAP22')).toBeTruthy();
});

it('Select All / Deselect All toggle every section switch and gate Generate on at least one', async () => {
  const user = userEvent.setup();
  render(<MoveReportOptions definition={DEF} initiative={INITIATIVE}
                             onBack={() => {}} onGenerate={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Deselect All' }));
  expect((screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement).disabled)
    .toBe(true);
  expect(screen.getByText('Turn on at least one section')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Select All' }));
  expect((screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement).disabled)
    .toBe(false);
});

it('Generate posts the current section toggles with notify:false by default', async () => {
  const user = userEvent.setup();
  const onGenerate = vi.fn();
  render(<MoveReportOptions definition={DEF} initiative={INITIATIVE}
                             onBack={() => {}} onGenerate={onGenerate} />);
  await user.click(screen.getByLabelText(/^Collision Report/));
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  expect(onGenerate).toHaveBeenCalledWith({
    initiative_id: 'i2', notify: false,
    options: { ...DEF.options, collisions: true },
  });
});

it('Notify me flips the payload\'s notify flag', async () => {
  const user = userEvent.setup();
  const onGenerate = vi.fn();
  render(<MoveReportOptions definition={DEF} initiative={INITIATIVE}
                             onBack={() => {}} onGenerate={onGenerate} />);
  await user.click(screen.getByLabelText(/^Notify me/));
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  await waitFor(() => expect(onGenerate).toHaveBeenCalledWith(
    expect.objectContaining({ notify: true })));
});

it('Generate is disabled without an initiative even if sections are enabled', () => {
  render(<MoveReportOptions definition={DEF} initiative={null}
                             onBack={() => {}} onGenerate={() => {}} />);
  expect((screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement).disabled)
    .toBe(true);
});

it('Back calls onBack', async () => {
  const user = userEvent.setup();
  const onBack = vi.fn();
  render(<MoveReportOptions definition={DEF} initiative={INITIATIVE}
                             onBack={onBack} onGenerate={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(onBack).toHaveBeenCalled();
});

it('renders every section title from MOVE_REPORT_SECTIONS', () => {
  render(<MoveReportOptions definition={DEF} initiative={INITIATIVE}
                             onBack={() => {}} onGenerate={() => {}} />);
  for (const s of MOVE_REPORT_SECTIONS) expect(screen.getByText(s.title)).toBeTruthy();
});

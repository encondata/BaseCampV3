// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AttachmentOut, ReportDefinition } from '../../lib/api';

const api = vi.hoisted(() => ({
  updateReportDefinition: vi.fn(), listAttachments: vi.fn(),
  uploadAttachmentRequest: vi.fn(), deleteAttachment: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: EditDefinitionModal } = await import('./EditDefinitionModal');

const MOVE_DEF: ReportDefinition = {
  id: 'd1', name: 'Move Report', description: '', report_type: 'move_report', is_system: true,
  updated_at: '2026-09-09T10:00:00Z',
  options: { summary: true, assets_by_source: false, assets_by_destination: false,
    size_weight: false, rail_usage: false, collisions: false, source_racks: false,
    destination_racks: false },
};
const SURVEY_DEF: ReportDefinition = {
  id: 'd2', name: 'Site & Move Survey', description: '', report_type: 'site_move_survey',
  is_system: true, updated_at: '2026-09-09T10:00:00Z',
  options: { company_name: 'Cumulus Solutions Group', include_transportation_standards: true,
    include_site_photos: true, condensed_assets: true },
};
const file = (over: Partial<AttachmentOut> = {}): AttachmentOut => ({
  id: 'f1', entity_type: 'report_definition', entity_id: 'd2', kind: 'report_asset',
  storage_key: 'k', filename: 'Transportation Standards.docx', content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size_bytes: 2048, created_at: '2026-09-09T10:00:00Z', url: null, ...over,
});

beforeEach(() => {
  api.listAttachments.mockResolvedValue([]);
  api.uploadAttachmentRequest.mockResolvedValue(file());
  api.deleteAttachment.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('Move Report has no company field or Files section', async () => {
  api.updateReportDefinition.mockResolvedValue(MOVE_DEF);
  render(<EditDefinitionModal definition={MOVE_DEF} onClose={() => {}} onSaved={() => {}} />);
  expect(screen.queryByLabelText('Company name')).toBeNull();
  expect(screen.queryByText('Files')).toBeNull();
  expect(screen.getByText('Default sections')).toBeTruthy();
});

it('Site & Move Survey shows the company field pre-filled, and saving patches company_name', async () => {
  const user = userEvent.setup();
  api.updateReportDefinition.mockResolvedValue(SURVEY_DEF);
  render(<EditDefinitionModal definition={SURVEY_DEF} onClose={() => {}} onSaved={() => {}} />);
  const company = screen.getByLabelText('Company name') as HTMLInputElement;
  expect(company.value).toBe('Cumulus Solutions Group');

  await user.clear(company);
  await user.type(company, 'Champagne Corp');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.updateReportDefinition).toHaveBeenCalledWith('d2', {
    name: 'Site & Move Survey', description: '',
    options: {
      company_name: 'Champagne Corp', include_transportation_standards: true,
      include_site_photos: true, condensed_assets: true,
    },
  }));
});

it('lists existing report_asset files and uploads a new one', async () => {
  const user = userEvent.setup();
  api.listAttachments.mockResolvedValue([file()]);
  render(<EditDefinitionModal definition={SURVEY_DEF} onClose={() => {}} onSaved={() => {}} />);
  expect(await screen.findByText(/Transportation Standards\.docx/)).toBeTruthy();

  const docx = new File(['x'], 'standards2.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, docx);

  await waitFor(() => expect(api.uploadAttachmentRequest).toHaveBeenCalledWith({
    entityType: 'report_definition', entityId: 'd2', kind: 'report_asset', file: docx,
  }));
});

it('deletes a file', async () => {
  const user = userEvent.setup();
  api.listAttachments.mockResolvedValue([file()]);
  render(<EditDefinitionModal definition={SURVEY_DEF} onClose={() => {}} onSaved={() => {}} />);
  await screen.findByText(/Transportation Standards\.docx/);
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(api.deleteAttachment).toHaveBeenCalledWith('f1'));
});

// @vitest-environment jsdom
/**
 * GenerateReportModal integration tests specific to the Site & Move
 * Survey report type: the shared "pick" step's "No initiative — choose
 * sites manually" row, and the nested CompleteSiteSurveyModal's Escape
 * key staying scoped to itself instead of also closing the outer
 * Generate flow (see task-5-review.md item 2).
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AttachmentOut, ReportDefinition, ReportRun, SiteItem, SurveySchema } from '../../lib/api';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

vi.mock('../../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({
    status: { read_only: false, read_only_message: '', workers_paused: false, banner: null },
    refresh: vi.fn(),
  }),
}));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ person: { id: 'me1', display_name: 'Me' } }),
}));

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(), createReportRun: vi.fn(), getReportRun: vi.fn(),
  getReportRunDownloadUrl: vi.fn(), setReportRunNotify: vi.fn(),
  listSurveyPartners: vi.fn(), listUsers: vi.fn(), listSites: vi.fn(),
  listAttachments: vi.fn(), getSurveySchema: vi.fn(), listInitiativeAssets: vi.fn(),
  listSiteSurvey: vi.fn(), putSiteSurveyValue: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: GenerateReportModal } = await import('./GenerateReportModal');

const SURVEY_DEF: ReportDefinition = {
  id: 'd2', name: 'Site & Move Survey', description: '', report_type: 'site_move_survey',
  is_system: true, updated_at: '2026-09-09T10:00:00Z',
  options: { company_name: 'Cumulus Solutions Group', include_transportation_standards: false,
    include_site_photos: true, condensed_assets: true },
};
const SITES: SiteItem[] = [{
  id: 's1', name: 'NAP11', code: null, site_type: null, type_label: null, type_color: null,
  status: 'active', status_label: 'Active', status_color: '#000',
  address_line1: null, address_line2: null, city: null, region: null, postal_code: null,
  country: 'US', latitude: null, longitude: null, timezone: null, dc_provider: null,
  partner_id: null, partner_name: null, notes: null, archived_at: null,
  created_at: '2026-01-01T00:00:00Z', clients: [],
} as unknown as SiteItem];
const SCHEMA: SurveySchema = {
  groups: [
    {
      key: 'contact', label: 'Site contact', fields: [
        { key: 'contact_name', label: 'Contact name', kind: 'text', options: [] },
      ],
    },
  ],
};
const TEMPLATE_FILE: AttachmentOut = {
  id: 'tf1', entity_type: 'report_definition', entity_id: 'd2', kind: 'survey_template',
  storage_key: 'k', filename: 'Move Survey.xlsx',
  content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  size_bytes: 4096, created_at: '2026-09-09T10:00:00Z', url: null,
};
const run = (over: Partial<ReportRun>): ReportRun => ({
  id: 'r1', definition_id: 'd2', definition_name: 'Site & Move Survey',
  report_type: 'site_move_survey', initiative_id: null, initiative_name: null,
  options: {}, status: 'queued', error: null, requested_by: 'p1',
  requested_by_name: 'Me', requested_rank: 40, notify: false, filename: null,
  size_bytes: null, started_at: null, finished_at: null, created_at: '2026-09-10T12:00:00Z',
  ...over,
});

beforeEach(() => {
  api.listInitiatives.mockResolvedValue([]);
  api.listSurveyPartners.mockResolvedValue([{ id: 'p1', name: 'Acme Logistics' }]);
  api.listUsers.mockResolvedValue([{ person_id: 'me1', display_name: 'Me', login_email: 'me@x.com', avatar_url: null }]);
  api.listSites.mockResolvedValue(SITES);
  // The definition needs a survey template for Generate to be reachable.
  api.listAttachments.mockResolvedValue([TEMPLATE_FILE]);
  api.getSurveySchema.mockResolvedValue(SCHEMA);
  api.listInitiativeAssets.mockResolvedValue([]);
  api.listSiteSurvey.mockResolvedValue([
    { field_key: 'contact_name', label: 'Contact name', group: 'contact', group_label: 'Site contact',
      kind: 'text', options: [], value: null, raw_id: null, updated_by: null, updated_by_name: null,
      updated_at: null },
  ]);
  api.putSiteSurveyValue.mockResolvedValue({});
  api.createReportRun.mockResolvedValue(run({}));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function chooseNoInitiativeAndProceed(user: ReturnType<typeof userEvent.setup>) {
  render(<GenerateReportModal definition={SURVEY_DEF} onClose={() => {}} />);
  const noInitiative = await screen.findByLabelText('No initiative — choose sites manually');
  await user.click(noInitiative);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Partner');
}

async function fillPartnerAndSourceSite(user: ReturnType<typeof userEvent.setup>) {
  const partnerCombo = await screen.findByPlaceholderText('Type to search partners…');
  await user.click(partnerCombo);
  await user.click(await screen.findByText('Acme Logistics'));

  const sourceCombo = screen.getByPlaceholderText('Type to search source sites…');
  await user.click(sourceCombo);
  await user.click(await screen.findByText('NAP11'));
}

it('the shared pick step\'s "No initiative" row lets Next proceed straight to the survey options', async () => {
  const user = userEvent.setup();
  await chooseNoInitiativeAndProceed(user);
  expect(screen.getByText('Logistics partner')).toBeTruthy();
});

it('Next stays disabled until an initiative or "No initiative" is chosen', async () => {
  const user = userEvent.setup();
  render(<GenerateReportModal definition={SURVEY_DEF} onClose={() => {}} />);
  await screen.findByLabelText('No initiative — choose sites manually');
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByLabelText('No initiative — choose sites manually'));
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);
});

it('Escape closes only the nested "Complete source site survey" modal, not the whole Generate flow', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<GenerateReportModal definition={SURVEY_DEF} onClose={onClose} />);
  await user.click(await screen.findByLabelText('No initiative — choose sites manually'));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Partner');
  await fillPartnerAndSourceSite(user);

  await user.click(await screen.findByRole('button', { name: 'Generate Report' }));
  await screen.findByText('Complete source site survey');

  await user.keyboard('{Escape}');

  await waitFor(() => expect(screen.queryByText('Complete source site survey')).toBeNull());
  // the outer Generate flow is still open and untouched
  expect(screen.getByText('Logistics partner')).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});

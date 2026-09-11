// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type {
  AttachmentOut, InitiativeAssetRow, InitiativeItem, ReportDefinition, SiteItem,
  SurveyPartnerOption, SurveySchema, UserSummary,
} from '../../lib/api';

// jsdom doesn't implement Element.scrollIntoView — ComboBox calls it when
// the active item changes (see Warehouse.test.tsx for the same shim).
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const auth = vi.hoisted(() => ({ person: { id: 'me1', display_name: 'Me' } }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ person: auth.person }) }));

const api = vi.hoisted(() => ({
  listSurveyPartners: vi.fn(), listUsers: vi.fn(), listSites: vi.fn(),
  listAttachments: vi.fn(), getSurveySchema: vi.fn(), listInitiativeAssets: vi.fn(),
  listSiteSurvey: vi.fn(), putSiteSurveyValue: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: SiteMoveSurveyOptions } = await import('./SiteMoveSurveyOptions');

const DEF: ReportDefinition = {
  id: 'd1', name: 'Site & Move Survey', description: '', report_type: 'site_move_survey',
  is_system: true, updated_at: '2026-09-09T10:00:00Z',
  options: {
    company_name: 'Cumulus Solutions Group', include_transportation_standards: true,
    include_site_photos: true, condensed_assets: true,
  },
};

const PARTNERS: SurveyPartnerOption[] = [
  { id: 'p1', name: 'Acme Logistics' },
  { id: 'p2', name: 'Beta Movers' },
];
const TEMPLATE_FILE: AttachmentOut = {
  id: 'tf1', entity_type: 'report_definition', entity_id: 'd1', kind: 'survey_template',
  storage_key: 'k', filename: 'Move Survey.xlsx',
  content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  size_bytes: 4096, created_at: '2026-09-09T10:00:00Z', url: null,
};
const USERS: UserSummary[] = [
  { person_id: 'me1', display_name: 'Me', login_email: 'me@example.com', avatar_url: null },
  { person_id: 'u2', display_name: 'Other Person', login_email: 'other@example.com', avatar_url: null },
];
const SITES: SiteItem[] = [
  { id: 's1', name: 'NAP11' }, { id: 's2', name: 'NAP22' },
].map((s) => ({
  ...s, code: null, site_type: null, type_label: null, type_color: null,
  status: 'active', status_label: 'Active', status_color: '#000',
  address_line1: null, address_line2: null, city: null, region: null, postal_code: null,
  country: 'US', latitude: null, longitude: null, timezone: null, dc_provider: null,
  partner_id: null, partner_name: null, notes: null, archived_at: null,
  created_at: '2026-01-01T00:00:00Z', clients: [],
} as unknown as SiteItem));
const SCHEMA: SurveySchema = {
  groups: [
    {
      key: 'contact', label: 'Site contact', fields: [
        { key: 'contact_name', label: 'Contact name', kind: 'text', options: [] },
      ],
    },
    {
      key: 'notes', label: 'Notes', fields: [
        { key: 'additional_notes', label: 'Additional notes', kind: 'textarea', options: [] },
      ],
    },
  ],
};

function ini(over: Partial<InitiativeItem> = {}): InitiativeItem {
  return {
    id: 'i1', name: 'Champagne Move', description: null, initiative_type: 'move',
    type_label: 'Move', type_color: '#000', sub_type: null, sub_type_label: null,
    sub_type_color: null, status: 'in_progress', status_label: 'In progress', status_color: '#000',
    client_id: null, client_name: 'Champagne', site_id: null, site_name: null, location: null,
    scheduled_start: '2026-10-01T00:00:00Z', scheduled_end: null, sky_command_project_id: null,
    origin_site_id: 's1', origin_site_name: 'NAP11',
    destination_site_id: 's2', destination_site_name: 'NAP22',
    real_start_at: null, real_end_at: null, priority_devices: null, shipping_types: [],
    shipping_partner_id: 'p1', shipping_partner_name: 'Acme Logistics',
    origin_tech_partner_id: null, origin_cable_partner_id: null, origin_logistics_partner_id: null,
    destination_tech_partner_id: null, destination_cable_partner_id: null,
    destination_logistics_partner_id: null, origin_vendor_involved: null,
    destination_vendor_involved: null, people_count: 0, links_count: 0,
    archived_at: null, created_at: '2026-01-01T00:00:00Z', ...over,
  } as unknown as InitiativeItem;
}

function assetRow(id: string, over: Partial<InitiativeAssetRow['asset']> = {}): InitiativeAssetRow {
  return {
    id, asset_id: id, priority_wave: null, disposition: null, owner: null,
    source_rack: 'R1', source_ru: 1, source_verified: null, source_position: null,
    destination_rack: null, destination_ru: null, destination_verified: null,
    destination_position: null, cable_info: null, vendor_involved: null,
    status: 'active', status_label: 'Active', status_color: '#000',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    asset: {
      id, legacy_id: 1, serial_number: 'SN', name: null, rfid_tag: null,
      model_make: 'Dell', model_name: 'R640', ru_size: 1, location_detail: null,
      client_name: null, model_category: null, model_category_label: null,
      model_category_color: null, status: 'active', status_label: 'Active', status_color: '#000',
      ...over,
    },
  };
}

beforeEach(() => {
  auth.person = { id: 'me1', display_name: 'Me' };
  api.listSurveyPartners.mockResolvedValue(PARTNERS);
  api.listUsers.mockResolvedValue(USERS);
  api.listSites.mockResolvedValue(SITES);
  // Most tests need Generate reachable, so default to a definition that
  // already carries a survey template; the "no template" tests below
  // override this back to [].
  api.listAttachments.mockResolvedValue([TEMPLATE_FILE]);
  api.getSurveySchema.mockResolvedValue(SCHEMA);
  api.listInitiativeAssets.mockResolvedValue([]);
  api.listSiteSurvey.mockResolvedValue([]);
  api.putSiteSurveyValue.mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows a notice and disables Generate when the definition has no survey template', async () => {
  api.listAttachments.mockResolvedValue([]);
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={() => {}} />);
  // wait for the load (Promise.all, including listAttachments) to resolve
  // before asserting the notice — otherwise this test would pass even if
  // the notice were shown unconditionally from first paint.
  await screen.findByText('me@example.com');
  expect(screen.getByText(
    'This report has no survey template yet. Upload an .xlsx template under Edit report › Files.',
  )).toBeTruthy();
  await waitFor(() => expect(
    (screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement).disabled,
  ).toBe(true));
});

it('shows no notice and enables Generate once the definition carries a survey template', async () => {
  api.listAttachments.mockResolvedValue([TEMPLATE_FILE]);
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByDisplayValue('Acme Logistics');   // partner auto-selected
  expect(screen.queryByText(/no survey template yet/)).toBeNull();
  await waitFor(() => expect(
    (screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement).disabled,
  ).toBe(false));
});

it('never shows the "no template" notice while attachments are still loading', async () => {
  // a promise that never resolves during this test — simulates the window
  // between mount and the Promise.all settling
  api.listAttachments.mockReturnValue(new Promise(() => {}));
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByPlaceholderText('Type to search partners…');
  expect(screen.queryByText(/no survey template yet/)).toBeNull();
});

it('defaults the company contact to the signed-in user, showing their email', async () => {
  render(<SiteMoveSurveyOptions definition={DEF} initiative={null} onBack={() => {}} onGenerate={() => {}} />);
  await waitFor(() => expect(screen.getByPlaceholderText('Type to search people…')).toBeTruthy());
  expect(await screen.findByText('me@example.com')).toBeTruthy();
});

it('auto-detects source/destination sites from the picked initiative, overridable', async () => {
  const user = userEvent.setup();
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={() => {}} />);

  const autoDetected = await screen.findAllByText('Auto-detected');
  expect(autoDetected).toHaveLength(2);
  expect(screen.getByText('NAP11')).toBeTruthy();
  expect(screen.getByText('NAP22')).toBeTruthy();

  // Overriding the source site swaps the auto-detected row for a picker.
  await user.click(screen.getByRole('button', { name: 'Change source site' }));
  expect(screen.getByPlaceholderText('Type to search source sites…')).toBeTruthy();
  expect(screen.getAllByText('Auto-detected')).toHaveLength(1);   // destination still auto
  expect(screen.getByRole('button', { name: 'Change destination site' })).toBeTruthy();
});

it('also auto-selects the initiative\'s logistics shipping partner', async () => {
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={() => {}} />);
  expect(await screen.findByDisplayValue('Acme Logistics')).toBeTruthy();   // p1 = Acme Logistics
});

it('hides the asset-notes textarea once the move has assets', async () => {
  api.listInitiativeAssets.mockResolvedValue([assetRow('a1')]);
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByText('Dell R640');
  expect(screen.queryByLabelText('Asset notes (optional)')).toBeNull();
});

it('shows the asset-notes textarea (with V2\'s explanatory hint) when the move has zero assets', async () => {
  api.listInitiativeAssets.mockResolvedValue([]);
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={() => {}} />);
  expect(await screen.findByLabelText('Asset notes (optional)')).toBeTruthy();
  expect(screen.getByText(
    'No assets associated with this initiative. Notes you enter below will be inserted into the generated survey in place of the equipment listing.',
  )).toBeTruthy();
});

it('shows a "no initiative" flavored hint when there is no initiative at all', async () => {
  render(<SiteMoveSurveyOptions definition={DEF} initiative={null} onBack={() => {}} onGenerate={() => {}} />);
  expect(await screen.findByLabelText('Asset notes (optional)')).toBeTruthy();
  expect(screen.getByText(/No initiative selected/)).toBeTruthy();
});

it('the condensed/per-asset toggle changes the preview grouping and the run payload', async () => {
  const user = userEvent.setup();
  const onGenerate = vi.fn();
  api.listInitiativeAssets.mockResolvedValue([
    assetRow('a1'), assetRow('a2'), assetRow('a3', { model_make: 'HP', model_name: 'DL380' }),
  ]);
  api.listSiteSurvey.mockResolvedValue([
    { field_key: 'contact_name', label: 'Contact name', group: 'contact', group_label: 'Site contact',
      kind: 'text', options: [], value: 'Jane', raw_id: 1, updated_by: null, updated_by_name: null,
      updated_at: null },
  ]);
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={onGenerate} />);

  await screen.findByText('Dell R640');
  expect(screen.getByText('×2')).toBeTruthy();     // condensed: 2 Dell rows collapse to one

  await user.click(screen.getByRole('tab', { name: 'Per asset' }));
  expect(screen.getAllByText('Dell R640')).toHaveLength(2);
  expect(screen.queryByText('×2')).toBeNull();

  await user.click(await screen.findByRole('button', { name: 'Generate Report' }));
  await waitFor(() => expect(onGenerate).toHaveBeenCalled());
  const payload = onGenerate.mock.calls[0][0];
  expect(payload.options.condensed_assets).toBe(false);
});

it('Generate is disabled without a partner, then enabled once one is auto-selected', async () => {
  const user = userEvent.setup();
  const onGenerate = vi.fn();
  render(<SiteMoveSurveyOptions definition={DEF}
                                 initiative={ini({ shipping_partner_id: null, shipping_partner_name: null })}
                                 onBack={() => {}} onGenerate={onGenerate} />);
  // no partner yet (the initiative has none to auto-select) — Generate is disabled
  await waitFor(() => expect(
    (screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement).disabled,
  ).toBe(true));

  const partnerCombo = screen.getByPlaceholderText('Type to search partners…');
  await user.click(partnerCombo);
  await user.click(await screen.findByText('Acme Logistics'));

  api.listSiteSurvey.mockResolvedValue([
    { field_key: 'contact_name', label: 'Contact name', group: 'contact', group_label: 'Site contact',
      kind: 'text', options: [], value: 'Jane', raw_id: 1, updated_by: null, updated_by_name: null,
      updated_at: null },
  ]);
  const generate = screen.getByRole('button', { name: 'Generate Report' });
  expect((generate as HTMLButtonElement).disabled).toBe(false);
  await user.click(generate);
  await waitFor(() => expect(onGenerate).toHaveBeenCalledWith({
    initiative_id: 'i1',
    options: {
      partner_id: 'p1', contact_person_id: 'me1', source_site_id: 's1',
      destination_site_id: 's2', include_transportation_standards: false,
      include_site_photos: true, condensed_assets: true,
    },
    notify: false,
  }));
});

it('opens the missing-survey modal when the source site lacks required answers, then saves and generates', async () => {
  const user = userEvent.setup();
  const onGenerate = vi.fn();
  api.listSiteSurvey.mockResolvedValue([
    { field_key: 'contact_name', label: 'Contact name', group: 'contact', group_label: 'Site contact',
      kind: 'text', options: [], value: null, raw_id: null, updated_by: null, updated_by_name: null,
      updated_at: null },
  ]);
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={onGenerate} />);
  await screen.findByDisplayValue('Acme Logistics');

  await user.click(await screen.findByRole('button', { name: 'Generate Report' }));
  expect(await screen.findByText('Complete source site survey')).toBeTruthy();

  await user.type(screen.getByLabelText('Contact name'), 'Jane Doe');
  await user.click(screen.getByRole('button', { name: /Save & continue/ }));

  await waitFor(() => expect(api.putSiteSurveyValue).toHaveBeenCalledWith('s1', 'contact_name', 'Jane Doe'));
  await waitFor(() => expect(onGenerate).toHaveBeenCalled());
});

// The preview card (`.rgm-summary`, left column) — scoped with `within`
// so its "Chosen partner"/"Source → Destination"/etc. lines never collide
// with the options column's own modal-section titles or form labels.
const previewCard = () => within(document.querySelector('.rgm-summary') as HTMLElement);

it('preview card: "Template ready"/"No template" chip tracks the definition\'s template state, and shows neither while attachments are still loading', async () => {
  api.listAttachments.mockReturnValue(new Promise(() => {}));   // never resolves during this test
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByPlaceholderText('Type to search partners…');
  expect(previewCard().queryByText('Template ready')).toBeNull();
  expect(previewCard().queryByText('No template')).toBeNull();
});

it('preview card: shows "Template ready" once the definition carries a survey template', async () => {
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByDisplayValue('Acme Logistics');
  expect(previewCard().getByText('Template ready')).toBeTruthy();
  expect(previewCard().queryByText('No template')).toBeNull();
});

it('preview card: shows "No template" once the definition has no survey template', async () => {
  api.listAttachments.mockResolvedValue([]);
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByDisplayValue('Acme Logistics');
  expect(previewCard().getByText('No template')).toBeTruthy();
  expect(previewCard().queryByText('Template ready')).toBeNull();
});

it('preview card: "Chosen partner" reads "Not chosen yet" until one is picked, then the partner\'s name', async () => {
  const user = userEvent.setup();
  render(<SiteMoveSurveyOptions definition={DEF}
                                 initiative={ini({ shipping_partner_id: null, shipping_partner_name: null })}
                                 onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByPlaceholderText('Type to search partners…');
  expect(previewCard().getByText('Not chosen yet')).toBeTruthy();

  await user.click(screen.getByPlaceholderText('Type to search partners…'));
  await user.click(await screen.findByText('Acme Logistics'));

  expect(previewCard().getByText('Acme Logistics')).toBeTruthy();
});

it('preview card: no separate "Source → Destination" line while sites are auto-detected (InitiativeSummary already shows the route)', async () => {
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByDisplayValue('Acme Logistics');
  expect(previewCard().getByText('NAP11 → NAP22')).toBeTruthy();   // InitiativeSummary's own line
  expect(previewCard().queryByText('Source → Destination')).toBeNull();
});

it('preview card: a "Source → Destination" line appears once the chosen source site is overridden away from the initiative\'s own', async () => {
  const user = userEvent.setup();
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByDisplayValue('Acme Logistics');

  await user.click(screen.getByRole('button', { name: 'Change source site' }));
  await user.click(screen.getByPlaceholderText('Type to search source sites…'));
  // "NAP22" also already labels the (still auto-detected) destination row,
  // so scope the pick to the open dropdown rather than the whole page.
  const menu = within(document.querySelector('.combo-menu') as HTMLElement);
  await user.click(await menu.findByText('NAP22'));

  expect(previewCard().getByText('Source → Destination')).toBeTruthy();
  expect(previewCard().getByText('NAP22 → NAP22')).toBeTruthy();
});

it('preview card: "Source → Destination" also shows when there is no initiative at all', async () => {
  render(<SiteMoveSurveyOptions definition={DEF} initiative={null} onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByPlaceholderText('Type to search partners…');
  expect(previewCard().getByText('Source → Destination')).toBeTruthy();
  expect(previewCard().getByText('— → —')).toBeTruthy();
});

it('preview card: asset summary is "Notes only" with zero assets, "N assets · Condensed by make/model" once there are some, and "· Per asset" after the toggle', async () => {
  const user = userEvent.setup();
  api.listInitiativeAssets.mockResolvedValue([]);
  const { rerender } = render(
    <SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByDisplayValue('Acme Logistics');
  expect(previewCard().getByText('Notes only')).toBeTruthy();

  api.listInitiativeAssets.mockResolvedValue([assetRow('a1'), assetRow('a2')]);
  rerender(<SiteMoveSurveyOptions definition={DEF} initiative={ini({ id: 'i2' })}
                                   onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByText('Dell R640');
  expect(previewCard().getByText('2 assets · Condensed by make/model')).toBeTruthy();

  await user.click(screen.getByRole('tab', { name: 'Per asset' }));
  expect(previewCard().getByText('2 assets · Per asset')).toBeTruthy();
});

it('preview card: "Contact person" defaults to the signed-in user\'s display name', async () => {
  render(<SiteMoveSurveyOptions definition={DEF} initiative={ini()} onBack={() => {}} onGenerate={() => {}} />);
  await screen.findByDisplayValue('Acme Logistics');
  expect(previewCard().getByText('Me')).toBeTruthy();
});

it('Back calls onBack', async () => {
  const user = userEvent.setup();
  const onBack = vi.fn();
  render(<SiteMoveSurveyOptions definition={DEF} initiative={null} onBack={onBack} onGenerate={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(onBack).toHaveBeenCalled();
});

# Sites Portal Implementation Plan (2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `/sites` page — filterable list with the shared toolbar, a read-only row expansion behind an Edit modal, a survey form rendered from the server registry, and a Leaflet map view.

**Architecture:** One page (`Sites.tsx`) with two views (list ⇄ map) over the same scoped `GET /sites` payload. All mutation lives in an Edit modal per the standing rule; the survey form is generated from `GET /sites/survey-schema` so field definitions stay server-authoritative. Pure helpers (filters, payload builders, coordinate formatting) live in `lib/sites.ts` and are unit-tested.

**Tech Stack:** React 19 + TypeScript + Vite, react-router-dom, vitest, Leaflet + react-leaflet (OpenStreetMap tiles, no API key).

**Spec:** `docs/superpowers/specs/2026-07-15-sites-design.md`. **Prerequisite:** the API plan (`2026-07-15-sites-api.md`) is complete — `/sites`, `/sites/{id}`, `/sites/{id}/clients`, `/sites/{id}/survey`, `/sites/survey-schema`, `/site-types`, `/site-statuses` are live.

## Global Constraints

- Same branch `feature/sites`. Verify with `cd portal && npm run build` (tsc strict) and `npm test` (vitest; baseline **37 passing**) after every task.
- **Standing rules (binding):** every list gets the shared Filters/Columns/Export toolbar (`lib/listTools.tsx`; `Workers.tsx` is the reference consumer). Record-backed pickers use the shared type-to-filter `ComboBox` — never a bare select for a record list. **No card grids.** **Row expansions display information only; every mutation lives behind an Edit button that opens a modal.** No dev-DB seeding.
- The UI must never offer what the server refuses: gate the Edit/New buttons on `can('sites','change')` / `can('sites','add')`.
- Fixed-vocabulary lookups (type/status) use native `<select>` — consistent with `TierSelect` and the Workers status control; the ComboBox rule is for *record* pickers (clients, partners).
- Surface API error codes readably via the established `.pf-error` code-map pattern: `invalid_coordinates`, `unknown_site_type`, `unknown_status`, `unknown_survey_field`, `invalid_survey_value`, `client_not_found`, `site_not_found`, `forbidden`.
- Commit after every task with the message in its final step.

---

### Task 1: Deps, API client, pure helpers

**Files:**
- Modify: `portal/package.json` (add `leaflet`, `react-leaflet`, `@types/leaflet`)
- Modify: `portal/src/lib/api.ts` (append the sites section)
- Create: `portal/src/lib/sites.ts`
- Test: `portal/src/lib/sites.test.ts`

**Interfaces:**
- Produces in `lib/api.ts`:
  ```ts
  export interface ClientRef { client_id: string; name: string }
  export interface SiteItem {
    id: string; name: string; code: string | null;
    site_type: string | null; type_label: string | null;
    status: string; status_label: string; status_color: string;
    address_line1: string | null; address_line2: string | null;
    city: string | null; region: string | null; postal_code: string | null;
    country: string; latitude: number | null; longitude: number | null;
    timezone: string | null; dc_provider: string | null;
    partner_id: string | null; partner_name: string | null;
    notes: string | null; archived_at: string | null; created_at: string;
    clients: ClientRef[];
  }
  export interface SiteDetailOut extends SiteItem { survey_data: Record<string, unknown> }
  export interface SiteLookup {
    key: string; label: string; description: string;
    sort_order: number; icon: string | null; color: string | null;
  }
  export interface SurveyFieldDef {
    key: string; label: string;
    kind: 'text' | 'textarea' | 'bool' | 'int' | 'select';
    options: string[];
  }
  export interface SurveySchema { groups: { key: string; label: string; fields: SurveyFieldDef[] }[] }

  export async function listSites(): Promise<SiteItem[]>;
  export async function getSite(id: string): Promise<SiteDetailOut>;
  export async function createSite(body: Record<string, unknown>): Promise<SiteDetailOut>;
  export async function updateSite(id: string, body: Record<string, unknown>): Promise<SiteDetailOut>;
  export async function archiveSite(id: string, archived: boolean): Promise<void>;
  export async function setSiteClients(id: string, clientIds: string[]): Promise<void>;
  export async function saveSiteSurvey(id: string, data: Record<string, unknown>): Promise<SiteDetailOut>;
  export async function getSurveySchema(): Promise<SurveySchema>;
  export async function listSiteTypes(): Promise<SiteLookup[]>;
  export async function listSiteStatuses(): Promise<SiteLookup[]>;
  ```
- Produces in `lib/sites.ts`:
  ```ts
  export interface SiteFilters {
    type: string[]; status: string[]; client: string[];
    country: string[]; coords: string[];       // 'yes' | 'no'
  }
  export const EMPTY_SITE_FILTERS: SiteFilters;
  export function matchesSiteFilters(site: SiteItem, f: SiteFilters): boolean;
  export function siteSearchText(site: SiteItem): string;
  export function formatCoords(lat: number | null, lon: number | null): string;
  export function sitePayload(form: SiteFormState): Record<string, unknown>;
  export function surveyPayload(values: Record<string, unknown>, schema: SurveySchema): Record<string, unknown>;
  export interface SiteFormState {
    name: string; code: string; site_type: string; status: string;
    address_line1: string; address_line2: string; city: string; region: string;
    postal_code: string; country: string; latitude: string; longitude: string;
    timezone: string; dc_provider: string; partner_id: string; notes: string;
  }
  export function formFromSite(site: SiteItem | null): SiteFormState;
  ```

- [ ] **Step 1: Add dependencies**

```bash
cd portal && npm install leaflet react-leaflet && npm install -D @types/leaflet
```

- [ ] **Step 2: Write the failing test**

```ts
// portal/src/lib/sites.test.ts
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SITE_FILTERS, formFromSite, formatCoords, matchesSiteFilters,
  siteSearchText, sitePayload, surveyPayload, type SiteFormState,
} from './sites';
import type { SiteItem, SurveySchema } from './api';

const site: SiteItem = {
  id: 's1', name: 'Acme DC1', code: 'ADC1',
  site_type: 'datacenter', type_label: 'Data centre',
  status: 'active', status_label: 'Active', status_color: 'c-green',
  address_line1: '1 Way', address_line2: null, city: 'Austin', region: 'TX',
  postal_code: '78701', country: 'US', latitude: 30.2672, longitude: -97.7431,
  timezone: 'America/Chicago', dc_provider: 'Switch',
  partner_id: null, partner_name: null, notes: null,
  archived_at: null, created_at: '2026-07-15T00:00:00Z',
  clients: [{ client_id: 'c1', name: 'Acme Co' }],
};

describe('matchesSiteFilters', () => {
  it('passes everything when empty', () => {
    expect(matchesSiteFilters(site, EMPTY_SITE_FILTERS)).toBe(true);
  });
  it('filters by type, status, client, country', () => {
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, type: ['office'] })).toBe(false);
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, type: ['datacenter'] })).toBe(true);
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, status: ['planned'] })).toBe(false);
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, client: ['c1'] })).toBe(true);
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, client: ['c2'] })).toBe(false);
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, country: ['CA'] })).toBe(false);
  });
  it('filters by coords presence', () => {
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, coords: ['yes'] })).toBe(true);
    expect(matchesSiteFilters(site, { ...EMPTY_SITE_FILTERS, coords: ['no'] })).toBe(false);
    const noCoords = { ...site, latitude: null, longitude: null };
    expect(matchesSiteFilters(noCoords, { ...EMPTY_SITE_FILTERS, coords: ['no'] })).toBe(true);
  });
});

describe('siteSearchText', () => {
  it('includes name, code, city, provider and client names', () => {
    const text = siteSearchText(site);
    expect(text).toContain('acme dc1');
    expect(text).toContain('adc1');
    expect(text).toContain('austin');
    expect(text).toContain('switch');
    expect(text).toContain('acme co');
  });
});

describe('formatCoords', () => {
  it('formats a pair and handles absence', () => {
    expect(formatCoords(30.2672, -97.7431)).toBe('30.2672, -97.7431');
    expect(formatCoords(null, null)).toBe('—');
    expect(formatCoords(30.2672, null)).toBe('—');
  });
});

describe('sitePayload', () => {
  const base: SiteFormState = formFromSite(null);
  it('omits blanks and parses numbers', () => {
    const out = sitePayload({ ...base, name: ' New DC ', latitude: '30.2672',
                              longitude: '-97.7431', city: '' });
    expect(out).toEqual({ name: 'New DC', country: 'US',
                          latitude: 30.2672, longitude: -97.7431 });
  });
  it('sends null coords when both cleared', () => {
    const out = sitePayload({ ...formFromSite(site), latitude: '', longitude: '' });
    expect(out.latitude).toBeNull();
    expect(out.longitude).toBeNull();
  });
  it('never includes survey_data', () => {
    expect('survey_data' in sitePayload(base)).toBe(false);
  });
});

describe('surveyPayload', () => {
  const schema: SurveySchema = { groups: [{ key: 'dock', label: 'Dock', fields: [
    { key: 'dock_available', label: 'Dock available', kind: 'bool', options: [] },
    { key: 'dock_hours', label: 'Dock hours', kind: 'text', options: [] },
    { key: 'floor', label: 'Floor', kind: 'int', options: [] },
  ] }] };
  it('coerces by kind and drops blanks', () => {
    expect(surveyPayload({ dock_available: true, dock_hours: '  ',
                           floor: '3' }, schema))
      .toEqual({ dock_available: true, floor: 3 });
  });
  it('drops unknown keys rather than sending them', () => {
    expect(surveyPayload({ nope: 'x', dock_hours: '9-5' }, schema))
      .toEqual({ dock_hours: '9-5' });
  });
  it('drops unparseable ints', () => {
    expect(surveyPayload({ floor: 'abc' }, schema)).toEqual({});
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd portal && npm test`
Expected: FAIL — cannot resolve `./sites`.

- [ ] **Step 4: Implement `lib/sites.ts`**

```ts
// portal/src/lib/sites.ts
/** Pure helpers for the Sites page — filtering, search text, and the
 *  payload builders. Kept out of the component so they're unit-testable. */

import type { SiteItem, SurveySchema } from './api';

export interface SiteFilters {
  type: string[];
  status: string[];
  client: string[];
  country: string[];
  coords: string[];        // 'yes' | 'no'
}

export const EMPTY_SITE_FILTERS: SiteFilters = {
  type: [], status: [], client: [], country: [], coords: [],
};

export function matchesSiteFilters(site: SiteItem, f: SiteFilters): boolean {
  if (f.type.length && !f.type.includes(site.site_type ?? '')) return false;
  if (f.status.length && !f.status.includes(site.status)) return false;
  if (f.client.length && !site.clients.some((c) => f.client.includes(c.client_id))) {
    return false;
  }
  if (f.country.length && !f.country.includes(site.country)) return false;
  if (f.coords.length) {
    const has = site.latitude !== null && site.longitude !== null;
    if (!f.coords.includes(has ? 'yes' : 'no')) return false;
  }
  return true;
}

export function siteSearchText(site: SiteItem): string {
  return [
    site.name, site.code, site.type_label, site.status_label, site.city,
    site.region, site.country, site.dc_provider, site.partner_name,
    ...site.clients.map((c) => c.name),
  ].filter(Boolean).join(' ').toLowerCase();
}

export function formatCoords(lat: number | null, lon: number | null): string {
  if (lat === null || lon === null) return '—';
  return `${lat}, ${lon}`;
}

export interface SiteFormState {
  name: string; code: string; site_type: string; status: string;
  address_line1: string; address_line2: string; city: string; region: string;
  postal_code: string; country: string; latitude: string; longitude: string;
  timezone: string; dc_provider: string; partner_id: string; notes: string;
}

export function formFromSite(site: SiteItem | null): SiteFormState {
  return {
    name: site?.name ?? '',
    code: site?.code ?? '',
    site_type: site?.site_type ?? '',
    status: site?.status ?? 'active',
    address_line1: site?.address_line1 ?? '',
    address_line2: site?.address_line2 ?? '',
    city: site?.city ?? '',
    region: site?.region ?? '',
    postal_code: site?.postal_code ?? '',
    country: site?.country ?? 'US',
    latitude: site?.latitude != null ? String(site.latitude) : '',
    longitude: site?.longitude != null ? String(site.longitude) : '',
    timezone: site?.timezone ?? '',
    dc_provider: site?.dc_provider ?? '',
    partner_id: site?.partner_id ?? '',
    notes: site?.notes ?? '',
  };
}

const TEXT_FIELDS: (keyof SiteFormState)[] = [
  'name', 'code', 'site_type', 'status', 'address_line1', 'address_line2',
  'city', 'region', 'postal_code', 'country', 'timezone', 'dc_provider',
  'partner_id', 'notes',
];

export function sitePayload(form: SiteFormState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TEXT_FIELDS) {
    const value = form[key].trim();
    if (value) out[key] = value;
  }
  // Coordinates travel together: both set, or both explicitly cleared.
  const lat = form.latitude.trim();
  const lon = form.longitude.trim();
  if (lat && lon) {
    out.latitude = Number(lat);
    out.longitude = Number(lon);
  } else if (!lat && !lon) {
    out.latitude = null;
    out.longitude = null;
  } else {
    // half a coordinate — send it and let the server say invalid_coordinates
    out.latitude = lat ? Number(lat) : null;
    out.longitude = lon ? Number(lon) : null;
  }
  return out;
}

export function surveyPayload(
  values: Record<string, unknown>, schema: SurveySchema,
): Record<string, unknown> {
  const kinds = new Map<string, string>();
  for (const group of schema.groups) {
    for (const field of group.fields) kinds.set(field.key, field.kind);
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values)) {
    const kind = kinds.get(key);
    if (!kind) continue;                       // unknown key — never send it
    if (kind === 'bool') {
      if (raw === true) out[key] = true;
      continue;                                // false/undefined = unanswered
    }
    if (kind === 'int') {
      const n = Number(String(raw ?? '').trim());
      if (String(raw ?? '').trim() !== '' && Number.isInteger(n)) out[key] = n;
      continue;
    }
    const text = String(raw ?? '').trim();
    if (text) out[key] = text;
  }
  return out;
}
```

- [ ] **Step 5: Implement the API client**

Append to `portal/src/lib/api.ts` — the interfaces from the Interfaces block above, then the functions, each following the existing `apiFetch` + `errorFrom` convention already used by `setUserRoles`/`addContactLink`:

```ts
export async function listSites(): Promise<SiteItem[]> {
  const resp = await apiFetch('/sites');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getSite(id: string): Promise<SiteDetailOut> {
  const resp = await apiFetch(`/sites/${id}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createSite(body: Record<string, unknown>): Promise<SiteDetailOut> {
  const resp = await apiFetch('/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateSite(
  id: string, body: Record<string, unknown>,
): Promise<SiteDetailOut> {
  const resp = await apiFetch(`/sites/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function archiveSite(id: string, archived: boolean): Promise<void> {
  const resp = await apiFetch(
    `/sites/${id}/${archived ? 'archive' : 'unarchive'}`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function setSiteClients(id: string, clientIds: string[]): Promise<void> {
  const resp = await apiFetch(`/sites/${id}/clients`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_ids: clientIds }),
  });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function saveSiteSurvey(
  id: string, data: Record<string, unknown>,
): Promise<SiteDetailOut> {
  const resp = await apiFetch(`/sites/${id}/survey`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ survey_data: data }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getSurveySchema(): Promise<SurveySchema> {
  const resp = await apiFetch('/sites/survey-schema');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listSiteTypes(): Promise<SiteLookup[]> {
  const resp = await apiFetch('/site-types');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listSiteStatuses(): Promise<SiteLookup[]> {
  const resp = await apiFetch('/site-statuses');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

- [ ] **Step 6: Verify**

Run: `cd portal && npm test && npm run build`
Expected: vitest 37 baseline + 11 new = **48 passing**; build clean.

- [ ] **Step 7: Commit**

```bash
git add portal/package.json portal/package-lock.json portal/src/lib/api.ts portal/src/lib/sites.ts portal/src/lib/sites.test.ts
git commit -m "feat(portal): sites api client + pure helpers"
```

---

### Task 2: Sites page — route, nav, list, read-only expansion

**Files:**
- Create: `portal/src/pages/Sites.tsx`
- Create: `portal/src/styles/sites.css`
- Modify: `portal/src/App.tsx` (route), `portal/src/layout/AppShell.tsx` (nav item), `portal/src/components/CommandPalette.tsx` (command), `portal/src/lib/access.ts` (`ROUTE_RESOURCE`)

**Interfaces:**
- Consumes: `listSites`, `listSiteTypes`, `listSiteStatuses` from `lib/api.ts`; helpers from `lib/sites.ts`; `useAuth().can`.
- **Clients and partners lists** (needed for the Client filter facet here, and for the modal's pickers in Task 3): fetch them the way `External.tsx` already does — read its `loadAllOrgs` helper and reuse that path rather than inventing a new client function. Hold both in page state and pass them down to the modal.
- Produces: page component at route `/sites` (resource `sites`), nav item under **Operations**. Row expansion is read-only; the Edit button is rendered but wired in Task 3 (pass a no-op handler until then).

- [ ] **Step 1: Register route, nav, palette, route map**

`portal/src/lib/access.ts` — add to `ROUTE_RESOURCE`:
```ts
  '/sites': 'sites',
```

`portal/src/App.tsx` — add inside the shell routes (mirroring `/people/workers`):
```tsx
<Route path="/sites" element={<ProtectedRoute resource="sites"><Sites /></ProtectedRoute>} />
```
with `import Sites from './pages/Sites';`.

`portal/src/layout/AppShell.tsx` — add to the **Operations** section's `items`, after Dashboard:
```tsx
      {
        to: '/sites',
        label: 'Sites',
        resource: 'sites',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 21s-7-5.5-7-11a7 7 0 1 1 14 0c0 5.5-7 11-7 11z" />
            <circle cx="12" cy="10" r="2.6" />
          </svg>
        ),
      },
```

`portal/src/components/CommandPalette.tsx` — add a nav command gated on `can('sites', 'view')` that navigates to `/sites`, following the existing per-resource entries.

- [ ] **Step 2: Build the page (list + read-only expansion)**

`portal/src/pages/Sites.tsx`. Follow `Workers.tsx` structurally — it is the reference `listTools.tsx` consumer; read it before writing.

- State: `sites`, `types`, `statuses`, `clients` (for the filter facet), `filters`, `query`, `visibleCols`, `openId`, `editing`.
- Load on mount: `listSites()`, `listSiteTypes()`, `listSiteStatuses()`, `listClients()`.
- Toolbar via `listTools.tsx`: **Filters** (Type → types lookup; Status → statuses lookup; Client → clients; Country → distinct countries in the data; Coordinates → yes/no), **Columns** (every column toggleable), **Export** (CSV of the filtered rows).
- Search box filters on `siteSearchText(site).includes(query.toLowerCase())`; rows additionally pass `matchesSiteFilters(site, filters)`.
- Columns: Name (+ code beneath), Type (chip, `type_label`), Status (chip coloured by `status_color` — `className={`chip ${site.status_color}`}`), Clients (chips, `+N` past two), City, Country, DC provider, Coords (`formatCoords`).
- Archived sites render with the `.archived` row class and an "Archived" chip; they stay in the list (no filter needed — the Status facet covers intent).
- **Row expansion — read-only only** (standing rule): address block, coordinates + timezone, partner, DC provider, clients, notes, and a survey summary line ("Survey: 6 fields across 3 groups" or "No survey data"). The ONLY interactive element is:
```tsx
{can('sites', 'change') && (
  <button className="btn-solid" onClick={() => setEditing(site.id)}>Edit</button>
)}
```
- Page head + a **New site** button gated on `can('sites', 'add')` (opens the same modal in create mode — wired in Task 3).
- `sites.css`: row/expansion layout only; reuse existing tokens and chip classes from `directory.css`/`portal-theme.css` (import `directory.css` from the page, as `Access.tsx` does, so the `--surface`/`--c-*` tokens are explicit rather than accidental).

- [ ] **Step 3: Verify**

Run: `cd portal && npm run build && npm test` — both green.
Then: start the dev server, sign in, confirm the Sites nav item appears, the list renders (empty is fine — no seeding), toolbar opens, and expanding a row shows read-only content with a single Edit button.

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/Sites.tsx portal/src/styles/sites.css portal/src/App.tsx portal/src/layout/AppShell.tsx portal/src/components/CommandPalette.tsx portal/src/lib/access.ts
git commit -m "feat(portal): sites page — list, toolbar, read-only expansion"
```

---

### Task 3: Edit modal — fields, client links, survey form

**Files:**
- Create: `portal/src/components/sites/SiteEditModal.tsx`
- Create: `portal/src/components/sites/SurveyForm.tsx`
- Modify: `portal/src/pages/Sites.tsx` (wire the modal)

**Interfaces:**
- `SiteEditModal` props:
  ```ts
  interface Props {
    site: SiteItem | null;          // null = create mode
    types: SiteLookup[];
    statuses: SiteLookup[];
    clients: { id: string; name: string }[];
    partners: { id: string; name: string }[];
    canChange: boolean;
    onClose: () => void;
    onSaved: () => Promise<void> | void;   // parent refetches
  }
  ```
- `SurveyForm` props: `{ schema: SurveySchema; values: Record<string, unknown>; onChange: (key: string, value: unknown) => void; disabled?: boolean }` — renders each group as a section, each field by `kind` (text/textarea → input/textarea; bool → checkbox; int → number input; select → native select of `options`).

- [ ] **Step 1: Build the modal**

Follow the modal pattern already in `portal/src/pages/External.tsx` (`GrantAccessModal`) — same `modal-scrim` / `modal-card` / `modal-head` / `modal-body` / `modal-foot` classes.

Contents, in order:
1. **Details** — name (required), code, type `<select>` (from `types`), status `<select>` (from `statuses`).
2. **Address** — address_line1/2, city, region, postal_code, country.
3. **Location** — latitude, longitude (number inputs), timezone, dc_provider. Helper text under the coords pair: "Set both or neither."
4. **Relationships** — partner **ComboBox** (record picker → ComboBox, per the standing rule; clearable), clients **multi-select via ComboBox** (pick to add → chips with an × to remove; the chip list is the desired set).
5. **Survey** — `<SurveyForm>` fed by `getSurveySchema()` (fetch once on modal open; in create mode the survey section is hidden — a site must exist before a survey can be saved against it, since `PUT /sites/{id}/survey` needs an id).

Save behavior:
- **Create mode:** `createSite(sitePayload(form))` → then, if clients were picked, `setSiteClients(newId, clientIds)` → `onSaved()`. If the client-link step fails after creation, keep the modal open in **edit mode for the created site** with a message that distinguishes "site created, links failed — press Save to retry" (same trap the contacts modal already solved — never re-create on retry).
- **Edit mode:** `updateSite(id, sitePayload(form))`, then `setSiteClients(id, clientIds)` only when the set actually changed, then `saveSiteSurvey(id, surveyPayload(values, schema))` only when the survey changed. Each step's failure surfaces its mapped error and stops.
- Archive/unarchive button lives in the modal footer (edit mode only), calling `archiveSite(id, !archived)`.
- All controls disabled while `saving`; the modal is the only place any of this is editable.
- Error map:
```ts
const SITE_ERRORS: Record<string, string> = {
  invalid_coordinates: 'Latitude and longitude must both be set, and within range.',
  unknown_site_type: 'That site type no longer exists — pick another.',
  unknown_status: 'That status no longer exists — pick another.',
  unknown_survey_field: 'A survey field is no longer valid — reload and retry.',
  invalid_survey_value: 'A survey answer has the wrong format.',
  client_not_found: 'One of the selected clients no longer exists.',
  site_not_found: 'This site no longer exists.',
  forbidden: 'You do not have permission to change sites.',
};
```

- [ ] **Step 2: Verify**

Run: `cd portal && npm run build && npm test` — green.
Browser: create a site (name only), reopen it, set coordinates and a client link, fill two survey fields, save, confirm the expansion reflects all of it. Try latitude alone → expect the coordinate message.

- [ ] **Step 3: Commit**

```bash
git add portal/src/components/sites/ portal/src/pages/Sites.tsx
git commit -m "feat(portal): site edit modal with client links and survey form"
```

---

### Task 4: Map view

**Files:**
- Create: `portal/src/components/sites/SitesMap.tsx`
- Modify: `portal/src/pages/Sites.tsx` (view toggle), `portal/src/styles/sites.css` (map height)

**Interfaces:**
- `SitesMap` props: `{ sites: SiteItem[]; onSelect: (id: string) => void }` — renders only sites with both coordinates.

- [ ] **Step 1: Build the map**

```tsx
// portal/src/components/sites/SitesMap.tsx
/** Leaflet map of sites that have coordinates. OpenStreetMap tiles — no API
 *  key, no account. Sites without coordinates are listed by the caller. */

import { useEffect, useMemo } from 'react';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { SiteItem } from '../../lib/api';

// Leaflet's default marker icons resolve to broken paths under a bundler;
// point them at the packaged assets explicitly.
const icon = L.icon({
  iconUrl: new URL('leaflet/dist/images/marker-icon.png', import.meta.url).href,
  iconRetinaUrl: new URL('leaflet/dist/images/marker-icon-2x.png', import.meta.url).href,
  shadowUrl: new URL('leaflet/dist/images/marker-shadow.png', import.meta.url).href,
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
  }, [map, points]);
  return null;
}

export default function SitesMap({ sites, onSelect }: {
  sites: SiteItem[];
  onSelect: (id: string) => void;
}) {
  const located = useMemo(
    () => sites.filter((s) => s.latitude !== null && s.longitude !== null),
    [sites],
  );
  const points = useMemo(
    () => located.map((s) => [s.latitude as number, s.longitude as number] as [number, number]),
    [located],
  );

  if (!located.length) {
    return <p className="set-note">No sites have coordinates yet.</p>;
  }

  return (
    <MapContainer center={points[0]} zoom={4} className="sites-map">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitBounds points={points} />
      {located.map((s) => (
        <Marker key={s.id} icon={icon}
                position={[s.latitude as number, s.longitude as number]}>
          <Popup>
            <b>{s.name}</b>
            <div>{s.type_label ?? '—'} · {s.status_label}</div>
            {s.clients.length > 0 && (
              <div>{s.clients.map((c) => c.name).join(', ')}</div>
            )}
            <button className="link-plain" onClick={() => onSelect(s.id)}>
              Open details
            </button>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
```

`sites.css` needs a height or the map renders 0px tall:
```css
.sites-map { height: 60vh; border-radius: 14px; overflow: hidden; }
```

- [ ] **Step 2: Wire the toggle**

In `Sites.tsx`, add `view: 'list' | 'map'` state and a two-button pill toggle in the toolbar row (match the tab-pill styling used on the Access page). In map view render `<SitesMap sites={filtered} onSelect={(id) => { setView('list'); setOpenId(id); }} />` followed by a compact "N sites without coordinates" line listing their names, so they aren't silently invisible. Filters and search apply to both views (`filtered` feeds each).

- [ ] **Step 3: Verify**

Run: `cd portal && npm run build && npm test` — green.
Browser: create two sites with coordinates, switch to Map, confirm markers appear, bounds fit both, the popup shows details, and "Open details" returns to the list with that row expanded. Confirm a filter applied in list view also reduces the markers.

- [ ] **Step 4: Commit**

```bash
git add portal/src/components/sites/SitesMap.tsx portal/src/pages/Sites.tsx portal/src/styles/sites.css
git commit -m "feat(portal): sites map view with OpenStreetMap tiles"
```

---

## Completion

Both plans done = the Sites spec is implemented except the explicitly deferred items (locations, bulk import, pagination, asset counts, site photos, client self-service). Finish with the superpowers:finishing-a-development-branch skill: full API suite + portal build/test green, then merge `feature/sites`.

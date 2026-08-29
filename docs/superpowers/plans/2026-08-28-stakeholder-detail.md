# Stakeholder Full-Detail Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Full-detail pages for clients and partners (`/stakeholders/clients/:id`, `/stakeholders/partners/:id`) in the /me-page style: logo-chip hero, org details, previous initiatives, people/workers lists (standard list machinery), and a Notes & uploads section.

**Architecture:** One shared `StakeholderDetail.tsx` page parameterized by kind (mirroring how OrgDirectory serves both). API only needs notes-host entries for client/partner (attachments + logo upload already support both). Lists use the house directory-list machinery.

**Tech Stack:** existing only.

## Global Constraints

- "Standard lists" is binding: every list on the page uses the shared machinery — page-local `ColumnDef[]`, `usePersistentListState` (own storage key per list), sortable headers with carets, per-column `ColumnMenu` filters, search box + `result-count`, `FilterSummaryChip`, `ColumnsButton`, `ExportButton`/`exportCsv`, `VirtualRows`. MoveDashboard's roster (`portal/src/pages/MoveDashboard.tsx`) is the read-only exemplar; timestamp columns sort by `Date.parse`.
- Status chips wrap in `StatusHover` (`entityType="client"` / `"partner"` for the org's own status — the provenance API already supports both; `entityType="initiative"` / `"worker"` inside lists).
- Hero mirrors `/me` (`portal/src/pages/Profile.tsx`): `.profile-hero`/`.profile-cover`/`.profile-id`/`.profile-meta` chrome (styles in `portal/src/styles/profile.css`), with `AvatarUpload` as the logo chip — it already supports `entityType: 'client' | 'partner'` and uploads land on `logo_key` server-side.
- Notes & uploads = the existing `NotesFilesPanel` component (`entityType="client"|"partner"`), write access gated on `can(kind, 'change')`.
- Dark theme via tokens; no new colors. Hours/money: n/a.
- Tests FOREGROUND, one continuous run, timeout 600000ms.

---

### Task 1: API — notes hosts for client/partner

**Files:**
- Modify: `api/src/serversherpa/api/routes/notes.py` (NOTE_HOSTS += `"client": ("clients", Client)`, `"partner": ("partners", Partner)`; import models)
- Test: extend `api/tests/test_notes.py` (or the existing notes test file — find it; follow its per-host test pattern)

**Steps:**
- [ ] TDD: add tests first — create/list/edit/delete a note on a client and on a partner as a global staff/admin user; 404 unknown org; a role with no clients grant → 403. ALSO one scoped-actor test: a client-scoped user (client_owner anchored to org A) can view/add notes on org A but gets 403/404 on org B — the existing `scope_conditions` machinery in notes.py must be exercised, not bypassed (check how the hosts dict flows into the scope query; if org-anchored hosts need special handling like the workers branch found for person hosts, report it rather than hacking around it).
- [ ] Implement; focused tests green; FULL api suite foreground; commit `feat(api): notes on clients and partners` (Claude Fable trailer).

---

### Task 2: Portal — StakeholderDetail page

**Files:**
- Create: `portal/src/pages/StakeholderDetail.tsx`
- Modify: `portal/src/App.tsx` (routes `/stakeholders/clients/:id` → `<StakeholderDetail kind="client" />` behind resource `clients`; `/stakeholders/partners/:id` → `kind="partner"` behind `partners`)
- Modify: `portal/src/lib/api.ts` (add `OrgItem` interface — lift the shape from OrgDirectory.tsx's local one — plus `getOrg(kind, id)`, `listOrgContacts(kind, id)`, `listPartnerWorkers(id)` fetchers IF not already exported; reuse whatever exists rather than duplicating)
- Modify: `portal/src/pages/OrgDirectory.tsx` (row detail gains a `Full Details ↗` link to the new page; keep everything else untouched)
- Modify: `portal/src/components/Topbar.tsx` (search select(): `client`/`partner` hits navigate to the detail page instead of the list-with-openRow, mirroring the site/initiative branches)

**Page layout (top → bottom):**
1. Back link `← Clients` / `← Partners` (idet-back) to the directory.
2. **Hero** (/me chrome): `AvatarUpload` logo chip (name-seeded gradient fallback, upload gated on `can(kind,'change')`; after upload update local logo url from the returned attachment like Profile.tsx does), name + chips row (kind label chip, status chip in `StatusHover`, tier chip, and for partners the `partner_types` chips as on the directory rows), sub-line: account manager · website (as a real link) · phone.
3. **Details panel** (`.panel`/`.panel-head`/`.panel-body` + `<dl className="kv">`): Code, Address (lines/city/region/postal/country), Phone, Website, Account manager, Tier, Created. Also the org's own `notes` text field if non-empty (label "Directory notes").
4. **Previous initiatives** (standard list, storage key `stakeholder_initiatives`): rows from `listInitiatives()` filtered client-side — client: `i.client_id === id`; partner: any of `shipping_partner_id`, `origin_tech_partner_id`, `origin_cable_partner_id`, `origin_logistics_partner_id`, `destination_tech_partner_id`, `destination_cable_partner_id`, `destination_logistics_partner_id` equals id. Columns: Name(1.6fr default) · Type(1fr default, chip) · Sub-type(1fr) · Status(1fr default, chip+StatusHover initiative) · Start(0.9fr default) · End(0.9fr) · **Role(1.1fr, partners only, default)** — role = comma-joined labels of which partner slots matched ("Shipping", "Origin tech", "Origin cable", "Origin logistics", "Destination tech", …). Rows link to `/initiatives/:id`. Default sort Start desc (Date.parse). Empty state "No initiatives yet."
5. **People** (standard list, key `stakeholder_contacts`): contacts from the org contacts endpoint. Columns: Name(1.4fr) · Contact tier(0.9fr) · Email(1.4fr) · Phone(1fr) · Job title(1.1fr). Empty state "No contacts yet."
6. **Workers** (partners only; standard list, key `stakeholder_workers`): from `/partners/{id}/workers`. Columns: Name(1.4fr) · Trade(1fr) · Level(0.9fr) · Status(1fr, chip + StatusHover worker) · Certs(0.7fr). Row link `Full Details` → `/people/workers/{person_id}`. Empty state "No workers supplied yet."
7. **Notes & uploads**: `<NotesFilesPanel entityType={kind} entityId={id} canWrite={can(kind,'change')} />` in an `.init-panel`.
- Missing org → dir-empty "Client not found" / "Partner not found". Every fetch guarded; secondary-panel failures degrade to empty states (house convention).

**Steps:**
- [ ] Implement; `npx tsc --noEmit`; FULL portal suite + build foreground.
- [ ] Commit `feat(portal): stakeholder full-detail pages — hero, initiatives, people/workers, notes & uploads` (Claude Fable trailer).

---

### Task 3: Verification (orchestrator)
- [ ] Browser: partner detail (Hen-U — has 62 workers) — hero/logo, chips, initiatives list machinery (sort/filter/columns), workers list, contacts empty state, notes add + file upload; client detail (Broadcom); Full Details links from directory; search → detail; dark theme spot-check. Full suites; ledger.

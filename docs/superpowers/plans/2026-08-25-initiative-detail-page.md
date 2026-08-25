# Initiative Full Details Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/initiatives/:id` Full Details page (v2-detail-page spirit) reached from a "Full details" button in the Initiatives expanded row, with header + info cards, an Assets placeholder, an editable People table, Linked initiatives, and Notes & Attachments.

**Architecture:** One new page component (portal/src/pages/InitiativeDetail.tsx) that owns its data loading (`getInitiative` + the same vocab/option loads Initiatives.tsx does), reuses `InitiativeEditModal`, `ComboBox`, `NotesFilesPanel`, and existing chip/panel CSS, and adds page-scoped `idet-` styles to initiatives.css. Two one-line integrations: the route in App.tsx and the button in `InitiativeRowDetail`.

**Tech Stack:** React 18 + TypeScript, react-router-dom v6, existing api client (no new endpoints).

**Spec:** docs/superpowers/specs/2026-08-25-initiative-detail-page-design.md — read it in full; it is the requirements source.

## Global Constraints

- All commands run from `portal/`. Verification: `npx tsc -b` clean, `npm test` green (370 existing tests), `npm run build` clean.
- Follow the codebase's style: 2-space indent, doc-comment tone from Initiatives.tsx, kv/dl markup for label-value pairs, `run()` mutation pattern from `InitiativeRowDetail`.
- Reuse before invent: `.init-panel`, `.kv`, `.eyebrow-sm`, `.page-hint`, `.init-row(s)`, `.init-add`, `.chip custom` + `--chip` var, `.btn-solid/.btn-ghost/.mini-btn`, `.pf-error`. New classes only with the `idet-` prefix, added to portal/src/styles/initiatives.css.
- Permissions identical to the list page: `can('initiatives','change')` gates all mutation UI; sites/clients/partners/workers loads gated by their own `can(x,'view')`.
- Commit messages end with:

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 1: page skeleton + route + row button

**Files:**
- Create: `portal/src/pages/InitiativeDetail.tsx`
- Modify: `portal/src/App.tsx` (add route), `portal/src/pages/Initiatives.tsx` (Full details button in `detail-actions`, ~line 767)
- Modify: `portal/src/styles/initiatives.css` (append `idet-` styles)

**Interfaces:**
- Consumes: `getInitiative`, `InitiativeDetail`, vocab loaders, `InitiativeEditModal` (props as used at Initiatives.tsx:499–507), `initiativeCellText` for date formatting, `useAuth().can`.
- Produces: default-export `InitiativeDetail` page component registered at `/initiatives/:id`; sections container the later task fills (People/Links/Notes render as simple placeholders in this task ONLY if splitting is needed — prefer completing static sections here).

- [ ] **Step 1:** Build the page: `useParams` id; load `getInitiative(id)` into state (reload on id change); load statuses/types/subTypes/workTypes/shippingTypes always and sites/clients/partners/workers/allInitiatives behind `can()` view checks. Render: back link (`Link` to `/initiatives`), header block (name, type/sub-type/status chips via the `--chip` pattern, Archived tag, description, Edit button opening `InitiativeEditModal`, `onSaved` → refetch), Overview card, Move card (moves only, partner-role names resolved from partners list), Assets placeholder panel. Error states per spec. Add `idet-` CSS for header + card grid.
- [ ] **Step 2:** Register the route in App.tsx after the `/initiatives` route: `<Route path="/initiatives/:id" element={<ProtectedRoute resource="initiatives"><InitiativeDetail /></ProtectedRoute>} />` (name the import to avoid clashing with the `InitiativeDetail` type import if both appear — use `import InitiativeDetailPage from './pages/InitiativeDetail'`).
- [ ] **Step 3:** In Initiatives.tsx `InitiativeRowDetail` actions (~line 767), add `<button className="btn-ghost" onClick={...navigate}>Full details</button>` before the Edit button; get `navigate` via `useNavigate()` inside `InitiativeRowDetail`.
- [ ] **Step 4:** Verify `npx tsc -b` clean; commit `feat(portal): initiative Full Details page — skeleton, route, row button`.

### Task 2: People table + edit dialog, Linked initiatives, Notes & Attachments

**Files:**
- Modify: `portal/src/pages/InitiativeDetail.tsx`, `portal/src/styles/initiatives.css`

**Interfaces:**
- Consumes: `addInitiativePerson`, `updateInitiativePerson(assocId, body)`, `removeInitiativePerson`, `addInitiativeLink`, `removeInitiativeLink`, `listInitiatives`, `ComboBox`, `NotesFilesPanel`.
- Produces: complete page per spec sections 4–6.

- [ ] **Step 1:** People section: table (`idet-table`) Name / Work type chip / Site worked / Rating (★ n) / actions; Edit opens a small dialog (reuse the codebase's modal shell pattern — see InitiativeEditModal's overlay classes) with Work type ComboBox (clearable), Site worked ComboBox (clearable, options from sites), Rating number input 1–5 (blank → null); Save → `updateInitiativePerson` → refetch. Remove + add-person row as in `InitiativeRowDetail`. All mutation UI behind canChange; `run()` pattern with `pf-error` + busy.
- [ ] **Step 2:** Linked initiatives section (contains/part-of, unlink for children, link-as-child ComboBox from non-archived unlinked initiatives) with names navigating to `/initiatives/<other_id>`; Notes & Attachments via `NotesFilesPanel entityType="initiative"`.
- [ ] **Step 3:** Verify `npx tsc -b` clean and `npm test` green; commit `feat(portal): initiative detail — people table, links, notes`.

### Task 3: verification (controller)

- [ ] Full suite + build; live browser pass per spec Testing section; fix-forward anything found.

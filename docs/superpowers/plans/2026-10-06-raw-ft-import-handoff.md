# Convert Raw F-T → import handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let super admins send the converted file straight into a move's From-To import: a second button on step 3, a step 4 to pick the move, and the import page opening with the file already loaded.

**Architecture:** An in-memory handoff module carries the File across the SPA navigation; the import page seeds its file state from it. WizardFooter gains a secondary button. The wizard adds a rank-gated fourth step.

**Tech Stack:** React + TypeScript, react-router, SheetJS, vitest/testing-library.

Spec: `docs/superpowers/specs/2026-10-06-raw-ft-import-handoff-design.md` (binding copy and rules).

## Global Constraints

- Gate: `maxRank >= SUPER_ADMIN_RANK && can('initiatives', 'change')` (`SUPER_ADMIN_RANK` from `portal/src/lib/access.ts`). Ineligible people see today's three-step wizard unchanged.
- Copy verbatim from the spec: button `Import into a move`; step 4 key `import`, label `Import`, title `Choose the move`, description `Pick the move to import into. Its From-To import opens with the converted file already loaded.`; ComboBox label `Move`, placeholder `Pick a move…`; lines `Loading moves…`, `Couldn't load moves. Go back and try again.`, `There are no moves to import into.`; primary `Open the import`; import-page note `This file came from Convert Raw F-T.`
- Move options: `initiative_type === 'move'` and `archived_at == null`, `sortNatural` by name, `sub` = `{status_label} · {origin_site_name ?? '—'} → {destination_site_name ?? '—'}`.
- Handoff is module-scope memory only (no storage, no server). Peek is side-effect free; the import page clears it in a mount effect.
- Handed-off File: same workbook + `compression: true` as the download, name `convertedFilename(file.name)`, type `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
- Reuse idioms (ComboBox, mini-btn, btn-solid, page-hint, pf-error). No native `<select>`; no `localeCompare`/bare `.sort()`; no new `*-head` CSS selectors.
- American English. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash`.
- Portal checks from `portal/`, foreground: `npx vitest run <files>`, full `npx vitest run`, `npx tsc -b`, `npm run build`.

---

### Task 1: handoff module, import-page preload, WizardFooter secondary, hook `toFile()`

**Files:**
- Create: `portal/src/lib/importHandoff.ts`, `portal/src/lib/importHandoff.test.ts`
- Modify: `portal/src/pages/ImportMoveAssets.tsx` (+ its test file `portal/src/pages/ImportMoveAssets.test.tsx`)
- Modify: `portal/src/components/common/WizardFooter.tsx` (+ create `WizardFooter.test.tsx` if none exists)
- Modify: `portal/src/components/bulk/rawFt/useRawFtConvert.ts` (+ `useRawFtConvert.test.tsx`)

**Interfaces (Produces):**
- `handOffImportFile(initiativeId: string, file: File): void`, `peekHandedOffImportFile(initiativeId: string | undefined): File | null`, `clearHandedOffImportFile(initiativeId: string | undefined): void`.
- `WizardFooter` prop `secondary?: { label: string; onClick: () => void; disabled?: boolean }`.
- `useRawFtConvert(...).toFile(): File | null` — null before a conversion exists.

Code:

```ts
// portal/src/lib/importHandoff.ts
/**
 * importHandoff — carries one file from Bulk Actions › Convert Raw F-T to a
 * move's From-To import page across the in-app navigation. Memory only: a
 * reload loses it, like any file someone picked but hadn't imported yet.
 * Spec: docs/superpowers/specs/2026-10-06-raw-ft-import-handoff-design.md
 */
let pending: { initiativeId: string; file: File } | null = null;

export function handOffImportFile(initiativeId: string, file: File): void {
  pending = { initiativeId, file };
}

/** The file handed off for this initiative, without consuming it (safe in a
 *  lazy useState initializer, which StrictMode calls twice). */
export function peekHandedOffImportFile(initiativeId: string | undefined): File | null {
  return pending && initiativeId && pending.initiativeId === initiativeId ? pending.file : null;
}

export function clearHandedOffImportFile(initiativeId: string | undefined): void {
  if (pending && pending.initiativeId === initiativeId) pending = null;
}
```

ImportMoveAssets:

```tsx
const [handedOff] = useState(() => peekHandedOffImportFile(id));
const [file, setFile] = useState<File | null>(() => handedOff);
useEffect(() => { clearHandedOffImportFile(id); }, [id]);
// under <ImportUploadFields …/>:
{handedOff && file === handedOff && (
  <p className="page-hint">This file came from Convert Raw F-T.</p>
)}
```

Hook:

```ts
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const toFile = (): File | null => {
  if (!file || !conversion) return null;
  const bytes = XLSX.write(convertedWorkbook(conversion), { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer;
  return new File([bytes], convertedFilename(file.name), { type: XLSX_TYPE });
};
```

WizardFooter: render `{secondary && <button className="mini-btn" type="button" disabled={busy || !!secondary.disabled} onClick={secondary.onClick}>{secondary.label}</button>}` immediately before the primary; give the secondary `className="mini-btn wiz-next"` only if needed for the right-side placement — the primary currently has `wiz-next` (margin-left: auto); make the secondary carry `wiz-next` when present and the primary not, or wrap both in a right-aligned span. Keep the existing footer tests green.

- [ ] Step 1: tests (importHandoff cases from the spec; ImportMoveAssets preload/note/clear/no-note/other-file cases — follow that test file's existing mocks; WizardFooter secondary order/click/disabled/busy; hook `toFile()` returns null before a file, then a File with the converted name, xlsx type, and bytes that `readWorkbook` reads back to `[header, ...rows]`). Run → FAIL.
- [ ] Step 2: implement. Run the four test files + `npx tsc -b` → PASS.
- [ ] Step 3: commit `feat(portal): import handoff for converted files; WizardFooter secondary action`.

---

### Task 2: the gated step 4 and the step-3 button

**Files:**
- Modify: `portal/src/components/bulk/rawFt/steps.ts` (add the `import` step; export `RAW_FT_STEPS` (4 entries) and keep the type union in sync)
- Create: `portal/src/components/bulk/rawFt/ImportStep.tsx`
- Modify: `portal/src/pages/BulkConvertRawFt.tsx`
- Test: `portal/src/components/bulk/rawFt/RawFtSteps.test.tsx` and/or `portal/src/pages/BulkConvertRawFt.test.tsx` (mock `useAuth` for rank/permission; mock `listInitiatives`; mock `useNavigate` or render inside a MemoryRouter with a catch route showing the path)

**Interfaces:** Consumes Task 1 (`handOffImportFile`, `toFile`, `secondary`).

- `ImportStep({ moveId, onMove })`: loads `listInitiatives()` once on mount, filters/sorts/labels per the Global Constraints, renders the `Move` ComboBox (`inputId="ftc-move"`) and the loading/failure/empty lines.
- Page: `const { maxRank, can } = useAuth(); const canImport = maxRank >= SUPER_ADMIN_RANK && can('initiatives', 'change');` `const steps = canImport ? RAW_FT_STEPS : RAW_FT_STEPS.slice(0, 3);` pass `steps` to WizardHeader (the Chrome helper takes them). Step 3 footer adds `secondary={canImport ? { label: 'Import into a move', onClick: () => setStep(3), disabled: convert.matched === 0 } : undefined}`. Step 4 (only when `canImport`): `<ImportStep moveId={moveId} onMove={setMoveId} />` + `<WizardFooter onBack={() => setStep(2)} nextLabel="Open the import" nextDisabled={!moveId} onNext={openImport} />` where `openImport` = `const f = convert.toFile(); if (!f || !moveId) return; handOffImportFile(moveId, f); navigate(`/initiatives/${moveId}/import-assets`);`. The loading/error Chrome before the template loads uses the same `steps` choice.

- [ ] Step 1: tests per the spec's Wizard bullet (rank 60 → 3 steps, no button; rank 80 + change → 4 steps + button; rank 80 without change → none; step 4 options = unarchived moves only, natural order, sub line; Open the import disabled until a pick, then the handed-off File name/bytes and the navigation to `/initiatives/{id}/import-assets`; load-failure and no-moves lines). Run → FAIL.
- [ ] Step 2: implement. Run `npx vitest run src/components/bulk src/pages/BulkConvertRawFt.test.tsx src/pages/ImportMoveAssets.test.tsx src/lib/importHandoff.test.ts`, then full `npx vitest run`, `npx tsc -b`, `npm run build` → PASS.
- [ ] Step 3: commit `feat(portal): Convert Raw F-T step 4 — import straight into a move (super admin)`.

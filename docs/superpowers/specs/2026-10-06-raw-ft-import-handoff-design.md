# Convert Raw F-T — import straight into a move (step 4)

Date: 2026-10-06. Branch `raw-ft-import`. Builds on
`2026-10-06-convert-raw-ft-steps-design.md` (three-step wizard) and
`2026-10-05-convert-customer-from-to-design.md` (reading/conversion rules).

## Who

Super admins and above who can change moves:
`maxRank >= SUPER_ADMIN_RANK (80) && can('initiatives', 'change')`.
Everyone else sees the wizard exactly as today (three steps, no new button).

## Step 3 (Download)

The footer keeps **Back** and the primary **Download converted file**. For
eligible people a second button **Import into a move** (mini button, just
left of the primary) goes to step 4. It is disabled when no column is
matched, like the primary.

## Step 4 (Import) — eligible people only

The step row shows four steps for eligible people: Upload / Match /
Download / **Import**. Step 4: key `import`, label **Import**, title
**Choose the move**, description **Pick the move to import into. Its
From-To import opens with the converted file already loaded.**

- A **Move** ComboBox (`inputId="ftc-move"`, label **Move**, type to filter,
  placeholder **Pick a move…**). Options are every initiative with
  `initiative_type === 'move'` and `archived_at == null`, sorted naturally by
  name (`sortNatural`); each option's `sub` is
  `{status_label} · {origin_site_name or —} → {destination_site_name or —}`.
  Loaded from `listInitiatives()` when step 4 first opens.
- Loading: **Loading moves…**; failure: **Couldn't load moves. Go back and
  try again.**; none: **There are no moves to import into.**
- Footer: **Back** (to step 3) and the primary **Open the import**,
  disabled until a move is picked.
- **Open the import** builds the converted file in memory (same workbook
  and compression as the download, named `convertedFilename(original)`,
  type `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`),
  hands it off, and navigates to `/initiatives/{id}/import-assets`.

## Handoff

`portal/src/lib/importHandoff.ts` keeps one pending `{ initiativeId, file }`
in memory (module scope): `handOffImportFile(initiativeId, file)`,
`peekHandedOffImportFile(initiativeId): File | null` (no side effect), and
`clearHandedOffImportFile(initiativeId)`. Nothing goes to storage or the
server; a reload loses it, like any unsaved file pick.

The From-To import page (`ImportMoveAssets`) starts its `file` state from
`peekHandedOffImportFile(id)` (lazy initializer, safe under StrictMode's
double call) and clears the handoff in a mount effect. While the file shown
is the handed-off one, a `page-hint` under the drop zone reads **This file
came from Convert Raw F-T.** Everything else on that page is unchanged: the
person still chooses options and runs Validate, Review and Import.

## Shared chrome

`WizardFooter` gains an optional `secondary?: { label: string; onClick:
() => void; disabled?: boolean }`, rendered as a `mini-btn` immediately
before the primary button (also disabled while `busy`).

## Testing

- importHandoff: peek doesn't clear; peek for another initiative returns
  null; clear removes it; a new hand-off replaces the old one.
- ImportMoveAssets: with a handed-off file for its id the drop zone shows
  that file and the note; the handoff is cleared after mount; no note when
  nothing was handed off; picking a different file hides the note.
- WizardFooter: secondary renders before the primary, calls back, honors
  disabled and busy.
- Wizard: rank 60 sees three steps and no Import button; rank 80 with
  change sees four steps and the button; rank 80 without change doesn't;
  step 4 lists only unarchived moves, naturally sorted, with the sub line;
  Open the import is disabled until a pick, then hands off a File named
  `Acme FT-converted.xlsx` whose bytes re-read to the converted rows, and
  navigates to `/initiatives/{id}/import-assets`; the load-failure and
  no-moves lines.
